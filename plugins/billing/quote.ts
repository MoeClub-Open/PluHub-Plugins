import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type { CatalogModel, RequestPricing } from "@pluhub/contracts/ai";
import { priceUsage } from "../../lib/commerce/pricing.js";
import { channelScope } from "../../lib/ai/channel-scope.js";
import { freezePricing } from "../../lib/commerce/expression.js";

export function installPriceQuote(host: Host) {
  host.api({
    method: "POST",
    path: "/quote",
    access: "authenticated",
    async handle(request, ctx) {
      const body = await readObject(request);
      const model = requiredString(body.model, "model");
      const selectedChannel = body.channelId
        ? requiredString(body.channelId, "channelId", 256)
        : undefined;
      const channels = channelScope(ctx.principal, selectedChannel);
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      if (allowed?.length && !allowed.includes(model))
        throw new HostError("forbidden", "Model is not allowed", 403);
      const models = await host.call<CatalogModel[]>("ai.catalog@2", {
        principalId: ctx.principal!.id,
        ...channels,
      });
      const selected = models.find((entry) => entry.id === model);
      if (
        !selected ||
        (!["request", "expression"].includes(
          selected.pricing?.mode ?? "tokens",
        ) &&
          (selected.inputPrice === undefined ||
            selected.outputPrice === undefined))
      )
        throw new HostError(
          "price_unavailable",
          "Model has no billing price",
          404,
        );
      const pricing: RequestPricing = selected.billing ?? {
        ...selected.pricing,
        input: selected.inputPrice ?? 0,
        output: selected.outputPrice ?? 0,
        multiplier: selected.consumptionMultiplier,
      };
      if (!body.usage || typeof body.usage !== "object")
        throw new HostError("invalid_usage", "Usage is required");
      const context = body.context ?? {};
      if (
        context.headers &&
        (typeof context.headers !== "object" || Array.isArray(context.headers))
      )
        throw new HostError("invalid_request", "Invalid billing headers");
      return json(
        priceUsage(
          body.usage,
          freezePricing(
            pricing,
            context.at ?? Date.now(),
            context.params,
            new Headers(context.headers),
          ),
        ),
      );
    },
  });
}
