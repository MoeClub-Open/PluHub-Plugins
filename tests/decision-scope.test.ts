import { describe, expect, it } from "vitest";
import type { Host, RequestContext } from "@pluhub/sdk";
import {
  getDecisionScope,
  withDecisionScope,
} from "../plugins/ai-router/decision-scope.js";

function context(id = "user"): RequestContext {
  return {
    id: "request",
    graphVersion: 1,
    request: new Request("http://test/v1/chat/completions"),
    signal: new AbortController().signal,
    principal: { id, permissions: [] },
    state: new Map([["ai.request", { model: "public" }]]),
    config: {},
  };
}
const host = (ctx: RequestContext) =>
  ({ requestContext: () => ctx }) as unknown as Host;
const scope = (profile = "p") => ({
  profile,
  principalId: "user",
  entryModel: "public",
  request: { model: "public", messages: [], tools: [], stream: false },
});

describe("trusted automatic decision scope", () => {
  it("binds a one-time token to the actual context and profile", async () => {
    const h = host(context());
    await withDecisionScope(h, scope(), async (token) => {
      expect(() => getDecisionScope(h, "other", token)).toThrow();
      expect(() => getDecisionScope(host(context()), "p", token)).toThrow();
      expect(getDecisionScope(h, "p", token).request.model).toBe("public");
      expect(() => getDecisionScope(h, "p", token)).toThrow();
    });
  });

  it("isolates overlapping scopes and revokes them after completion", async () => {
    const h = host(context());
    let finish!: () => void;
    let firstToken: string | undefined;
    const first = withDecisionScope(h, scope("first"), async (token) => {
      firstToken = token;
      await new Promise<void>((resolve) => {
        finish = resolve;
      });
    });
    await withDecisionScope(h, scope("second"), async (token) => {
      expect(getDecisionScope(h, "second", token).profile).toBe("second");
      expect(getDecisionScope(h, "first", firstToken).profile).toBe("first");
      await withDecisionScope(h, scope("third"), async (nested) => {
        finish();
        await first;
        expect(getDecisionScope(h, "third", nested).profile).toBe("third");
      });
    });
    await first;
    expect(() => getDecisionScope(h, "first", firstToken)).toThrow();
  });

  it("does not create authorization for management previews or a different identity", async () => {
    const preview = {
      requestContext: () => {
        throw new Error("not a gateway request");
      },
    } as unknown as Host;
    await withDecisionScope(preview, scope(), async (token) =>
      expect(token).toBeUndefined(),
    );
    await expect(
      withDecisionScope(host(context("other")), scope(), async () => undefined),
    ).rejects.toThrow();
    await expect(
      withDecisionScope(
        host(context()),
        { ...scope(), entryModel: "other-model" },
        async () => undefined,
      ),
    ).rejects.toThrow();
  });

  it("accepts a fallback target only after a definite rejection of its recorded route", async () => {
    const ctx = context();
    const h = host(ctx);
    const redirected = {
      ...scope(),
      entryModel: "fallback",
      channelId: "platform",
    };
    ctx.state.set("ai.plan", {
      fallback: {
        model: "fallback",
        principalId: "user",
        channelId: "platform",
      },
    });
    await expect(
      withDecisionScope(h, redirected, async () => undefined),
    ).rejects.toThrow();
    ctx.state.set("ai.executionRejected", true);
    await withDecisionScope(h, redirected, async (token) => {
      expect(getDecisionScope(h, "p", token).entryModel).toBe("fallback");
    });
    await expect(
      withDecisionScope(
        h,
        { ...redirected, channelId: "other" },
        async () => undefined,
      ),
    ).rejects.toThrow();
  });
});
