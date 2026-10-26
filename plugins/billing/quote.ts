import {
  HostError,
  json,
  readObject,
  requiredString,
  type Host,
} from "@pluhub/sdk";
import type { AIPlan, CatalogModel } from "@pluhub/contracts/ai";
import { decode } from "../../lib/ai/protocols.js";
import { readMedia } from "../../lib/ai/media.js";
import { priceUsage } from "../../lib/commerce/pricing.js";
import { channelScope } from "../../lib/ai/channel-scope.js";
import { capturePricingContext } from "../../lib/commerce/expression.js";

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
      const channels = channelScope(
        ctx.principal,
        selectedChannel,
        body.groupId ? requiredString(body.groupId, "groupId") : undefined,
      );
      const allowed = ctx.principal?.attributes?.models as string[] | undefined;
      if (allowed?.length && !allowed.includes(model))
        throw new HostError("forbidden", "Model is not allowed", 403);
      const models = await host.call<CatalogModel[]>("ai.catalog@2", {
        principalId: ctx.principal!.id,
        ...channels,
      });
      const candidates = models.filter((entry) => entry.id === model);
      if (!selectedChannel && candidates.length > 1)
        throw new HostError(
          "price_ambiguous",
          "同名模型存在多个路由，请选择渠道后试算",
          409,
        );
      const selected = candidates[0];
      if (!selected)
        throw new HostError("model_not_found", "当前使用范围内没有此模型", 404);
      if (!body.usage || typeof body.usage !== "object")
        throw new HostError("invalid_usage", "Usage is required");
      const context = body.context ?? {};
      const operation = body.operation ?? selected.operations?.[0] ?? "chat";
      if (!(selected.operations ?? ["chat"]).includes(operation))
        throw new HostError(
          "operation_not_supported",
          "Model does not support this endpoint",
          400,
        );
      const quoteRequest = body.request
        ? operation === "chat"
          ? decode("openai-chat", { ...body.request, model })
          : await readMedia(
              new Request("http://localhost/quote", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ ...body.request, model }),
              }),
              operation,
            )
        : undefined;
      if (
        context.headers &&
        (typeof context.headers !== "object" || Array.isArray(context.headers))
      )
        throw new HostError("invalid_request", "Invalid billing headers");
      const plan = await host.call<AIPlan>(
        "ai.routing@2",
        {
          purpose: "quote",
          operation,
          model: selected.routeId ?? selected.id,
          ...channels,
          channelId: selected.channelId,
          principalId: ctx.principal!.id,
          ingressProtocol: "openai-chat",
          features: ["text", "usage"],
          ...(quoteRequest ? { request: quoteRequest } : {}),
          pricingContext: capturePricingContext(
            context.params ?? body.request,
            new Headers(context.headers),
            context.at ?? Date.now(),
          ),
        },
        ctx.signal,
      );
      if (!plan.pricing)
        throw new HostError(
          "price_unavailable",
          "Model has no billing price",
          404,
        );
      return json(priceUsage(body.usage, plan.pricing));
    },
  });
}
