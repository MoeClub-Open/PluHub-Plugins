import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
} from "@pluhub/sdk";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { compileWorkflow, runWorkflow } from "../../lib/ai/channel-graph.js";

export default definePlugin({
  setup(host) {
    host.validateConfig((config) => {
      for (const flow of Object.values(
        config.flows ?? {},
      ) as ChannelWorkflow[]) {
        compileWorkflow(flow);
        if (
          flow.nodes.some((n) => n.type === "rateLimit") &&
          !host.hasCapability("ai.request-limits@1")
        )
          throw new HostError(
            "invalid_config",
            "请求限流节点需要安装请求限流插件",
          );
        if (
          flow.nodes.some((n) => n.type === "tps") &&
          !host.hasCapability("ai.output-pace@2")
        )
          throw new HostError(
            "invalid_config",
            "TPS nodes require Token Speed",
          );
      }
    });
    host.provide(
      "ai.workflow@1",
      ({ profile, request, ingressProtocol }, signal) => {
        const flow = (
          host.config().flows as Record<string, ChannelWorkflow> | undefined
        )?.[requiredString(profile, "profile")];
        if (!flow)
          throw new HostError(
            "workflow_not_found",
            "Channel workflow is not configured",
            404,
          );
        return runWorkflow(profile, flow, request, signal, { ingressProtocol });
      },
    );
    host.api({
      method: "POST",
      path: "/preview",
      access: "host.manage",
      handle: async (r, ctx) => {
        const body = await readObject(r);
        if (
          !body.request ||
          !Array.isArray(body.request.messages) ||
          !Array.isArray(body.request.tools)
        )
          throw new HostError(
            "invalid_request",
            "Provide a normalized AI request",
          );
        return json(await host.call("ai.workflow@1", body, ctx.signal));
      },
    });
  },
});
