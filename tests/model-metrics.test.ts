import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { readModelMetrics } from "../plugins/observability/model-metrics.js";
import {
  beginObservation,
  observation,
  observeEvents,
} from "../lib/ai/telemetry.js";

it("scopes public metrics to exact platform pairs and computes weighted streaming speed", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`CREATE TABLE requests(model TEXT,upstream TEXT,created_at INTEGER,status TEXT,
      latency_ms INTEGER,first_token_ms INTEGER,stream INTEGER,generation_ms INTEGER,
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
        .prepare("INSERT INTO requests VALUES(?,?,?,?,?,?,?,?,?,?,?)")
        .run(
          "model",
          channel,
          at,
          status,
          3000,
          1000,
          stream,
          ms,
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
      avgLatencyMs: 3000,
      avgFirstTokenMs: 1000,
      outputTps: 65,
      streamSamples: 2,
      cacheHitRate: 0.5,
      cacheSamples: 2,
    });
    expect(result.private).toBeUndefined();
    expect(result.unused).toMatchObject({
      requests: 0,
      cacheSamples: 0,
      streamSamples: 0,
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
      latency_ms INTEGER,first_token_ms INTEGER,stream INTEGER,generation_ms INTEGER,
      output_tokens INTEGER,usage_json TEXT,parent_request_id TEXT);
      INSERT INTO requests VALUES('m','2',100000000,'success',2000,2000,0,NULL,10,'{"input":100,"output":10}',NULL);`);
    const result = readModelMetrics(
      db,
      { models: [{ id: "m", channelId: "2" }] },
      100000000,
    ).m;
    expect(result.cacheSamples).toBe(0);
    expect(result.cacheHitRate).toBeUndefined();
    expect(result.avgFirstTokenMs).toBeUndefined();
    expect(result.outputTps).toBeUndefined();
  } finally {
    db.close();
  }
});

it("measures streamed content generation separately from initial latency and trailing usage", async () => {
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
    expect(observation(ctx)).toMatchObject({
      firstTokenMs: 1000,
      generationMs: 300,
      finished: true,
    });
  } finally {
    Date.now = original;
  }
});
