import { expect, it } from "vitest";
import {
  readNodeModels,
  validateProviderModels,
} from "../plugins/ai-router/provider-models.js";
import { assignProviderModel } from "../plugins/ai-router/model-config.js";
import { planRoute } from "../plugins/ai-router/planning.js";
import { compileWorkflow } from "../lib/ai/channel-graph.js";
import { providerModel } from "../lib/ai/channel-config.js";

it("does not inherit another provider's offered models when assigning a target", () => {
  const config: any = {
    upstreams: {
      channel: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "agy" },
            {
              id: "agy",
              type: "provider",
              modelMap: { gemini: "gemini-high" },
            },
            { id: "codex", type: "provider", modelMap: {} },
          ],
        },
      },
    },
    models: {
      gemini: { upstream: "channel", model: "gemini" },
      gpt: { upstream: "channel", model: "gpt" },
    },
  };
  assignProviderModel(config, "channel", "codex", "gpt", "gpt-native");
  const nodes = config.upstreams.channel.flow.nodes;
  expect(nodes[1].modelMap).toEqual({ gemini: "gemini-high" });
  expect(nodes[2].modelMap).toEqual({ gpt: "gpt-native" });
  expect(() => providerModel(nodes[2], "gemini")).toThrow(/未提供/);
});

it("checks changed subscription targets against that node's catalog only", async () => {
  const previous: any = {
    upstreams: {
      channel: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "agy" },
            {
              id: "agy",
              type: "provider",
              upstream: {
                protocol: "antigravity",
                subscriptionAccountIds: ["a"],
              },
              modelMap: { gemini: "gemini-high" },
            },
          ],
        },
      },
    },
  };
  const config: any = structuredClone(previous);
  config.upstreams.channel.flow.nodes.push({
    id: "codex",
    type: "provider",
    upstream: { protocol: "codex", subscriptionAccountIds: ["b"] },
  });
  const calls: string[] = [];
  const host = {
    call: async (_: string, request: any) => {
      calls.push(request.provider);
      return [{ id: "gpt-native" }];
    },
  } as any;
  const signal = new AbortController().signal;
  await validateProviderModels(host, config, previous, signal);
  expect(config.upstreams.channel.flow.nodes[2].modelMap).toEqual({});
  expect(calls).toEqual([]);
  config.upstreams.channel.flow.nodes[2].modelMap = { gemini: "gemini-high" };
  await expect(
    validateProviderModels(host, config, previous, signal),
  ).rejects.toMatchObject({ code: "model_not_found" });
  expect(calls).toEqual(["codex"]);
  config.upstreams.channel.flow.nodes[2].modelMap = { gemini: "gpt-native" };
  await validateProviderModels(host, config, previous, signal);
  expect(calls).toEqual(["codex", "codex"]);
});

it("keeps same-name model directories scoped to the selected provider node", async () => {
  const calls: string[] = [];
  const config = {
    upstreams: {
      channel: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "a" },
            ...["a", "b"].map((id) => ({
              id,
              type: "provider",
              upstream: { protocol: "codex", subscriptionAccountIds: [id] },
            })),
          ],
        },
      },
    },
  };
  const host = {
    config: () => config,
    call: async (_capability: string, input: any) => {
      calls.push(input.id);
      return [
        { id: "same-model", contextLength: input.id === "a" ? 100000 : 20000 },
      ];
    },
  } as any;
  const signal = new AbortController().signal;
  await expect(
    readNodeModels(host, "channel", undefined, signal),
  ).rejects.toMatchObject({ code: "provider_required" });
  expect(calls).toEqual([]);
  expect(
    (await readNodeModels(host, "channel", "a", signal)).models[0],
  ).toMatchObject({ id: "same-model", contextLength: 100000 });
  expect(calls).toEqual(["a"]);
  expect(
    (await readNodeModels(host, "channel", "b", signal)).models[0],
  ).toMatchObject({ id: "same-model", contextLength: 20000 });
});

it("routes a provided model through each node's mapping while retaining its external price", async () => {
  const config: any = {
    upstreams: {
      channel: {
        flow: {
          entry: "start",
          nodes: [
            { id: "start", type: "start", next: "branch" },
            {
              id: "has-tools",
              type: "compare",
              valueType: "boolean",
              operator: "eq",
              left: false,
              right: true,
            },
            {
              id: "branch",
              type: "branch",
              condition: false,
              yes: "a",
              no: "b",
            },
            ...["a", "b"].map((id) => ({
              id,
              type: "provider",
              upstream: {
                protocol: "openai-chat",
                baseUrl: "https://" + id + ".example/v1",
              },
            })),
          ],
          bindings: [
            {
              source: "start",
              output: "hasTools",
              target: "has-tools",
              input: "left",
            },
            {
              source: "has-tools",
              output: "result",
              target: "branch",
              input: "condition",
            },
          ],
        },
      },
    },
    models: {
      route: {
        publicModel: "assistant",
        upstream: "channel",
        model: "channel-model",
        inputPrice: 1.5,
        outputPrice: 3,
      },
    },
  };
  assignProviderModel(config, "channel", "a", "channel-model", "native-a");
  assignProviderModel(config, "channel", "b", "channel-model", "native-b");
  compileWorkflow(config.upstreams.channel.flow);
  const host = {
    config: () => config,
    hasCapability: () => true,
    call: () => {
      throw Error("Unexpected upstream request");
    },
  } as any;
  const request = {
    model: "assistant",
    stream: false,
    messages: [{ role: "user" as const, text: "Hello" }],
    tools: [] as any[],
  };
  const input = {
    model: "assistant",
    request,
    features: ["text"] as const,
    ingressProtocol: "openai-chat" as const,
  };
  const signal = new AbortController().signal;
  const plain = await planRoute(host, input, signal);
  const tools = await planRoute(
    host,
    {
      ...input,
      request: {
        ...request,
        tools: [{ name: "lookup", parameters: { type: "object" } }],
      },
    },
    signal,
  );
  expect(plain.model).toBe("native-b");
  expect(tools.model).toBe("native-a");
  expect(plain.pricing).toMatchObject({ input: 1.5, output: 3 });
  expect(tools.pricing).toEqual(plain.pricing);
  expect(config.models.route).toMatchObject({
    publicModel: "assistant",
    inputPrice: 1.5,
    outputPrice: 3,
  });
  delete config.upstreams.channel.flow.nodes.find(
    (node: any) => node.id === "b",
  ).modelMap["channel-model"];
  await expect(planRoute(host, input, signal)).rejects.toMatchObject({
    code: "model_not_found",
  });
});
