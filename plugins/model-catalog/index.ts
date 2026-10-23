import { definePlugin, json } from "@pluhub/sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import type { ModelMetrics } from "@pluhub/contracts/analytics";
import { catalogScope } from "../../lib/ai/catalog-scope.js";
export default definePlugin({
  setup(host) {
    async function withMetrics(models: CatalogModel[]) {
      const pairs = models.flatMap((m) =>
        m.channelId && !m.channelId.startsWith("personal:")
          ? [{ id: m.id, channelId: m.channelId }]
          : [],
      );
      const metrics: Record<string, ModelMetrics> =
        pairs.length && host.hasCapability("observability.model-metrics@1")
          ? await host
              .call<Record<string, ModelMetrics>>(
                "observability.model-metrics@1",
                { models: pairs },
              )
              .catch(() => ({}))
          : {};
      return models.map(({ channelId, ...model }) => ({
        ...model,
        metrics: metrics[model.id],
      }));
    }
    host.api({
      method: "GET",
      path: "/public",
      access: "public",
      async handle() {
        // Never use a visitor's channel selector or identity for this listing.
        const models = await host.call<CatalogModel[]>("ai.catalog@1");
        return Response.json(
          await withMetrics(models).then((models) =>
            models.map((model) => ({
              id: model.id,
              name: model.name,
              provider: model.provider,
              description: model.description,
              contextWindow: model.contextWindow,
              inputPrice: model.inputPrice,
              outputPrice: model.outputPrice,
              pricing: model.pricing,
              consumptionMultiplier: model.consumptionMultiplier,
              features: model.features,
              metrics: model.metrics,
            })),
          ),
          { headers: { "cache-control": "no-store" } },
        );
      },
    });
    host.api({
      method: "GET",
      path: "/models",
      access: "authenticated",
      async handle(request, ctx) {
        const models = await host.call<CatalogModel[]>(
          "ai.catalog@1",
          catalogScope(request, ctx),
        );
        const allowed = ctx.principal?.attributes?.models as
          string[] | undefined;
        return json(
          await withMetrics(
            models.filter((m) => !allowed?.length || allowed.includes(m.id)),
          ),
        );
      },
    });
  },
});
