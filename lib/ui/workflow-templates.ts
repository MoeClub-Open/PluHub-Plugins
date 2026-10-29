import type { ChannelWorkflow } from "@pluhub/contracts/workflow";

export type WorkflowTemplateId =
  | "llm-routing"
  | "jev-routing"
  | "discussion"
  | "polish"
  | "output-processing";

export type WorkflowTemplateModel =
  | "decision"
  | "primary"
  | "secondary"
  | "summary"
  | "simpleTarget"
  | "complexTarget";

/** Model fields are filled from the user's available models when applying a template. */
export const workflowTemplates: {
  id: WorkflowTemplateId;
  label: string;
  models: { key: WorkflowTemplateModel; label: string }[];
}[] = [
  {
    id: "llm-routing",
    label: "LLM 智能路由",
    models: [
      { key: "decision", label: "判断模型" },
      { key: "simpleTarget", label: "简单问题模型" },
      { key: "complexTarget", label: "复杂问题模型" },
    ],
  },
  {
    id: "jev-routing",
    label: "Jev 智能路由",
    models: [
      { key: "decision", label: "Jev 模型" },
      { key: "simpleTarget", label: "简单问题模型" },
      { key: "complexTarget", label: "复杂问题模型" },
    ],
  },
  {
    id: "discussion",
    label: "多模型讨论与汇总",
    models: [
      { key: "primary", label: "回答模型 A" },
      { key: "secondary", label: "回答模型 B" },
      { key: "summary", label: "汇总模型" },
    ],
  },
  {
    id: "polish",
    label: "回答润色",
    models: [
      { key: "primary", label: "回答模型" },
      { key: "summary", label: "润色模型" },
    ],
  },
  {
    id: "output-processing",
    label: "提示词、内容替换与限速",
    models: [{ key: "primary", label: "回答模型" }],
  },
];

export function createWorkflowTemplate(
  id: WorkflowTemplateId,
  models: Partial<Record<WorkflowTemplateModel, string>>,
  options: { find?: string; replacement?: string } = {},
): ChannelWorkflow {
  const model = (key: WorkflowTemplateModel) => models[key] ?? "";
  if (id === "llm-routing" || id === "jev-routing") {
    const decision = id === "llm-routing"
      ? {
          id: "decision",
          type: "llm",
          model: model("decision"),
          system: "判断用户问题是否需要复杂推理。只输出 simple 或 complex，不要输出其他内容。",
          promptMode: "append",
          maxTokens: 16,
        }
      : {
          id: "decision",
          type: "jev",
          model: model("decision"),
          state: "",
          questions: {
            route: {
              type: "choice",
              instructions: "判断问题是否需要复杂推理。",
              criteria: { simple: "简单直接的问题", complex: "需要多步推理或深入分析的问题" },
            },
          },
          answerKey: "route",
        };
    return {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["branch"] },
        decision,
        { id: "compare", type: "compare", valueType: "string", operator: "matches", left: "", right: ["*complex*"] },
        { id: "branch", type: "branch", condition: false, yes: "complex", no: "simple" },
        { id: "simple", type: "upstream", target: model("simpleTarget"), mode: "implicit" },
        { id: "complex", type: "upstream", target: model("complexTarget"), mode: "implicit" },
      ],
      bindings: [
        ...(id === "jev-routing" ? [{ source: "start", output: "text", target: "decision", input: "state" }] : []),
        { source: "decision", output: id === "jev-routing" ? "choice" : "text", target: "compare", input: "left" },
        { source: "compare", output: "result", target: "branch", input: "condition" },
      ],
      layout: {
        start: { x: 40, y: 40 },
        branch: { x: 1190, y: 40 },
        complex: { x: 1570, y: 40 },
        simple: { x: 1570, y: 340 },
        decision: { x: 40, y: 400 },
        compare: { x: 820, y: 400 },
      },
    } as ChannelWorkflow;
  }

  if (id === "discussion" || id === "polish") {
    const discussion = id === "discussion";
    return {
      entry: "start",
      nodes: [
        { id: "start", type: "start", next: ["response"] },
        { id: "first", type: "llm", model: model("primary"), promptMode: "append" },
        ...(discussion ? [{ id: "second", type: "llm", model: model("secondary"), promptMode: "append" }] : []),
        {
          id: "prompt",
          type: "template",
          template: discussion
            ? "回答一：\n{{first}}\n\n回答二：\n{{second}}\n\n请结合之前的对话，综合以上回答，核对差异，给出准确完整的最终回答。"
            : "原回答：\n{{first}}\n\n请结合之前的对话，检查事实与逻辑并润色回答，保留原意，直接输出最终回答。",
          values: discussion ? { first: "", second: "" } : { first: "" },
        },
        { id: "summary", type: "llm", model: model("summary"), prompt: "", promptMode: "append" },
        { id: "response", type: "response", text: "" },
      ],
      bindings: [
        { source: "first", output: "text", target: "prompt", input: "values.first" },
        ...(discussion ? [{ source: "second", output: "text", target: "prompt", input: "values.second" }] : []),
        { source: "prompt", output: "text", target: "summary", input: "prompt" },
        { source: "summary", output: "text", target: "response", input: "text" },
      ],
      layout: {
        start: { x: 40, y: 40 },
        response: { x: 1600, y: 40 },
        first: { x: 40, y: 400 },
        ...(discussion ? { second: { x: 40, y: 740 } } : {}),
        prompt: { x: 450, y: 400 },
        summary: { x: 1000, y: 400 },
      },
    } as ChannelWorkflow;
  }

  return {
    entry: "start",
    nodes: [
      { id: "start", type: "start", next: ["pace"] },
      { id: "pace", type: "tps", rate: 30, tokenizer: "o200k_base", next: "response" },
      { id: "answer", type: "llm", model: model("primary"), system: "请准确、有条理地回答用户的问题。", promptMode: "append" },
      { id: "replace", type: "replace", text: "", find: options.find ?? "", replacement: options.replacement ?? "", all: true },
      { id: "response", type: "response", text: "" },
    ],
    bindings: [
      { source: "answer", output: "text", target: "replace", input: "text" },
      { source: "replace", output: "text", target: "response", input: "text" },
    ],
    layout: {
      start: { x: 40, y: 40 },
      pace: { x: 450, y: 40 },
      response: { x: 1250, y: 40 },
      answer: { x: 40, y: 400 },
      replace: { x: 450, y: 400 },
    },
  } as ChannelWorkflow;
}
