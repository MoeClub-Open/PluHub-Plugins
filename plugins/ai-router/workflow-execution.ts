import { routingContext, workflowCallers } from "./request-context.js";
import { HostError, json, type Host } from "@pluhub/sdk";
import type { AIEvent, AIPlan, AIRequest, Protocol } from "@pluhub/contracts/ai";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import { createWorkflowDataGraph } from "../../lib/ai/workflow-data.js";
import { runWorkflowPath } from "../../lib/ai/workflow-path.js";
import { collect, decodeResult, encodeRequest, encodeResult } from "../../lib/ai/protocols.js";
import { encodeStream } from "../../lib/ai/streams.js";
import { observation, observeEvents, planObservation } from "../../lib/ai/telemetry.js";
import { decodeUsage } from "../../lib/ai/usage.js";
import { resolveRoute } from "./resolution.js";

type LLMNode = Extract<WorkflowNode, { type: "llm" }>;
type JevNode = Extract<WorkflowNode, { type: "jev" }>;

function requestHeaders(groupId?: string, channelId?: string): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (groupId) headers.set("x-pluhub-group", groupId);
  if (channelId) headers.set("x-pluhub-channel", channelId);
  return headers;
}

async function childJson(response: Response): Promise<any> {
  const body = await response.json().catch(() => undefined);
  if (!response.ok) {
    const error = body?.error;
    throw new HostError(
      typeof error?.code === "string" ? error.code : "workflow_child_failed",
      typeof error?.message === "string" ? error.message : "流程内部请求失败",
      response.status,
    );
  }
  if (!body || typeof body !== "object")
    throw new HostError("upstream_protocol", "流程内部请求返回无效响应", 502);
  return body;
}

function llmTask(node: LLMNode, input: AIRequest): AIRequest {
  const messages = node.promptMode === "replace"
    ? [{ role: "user" as const, text: node.prompt ?? "" }]
    : structuredClone(node.messages ?? input.messages);
  if (node.promptMode === "append" && node.prompt)
    messages.push({ role: "user", text: node.prompt });
  if (node.system) messages.unshift({ role: "system", text: node.system });
  return {
    model: node.model,
    messages,
    tools: [],
    stream: false,
    ...(node.maxTokens !== undefined ? { maxTokens: node.maxTokens } : {}),
  };
}

