import { definePlugin, HostError } from "@pluhub/sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import type {
  AggregateRanking,
  AggregateRankingRow,
  Leaderboard,
  LeaderboardRow,
  PublicUserProfile,
  RankingKind,
  RankingMetric,
  RankingRange,
} from "@pluhub/contracts/analytics";

export default definePlugin({
  setup(host) {
    host.api({
      method: "GET",
      path: "/rankings",
      access: "authenticated",
      async handle(request, ctx) {
        const params = new URL(request.url).searchParams;
        const kind = params.get("kind") ?? "users";
        const metric = params.get("metric") ?? "tokens";
        const range = params.get("range") ?? "7d";
        if (
          !["users", "models"].includes(kind) ||
          !["tokens", "requests"].includes(metric) ||
          !["7d", "30d", "all"].includes(range)
        )
          throw new HostError("invalid_request", "排行榜筛选无效");
        // Public rankings use the platform catalog, never a viewer's BYOK catalog.
        const [users, models] = await Promise.all([
          host.call<PublicUserProfile[]>("users.directory@1", {}),
          kind === "models"
            ? host.call<CatalogModel[]>("ai.catalog@2", {})
            : Promise.resolve([] as CatalogModel[]),
        ]);
        const names = new Map(users.map((user) => [user.id, user.name]));
        const catalog = new Map(models.map((model) => [model.id, model]));
        const aggregate = await host.call<AggregateRanking>(
          "observability.rankings@1",
          {
            kind,
            metric,
            range,
            userIds: users.map((user) => user.id),
            modelIds: models.map((model) => model.id),
            viewerId: ctx.principal!.id,
          },
        );
        const total =
          metric === "tokens"
            ? aggregate.totals.tokens
            : aggregate.totals.requests;
        const present = (row: AggregateRankingRow): LeaderboardRow => ({
          rank: row.rank,
          name:
            kind === "users"
              ? names.get(row.subjectId)!
              : catalog.get(row.subjectId)!.name,
          ...(kind === "models"
            ? {
                modelId: row.subjectId,
                provider: catalog.get(row.subjectId)!.provider,
              }
            : {}),
          requests: row.requests,
          tokens: row.tokens,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          usageRequests: row.usageRequests,
          isCurrentUser:
            kind === "users" && row.subjectId === ctx.principal!.id,
          share: total ? row[metric as RankingMetric] / total : 0,
        });
        const result: Leaderboard = {
          ...aggregate,
          kind: kind as RankingKind,
          metric: metric as RankingMetric,
          range: range as RankingRange,
          rows: aggregate.rows.map(present),
          me: aggregate.me ? present(aggregate.me) : undefined,
        };
        return Response.json(result, {
          headers: { "cache-control": "private, no-store" },
        });
      },
    });
  },
});
