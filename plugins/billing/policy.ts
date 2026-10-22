import type { DatabaseSync } from "node:sqlite";
import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type { CatalogModel, RequestPricing } from "@pluhub/contracts/ai";
import { requireAdmin, adminTarget } from "../../lib/admin/access.js";
import { priceUsage, validRate } from "../../lib/commerce/pricing.js";

export type BillingGroup = { name: string; multiplier: number };
export const billingGroups = (
  config: Record<string, any>,
): Record<string, BillingGroup> => ({
  default: { name: "Default", multiplier: 1 },
  ...config.groups,
});
export function installPricingPolicy(host: Host, db: DatabaseSync) {
  const policy = (userId: string) => {
    const row = db
      .prepare(
        "SELECT group_id,user_multiplier FROM pricing_users WHERE user_id=?",
      )
      .get(userId) as any;
    const group = row?.group_id ?? "default";
    const selected = billingGroups(host.config())[group];
    if (!selected)
      throw new HostError(
        "billing_group_unavailable",
        "Billing group is unavailable",
        503,
      );
    return {
      group,
      groupName: selected.name,
      groupMultiplier: selected.multiplier,
      userMultiplier: row?.user_multiplier ?? 1,
    };
  };
  host.validateConfig((config) => {
    const groups = billingGroups(config);
    for (const [id, group] of Object.entries(groups)) {
      if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(id) || !group?.name?.trim())
        throw new HostError("invalid_config", "Invalid billing group");
      validRate(group.multiplier, "group multiplier", 1000);
    }
    for (const row of db
      .prepare("SELECT DISTINCT group_id FROM pricing_users")
      .all() as any[])
      if (!Object.hasOwn(groups, row.group_id))
        throw new HostError(
          "billing_group_in_use",
          "Billing group is still assigned: " + row.group_id,
          409,
        );
  });
  host.api({
    method: "GET",
    path: "/pricing-policy",
    access: "authenticated",
    handle: (_r, ctx) => json(policy(ctx.principal!.id)),
  });
  host.api({
    method: "GET",
    path: "/admin/pricing-user",
    access: "host.manage",
    async handle(r, ctx) {
      await requireAdmin(host, r, ctx, false);
      return json({
        ...policy(
          requiredString(new URL(r.url).searchParams.get("userId"), "userId"),
        ),
        groups: billingGroups(host.config()),
      });
    },
  });
  host.api({
    method: "PUT",
    path: "/admin/pricing-user",
    access: "host.manage",
    async handle(r, ctx) {
      await requireAdmin(host, r, ctx);
      const body = await readObject(r);
      const userId = requiredString(body.userId, "userId");
      const group = requiredString(body.group, "group");
      const userMultiplier = validRate(
        body.userMultiplier,
        "user multiplier",
        1000,
      );
      const reason = requiredString(body.reason, "reason");
      if (!Object.hasOwn(billingGroups(host.config()), group))
        throw new HostError("invalid_group", "Unknown billing group");
      if (
        host.hasCapability("users.lookup@1") &&
        !(await host.call("users.lookup@1", { id: userId }))
      )
        throw new HostError("not_found", "用户不存在", 404);
      db.prepare(
        "INSERT INTO pricing_users VALUES(?,?,?) ON CONFLICT(user_id) DO UPDATE SET group_id=excluded.group_id,user_multiplier=excluded.user_multiplier",
      ).run(userId, group, userMultiplier);
      adminTarget(ctx, userId, undefined, reason);
      return json(policy(userId));
    },
  });
  host.api({
    method: "POST",
    path: "/quote",
    access: "authenticated",
    async handle(r, ctx) {
      const body = await readObject(r);
      const model = requiredString(body.model, "model");
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      if (allowed?.length && !allowed.includes(model))
        throw new HostError("forbidden", "Model is not allowed", 403);
      const models = await host.call<CatalogModel[]>("ai.catalog@1");
      const selected = models.find((m) => m.id === model);
      if (
        !selected ||
        (selected.pricing?.mode !== "request" &&
          (selected.inputPrice === undefined ||
            selected.outputPrice === undefined))
      )
        throw new HostError(
          "price_unavailable",
          "Model has no billing price",
          404,
        );
      const pricing: RequestPricing = {
        ...selected.pricing,
        input: selected.inputPrice ?? 0,
        output: selected.outputPrice ?? 0,
        multiplier: selected.consumptionMultiplier,
        ...policy(ctx.principal!.id),
      };
      if (!body.usage || typeof body.usage !== "object")
        throw new HostError("invalid_usage", "Usage is required");
      return json(priceUsage(body.usage, pricing));
    },
  });
  return policy;
}
