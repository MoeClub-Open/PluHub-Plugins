import { describe, expect, it, vi } from "vitest";
import type { AIRequest } from "@pluhub/contracts/ai";
import { createWorkflowDataGraph } from "../lib/ai/workflow-data.js";

const request: AIRequest = {
  model: "public",
  messages: [
    { role: "user", text: "first" },
    { role: "assistant", text: "reply" },
    { role: "user", text: "last $& question" },
  ],
  stream: false,
  tools: [],
};

function setup(
  nodes: any[],
  bindings: { source: string; output: string; target: string; input: string }[],
  callLLM = vi.fn(async (node: any) => ({ text: `answer:${node.id}` })),
  controller = new AbortController(),
) {
  const callJev = vi.fn(async () => ({ answers: {} }));
  const graph = createWorkflowDataGraph({
    flow: { nodes, bindings },
    request,
    signal: controller.signal,
    callLLM,
    callJev,
  });
  return { graph, callLLM, callJev, controller };
}

describe("workflow data execution", () => {
  it("evaluates on demand once per node and fans its output out to several inputs", async () => {
    const { graph, callLLM } = setup(
      [
        { id: "used", type: "llm", promptMode: "append", model: "one" },
        { id: "unused", type: "llm", promptMode: "append", model: "two" },
        { id: "combine", type: "template", template: "{{first}} / {{second}}", values: { first: "", second: "" } },
      ],
      [
        { source: "used", output: "text", target: "combine", input: "values.first" },
        { source: "used", output: "text", target: "combine", input: "values.second" },
      ],
    );
    expect(callLLM).not.toHaveBeenCalled();
    const [a, b] = await Promise.all([graph.get("combine", "text"), graph.get("used", "text")]);
    expect(a).toBe("answer:used / answer:used");
    expect(b).toBe("answer:used");
    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(callLLM.mock.calls[0]?.[0].id).toBe("used");
  });

  it("waits for all started parallel dependencies to finish before reporting a failure", async () => {
    let finishSlow!: () => void;
    const slow = new Promise<void>((resolve) => { finishSlow = resolve; });
    const ended: string[] = [];
    const call = vi.fn(async (node: any) => {
      if (node.id === "bad") throw new Error("bad upstream");
      await slow;
      ended.push("slow finished");
      return { text: "slow answer" };
    });
    const { graph } = setup(
      [
        { id: "bad", type: "llm", promptMode: "append", model: "a" },
        { id: "slow", type: "llm", promptMode: "append", model: "b" },
        { id: "combine", type: "template", template: "{{a}} {{b}}", values: { a: "", b: "" } },
      ],
      [
        { source: "bad", output: "text", target: "combine", input: "values.a" },
        { source: "slow", output: "text", target: "combine", input: "values.b" },
      ],
      call,
    );
    let settled = false;
    const result = graph.get("combine", "text").then(
      () => { settled = true; return undefined; },
      (error) => { settled = true; return error; },
    );
    await vi.waitFor(() => expect(call).toHaveBeenCalledTimes(2));
    expect(settled).toBe(false);
    finishSlow();
    expect((await result).message).toBe("bad upstream");
    expect(ended).toEqual(["slow finished"]);
  });

  it("short circuits boolean logic without calling the unused model", async () => {
    const { graph, callLLM } = setup(
      [
        { id: "llm", type: "llm", promptMode: "append", model: "expensive" },
        { id: "compare", type: "compare", valueType: "string", operator: "eq", left: "", right: "yes" },
        { id: "logic", type: "logic", operator: "and", left: false, right: true },
      ],
      [
        { source: "llm", output: "text", target: "compare", input: "left" },
        { source: "compare", output: "result", target: "logic", input: "right" },
      ],
    );
    expect(await graph.get("logic", "result")).toBe(false);
    expect(callLLM).not.toHaveBeenCalled();
  });

  it("rejects data cycles and duplicate inputs before starting model work", () => {
    const nodes = [
      { id: "a", type: "text", text: "a" },
      { id: "b", type: "text", text: "b" },
    ];
    const ab = { source: "a", output: "text", target: "b", input: "text" };
    const ba = { source: "b", output: "text", target: "a", input: "text" };
    expect(() => setup(nodes, [ab, ba])).toThrow(/循环/);
    expect(() => setup(nodes, [ab, ab])).toThrow(/一个数据来源/);
  });

  it("does not allow secrets to flow into a Jev JSON state", () => {
    expect(() => setup(
      [
        { id: "secret", type: "value", valueType: "secret", secretRef: "secret:KEY" },
        { id: "j", type: "jev", model: "decision", state: "task", questions: { route: {} } },
      ],
      [{ source: "secret", output: "value", target: "j", input: "state" }],
    )).toThrow(/类型/);
  });

  it("rejects unsafe template keys and never resolves inherited properties", async () => {
    const inherited = Object.assign(Object.create({ left: true }), {
      id: "logic", type: "logic", operator: "not",
    });
    const inheritedGraph = setup([inherited], []).graph;
    await expect(inheritedGraph.get("logic", "result")).rejects.toThrow(/布尔值/);

    const template = setup(
      [{ id: "template", type: "template", template: "{{toString}}", values: {} }], [],
    ).graph;
    await expect(template.get("template", "text")).rejects.toThrow(/缺少文本值/);

    for (const key of ["__proto__", "constructor", "prototype"]) {
      const values = JSON.parse(`{"${key}": ""}`);
      expect(() => setup(
        [
          { id: "source", type: "text", text: "bad" },
          { id: "template", type: "template", template: "", values },
        ],
        [{ source: "source", output: "text", target: "template", input: `values.${key}` }],
      )).toThrow();
    }
    expect(Object.hasOwn(Object.prototype, "__pluhubPolluted")).toBe(false);
  });

  it("rejects blank and overlong resolved upstream targets", async () => {
    for (const target of ["   ", "x".repeat(257)]) {
      const { graph } = setup(
        [
          { id: "source", type: "text", text: target },
          { id: "upstream", type: "upstream", target: "original", mode: "implicit" },
        ],
        [{ source: "source", output: "text", target: "upstream", input: "target" }],
      );
      await expect(graph.resolveNode("upstream")).rejects.toThrow(/目标模型/);
    }
  });

  it("enforces a dynamic target allowlist through intermediate nodes", async () => {
    const nodes = [
      { id: "start", type: "start" },
      { id: "copy", type: "text", text: "" },
      { id: "llm", type: "llm", promptMode: "append", model: "placeholder", allowedModels: ["safe"] },
    ];
    const bindings = [
      { source: "start", output: "requestedModel", target: "copy", input: "text" },
      { source: "copy", output: "text", target: "llm", input: "model" },
    ];
    const denied = setup(nodes, bindings);
    await expect(denied.graph.get("llm", "text")).rejects.toThrow(/允许列表/);
    expect(denied.callLLM).not.toHaveBeenCalled();
    nodes[2]!.allowedModels = ["public"];
    const allowed = setup(nodes, bindings);
    expect(await allowed.graph.get("llm", "text")).toBe("answer:llm");
    expect(allowed.callLLM.mock.calls[0]?.[0].model).toBe("public");
  });

  it("passes the last user text and preserves replacement text literally", async () => {
    const { graph } = setup(
      [
        { id: "start", type: "start" },
        { id: "template", type: "template", template: "Input: {{value}}", values: { value: "" } },
        { id: "replace", type: "replace", text: "", find: "$&", replacement: "$1", all: true },
      ],
      [
        { source: "start", output: "text", target: "template", input: "values.value" },
        { source: "template", output: "text", target: "replace", input: "text" },
      ],
    );
    expect(await graph.get("replace", "text")).toBe("Input: last $1 question");
    expect(await graph.get("start", "messages")).toEqual(request.messages);
    expect(await graph.get("start", "messages")).not.toBe(request.messages);
  });

  it("rejects a model result with the wrong type when resolving a response", async () => {
    const call = vi.fn(async () => ({ text: 42 as any }));
    const { graph } = setup(
      [
        { id: "llm", type: "llm", model: "a", promptMode: "append" },
        { id: "response", type: "response", text: "" },
      ],
      [{ source: "llm", output: "text", target: "response", input: "text" }],
      call,
    );
    await expect(graph.resolveNode("response")).rejects.toThrow();
    await expect(graph.get("llm", "text")).rejects.toThrow(/有效值/);
    expect(call).toHaveBeenCalledOnce();
  });

  it("rejects invalid Jev output types and preserves valid answers", async () => {
    const callJev = vi.fn(async () => ({
      answers: { route: { choice: "fast" } },
      choice: 123 as any,
      confidence: "high" as any,
    }));
    const graph = createWorkflowDataGraph({
      flow: { nodes: [{ id: "j", type: "jev", model: "decision", state: "task", questions: { route: {} } }], bindings: [] },
      request,
      signal: new AbortController().signal,
      callLLM: async () => ({ text: "unused" }),
      callJev,
    });
    expect(await graph.get("j", "answers")).toEqual({ route: { choice: "fast" } });
    await expect(graph.get("j", "choice")).rejects.toThrow(/有效值/);
    await expect(graph.get("j", "confidence")).rejects.toThrow(/有效值/);
    expect(callJev).toHaveBeenCalledOnce();
  });

  it("exposes Jev numeric and box outputs for formatting into a prompt", async () => {
    const callJev = vi.fn(async () => ({
      answers: { result: { score: 4.5, noul: 0.8, box: { left: 1, top: 2, right: 3, bottom: 4 } } },
      score: 4.5,
      noul: 0.8,
      box: { left: 1, top: 2, right: 3, bottom: 4 },
    }));
    const graph = createWorkflowDataGraph({
      flow: {
        nodes: [
          { id: "j", type: "jev", model: "decision", state: "task", questions: { result: {} } },
          { id: "score", type: "format", value: 0 },
          { id: "noul", type: "format", value: 0 },
          { id: "box", type: "format", value: {} },
          { id: "prompt", type: "template", template: "{{score}}/{{noul}}/{{box}}", values: { score: "", noul: "", box: "" } },
        ],
        bindings: [
          { source: "j", output: "score", target: "score", input: "value" },
          { source: "j", output: "noul", target: "noul", input: "value" },
          { source: "j", output: "box", target: "box", input: "value" },
          { source: "score", output: "text", target: "prompt", input: "values.score" },
          { source: "noul", output: "text", target: "prompt", input: "values.noul" },
          { source: "box", output: "text", target: "prompt", input: "values.box" },
        ],
      },
      request,
      signal: new AbortController().signal,
      callLLM: async () => ({ text: "unused" }),
      callJev,
    });
    expect(await graph.get("prompt", "text")).toBe('4.5/0.8/{"left":1,"top":2,"right":3,"bottom":4}');
    expect(callJev).toHaveBeenCalledOnce();
  });

  it("fails explicitly when the requested Jev output is absent", async () => {
    const callJev = vi.fn(async () => ({ answers: { result: { choice: "a" } }, choice: "a" }));
    const graph = createWorkflowDataGraph({
      flow: { nodes: [{ id: "j", type: "jev", model: "decision", state: "task", questions: { result: {} } }], bindings: [] },
      request,
      signal: new AbortController().signal,
      callLLM: async () => ({ text: "unused" }),
      callJev,
    });
    for (const output of ["score", "noul", "box", "confidence"])
      await expect(graph.get("j", output)).rejects.toThrow(/有效值/);
    expect(callJev).toHaveBeenCalledOnce();
  });

  it("rejects an answer key absent from questions before making the Jev request", async () => {
    const callJev = vi.fn(async () => ({ answers: {} }));
    const graph = createWorkflowDataGraph({
      flow: { nodes: [{ id: "j", type: "jev", model: "decision", state: "task", questions: { valid: {} }, answerKey: "missing" }], bindings: [] },
      request,
      signal: new AbortController().signal,
      callLLM: async () => ({ text: "unused" }),
      callJev,
    });
    await expect(graph.get("j", "answers")).rejects.toThrow(/答案 ID/);
    expect(callJev).not.toHaveBeenCalled();
  });

  it("passes cancellation to a running call and waits for its cleanup", async () => {
    const controller = new AbortController();
    let cleaned = false;
    const call = vi.fn(async (_node: any, _request: AIRequest, signal: AbortSignal) => {
      try {
        await new Promise<void>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
        return { text: "unexpected" };
      } finally {
        cleaned = true;
      }
    });
    const { graph } = setup([{ id: "llm", type: "llm", promptMode: "append", model: "a" }], [], call, controller);
    const result = graph.get("llm", "text").catch((error) => error);
    await vi.waitFor(() => expect(call).toHaveBeenCalledOnce());
    controller.abort(new Error("cancelled"));
    expect((await result).message).toBe("cancelled");
    expect(cleaned).toBe(true);
  });
});
