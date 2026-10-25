import { consumptionSourceSql } from "./charges.js";
import { attachCharges, consumptionSummary } from "./charges.js";
import { attachRequestLabels } from "./request-labels.js";
import { join } from "node:path";
import { definePlugin, HostError, json } from "@pluhub/sdk";
import { openDatabase, transaction } from "../../lib/storage/sqlite.js";
import { beginObservation, observation } from "../../lib/ai/telemetry.js";
import { rankingMigration, readRankings, recordRanking } from "./rankings.js";
import { readModelMetrics } from "./model-metrics.js";
import { csvResponse, exportGuard } from "../../lib/export/csv.js";
import {
  validateUsage,
  validatePricing,
  priceUsage,
} from "../../lib/commerce/pricing.js";
import { fixedPricing } from "../../lib/commerce/expression.js";
import { retirePricingFactors } from "../../lib/commerce/migrations.js";
export default definePlugin({
  setup(host) {
    const db = openDatabase(join(host.dataDir, "requests.sqlite"), [
      `CREATE TABLE requests (
        id TEXT PRIMARY KEY, user_id TEXT, key_id TEXT, created_at INTEGER NOT NULL,
        model TEXT NOT NULL, upstream TEXT, protocol TEXT NOT NULL, status TEXT NOT NULL,
        http_status INTEGER NOT NULL, latency_ms INTEGER NOT NULL, first_token_ms INTEGER,
        input_tokens INTEGER, output_tokens INTEGER, cost_micro_usd INTEGER, stream INTEGER NOT NULL, error_code TEXT
      ); CREATE INDEX requests_time ON requests(created_at); CREATE INDEX requests_user_time ON requests(user_id,created_at);`,
      "ALTER TABLE requests ADD COLUMN routing TEXT;",
      rankingMigration,
      "ALTER TABLE requests ADD COLUMN usage_json TEXT; ALTER TABLE requests ADD COLUMN pricing_json TEXT;",
      "ALTER TABLE requests ADD COLUMN generation_ms INTEGER; CREATE INDEX requests_model_upstream_time ON requests(model,upstream,created_at);",
      retirePricingFactors("requests", "pricing_json"),
      "ALTER TABLE requests ADD COLUMN billing_mode TEXT;",
      `ALTER TABLE requests ADD COLUMN consumption_source TEXT;
       UPDATE requests SET consumption_source=CASE
         WHEN billing_mode IN ('platform','disabled') THEN 'platform'
         WHEN billing_mode='personal' THEN 'personal' END;`,
      "ALTER TABLE requests ADD COLUMN user_name TEXT; ALTER TABLE requests ADD COLUMN key_name TEXT;",
    ]);
    host.cleanup(() => db.close());
    host.provide("observability.rankings@1", (input) =>
      readRankings(db, input),
    );
    host.provide("observability.model-metrics@1", (input) =>
      readModelMetrics(db, input),
    );
    const retentionDays = Number(host.config().retentionDays ?? 30);
    const maxRows = Number(host.config().maxRows ?? 100000);
    let rowCount = Number(
      (db.prepare("SELECT COUNT(*) n FROM requests").get() as any).n,
    );
    const trim = () => {
      if (rowCount <= maxRows) return;
      db.prepare(
        "DELETE FROM requests WHERE rowid IN (SELECT rowid FROM requests ORDER BY created_at,rowid LIMIT ?)",
      ).run(rowCount - maxRows);
      rowCount = maxRows;
    };
    const prune = () => {
      db.prepare("DELETE FROM requests WHERE created_at<?").run(
        Date.now() - retentionDays * 86400000,
      );
      rowCount = Number(
        (db.prepare("SELECT COUNT(*) n FROM requests").get() as any).n,
      );
      trim();
    };
    prune();
    const sweep = setInterval(() => {
      try {
        prune();
      } catch {
        host.log("error", "Request log retention cleanup failed");
      }
    }, 60000);
    sweep.unref();
    host.cleanup(() => clearInterval(sweep));
    let writes = 0;
    let dropped = 0,
      failures = 0,
      lastFaultAt = 0;
    const fault = () => {
      failures++;
      if (Date.now() - lastFaultAt > 30000) {
        lastFaultAt = Date.now();
        host.log(
          "error",
          "Request observation storage failed; billing settlement remains independent",
        );
      }
    };
    const checkStorage = () => {
      try {
        db.prepare("SELECT 1 FROM requests LIMIT 1").get();
      } catch {
        throw new HostError(
          "logs_unavailable",
          "调用日志暂不可用，请稍后重试",
          503,
        );
      }
    };
    host.api({
      method: "GET",
      path: "/status",
      access: "host.manage",
      handle() {
        let available = true;
        try {
          checkStorage();
        } catch {
          available = false;
        }
        return json({ available, dropped, failures, retentionDays, maxRows });
      },
    });
    host.hook({
      id: "start",
      phase: "Ingress",
      handle(ctx) {
        if (ctx.request.method !== "POST") return;
        const path = new URL(ctx.request.url).pathname;
        const protocol =
          path === "/v1/chat/completions"
            ? "openai-chat"
            : path === "/v1/responses"
              ? "openai-responses"
              : path === "/v1/messages"
                ? "anthropic"
                : path.startsWith("/v1beta/models/")
                  ? "gemini"
                  : undefined;
        if (protocol) beginObservation(ctx, protocol);
      },
    });
    host.hook({
      id: "record",
      phase: "Finalize",
      handle(ctx) {
        const state = observation(ctx);
        if (!state) return;
        const cancelled =
          ctx.signal.aborted || ctx.state.get("http.cancelled") === true;
        const code =
          state.errorCode ??
          (ctx.state.get("http.errorCode") as string | undefined);
        const status = cancelled
          ? "cancelled"
          : code || !state.finished
            ? "error"
            : "success";
        if (status === "error")
          ctx.state.set("http.errorCode", code ?? "upstream_incomplete");
        let cost: number | null = null;
        let usageDetails: string | null = null;
        if (state.usage) {
          const safe = Object.fromEntries(
            [
              "input",
              "output",
              "cacheRead",
              "cacheWrite",
              "cacheWrite1h",
              "reasoning",
              "webSearch",
            ].flatMap((key) => {
              const value = (state.usage as any)[key];
              return value === undefined ? [] : [[key, value]];
            }),
          );
          try {
            validateUsage(safe as any);
            usageDetails = JSON.stringify(safe);
          } catch {
            /* Invalid usage is retained as unknown detail, not a payable fact. */
          }
        }
        let prices: string | null = null;
        if (state.pricing) {
          try {
            validatePricing(state.pricing);
            const copy = Object.fromEntries(
              [
                "input",
                "output",
                "cacheRead",
                "cacheWrite",
                "cacheWrite1h",
                "mode",
                "request",
                "webSearch",
                "multiplier",
                "tiers",
                "expression",
                "context",
                "serviceGroup",
              ].flatMap((key) => {
                const value = (state.pricing as any)[key];
                return value === undefined ? [] : [[key, value]];
              }),
            );
            if (Array.isArray(copy.tiers))
              copy.tiers = copy.tiers.map((tier) =>
                Object.fromEntries(
                  [
                    "above",
                    "input",
                    "output",
                    "cacheRead",
                    "cacheWrite",
                    "cacheWrite1h",
                  ].flatMap((key) =>
                    tier[key] === undefined ? [] : [[key, tier[key]]],
                  ),
                ),
              );
            prices = JSON.stringify(copy);
          } catch {
            /* Unvalidated plugin metadata is not persisted in a user's log. */
          }
        }
        try {
          if (
            state.pricing &&
            (state.usage || (state.finished && fixedPricing(state.pricing)))
          )
            cost = priceUsage(
              state.usage ?? {
                input: 0,
                output: 0,
                ...(state.routing?.webSearchCalls
                  ? { webSearch: state.routing.webSearchCalls }
                  : {}),
              },
              state.pricing,
            ).amount;
        } catch {
          /* Invalid provider usage remains unpriced for review. */
        }
        let recorded = false;
        try {
          transaction(db, () => {
            db.prepare(
              "INSERT INTO requests(id,user_id,key_id,created_at,model,upstream,protocol,status,http_status,latency_ms,first_token_ms,input_tokens,output_tokens,cost_micro_usd,stream,error_code,routing,usage_json,pricing_json,generation_ms,billing_mode,consumption_source,user_name,key_name) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
            ).run(
              ctx.id,
              ctx.principal?.id ?? null,
              String(ctx.principal?.attributes?.keyId ?? "") || null,
              state.startedAt,
              state.model ?? "",
              state.upstream ?? null,
              state.protocol,
              status,
              Number(ctx.state.get("http.status") ?? 500),
              Math.max(0, Date.now() - state.startedAt),
              state.firstTokenMs ?? null,
              state.usage?.input ?? null,
              state.usage?.output ?? null,
              cost !== null && Number.isSafeInteger(cost) ? cost : null,
              state.stream ? 1 : 0,
              status === "error"
                ? (code ?? "upstream_incomplete").slice(0, 128)
                : null,
              state.routing ? JSON.stringify(state.routing) : null,
              usageDetails,
              prices,
              state.generationMs ?? null,
              (ctx.state.get("billing.mode") as string | undefined) ?? null,
              state.consumptionSource ?? null,
              typeof ctx.principal?.attributes?.username === "string"
                ? ctx.principal.attributes.username
                : null,
              typeof ctx.principal?.attributes?.keyName === "string"
                ? ctx.principal.attributes.keyName
                : null,
            );
            recordRanking(db, {
              at: state.startedAt,
              userId: ctx.principal?.id,
              model: state.model,
              upstream: state.upstream,
              status,
              input: state.usage?.input,
              output: state.usage?.output,
            });
          });
          recorded = true;
          rowCount++;
          trim();
          if (++writes % 100 === 0) prune();
        } catch {
          if (!recorded) dropped++;
          fault();
        }
      },
    });
    async function logScope(principal: {
      id: string;
      permissions: string[];
      session?: boolean;
    }) {
      if (host.hasCapability("users.log-scope@1"))
        return host.call<{
          scope: string;
          users: { id: string; name: string }[];
        }>("users.log-scope@1", {
          id: principal.id,
          all:
            principal.session === true && principal.permissions.includes("*"),
          children: principal.session === true,
        });
      return {
        scope:
          principal.session === true && principal.permissions.includes("*")
            ? "all"
            : "self",
        users: [{ id: principal.id, name: "" }],
      };
    }
    host.api({
      method: "GET",
      path: "/log-scope",
      access: "authenticated",
      async handle(_request, ctx) {
        return json(await logScope(ctx.principal!));
      },
    });
    async function filter(
      request: Request,
      principal: { id: string; permissions: string[]; session?: boolean },
    ) {
      checkStorage();
      const query = new URL(request.url).searchParams;
      let hours = Number(query.get("hours") ?? 24);
      if (![24, 168, 720].includes(hours))
        throw new HostError("invalid_request", "Invalid time range");
      let from = Date.now() - hours * 3600000,
        to = Date.now();
      if (query.has("from") || query.has("to")) {
        from = Number(query.get("from"));
        to = Number(query.get("to"));
        if (
          !query.has("from") ||
          !query.has("to") ||
          !Number.isSafeInteger(from) ||
          !Number.isSafeInteger(to) ||
          from < 0 ||
          to <= from ||
          to - from > 365 * 86400000
        )
          throw new HostError("invalid_request", "Invalid time range");
        hours = (to - from) / 3600000;
      }
      const where = ["created_at>=?", "created_at<=?"];
      const params: (string | number)[] = [from, to];
      const allowed = await logScope(principal);
      if (query.get("scope") === "me" || allowed.scope === "self") {
        where.push("user_id=?");
        params.push(principal.id);
      } else if (allowed.scope !== "all") {
        where.push("user_id IN (SELECT value FROM json_each(?))");
        params.push(JSON.stringify(allowed.users.map((user) => user.id)));
      }
      const userId = query.get("userId");
      if (userId) {
        if (
          allowed.scope !== "all" &&
          !allowed.users.some((user) => user.id === userId)
        )
          throw new HostError("forbidden", "User outside log scope", 403);
        where.push("user_id=?");
        params.push(userId);
      }
      if (query.has("model")) {
        where.push("model=?");
        params.push(query.get("model")!.slice(0, 256));
      }
      for (const [key, column] of [
        ["requestId", "id"],
        ["upstream", "upstream"],
        ["errorCode", "error_code"],
        ["keyId", "key_id"],
        ["protocol", "protocol"],
      ]) {
        const value = query.get(key!);
        if (!value) continue;
        if (value.length > 256)
          throw new HostError("invalid_request", "Invalid request log filter");
        where.push(column + "=?");
        params.push(value);
      }
      if (query.has("status")) {
        const status = query.get("status")!;
        if (!["success", "error", "cancelled"].includes(status))
          throw new HostError("invalid_request", "Invalid status");
        where.push("status=?");
        params.push(status);
      }
      if (query.has("source")) {
        const source = query.get("source")!;
        if (
          ![
            "platform",
            "byoapi",
            "byosub",
            "personal",
            "unrouted",
            "unknown",
          ].includes(source)
        )
          throw new HostError("invalid_request", "Invalid consumption source");
        where.push(consumptionSourceSql + "=?");
        params.push(source);
      }
      return {
        query,
        hours,
        from,
        to,
        sql: where.join(" AND "),
        params,
        users: allowed.users,
      };
    }
    const guardExport = exportGuard();
    host.api({
      method: "GET",
      path: "/requests/export",
      access: "authenticated",
      async handle(request, ctx) {
        const f = await filter(request, ctx.principal!);
        guardExport(ctx.principal!.id);
        const rows = db
          .prepare(
            "SELECT * FROM requests WHERE " +
              f.sql +
              " ORDER BY created_at DESC,id DESC LIMIT 10001",
          )
          .all(...f.params) as Record<string, any>[];
        const columns = [
          "id",
          "user_id",
          "user_name",
          "key_id",
          "key_name",
          "created_at",
          "model",
          "upstream",
          "protocol",
          "effort",
          "status",
          "http_status",
          "latency_ms",
          "first_token_ms",
          "input_tokens",
          "output_tokens",
          "estimated_cost_micro_usd",
          "consumption_source",
          "charged_micro_usd",
          "held_micro_usd",
          "billing_status",
          "stream",
          "error_code",
        ];
        return csvResponse(
          "pluhub-requests.csv",
          columns,
          (
            await attachCharges(
              host,
              await attachRequestLabels(host, rows, f.users, ctx.signal),
              ctx.signal,
            )
          ).map((row) =>
            columns.map(
              (key) =>
                row[
                  key === "estimated_cost_micro_usd" ? "cost_micro_usd" : key
                ],
            ),
          ),
        );
      },
    });
    host.api({
      method: "GET",
      path: "/requests",
      access: "authenticated",
      async handle(request, ctx) {
        const f = await filter(request, ctx.principal!);
        const limit = Number(f.query.get("limit") ?? 20);
        const offset = Number(f.query.get("offset") ?? 0);
        if (
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100 ||
          !Number.isInteger(offset) ||
          offset < 0 ||
          offset > 100000
        )
          throw new HostError("invalid_request", "Invalid pagination");
        const total = (
          db
            .prepare("SELECT COUNT(*) n FROM requests WHERE " + f.sql)
            .get(...f.params) as any
        ).n;
        const rows = db
          .prepare(
            "SELECT * FROM requests WHERE " +
              f.sql +
              " ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
          )
          .all(...f.params, limit, offset);
        return json({
          data: await attachCharges(
            host,
            await attachRequestLabels(
              host,
              rows as Record<string, any>[],
              f.users,
              ctx.signal,
            ),
            ctx.signal,
          ),
          total,
          limit,
          offset,
        });
      },
    });
    host.api({
      method: "GET",
      path: "/summary",
      access: "authenticated",
      async handle(request, ctx) {
        const f = await filter(request, ctx.principal!);
        const summary = db
          .prepare(
            `SELECT COUNT(*) requests,
        COALESCE(SUM(status='success'),0) successes, COALESCE(SUM(status='error'),0) errors,
        COALESCE(SUM(status='cancelled'),0) cancelled,
        COALESCE(SUM(input_tokens),0) inputTokens, COALESCE(SUM(output_tokens),0) outputTokens,
        COUNT(input_tokens) usageKnownRequests, COUNT(cost_micro_usd) pricedRequests,
        AVG(CASE WHEN status='success' AND stream=1 AND first_token_ms IS NOT NULL THEN latency_ms END) avgLatencyMs, AVG(CASE WHEN status='success' AND stream=1 THEN first_token_ms END) avgFirstTokenMs
        FROM requests WHERE ${f.sql}`,
          )
          .get(...f.params);
        const bucketMs = f.hours <= 48 ? 3600000 : 86400000;
        const buckets = db
          .prepare(
            `SELECT CAST(created_at/? AS INTEGER) bucket, COUNT(*) requests, SUM(status='error') errors FROM requests WHERE ${f.sql} GROUP BY bucket`,
          )
          .all(bucketMs, ...f.params) as any[];
        const end = Math.floor(f.to / bucketMs);
        const start = Math.floor(f.from / bucketMs);
        const series = Array.from({ length: end - start + 1 }, (_, index) => {
          const bucket = start + index;
          const row = buckets.find((r) => r.bucket === bucket);
          return {
            at: bucket * bucketMs,
            requests: row?.requests ?? 0,
            errors: row?.errors ?? 0,
          };
        });
        const models = db
          .prepare(
            `SELECT model,COUNT(*) requests,SUM(COALESCE(input_tokens,0)+COALESCE(output_tokens,0)) tokens FROM requests WHERE ${f.sql} GROUP BY model ORDER BY requests DESC LIMIT 6`,
          )
          .all(...f.params);
        return json({
          ...summary,
          ...(await consumptionSummary(host, db, f, ctx.signal)),
          series,
          models,
          retentionDays,
          maxRows,
        });
      },
    });
  },
});
