import type { DatabaseSync } from "node:sqlite";
import type {
  ModelMetrics,
  ModelMetricsQuery,
} from "@pluhub/contracts/analytics";

export function readModelMetrics(
  db: DatabaseSync,
  query: ModelMetricsQuery,
  now = Date.now(),
): Record<string, ModelMetrics> {
  const from = now - 86400000;
  const models = query.models.filter(
    (m) => m.channelId && !m.channelId.startsWith("personal:"),
  );
  if (!models.length) return {};
  const rows = db
    .prepare(
      `
    WITH allowed AS (
      SELECT DISTINCT json_extract(value,'$.id') model,
        json_extract(value,'$.channelId') upstream FROM json_each(?)
    ), samples AS (
      SELECT r.*, json_extract(r.usage_json,'$.cacheRead') cached
      FROM requests r JOIN allowed a ON r.model=a.model AND r.upstream=a.upstream
      WHERE r.parent_request_id IS NULL AND r.created_at>=? AND r.created_at<=?
    )
    SELECT model, COUNT(*) requests, SUM(status='success') successes,
      AVG(CASE WHEN status='success' THEN latency_ms END) latency,
      AVG(CASE WHEN status='success' AND stream=1 THEN first_token_ms END) ttft,
      SUM(CASE WHEN status='success' AND latency_ms>0 AND output_tokens IS NOT NULL THEN output_tokens END)*1000.0 /
        SUM(CASE WHEN status='success' AND latency_ms>0 AND output_tokens IS NOT NULL THEN latency_ms END) tps,
      SUM(status='success' AND latency_ms>0 AND output_tokens IS NOT NULL) output_samples,
      AVG(CASE WHEN status='success' AND typeof(cached) IN ('integer','real') THEN cached>0 END) hit_rate,
      SUM(status='success' AND typeof(cached) IN ('integer','real')) cache_samples
    FROM samples GROUP BY model
  `,
    )
    .all(JSON.stringify(models), from, now) as Record<string, any>[];
  const result: Record<string, ModelMetrics> = {};
  for (const { id } of models)
    result[id] = {
      from,
      updatedAt: now,
      requests: 0,
      successes: 0,
      outputSamples: 0,
      cacheSamples: 0,
    };
  for (const row of rows)
    result[row.model] = {
      from,
      updatedAt: now,
      requests: row.requests,
      successes: row.successes,
      avgLatencyMs: row.latency ?? undefined,
      avgFirstTokenMs: row.ttft ?? undefined,
      outputTps: row.tps ?? undefined,
      outputSamples: row.output_samples ?? 0,
      cacheHitRate: row.hit_rate ?? undefined,
      cacheSamples: row.cache_samples,
    };
  return result;
}
