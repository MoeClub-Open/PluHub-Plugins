import { expect, it } from "vitest";
import { createWorkflowDataGraph } from "../lib/ai/workflow-data.js";
import { createWorkflowTemplate, workflowTemplates } from "../lib/ui/workflow-templates.js";
import { compileWorkflow } from "../lib/ai/channel-graph.js";

const request = {
  model: "public",
  messages: [{ role: "user" as const, text: "为什么？" }],
  tools: [],
  stream: false,
};

it("creates valid graphs for each preset when its choices are filled", () => {
  for (const template of workflowTemplates) {
    const models = Object.fromEntries(template.models.map(({ key }) => [key, `model-${key}`]));
    expect(() => compileWorkflow(createWorkflowTemplate(template.id, models, { find: "old", replacement: "new" }))).not.toThrow();
  }
});

it("routes using the chosen classifier without letting its output name the target", async () => {
  const flow = createWorkflowTemplate("llm-routing", {
    decision: "classifier",
    simpleTarget: "fast",
    complexTarget: "deep",
  });
  const graph = createWorkflowDataGraph({
    flow,
    request,
    signal: new AbortController().signal,
    callLLM: async () => ({ text: "complex\n" }),
    callJev: async () => ({ answers: {} }),
  });
  const branch = await graph.resolveNode("branch");
  expect(branch).toMatchObject({ condition: true, yes: "complex", no: "simple" });
  expect(flow.nodes.find((node) => node.id === "complex")).toMatchObject({ target: "deep" });
});

it("passes the user's text into Jev and branches on its selected answer", async () => {
  const flow = createWorkflowTemplate("jev-routing", {
    decision: "jev-service",
    simpleTarget: "fast",
    complexTarget: "deep",
  });
  const graph = createWorkflowDataGraph({
    flow,
    request,
    signal: new AbortController().signal,
    callLLM: async () => ({ text: "" }),
    callJev: async (node) => {
      expect(node).toMatchObject({ model: "jev-service", state: "为什么？", answerKey: "route" });
      return { answers: {}, choice: "complex" };
    },
  });
  expect(await graph.resolveNode("branch")).toMatchObject({ condition: true });
});

it("runs independent answers in parallel before supplying both to the summarizer", async () => {
  const flow = createWorkflowTemplate("discussion", {
    primary: "first-model",
    secondary: "second-model",
    summary: "summary-model",
  });
  const started: string[] = [];
  let release!: () => void;
  const bothStarted = new Promise<void>((resolve) => { release = resolve; });
  let summaryPrompt = "";
  const graph = createWorkflowDataGraph({
    flow,
    request,
    signal: new AbortController().signal,
    callJev: async () => ({ answers: {} }),
    callLLM: async (node, original) => {
      if (node.type !== "llm") throw new Error("unexpected node");
      if (node.id === "summary") {
        expect(node.promptMode).toBe("append");
        expect(original.messages).toEqual(request.messages);
        summaryPrompt = node.prompt ?? "";
        return { text: "最终回答" };
      }
      started.push(node.id);
      if (started.length === 2) release();
      await bothStarted;
      return { text: node.id === "first" ? "回答甲" : "回答乙" };
    },
  });
  const response = await graph.resolveNode("response");
  expect(response).toMatchObject({ text: "最终回答" });
  expect(started.sort()).toEqual(["first", "second"]);
  expect(summaryPrompt).toContain("回答甲");
  expect(summaryPrompt).toContain("回答乙");
});

it("uses the requested replacement rather than an inert placeholder", async () => {
  const flow = createWorkflowTemplate("output-processing", { primary: "model" }, { find: "旧词", replacement: "新词" });
  const graph = createWorkflowDataGraph({
    flow,
    request,
    signal: new AbortController().signal,
    callLLM: async () => ({ text: "旧词和旧词" }),
    callJev: async () => ({ answers: {} }),
  });
  expect(await graph.resolveNode("response")).toMatchObject({ text: "新词和新词" });
});
