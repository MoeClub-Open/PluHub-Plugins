import { it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import {
  rankingMigration,
  readRankings,
  recordRanking,
} from "../plugins/observability/rankings.js";

it("uses equal ranks for ties, keeps a viewer outside the first 50, and never reads future day buckets", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE requests(created_at INTEGER,user_id TEXT,model TEXT,status TEXT,upstream TEXT,input_tokens INTEGER,output_tokens INTEGER)",
    );
    db.exec(rankingMigration);
    const now = Date.now();
    const userIds = Array.from({ length: 61 }, (_, index) => "user-" + index);
    userIds.forEach((userId, index) =>
      recordRanking(db, {
        at: now,
        userId,
        model: "public",
        upstream: "platform",
        status: "success",
        input: index < 2 ? 100 : 100 - index,
        output: 0,
      }),
    );
    recordRanking(db, {
      at: now + 86400000,
      userId: "user-60",
      model: "public",
      upstream: "platform",
      status: "success",
      input: 99999,
      output: 0,
    });
    const board = readRankings(
      db,
      {
        kind: "users",
        range: "7d",
        metric: "tokens",
        userIds,
        viewerId: "user-60",
      },
      now,
    );
    expect(board.rows).toHaveLength(50);
    expect(board.rows.slice(0, 3).map((row) => row.rank)).toEqual([1, 1, 3]);
    expect(board.me).toMatchObject({
      subjectId: "user-60",
      rank: 61,
      tokens: 40,
    });
    expect(board.totals.participants).toBe(61);
    expect(
      readRankings(
        db,
        { kind: "users", range: "7d", metric: "tokens", userIds: [] },
        now,
      ).rows,
    ).toEqual([]);
  } finally {
    db.close();
  }
});

it("includes the seventh UTC day, excludes the eighth, and counts missing usage only as a request", () => {
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(
      "CREATE TABLE requests(created_at INTEGER,user_id TEXT,model TEXT,status TEXT,upstream TEXT,input_tokens INTEGER,output_tokens INTEGER)",
    );
    db.exec(rankingMigration);
    const now = Date.now();
    for (const [age, tokens] of [
      [6, 10],
      [7, 100],
    ] as const)
      recordRanking(db, {
        at: now - age * 86400000,
        userId: "user",
        model: "model",
        upstream: "platform",
        status: "success",
        input: tokens,
        output: 1,
      });
    recordRanking(db, {
      at: now,
      userId: "user",
      model: "model",
      upstream: "platform",
      status: "success",
    });
    recordRanking(db, {
      at: now,
      userId: "user",
      model: "model",
      upstream: "platform",
      parentRequestId: "parent",
      status: "success",
      input: 9999,
      output: 9999,
    });
    const query = {
      kind: "models",
      metric: "tokens",
      userIds: ["user"],
      modelIds: ["model"],
    } as const;
    const result = readRankings(
      db,
      {
        ...query,
        userIds: [...query.userIds],
        modelIds: [...query.modelIds],
        range: "7d",
      },
      now,
    );
    expect(result.rows[0]).toMatchObject({
      requests: 2,
      tokens: 11,
      usageRequests: 1,
    });
    expect(
      readRankings(
        db,
        {
          ...query,
          userIds: [...query.userIds],
          modelIds: [...query.modelIds],
          range: "30d",
        },
        now,
      ).totals.tokens,
    ).toBe(112);
  } finally {
    db.close();
  }
});
