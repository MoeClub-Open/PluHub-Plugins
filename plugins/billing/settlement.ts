import type { DatabaseSync } from "node:sqlite";
import type { Usage } from "@pluhub/contracts/ai";
import { fixedPricing } from "../../lib/commerce/expression.js";
import {
  priceUsage,
  validateUsage,
  type PriceReceipt,
} from "../../lib/commerce/pricing.js";
import { transaction } from "../../lib/storage/sqlite.js";

type Reservation = {
  id: string;
  user_id: string;
  amount: number;
  pricing: string | null;
};
type Post = (userId: string, amount: number, source: string) => void;

/** A completed attempt always posts a final charge; unavailable usage uses its reservation. */
export function settleRequest(
  db: DatabaseSync,
  post: Post,
  row: Reservation,
  options: {
    usage?: Usage;
    webSearchCalls?: number;
    reservedReason?: string;
    recovered?: boolean;
  } = {},
): PriceReceipt {
  return transaction(db, () => {
    const pricing = row.pricing ? JSON.parse(row.pricing) : undefined;
    let receipt: PriceReceipt = {
      mode: "reserved",
      amount: row.amount,
      pricing,
      lines: [],
    };
    let note =
      options.reservedReason ?? "Usage unavailable; charged reserved amount";
    let usage: Usage | undefined;
    if (options.usage) {
      try {
        validateUsage(options.usage);
        usage = Object.fromEntries(
          [
            "input",
            "output",
            "cacheRead",
            "cacheWrite",
            "cacheWrite1h",
            "reasoning",
            "webSearch",
          ].flatMap((key) =>
            options.usage![key as keyof Usage] === undefined
              ? []
              : [[key, options.usage![key as keyof Usage]]],
          ),
        ) as unknown as Usage;
        db.prepare("UPDATE reservations SET reported_usage=? WHERE id=?").run(
          JSON.stringify(usage),
          row.id,
        );
      } catch {
        note = "Invalid usage; charged reserved amount";
      }
    }
    if (
      !options.reservedReason &&
      pricing &&
      (usage || (fixedPricing(pricing) && !pricing.webSearch))
    ) {
      try {
        receipt = priceUsage(
          usage ?? {
            input: 0,
            output: 0,
            ...(options.webSearchCalls
              ? { webSearch: options.webSearchCalls }
              : {}),
          },
          pricing,
        );
        note = options.recovered ? "Recovered request settlement" : "";
      } catch {
        note = "Invalid usage or cost; charged reserved amount";
      }
    }
    post(row.user_id, -receipt.amount, "request:" + row.id);
    db.prepare(
      "UPDATE reservations SET status='settled',actual=?,receipt=?,note=? WHERE id=?",
    ).run(receipt.amount, JSON.stringify(receipt), note || null, row.id);
    return receipt;
  });
}

/** Finish historical review rows and interrupted requests once before admitting new work. */
export function recoverRequestSettlements(db: DatabaseSync, post: Post) {
  const rows = db
    .prepare("SELECT * FROM reservations WHERE status IN ('reserved','review')")
    .all() as (Reservation & { reported_usage?: string; note?: string })[];
  for (const row of rows) {
    let usage: Usage | undefined;
    try {
      usage = row.reported_usage ? JSON.parse(row.reported_usage) : undefined;
    } catch {}
    settleRequest(db, post, row, {
      usage,
      recovered: true,
      ...(row.note === "Output limit exceeded"
        ? { reservedReason: "Output limit exceeded; charged reserved amount" }
        : !usage
          ? { reservedReason: "Recovered request; charged reserved amount" }
          : {}),
    });
  }
}
