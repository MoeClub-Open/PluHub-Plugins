import { describe, expect, it } from "vitest";
import rateLimit from "../plugins/rate-limit/index.js";

function fixture(user: Record<string, number>, channel: Record<string, number> = {}) {
  const hooks = new Map<string, (ctx: any) => void>();
  let capability: (input: any) => any = () => undefined;
  let cleanup: () => void = () => undefined;
  rateLimit.setup({
    config: () => ({ user, key: user, channels: { vendor: channel } }),
    cleanup: (fn: () => void) => { cleanup = fn; },
    provide: (_name: string, fn: typeof capability) => { capability = fn; },
    hook: ({ id, handle }: any) => hooks.set(id, handle),
    api: () => {},
  } as any);
  const principal = { id: "user", permissions: [], attributes: { keyId: "key" } };
  const make = (id: string, parent?: { requestId: string; nodeId: string; depth: number }, coordinator = false) => ({
    id, parent, principal, state: new Map<string, unknown>([
      ["ai.request", { model: "model", messages: [{ role: "user", text: "test" }], tools: [], maxTokens: 10 }],
      ["ai.plan", coordinator ? { workflowDeferred: {} } : { upstreamId: "vendor" }],
    ]),
  });
  return { hooks, capability: (input: any) => capability(input), make, cleanup, principal };
}

