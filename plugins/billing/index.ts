import { settleRequest, recoverRequestSettlements } from "./settlement.js";
import type { RequestContext } from "@pluhub/sdk";
import { installRequestCharges } from "./request-charges.js";
import { consumptionSource } from "../../lib/commerce/consumption.js";
import { join } from "node:path";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import type { AIRequest, AIPlan } from "@pluhub/contracts/ai";
import { openDatabase, transaction } from "../../lib/storage/sqlite.js";
import { integer } from "../../lib/commerce/money.js";
import { reserveCost } from "../../lib/commerce/pricing.js";
import { installPriceQuote } from "./quote.js";
import { mediaInputBound } from "../../lib/ai/media.js";
import { retirePricingFactors } from "../../lib/commerce/migrations.js";
import { observation } from "../../lib/ai/telemetry.js";
import { requireAdmin, adminTarget } from "../../lib/admin/access.js";
import { installBillingAdmin } from "./admin.js";
import { installBillingHistory } from "./history.js";
import { installPaymentBalances, paymentMigration } from "./payments.js";
import {
  outputBudget,
  validateOutputBudget,
} from "../../lib/ai/output-budget.js";
export default definePlugin({
  setup(host) {
    const db = openDatabase(join(host.dataDir, "billing.sqlite"), [
      `
    CREATE TABLE wallets(user_id TEXT PRIMARY KEY, balance INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE ledger(id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, amount INTEGER NOT NULL, source TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL);
    CREATE TABLE reservations(id TEXT PRIMARY KEY,user_id TEXT NOT NULL,amount INTEGER NOT NULL,status TEXT NOT NULL,actual INTEGER,created_at INTEGER NOT NULL, note TEXT);
    CREATE INDEX reservations_user ON reservations(user_id,status);
  `,
      "CREATE TABLE adjustments(source TEXT PRIMARY KEY,actor TEXT NOT NULL,reason TEXT NOT NULL);",
      `ALTER TABLE reservations ADD COLUMN pricing TEXT;
       ALTER TABLE reservations ADD COLUMN receipt TEXT;
       CREATE TABLE pricing_users(user_id TEXT PRIMARY KEY,group_id TEXT NOT NULL,user_multiplier REAL NOT NULL);`,
      "CREATE INDEX ledger_user_id ON ledger(user_id,id);",
      paymentMigration,
      "ALTER TABLE reservations ADD COLUMN budget TEXT; ALTER TABLE reservations ADD COLUMN reported_usage TEXT;",
      retirePricingFactors("reservations", "pricing") +
        retirePricingFactors("reservations", "receipt", "$.pricing") +
        "DROP TABLE pricing_users;",
    ]);
    host.cleanup(() => db.close());
    function wallet(userId: string, create = true) {
      if (create)
        db.prepare("INSERT OR IGNORE INTO wallets(user_id) VALUES(?)").run(
          userId,
        );
      const balance = Number(
        (
          db
            .prepare("SELECT balance FROM wallets WHERE user_id=?")
            .get(userId) as any
        )?.balance ?? 0,
      );
      const requestHeld = Number(
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(amount),0) AS n FROM reservations WHERE user_id=? AND status='reserved'",
            )
            .get(userId) as any
        ).n,
      );
      const paymentHeld = Number(
        (
          db
            .prepare(
              "SELECT COALESCE(SUM(hold),0) n FROM payment_balances WHERE user_id=?",
            )
            .get(userId) as any
        ).n,
      );
      const held = requestHeld + paymentHeld;
      return {
        enabled: host.config().enabled === true,
        currency: "USD",
        unit: "micro",
        balance,
        held,
        requestHeld,
        paymentHeld,
        available: balance - held,
      };
    }
    installBillingAdmin(host, db, wallet);
    installBillingHistory(host, db);
    installRequestCharges(host, db);
    installPriceQuote(host);
    host.validateConfig(validateOutputBudget);
    function post(userId: string, amount: number, source: string) {
      integer(Math.abs(amount));
      requiredString(userId, "userId");
      requiredString(source, "source", 512);
      const old = db
        .prepare("SELECT user_id,amount FROM ledger WHERE source=?")
        .get(source) as any;
      if (old) {
        if (old.user_id !== userId || old.amount !== amount)
          throw new HostError(
            "idempotency_conflict",
            "Ledger source already used",
            409,
          );
        return;
      }
      const current = wallet(userId);
      integer(Math.abs(current.balance + amount));
      db.prepare(
        "INSERT INTO ledger(user_id,amount,source,created_at) VALUES(?,?,?,?)",
      ).run(userId, amount, source, Date.now());
      db.prepare("UPDATE wallets SET balance=balance+? WHERE user_id=?").run(
        amount,
        userId,
      );
    }
    recoverRequestSettlements(db, post);
    installPaymentBalances(host, db, post, wallet);
    host.provide("billing.credit@1", ({ userId, amount, source }) =>
      transaction(db, () => {
        integer(amount, "credit", 1);
        post(userId, amount, source);
        return wallet(userId);
      }),
    );
    host.provide("billing.balance@1", ({ userId }) =>
      wallet(requiredString(userId, "userId")),
    );
    function admit(ctx: RequestContext, retry = false) {
      if (retry && ctx.state.get("billing.reserved"))
        db.prepare(
          "UPDATE reservations SET status='released',note='Upstream rejected before generation' WHERE id=? AND status='reserved'",
        ).run(ctx.id);
      ctx.state.set("billing.reserved", false);

      const request = ctx.state.get("ai.request") as AIRequest | undefined;
      const plan = ctx.state.get("ai.plan") as AIPlan | undefined;
      if (!request || !plan) return;
      if (plan.workflowDeferred) {
        // The coordinator does not call a provider; each child has its own reservation.
        ctx.state.set("billing.mode", "workflow");
        return;
      }
      const personal = consumptionSource(plan) !== "platform";
      ctx.state.set(
        "billing.mode",
        personal ? "personal" : host.config().enabled ? "platform" : "disabled",
      );
      if (personal || !host.config().enabled) return;
      if (!plan.pricing)
        throw new HostError(
          "price_unavailable",
          "Model has no billing price",
          503,
        );
      // Conservative UTF-8 byte bound plus per-message/tool framing; actual provider usage is authoritative.
      const { request: prepared, budget } = outputBudget(
        request,
        plan,
        host.config(),
      );
      plan.preparedRequest = prepared;
      const inputBound = prepared.operation
        ? mediaInputBound(prepared)
        : Buffer.byteLength(
            JSON.stringify({
              messages: prepared.messages,
              tools: prepared.tools,
            }),
          ) + 1024;
      const pricing = structuredClone(plan.pricing);
      plan.pricing = pricing;
      const state = observation(ctx);
      if (state) {
        state.pricing = pricing;
        state.routing = { ...state.routing, outputBudget: budget };
      }
      const amount = reserveCost(
        inputBound,
        budget.reservedTokens,
        pricing,
        prepared.webSearch ? (prepared.webSearch.maxCalls ?? 3) : 0,
      );
      transaction(db, () => {
        const userId = ctx.principal!.id;
        if (wallet(userId).available < amount)
          throw new HostError(
            "insufficient_balance",
            "Insufficient available balance",
            402,
          );
        db.prepare(
          "INSERT INTO reservations(id,user_id,amount,status,created_at,pricing,budget) VALUES(?,?,?,'reserved',?,?,?) ON CONFLICT(id) DO UPDATE SET user_id=excluded.user_id,amount=excluded.amount,status='reserved',created_at=excluded.created_at,pricing=excluded.pricing,budget=excluded.budget,actual=NULL,receipt=NULL,reported_usage=NULL,note=NULL WHERE reservations.status='released'",
        ).run(
          ctx.id,
          userId,
          amount,
          Date.now(),
          JSON.stringify(pricing),
          JSON.stringify({ ...budget, inputTokens: inputBound }),
        );
      });
      ctx.state.set("billing.reserved", true);
    }
    host.provide(
      "billing.admit@1",
      ({ context, retry }: { context: RequestContext; retry?: boolean }) =>
        admit(context, retry),
    );
    host.hook({
      id: "reserve",
      phase: "Admission",
      handle: (ctx) => admit(ctx),
    });
    host.hook({
      id: "settle",
      phase: "Finalize",
      handle(ctx) {
        if (
          ctx.state.get("billing.mode") !== "platform" ||
          !ctx.state.get("billing.reserved")
        )
          return;
        const row = db
          .prepare("SELECT * FROM reservations WHERE id=?")
          .get(ctx.id) as any;
        if (!row || row.status !== "reserved") return;
        if (
          !ctx.state.get("ai.executionStarted") ||
          ctx.state.get("ai.executionRejected")
        ) {
          db.prepare(
            "UPDATE reservations SET status='released',note=? WHERE id=?",
          ).run(
            ctx.state.get("ai.executionRejected")
              ? "Upstream rejected before generation"
              : null,
            ctx.id,
          );
          return;
        }
        const state = observation(ctx);
        const receipt = settleRequest(db, post, row, {
          usage: state?.usage,
          webSearchCalls: state?.routing?.webSearchCalls,
          ...(state?.errorCode === "upstream_budget_exceeded"
            ? {
                reservedReason:
                  "Output limit exceeded; charged reserved amount",
              }
            : {}),
        });
        ctx.state.set("billing.receipt", receipt);
      },
    });
    host.api({
      method: "GET",
      path: "/wallet",
      access: "authenticated",
      handle: (_r, ctx) => json(wallet(ctx.principal!.id)),
    });
    host.api({
      method: "GET",
      path: "/ledger",
      access: "authenticated",
      handle: (_r, ctx) =>
        json(
          db
            .prepare(
              "SELECT l.amount,l.source,l.created_at,r.receipt FROM ledger l LEFT JOIN reservations r ON l.source='request:'||r.id WHERE l.user_id=? ORDER BY l.id DESC LIMIT 100",
            )
            .all(ctx.principal!.id),
        ),
    });
    host.api({
      method: "POST",
      path: "/adjust",
      access: "host.manage",
      handle: async (r, ctx) => {
        await requireAdmin(host, r, ctx);
        const b = await readObject(r);
        const reason = requiredString(b.reason, "reason");
        const userId = requiredString(b.userId, "userId");
        if (
          host.hasCapability("users.lookup@1") &&
          !(await host.call("users.lookup@1", { id: userId }))
        )
          throw new HostError("not_found", "用户不存在", 404);
        adminTarget(ctx, userId, b.id, reason);
        const source =
          "adjust:" + requiredString(b.id, "id") + ":" + ctx.principal!.id;
        integer(Math.abs(b.amount), "amount", 1);
        transaction(db, () => {
          post(requiredString(b.userId, "userId"), b.amount, source);
          db.prepare("INSERT OR IGNORE INTO adjustments VALUES(?,?,?)").run(
            source,
            ctx.principal!.id,
            reason,
          );
        });
        return json({ ok: true });
      },
    });
  },
});
