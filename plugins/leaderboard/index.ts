import { definePlugin, HostError, type RequestContext } from "@pluhub/sdk";
import { channelScope } from "../../lib/ai/channel-scope.js";
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
    async function visibleModels(ctx: RequestContext) {
      if (!host.hasCapability("ai.catalog@3")) return [];
      const models = await host.call<CatalogModel[]>("ai.catalog@3", {
        principalId: ctx.principal!.id,
        ...channelScope(ctx.principal),
      });
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      return models.filter(
        (model) =>
          !model.channelId?.startsWith("personal:") &&
          (!allowed?.length || allowed.includes(model.id)),
      );
    }
    host.api({
      method: "GET",
      path: "/prices",
      access: "authenticated",
      async handle(_request, ctx) {
        const models = await visibleModels(ctx);
        return Response.json(
          models.map((model) => ({
            id: model.id,
            name: model.name,
            provider: model.provider,
            inputPrice: model.inputPrice,
            outputPrice: model.outputPrice,
            pricing: model.pricing,
            billing: model.billing,
            consumptionMultiplier: model.consumptionMultiplier,
            channel: model.channel,
          })),
          { headers: { "cache-control": "private, no-store" } },
        );
      },
    });
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
        // Model visibility follows the viewer's platform catalog; BYOK stays private.
        const [users, models] = await Promise.all([
          host.call<PublicUserProfile[]>("users.directory@1", {}),
          kind === "models"
            ? visibleModels(ctx)
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
