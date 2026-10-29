import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readCatalog } from "../plugins/ai-router/catalog.js";
import { planRoute } from "../plugins/ai-router/planning.js";
import { channelScope } from "../lib/ai/channel-scope.js";
import { serviceGroupMigration } from "../plugins/auth/keys.js";
import { priceUsage } from "../lib/commerce/pricing.js";
import {
  attachCharges,
  consumptionSummary,
} from "../plugins/observability/charges.js";

const config = () => ({
  upstreams: {
    a: { protocol: "openai-chat", consumptionMultiplier: 2 },
    b: { protocol: "openai-chat" },
  },
  models: {
    m: { upstream: "a", model: "m", inputPrice: 1, outputPrice: 2 },
    other: { upstream: "b", model: "other", inputPrice: 9, outputPrice: 9 },
  },
  groups: {
    default: { name: "普通", channelIds: ["a"], multiplier: 1 },
    vip: {
      name: "专用",
      channelIds: ["a"],
      multiplier: 0.5,
      userIds: ["alice"],
    },
    off: { name: "停用", channelIds: ["b"], enabled: false },
  },
});
const host = (c: any = config()): any => ({
  config: () => c,
  hasCapability: () => true,
});
const signal = () => new AbortController().signal;
const request = (groupId?: string): any => ({
  model: "m",
  groupId,
  principalId: "alice",
  features: ["text"],
  request: { model: "m", messages: [], tools: [], stream: false },
});

it("keeps catalog, execution and frozen receipts on the same group price", async () => {
  const c = config();
  const catalog = await readCatalog(host(c), {
    principalId: "alice",
    groupId: "vip",
  });
  expect(catalog.map((m) => m.id)).toEqual(["m"]);
  const plan = await planRoute(host(c), request("vip"), signal());
  expect(plan.pricing).toEqual(catalog[0]!.billing);
  expect(
    priceUsage({ input: 1_000_000, output: 0 }, plan.pricing!).amount,
  ).toBe(1_000_000);
  c.groups.vip.multiplier = 3;
  expect(plan.pricing!.serviceGroup).toEqual({
    id: "vip",
    name: "专用",
    multiplier: 0.5,
  });
  expect(
    priceUsage({ input: 1_000_000, output: 0 }, plan.pricing!).amount,
  ).toBe(1_000_000);
});
it("fails closed for disabled, missing, restricted groups and out-of-group channels", async () => {
  for (const id of ["off", "missing", "toString"])
    await expect(
      readCatalog(host(), { groupId: id, principalId: "alice" }),
    ).rejects.toMatchObject({ code: "group_unavailable" });
  await expect(
    readCatalog(host(), { groupId: "vip", principalId: "bob" }),
  ).rejects.toMatchObject({ code: "group_unavailable" });
  await expect(
    readCatalog(host(), {
      groupId: "vip",
      principalId: "alice",
      channelId: "b",
    }),
  ).rejects.toMatchObject({ code: "channel_forbidden" });
  await expect(
    readCatalog(host(), {
      groupId: "vip",
      principalId: "alice",
      channelId: "personal:own",
    }),
  ).rejects.toMatchObject({ code: "channel_forbidden" });
  const c: any = config();
  c.upstreams.a.flow = {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["jump"] },
      { id: "jump", type: "upstream", target: "other", mode: "implicit" },
    ],
  };
  await expect(
    planRoute(host(c), request("vip"), signal()),
  ).rejects.toMatchObject({ code: "group_forbidden" });
});
it("preserves explicit legacy channel bindings and their price", async () => {
  const c = config();
  c.groups.default.multiplier = 9;
  const plan = await planRoute(
    host(c),
    { ...request(), channelIds: ["a"] },
    signal(),
  );
  expect(plan.pricing!.multiplier).toBe(2);
  expect(plan.pricing!.serviceGroup).toBeUndefined();
  expect(() =>
    channelScope(
      { attributes: { keyId: "key", groupId: "vip" } },
      undefined,
      "default",
    ),
  ).toThrow();
  expect(
    channelScope({ attributes: { keyId: "key", groupId: "vip" } }).groupId,
  ).toBe("vip");
});
it("migrates unbound keys to default while preserving personal and legacy bindings", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      `CREATE TABLE api_keys(id TEXT,channel_ids_json TEXT); INSERT INTO api_keys VALUES('plain','[]'),('legacy','["a"]'),('personal','["personal:one"]');`,
    );
    db.exec(serviceGroupMigration);
    expect(
      db
        .prepare("SELECT group_id FROM api_keys ORDER BY id")
        .all()
        .map((r) => r.group_id),
    ).toEqual([null, null, "default"]);
  } finally {
    db.close();
  }
});
it("distinguishes pre-routing failures from missing settlement without hiding real charges", async () => {
  const db = new DatabaseSync(":memory:");
  const row = {
    id: "early",
    user_id: "alice",
    consumption_source: null,
    billing_mode: null,
    status: "error",
    upstream: null,
    input_tokens: null,
    pricing_json: null,
  };
  try {
    db.exec(
      `CREATE TABLE requests(id TEXT,user_id TEXT,consumption_source TEXT,billing_mode TEXT,status TEXT,upstream TEXT,input_tokens INTEGER,output_tokens INTEGER,pricing_json TEXT,cost_micro_usd INTEGER); INSERT INTO requests(id,user_id,status) VALUES('early','alice','error');`,
    );
    const unavailable: any = { hasCapability: () => false };
    expect(
      (await attachCharges(unavailable, [row], signal()))[0],
    ).toMatchObject({
      billing_status: "not_started",
      charged_micro_usd: 0,
      consumption_source: "unrouted",
    });
    const summary = await consumptionSummary(
      unavailable,
      db,
      { sql: "1=1", params: [] },
      signal(),
    );
    expect(summary.wallet.unknownRequests).toBe(0);
    expect(summary.wallet.chargedUSD).toBe(0);
    const real: any = {
      hasCapability: () => true,
      call: async () => [
        { requestId: "early", status: "settled", charged: 123, held: 0 },
      ],
    };
    expect((await attachCharges(real, [row], signal()))[0]).toMatchObject({
      billing_status: "settled",
      charged_micro_usd: 123,
    });
    const actual: any = {
      hasCapability: () => true,
      call: async () => ({
        knownRequests: 1,
        pendingRequests: 0,
        charged: 123,
        held: 0,
      }),
    };
    const actualSummary = await consumptionSummary(
      actual,
      db,
      { sql: "1=1", params: [] },
      signal(),
    );
    expect(actualSummary.wallet).toMatchObject({
      chargedUSD: 0.000123,
      unknownRequests: 0,
    });
  } finally {
    db.close();
  }
});