/** Execute a deferred graph under the already admitted outer request. */
export function installWorkflowExecution(host: Host) {
  host.provide("ai.workflow-execution@1", async (_input, signal): Promise<Response> => {
    const ctx = routingContext(host);
    const request = ctx.state.get("ai.request") as AIRequest;
    const plan = ctx.state.get("ai.plan") as AIPlan;
    const protocol = observation(ctx)?.protocol as Protocol;
    const deferred = plan?.workflowDeferred;
    if (!ctx.state.get("workflow.ready") || !deferred || !ctx.principal ||
        deferred.input.principalId !== ctx.principal.id || !request ||
        !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(protocol))
      throw new HostError("invalid_workflow", "缺少已授权的流程计划", 400);
    ctx.state.delete("workflow.ready");
    const groupId = deferred.input.groupId;
    const reserved = new Set<string>();
    await host.call("ai.request-limits@1", { action: "workflow", context: ctx, policies: [] }, signal);
    const child = (path: string, body: unknown, nodeId: string, channelId?: string, options?: Omit<Parameters<Host["dispatchChild"]>[1], "nodeId">) => {
      ctx.state.set("ai.executionStarted", true);
      return host.dispatchChild(new Request(new URL(path, ctx.request.url), {
        method: "POST", headers: requestHeaders(groupId, channelId),
        body: JSON.stringify(body), signal,
      }), { ...options, nodeId });
    };
    const { plan: resolved } = await resolveRoute(
      host, deferred.input, signal, deferred.requestedModel,
      {
        runWorkflow: async (profile, flow, task, activeSignal, context) => {
          const graph = createWorkflowDataGraph({
            flow, request: task, context, signal: activeSignal,
            callLLM: async (rawNode, source) => {
              if (rawNode.type !== "llm") throw new HostError("invalid_workflow", "无效模型节点", 400);
              const node = rawNode as LLMNode;
              const targetProtocol = node.protocol ?? "openai-chat";
              const path = targetProtocol === "openai-responses" ? "/v1/responses"
                : targetProtocol === "anthropic" ? "/v1/messages" : "/v1/chat/completions";
              const task = llmTask(node, source);
              const body = await childJson(await child(path, encodeRequest(targetProtocol, task), node.id, node.channelId,
                context.personal ? undefined : { delegatedModel: node.model }));
              const result = decodeResult(targetProtocol, body, node.model);
              if (result.calls.length || result.refusal || result.reason !== "stop")
                throw new HostError("workflow_node_incomplete", "流程模型未返回完整文本", 502);
              const usage = decodeUsage(targetProtocol, body.usage);
              return { text: result.text, ...(usage ? { usage } : {}) };
            },
            callJev: async (rawNode) => {
              if (rawNode.type !== "jev") throw new HostError("invalid_workflow", "无效判断节点", 400);
              const node = rawNode as JevNode;
              const body = await childJson(await child("/internal/workflow/jev", {
                model: node.model, state: node.state, questions: node.questions,
                ...(node.assets ? { assets: node.assets } : {}),
              }, node.id, node.channelId, context.personal ? undefined : { delegatedModel: node.model }));
              const answers = body.answers as Record<string, unknown>;
              const answer = answers?.[node.answerKey ?? Object.keys(answers ?? {})[0]!] as any;
              return { answers, ...(typeof answer?.choice === "string" ? { choice: answer.choice } : {}),
                ...(typeof answer?.confidence === "number" ? { confidence: answer.confidence } : {}),
                ...(typeof answer?.score === "number" ? { score: answer.score } : {}),
                ...(typeof answer?.noul === "number" ? { noul: answer.noul } : {}),
                ...(answer?.box && typeof answer.box === "object" ? { box: answer.box } : {}) };
            },
          });
          return runWorkflowPath(profile, flow, task, graph, activeSignal, context, async (policy) => {
            await host.call("ai.request-limits@1", { action: "workflow", context: ctx, policies: [policy] }, activeSignal);
            reserved.add(JSON.stringify([policy.channel, policy.node]));
          });
        },
      },
    );
    // The outer request remains an unbilled coordinator; child requests own usage.
    Object.assign(plan, {
      requestLimits: resolved.requestLimits, outputPolicy: resolved.outputPolicy,
      workflows: resolved.workflows,
    });
    planObservation(ctx, request, { ...resolved, pricing: undefined });
    ctx.state.set("ai.executionStarted", true);
    if (resolved.workflowResponse) {
      const text = resolved.workflowResponse.text;
      const remaining = resolved.requestLimits?.filter((policy) => !reserved.has(JSON.stringify([policy.channel, policy.node]))) ?? [];
      if (remaining.length)
        await host.call("ai.request-limits@1", { action: "workflow", context: ctx, policies: remaining }, signal);
      async function* content(): AsyncGenerator<AIEvent> {
        yield { type: "text", text };
        yield { type: "finish", reason: "stop" };
      }
      let events: AsyncIterable<AIEvent> = content();
      if (host.hasCapability("ai.output-pace@2"))
        events = await host.call("ai.output-pace@2", { events, plan: resolved, request }, signal);
      const observed = observeEvents(events, ctx);
      const model = resolved.responseModel ?? request.model;
      if (!request.stream) {
        const body = encodeResult(protocol, await collect(observed, model));
        delete body.usage;
        delete body.usageMetadata;
        return json(body);
      }
      return new Response(encodeStream(protocol, observed, model, ctx.signal), {
        headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache", "x-accel-buffering": "no" },
      });
    }
    const prepared = { ...(resolved.preparedRequest ?? request), model: request.model };
    const terminal = resolved.workflows?.at(-1)?.nodes.at(-1) ?? "provider";
    const childPlan = {
      ...resolved,
      workflowParentChannel: plan.upstreamId,
      requestLimits: resolved.requestLimits?.filter((policy) => !reserved.has(JSON.stringify([policy.channel, policy.node]))),
    };
    return child("/internal/workflow/provider", { request: prepared, protocol }, terminal, undefined, {
      plan: childPlan,
      onComplete: (outcome) => {
        const result = outcome.result as { finished?: boolean; errorCode?: string } | undefined;
        const state = observation(ctx);
        if (!state) return;
        state.finished = result?.finished === true;
        if (outcome.cancelled) ctx.state.set("http.cancelled", true);
        if (result?.errorCode || outcome.errorCode || outcome.status >= 400)
          state.errorCode = result?.errorCode ?? outcome.errorCode ?? "workflow_child_failed";
      },
    });
  }, { callers: workflowCallers });
}
