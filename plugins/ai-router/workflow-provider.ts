import { HostError, readObject, type Host } from "@pluhub/sdk";
import type { AIPlan, AIRequest, Protocol } from "@pluhub/contracts/ai";
import { executeIngress } from "../../lib/ai/ingress-response.js";
import {
  beginObservation,
  observation,
  planObservation,
} from "../../lib/ai/telemetry.js";

const protocols: readonly Protocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];

/** Execute a routing plan selected by the parent workflow in its own pipeline.
 * The kernel only accepts this route from a trusted child dispatch, and only
 * the router can supply the plan; neither is read from the HTTP request.
 */
export function installWorkflowProvider(host: Host) {
  host.hook({
    id: "workflow-provider-result",
    phase: "Finalize",
    handle(ctx) {
      if (new URL(ctx.request.url).pathname !== "/internal/workflow/provider" || !ctx.parent)
        return;
      const state = observation(ctx);
      ctx.state.set("internal.result", {
        finished: state?.finished === true,
        ...(state?.errorCode ? { errorCode: state.errorCode } : {}),
      });
    },
  });
  host.route({
    internal: true, childCallers: [host.id],
    method: "POST",
    path: "/internal/workflow/provider",
    access: "authenticated",
    prepare: async (request, ctx) => {
      beginObservation(ctx, "workflow");
      const parent = ctx.parent;
      const plan = ctx.state.get("internal.plan") as AIPlan | undefined;
      if (!parent || !ctx.principal || !plan)
        throw new HostError("forbidden", "Internal workflow plan required", 403);

      const input = await readObject<{
        request: AIRequest;
        protocol: Protocol;
      }>(request, 16 * 1024 * 1024);
      const task = input.request;
      if (
        !protocols.includes(input.protocol) ||
        !task ||
        typeof task.model !== "string" ||
        !task.model ||
        !Array.isArray(task.messages) ||
        !Array.isArray(task.tools) ||
        typeof task.stream !== "boolean" ||
        task.operation ||
        typeof plan.capability !== "string" ||
        !plan.capability.startsWith("ai.upstream.") ||
        !plan.upstream ||
        typeof plan.model !== "string" ||
        !plan.model
      )
        throw new HostError("invalid_request", "Invalid workflow provider request");

      const allowed = ctx.principal.attributes?.models as string[] | undefined;
      if (allowed?.length && !allowed.includes(task.model))
        throw new HostError("model_forbidden", "API key cannot access this model", 403);

      observation(ctx)!.protocol = input.protocol;
      const prepared = plan.preparedRequest
        ? { ...plan.preparedRequest, model: task.model }
        : task;
      ctx.state.set("ai.request", prepared);
      ctx.state.set("ai.plan", plan);
      ctx.state.set("workflow.provider.protocol", input.protocol);
      planObservation(ctx, prepared, plan);
    },
    handle: async (_request, ctx) => {
      const task = ctx.state.get("ai.request") as AIRequest;
      const plan = ctx.state.get("ai.plan") as AIPlan;
      const protocol = ctx.state.get("workflow.provider.protocol") as Protocol;
      return executeIngress(host, ctx, task, plan, protocol);
    },
  });
}