describe("workflow internal request limits", () => {
  it("shares parent user and key request slots while independently limiting each provider", () => {
    const f = fixture({ rpm: 1, concurrency: 1, tpm: 10000 }, { concurrency: 1 });
    try {
      const parent = f.make("parent", undefined, true);
      f.hooks.get("admit")!(parent);
      const child = f.make("child", { requestId: parent.id, nodeId: "one", depth: 1 });
      expect(() => f.capability({ action: "preflight", principal: f.principal, context: child })).not.toThrow();
      f.hooks.get("admit")!(child);
      const sibling = f.make("other", { requestId: parent.id, nodeId: "two", depth: 1 });
      expect(() => f.hooks.get("admit")!(sibling)).toThrow(/limit/i);
      child.state.set("ai.executionRejected", true);
      f.hooks.get("release")!(child);
      expect(() => f.hooks.get("admit")!(sibling)).not.toThrow();
      f.hooks.get("release")!(sibling);
      f.hooks.get("release")!(parent);
    } finally { f.cleanup(); }
  });

  it("charges actual child tokens to user and key limits without counting the parent twice", () => {
    const f = fixture({ rpm: 1, concurrency: 1, tpm: 1500 });
    try {
      const parent = f.make("parent", undefined, true);
      f.hooks.get("admit")!(parent);
      const child = f.make("child", { requestId: parent.id, nodeId: "one", depth: 1 });
      f.hooks.get("admit")!(child);
      child.state.set("ai.observation", { finished: true, usage: { input: 600, output: 0 } });
      f.hooks.get("release")!(child);
      const next = f.make("next", { requestId: parent.id, nodeId: "two", depth: 1 });
      expect(() => f.hooks.get("admit")!(next)).toThrow(/limit/i);
      // A coordinator can observe a child result, but must not count its usage again.
      parent.state.set("ai.observation", { finished: true, usage: { input: 1000, output: 0 } });
      f.hooks.get("release")!(parent);
      expect(() => f.capability({ rules: [["user:user", { tpm: 1500 }]], tokens: 900 })).not.toThrow();
    } finally { f.cleanup(); }
  });

  it("keeps the reserved tokens for an interrupted child while releasing its provider slot", () => {
    const f = fixture({ concurrency: 1, tpm: 2000 }, { concurrency: 1 });
    try {
      const parent = f.make("parent", undefined, true);
      f.hooks.get("admit")!(parent);
      const child = f.make("child", { requestId: parent.id, nodeId: "one", depth: 1 });
      f.hooks.get("admit")!(child);
      child.state.set("ai.executionStarted", true);
      f.hooks.get("release")!(child);
      const next = f.make("next", { requestId: parent.id, nodeId: "two", depth: 1 });
      expect(() => f.hooks.get("admit")!(next)).toThrow(/limit/i);
      // A fresh user can still use the released provider slot.
      next.principal = { id: "another", permissions: [], attributes: { keyId: "other-key" } };
      expect(() => f.hooks.get("admit")!(next)).not.toThrow();
      f.hooks.get("release")!(next);
      f.hooks.get("release")!(parent);
    } finally { f.cleanup(); }
  });

  it("replaces a rejected child's reservation on retry without counting the same channel twice", () => {
    const f = fixture({ rpm: 1, concurrency: 1, tpm: 5000 }, { rpm: 1, concurrency: 1 });
    try {
      const parent = f.make("parent", undefined, true);
      f.hooks.get("admit")!(parent);
      const child = f.make("child", { requestId: parent.id, nodeId: "one", depth: 1 });
      f.hooks.get("admit")!(child);
      expect(() => f.capability({ action: "admit", context: child, retry: true })).not.toThrow();
      child.state.set("ai.executionRejected", true);
      f.hooks.get("release")!(child);
      f.hooks.get("release")!(parent);
    } finally { f.cleanup(); }
  });

  it("limits response-only workflow paths and releases their concurrency slot", () => {
    const f = fixture({});
    try {
      const parent = f.make("parent", undefined, true);
      const second = f.make("second", undefined, true);
      const policies = [{ channel: "virtual", node: "limit", rule: { concurrency: 1, tpm: 10000 } }];
      f.hooks.get("admit")!(parent);
      f.hooks.get("admit")!(second);
      f.capability({ action: "workflow", context: parent, policies });
      expect(() => f.capability({ action: "workflow", context: parent, policies })).not.toThrow();
      const another = [{ channel: "virtual", node: "second", rule: { concurrency: 1 } }];
      expect(() => f.capability({ action: "workflow", context: parent, policies: another })).not.toThrow();
      expect(() => f.capability({ action: "workflow", context: second, policies })).toThrow(/limit/i);
      f.hooks.get("release")!(parent);
      expect(() => f.capability({ action: "workflow", context: second, policies })).not.toThrow();
      f.hooks.get("release")!(second);
    } finally { f.cleanup(); }
  });

  it("does not reserve the parent's legacy channel again for the final provider", () => {
    const f = fixture({ concurrency: 1 }, { concurrency: 1 });
    try {
      const parent = f.make("parent", undefined, true);
      parent.state.set("ai.plan", { workflowDeferred: {}, upstreamId: "vendor" });
      f.hooks.get("admit")!(parent);
      f.capability({ action: "workflow", context: parent, policies: [] });
      const child = f.make("child", { requestId: parent.id, nodeId: "provider", depth: 1 });
      child.state.set("ai.plan", { upstreamId: "vendor", workflowParentChannel: "vendor" });
      expect(() => f.hooks.get("admit")!(child)).not.toThrow();
      f.hooks.get("release")!(child);
      f.hooks.get("release")!(parent);
    } finally { f.cleanup(); }
  });

  it("admits the external request before a paid routing decision and reuses its limits", () => {
    const f = fixture({ rpm: 1, concurrency: 1, tpm: 10000 }, { rpm: 1, concurrency: 1 });
    try {
      const parent = f.make("parent");
      parent.state.delete("ai.plan");
      const policies = [{ channel: "virtual", node: "limit", rule: { rpm: 1, concurrency: 1, tpm: 10000 } }];
      f.capability({ action: "early-admit", context: parent, policies, channelId: "vendor" });
      expect(() => f.capability({ action: "early-admit", context: parent, policies, channelId: "vendor" })).not.toThrow();
      expect(() => f.capability({ action: "preflight", principal: f.principal })).toThrow(/limit/i);
      const child = f.make("decision", { requestId: parent.id, nodeId: "decision", depth: 1 });
      child.state.set("ai.plan", { upstreamId: "decision" });
      expect(() => f.hooks.get("admit")!(child)).not.toThrow();
      child.state.set("ai.observation", { finished: true, usage: { input: 20, output: 5 } });
      f.hooks.get("release")!(child);
      parent.state.set("ai.plan", { upstreamId: "vendor", requestLimits: policies });
      expect(() => f.hooks.get("admit")!(parent)).not.toThrow();
      parent.state.set("ai.observation", { finished: true, usage: { input: 40, output: 10 } });
      f.hooks.get("release")!(parent);
      expect(() => f.capability({ rules: [["user:user", { concurrency: 1 }]], tokens: 0 })).not.toThrow();
    } finally { f.cleanup(); }
  });
});
