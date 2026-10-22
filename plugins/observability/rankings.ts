import type { DatabaseSync } from "node:sqlite";
import type {
  AggregateRanking,
  AggregateRankingRow,
  RankingQuery,
  RankingTotals,
} from "@pluhub/contracts/analytics";
import { HostError } from "@pluhub/sdk";

const dayMs = 86400000;

/** Backfill retained history exactly once, before the next retention prune. */
export const rankingMigration = `
  CREATE TABLE ranking_daily (
    day INTEGER NOT NULL, user_id TEXT NOT NULL, model TEXT NOT NULL,
    requests INTEGER NOT NULL, input_tokens INTEGER NOT NULL,
    output_tokens INTEGER NOT NULL, usage_requests INTEGER NOT NULL,
    PRIMARY KEY(day,user_id,model)
  );
  CREATE INDEX ranking_user_day ON ranking_daily(user_id,day);
  CREATE TABLE ranking_metadata (coverage_since INTEGER NOT NULL);
  INSERT INTO ranking_metadata SELECT COALESCE(MIN(created_at),CAST(unixepoch('subsec')*1000 AS INTEGER)) FROM requests;
  INSERT INTO ranking_daily
    SELECT CAST(created_at/${dayMs} AS INTEGER),user_id,model,COUNT(*),
      SUM(COALESCE(input_tokens,0)),SUM(COALESCE(output_tokens,0)),COUNT(input_tokens)
    FROM requests
    WHERE status='success' AND user_id IS NOT NULL AND model<>''
      AND upstream IS NOT NULL AND upstream NOT LIKE 'personal:%'
    GROUP BY 1,2,3;
`;

export function recordRanking(
  db: DatabaseSync,
  record: {
    at: number;
    userId?: string;
    model?: string;
    upstream?: string;
    status: string;
    input?: number;
    output?: number;
  },
) {
  if (
    record.status !== "success" ||
    !record.userId ||
    !record.model ||
    !record.upstream ||
    record.upstream.startsWith("personal:")
  )
    return;
  db.prepare(
    `INSERT INTO ranking_daily VALUES(?,?,?,?,?,?,?)
     ON CONFLICT(day,user_id,model) DO UPDATE SET
       requests=requests+1,input_tokens=input_tokens+excluded.input_tokens,
       output_tokens=output_tokens+excluded.output_tokens,
       usage_requests=usage_requests+excluded.usage_requests`,
  ).run(
    Math.floor(record.at / dayMs),
    record.userId,
    record.model,
    1,
    record.input ?? 0,
    record.output ?? 0,
    record.input === undefined ? 0 : 1,
  );
}

export function readRankings(
  db: DatabaseSync,
  input: RankingQuery,
  now = Date.now(),
): AggregateRanking {
  if (
    !["users", "models"].includes(input.kind) ||
    !["tokens", "requests"].includes(input.metric) ||
    !["7d", "30d", "all"].includes(input.range) ||
    !Array.isArray(input.userIds) ||
    !input.userIds.every((id) => typeof id === "string") ||
    (input.kind === "models" &&
      (!Array.isArray(input.modelIds) ||
        !input.modelIds.every((id) => typeof id === "string")))
  )
    throw new HostError("invalid_request", "Invalid leaderboard query");
  const coverageSince = Number(
    (db.prepare("SELECT coverage_since FROM ranking_metadata").get() as any)
      .coverage_since,
  );
  const startDay =
    input.range === "all"
      ? 0
      : Math.floor(now / dayMs) - (input.range === "7d" ? 6 : 29);
  const column = input.kind === "users" ? "user_id" : "model";
  const params: (number | string)[] = [
    startDay,
    Math.floor(now / dayMs),
    JSON.stringify(input.userIds),
  ];
  let scope =
    "day>=? AND day<=? AND user_id IN (SELECT value FROM json_each(?))";
  if (input.kind === "models") {
    scope += " AND model IN (SELECT value FROM json_each(?))";
    params.push(JSON.stringify(input.modelIds));
  }
  const grouped = `SELECT ${column} subjectId,SUM(requests) requests,
    SUM(input_tokens) inputTokens,SUM(output_tokens) outputTokens,
    SUM(input_tokens+output_tokens) tokens,SUM(usage_requests) usageRequests
    FROM ranking_daily WHERE ${scope} GROUP BY ${column}`;
  const ranked = `WITH totals AS (${grouped}),ranked AS
    (SELECT *,RANK() OVER (ORDER BY ${input.metric} DESC) rank FROM totals)`;
  const rows = db
    .prepare(
      `${ranked} SELECT * FROM ranked ORDER BY ${input.metric} DESC,requests DESC,subjectId ASC LIMIT 50`,
    )
    .all(...params) as unknown as AggregateRankingRow[];
  const me =
    input.kind === "users" && input.viewerId
      ? (db
          .prepare(`${ranked} SELECT * FROM ranked WHERE subjectId=?`)
          .get(...params, input.viewerId) as AggregateRankingRow | undefined)
      : undefined;
  const totals = db
    .prepare(
      `WITH totals AS (${grouped}) SELECT COUNT(*) participants,
       COALESCE(SUM(requests),0) requests,COALESCE(SUM(inputTokens),0) inputTokens,
       COALESCE(SUM(outputTokens),0) outputTokens,COALESCE(SUM(tokens),0) tokens,
       COALESCE(SUM(usageRequests),0) usageRequests FROM totals`,
    )
    .get(...params) as unknown as RankingTotals;
  return {
    rows,
    ...(me ? { me } : {}),
    totals,
    coverageSince,
    from: Math.max(coverageSince, startDay * dayMs),
    updatedAt: now,
    limit: 50,
  };
}
