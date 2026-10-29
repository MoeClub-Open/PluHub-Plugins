import { attachRequestLabels } from "../plugins/observability/request-labels.js";
import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readModelMetrics } from "../plugins/observability/model-metrics.js";
import {
  beginObservation,
  observation,
  observeEvents,
} from "../lib/ai/telemetry.js";

it("scopes public metrics to exact platform pairs and computes weighted output / total-time speed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE requests(model TEXT,upstream TEXT,created_at INTEGER,status TEXT,
      latency_ms INTEGER,first_token_ms INTEGER,stream INTEGER,
      output_tokens INTEGER,usage_json TEXT,parent_request_id TEXT)`);
    const now = 100000000;
    const add = (
      channel: string,
      at: number,
      status: string,
      stream: number,
      ms: number | null,
      out: number,
      usage: any,
      parent: string | null = null,
    ) =>
      db
        .prepare("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?)")
        .run(
          "model",
          channel,
          at,
          status,
          ms ?? 3000,
          1000,
          stream,
          out,
          JSON.stringify(usage),
          parent,
        );
    add("2", now, "success", 1, 1000, 100, { cacheRead: 20, reasoning: 40 });
    add("2", now, "success", 1, 3000, 200, { cacheRead: 0 });
    add("2", now, "success", 0, null, 5000, {});
    add("2", now, "error", 1, 1, 999999, { cacheRead: 999 });
    add("personal:mine", now, "success", 1, 1, 999999, { cacheRead: 999 });
    add("3", now, "success", 1, 1, 999999, {});
    add("2", now - 86400001, "success", 1, 1, 999999, {});
    add("2", now + 1, "success", 1, 1, 999999, {});
    add("2", now, "success", 1, 1, 999999, { cacheRead: 999 }, "parent");
    const result = readModelMetrics(
      db,
      {
        models: [
          { id: "model", channelId: "2" },
          { id: "model", channelId: "2" },
          { id: "private", channelId: "personal:mine" },
          { id: "unused", channelId: "2" },
        ],
      },
      now,
    );
    expect(result.model).toMatchObject({
      requests: 4,
      successes: 3,

      avgFirstTokenMs: 1000,

      outputSamples: 3,
      cacheHitRate: 0.5,
      cacheSamples: 2,
    });
    expect(result.model.avgLatencyMs).toBeCloseTo(7000 / 3);
    expect(result.model.outputTps).toBeCloseTo(5300 / 7);
    expect(result.private).toBeUndefined();
    expect(result.unused).toMatchObject({
      requests: 0,
      cacheSamples: 0,
      outputSamples: 0,
    });
    expect(result.unused.cacheHitRate).toBeUndefined();
    expect(result.unused.outputTps).toBeUndefined();
  } finally {
    db.close();
  }
});

it("keeps missing cache accounting unknown", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE requests(model TEXT,upstream TEXT,created_at INTEGER,status TEXT,
      latency_ms INTEGER,first_token_ms INTEGER,stream INTEGER,
      output_tokens INTEGER,usage_json TEXT,parent_request_id TEXT);
      INSERT INTO requests VALUES('m','2',100000000,'success',2000,2000,0,10,'{"input":100,"output":10}',NULL);`);
    const result = readModelMetrics(
      db,
      { models: [{ id: "m", channelId: "2" }] },
      100000000,
    ).m;
    expect(result.cacheSamples).toBe(0);
    expect(result.cacheHitRate).toBeUndefined();
    expect(result.avgFirstTokenMs).toBeUndefined();
    expect(result.outputTps).toBe(5);
  } finally {
    db.close();
  }
});

it("keeps initial latency while request TPS includes initial wait and trailing usage", async () => {
  const ctx = { state: new Map() } as any;
  beginObservation(ctx, "openai-chat");
  Object.assign(observation(ctx)!, { stream: true, startedAt: 1000 });
  const original = Date.now;
  let now = 2000;
  Date.now = () => now;
  try {
    async function* events(): AsyncGenerator<any> {
      yield { type: "reasoning", text: "thinking" };
      now = 2200;
      yield { type: "text", text: "a" };
      now = 2500;
      yield { type: "text", text: "b" };
      now = 4000;
      yield { type: "usage", usage: { input: 100, output: 20 } };
      yield { type: "finish" };
    }
    for await (const _ of observeEvents(events(), ctx)) {
      /* consume */
    }
    const [row, cancelled, unknown] = await attachRequestLabels(
      { hasCapability: () => false } as any,
      [
        { output_tokens: 20, latency_ms: now - 1000 },
        { status: "cancelled", output_tokens: 10, latency_ms: 2000 },
        { output_tokens: null, latency_ms: 2000 },
      ],
      [],
      new AbortController().signal,
    );
    expect(row.output_tps).toBeCloseTo(20 / 3);
    expect(cancelled.output_tps).toBe(5);
    expect(unknown.output_tps).toBeNull();
    expect(observation(ctx)).toMatchObject({
      firstTokenMs: 1000,
      finished: true,
    });
  } finally {
    Date.now = original;
  }
});
