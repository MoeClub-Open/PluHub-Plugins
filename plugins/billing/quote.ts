import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type { CatalogModel, RequestPricing } from "@pluhub/contracts/ai";
import { priceUsage } from "../../lib/commerce/pricing.js";

export function installPriceQuote(host: Host) {
  host.api({
    method: "POST",
    path: "/quote",
    access: "authenticated",
    async handle(request, ctx) {
      const body = await readObject(request);
      const model = requiredString(body.model, "model");
      const bound = ctx.principal?.attributes?.channelId as string | undefined;
      const selectedChannel = body.channelId
        ? requiredString(body.channelId, "channelId", 256)
        : undefined;
      if (bound && selectedChannel && bound !== selectedChannel)
        throw new HostError("channel_forbidden", "不能覆盖密钥的渠道绑定", 403);
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      if (allowed?.length && !allowed.includes(model))
        throw new HostError("forbidden", "Model is not allowed", 403);
      const models = await host.call<CatalogModel[]>("ai.catalog@1", {
        principalId: ctx.principal!.id,
        channelId: bound ?? selectedChannel,
      });
      const selected = models.find((entry) => entry.id === model);
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
      };
      if (!body.usage || typeof body.usage !== "object")
        throw new HostError("invalid_usage", "Usage is required");
      return json(priceUsage(body.usage, pricing));
    },
  });
}
