import { describe, expect, it } from "vitest";
import type { AIRequest } from "@pluhub/contracts/ai";
import type { ChannelWorkflow } from "@pluhub/contracts/workflow";
import { runWorkflow } from "../lib/ai/channel-graph.js";
import { resolveWorkflowBindings } from "../lib/ai/workflow-bindings.js";

const request: AIRequest = {
  model: "example",
  stream: false,
  tools: [],
  messages: [
    { role: "user", text: "first" },
    { role: "assistant", text: "answer" },
    { role: "user", text: "latest" },
  ],
};

describe("workflow request data", () => {
  it("uses the latest user text when connected directly to a prompt", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["prompt"] },
        { id: "prompt", type: "prompt", text: "default", next: "provider" },
        { id: "provider", type: "provider" },
      ],
      bindings: [{ source: "start", output: "text", target: "prompt", input: "text" }],
    };
    const result = runWorkflow("channel", flow, request, new AbortController().signal);
    expect(result.request.messages[0]).toEqual({ role: "system", text: "latest" });
  });

  it("copies the complete messages for a connected input", () => {
    const flow: ChannelWorkflow = {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["provider"] },
        { id: "provider", type: "provider" },
        { id: "model", type: "llm", model: "example", promptMode: "append" },
      ],
      bindings: [{ source: "start", output: "messages", target: "model", input: "messages" }],
    };
    const resolved = resolveWorkflowBindings(flow, {}, request, undefined, "model");
    const model = resolved.nodes.find((node) => node.id === "model");
    expect(model?.type === "llm" && model.messages).toEqual(request.messages);
    expect(model?.type === "llm" && model.messages).not.toBe(request.messages);
  });
});
