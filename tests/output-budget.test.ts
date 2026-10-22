import { expect, it } from "vitest";
import type { AIRequest, AIPlan } from "@pluhub/contracts/ai";
import {
  outputBudget,
  validateOutputBudget,
} from "../lib/ai/output-budget.js";
const request: AIRequest = {
  model: "public",
  messages: [{ role: "user", text: "hello" }],
  stream: false,
  tools: [],
};
const plan = (
  protocol: AIPlan["upstream"]["protocol"] = "openai-chat",
): AIPlan => ({
  model: "actual",
  capability: "ai.upstream." + protocol + "@1",
  upstream: { protocol },
  pricing: { input: 1, output: 2 },
});
it("reserves and sends the same default or explicit output bound without mutating the caller request", () => {
  const original = structuredClone(request);
  const defaulted = outputBudget(original, plan(), {
    reserveOutputTokens: 128,
  });
  expect(defaulted.request.maxTokens).toBe(128);
  expect(defaulted.budget).toEqual({
    mode: "bounded",
    source: "default",
    limit: 128,
    reservedTokens: 128,
  });
  expect(original.maxTokens).toBeUndefined();
  const prepared = plan();
  prepared.preparedRequest = { ...request, maxTokens: 16 };
  const limited = outputBudget({ ...request, maxTokens: 1000 }, prepared, {});
  expect(limited.request.maxTokens).toBe(16);
  expect(limited.budget.limit).toBe(16);
});
it("includes the effective thinking budget in an omitted default and never adds it twice", () => {
  for (const protocol of [
    "anthropic",
    "claude-subscription",
    "gemini",
    "antigravity",
  ] as const) {
    const selected = plan(protocol);
    selected.reasoning = { budgetTokens: 8192 };
    const prepared = outputBudget(request, selected, {});
    expect(prepared.request.maxTokens).toBe(9216);
    expect(prepared.budget.reservedTokens).toBe(9216);
    expect(prepared.budget.thinkingTokens).toBe(8192);
  }
  const selected = plan("anthropic");
  selected.reasoning = { budgetTokens: 8192 };
  expect(() =>
    outputBudget({ ...request, maxTokens: 8192 }, selected, {}),
  ).toThrow("Thinking budget");
  selected.reasoning = { budgetTokens: 1_000_000 };
  expect(() => outputBudget(request, selected, {})).toThrow(
    "output token budget",
  );
});
it("keeps CLI estimation explicit, supports strict rejection and per-request prices, and bounds SIWC", () => {
  const cli = plan("codex");
  cli.upstream.authMode = "cli";
  const automatic = outputBudget(request, cli, {});
  expect(automatic.request.maxTokens).toBeUndefined();
  expect(automatic.budget).toEqual({
    mode: "estimate",
    source: "default",
    reservedTokens: 4096,
  });
  expect(() =>
    outputBudget(request, cli, { outputBudgetMode: "bounded" }),
  ).toThrow("cannot enforce");
  cli.pricing = { input: 0, output: 0, mode: "request", request: 0.001 };
  expect(
    outputBudget(request, cli, { outputBudgetMode: "bounded" }).budget.mode,
  ).toBe("fixed");
  expect(() => outputBudget({ ...request, maxTokens: 64 }, cli, {})).toThrow(
    "Codex CLI",
  );
  cli.upstream.authMode = "siwc";
  expect(outputBudget(request, cli, {}).request.maxTokens).toBe(4096);
});
it("retains explicitly selected estimation without discarding client caps and rejects invalid policies", () => {
  const config = { outputBudgetMode: "estimate" };
  const estimated = outputBudget(request, plan(), config);
  expect(estimated.request.maxTokens).toBeUndefined();
  expect(estimated.budget.mode).toBe("estimate");
  expect(
    outputBudget({ ...request, maxTokens: 42 }, plan(), config).budget,
  ).toMatchObject({ mode: "bounded", limit: 42, reservedTokens: 42 });
  for (const value of [
    { outputBudgetMode: ["automatic"] },
    { outputBudgetMode: "invalid" },
    { reserveOutputTokens: 0 },
    { reserveOutputTokens: 1.5 },
    { reserveOutputTokens: 1_000_001 },
  ])
    expect(() => validateOutputBudget(value)).toThrow();
  expect(() =>
    validateOutputBudget({
      outputBudgetMode: "estimate",
      reserveOutputTokens: 100_000_000,
    }),
  ).not.toThrow();
});
