import type { Host } from "@pluhub/sdk";
import type {
  RequestCharge,
  RequestChargeTotals,
} from "@pluhub/contracts/commerce";
import type { DatabaseSync } from "node:sqlite";

// Billing admission never starts for these rows; unknown settlement is reserved for requests that reached it.
export const unroutedSql =
  "(status IN ('error','cancelled') AND upstream IS NULL AND billing_mode IS NULL AND input_tokens IS NULL AND pricing_json IS NULL)";
export const consumptionSourceSql = `COALESCE(consumption_source, CASE WHEN ${unroutedSql} THEN 'unrouted' ELSE 'unknown' END)`;
const exemptSql =
  "(consumption_source IN ('byoapi','byosub','personal') OR billing_mode IN ('personal','disabled'))";

export async function consumptionSummary(
  host: Host,
  db: DatabaseSync,
  filter: { sql: string; params: (string | number)[] },
  signal: AbortSignal,
) {
  const consumption = db
    .prepare(
      `SELECT ${consumptionSourceSql} source,
    COUNT(*) requests, COALESCE(SUM(input_tokens),0) inputTokens,
    COALESCE(SUM(output_tokens),0) outputTokens, COUNT(input_tokens) usageKnownRequests,
    COUNT(cost_micro_usd) pricedRequests, SUM(cost_micro_usd)/1000000.0 estimatedCostUSD
    FROM requests WHERE ${filter.sql} GROUP BY source`,
    )
    .all(...filter.params);
  const scope = `${filter.sql} AND NOT COALESCE(${exemptSql},0)`;
  const pending = db
    .prepare(
      `SELECT COUNT(*) count, COALESCE(SUM(${unroutedSql}),0) unstarted, MAX(rowid) last FROM requests WHERE ${scope}`,
    )
    .get(...filter.params) as {
    count: number;
    unstarted: number;
    last: number | null;
  };
  const totals: RequestChargeTotals = {
    knownRequests: 0,
    pendingRequests: 0,
    charged: 0,
    held: 0,
  };
  let unbilled = pending.unstarted;
  const capability = host.hasCapability("billing.request-totals@1");
  let available = pending.count === pending.unstarted || capability;
  if (capability && pending.count) {
    try {
      const page =
        db.prepare(`SELECT rowid, id, user_id, ${unroutedSql} AS unstarted FROM requests WHERE ${scope}
        AND rowid>? AND rowid<=? ORDER BY rowid LIMIT 5000`);
      let cursor = 0;
      while (cursor < pending.last!) {
        signal.throwIfAborted();
        const rows = page.all(...filter.params, cursor, pending.last!) as {
          rowid: number;
          id: string;
          user_id: string | null;
          unstarted: number;
        }[];
        if (!rows.length) break;
        cursor = rows.at(-1)!.rowid;
        const requests = rows.flatMap((row) =>
          row.user_id ? [{ id: row.id, userId: row.user_id }] : [],
        );
        if (!requests.length) continue;
        const result = await host.call<RequestChargeTotals>(
          "billing.request-totals@1",
          { requests },
          signal,
        );
        const early = rows
          .filter((row) => row.unstarted && row.user_id)
          .map((row) => ({ id: row.id, userId: row.user_id! }));
        if (early.length) {
          const known = await host.call<RequestChargeTotals>(
            "billing.request-totals@1",
            { requests: early },
            signal,
          );
          unbilled -= known.knownRequests + known.pendingRequests;
        }
        for (const key of [
          "knownRequests",
          "pendingRequests",
          "charged",
          "held",
        ] as const)
          totals[key] += result[key];
      }
    } catch {
      signal.throwIfAborted();
      available = false;
      host.log("warn", "Request charge totals are temporarily unavailable");
    }
  }
  return {
    consumption,
    wallet: {
      chargedUSD:
        available && (pending.count === unbilled || totals.knownRequests > 0)
          ? totals.charged / 1000000
          : null,
      heldUSD: available ? totals.held / 1000000 : null,
      pendingRequests: available ? totals.pendingRequests : null,
      unknownRequests: available
        ? Math.max(
            0,
            pending.count -
              totals.knownRequests -
              totals.pendingRequests -
              unbilled,
          )
        : pending.count - pending.unstarted,
    },
  };
}

export async function attachCharges(
  host: Host,
  rows: Record<string, any>[],
  signal: AbortSignal,
): Promise<Record<string, any>[]> {
  const charges = new Map<string, RequestCharge>();
  const available = host.hasCapability("billing.request-charges@1");
  let failed = false;
  if (available) {
    try {
      for (let index = 0; index < rows.length; index += 500) {
        const requests = rows
          .slice(index, index + 500)
          .filter((row) => row.user_id)
          .map((row) => ({ id: row.id, userId: row.user_id }));
        if (!requests.length) continue;
        for (const charge of await host.call<RequestCharge[]>(
          "billing.request-charges@1",
          { requests },
          signal,
        ))
          charges.set(charge.requestId, charge);
      }
    } catch (error) {
      signal.throwIfAborted();
      failed = true;
      host.log("warn", "Request charges are temporarily unavailable");
    }
  }
  return rows.map((row) => {
    const charge = charges.get(row.id);
    const personal =
      ["byoapi", "byosub", "personal"].includes(row.consumption_source) ||
      row.billing_mode === "personal";
    const notStarted =
      ["error", "cancelled"].includes(row.status) &&
      !row.upstream &&
      !row.billing_mode &&
      row.input_tokens == null &&
      !row.pricing_json;
    const exempt = personal || row.billing_mode === "disabled" || notStarted;
    return {
      ...row,
      consumption_source:
        row.consumption_source ?? (notStarted ? "unrouted" : "unknown"),
      charged_micro_usd: charge?.charged ?? (exempt ? 0 : null),
      held_micro_usd: charge?.held ?? (exempt ? 0 : null),
      billing_status:
        charge?.status ??
        (exempt
          ? notStarted
            ? "not_started"
            : personal
              ? "personal"
              : "disabled"
          : !available || failed
            ? "unavailable"
            : "unknown"),
      billing_receipt: charge?.receipt,
    };
  });
}
