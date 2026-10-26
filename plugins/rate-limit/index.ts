import { definePlugin, HostError, json, type Principal } from "@pluhub/sdk";
import type { AIRequest, AIPlan } from "@pluhub/contracts/ai";
import type { RequestLimitRule } from "@pluhub/contracts/workflow";
import { observation } from "../../lib/ai/telemetry.js";
import { throttle } from "./throttle.js";
type Rule = RequestLimitRule;
type Bucket = {
  window: number;
  requests: number;
  tokens: number;
  active: number;
};
export default definePlugin({
  setup(host) {
    const buckets = new Map<string, Bucket>();
    const sweep = setInterval(() => {
      for (const [k, v] of buckets)
        if (v.active === 0 && v.window < Math.floor(Date.now() / 60000) - 1)
          buckets.delete(k);
    }, 60000);
    sweep.unref();
    host.cleanup(() => clearInterval(sweep));
    function principalRules(principal?: Principal): [string, Rule][] {
      const c = host.config();
      const rules: [string, Rule][] = [];
      if (c.user && principal)
        rules.push(["user:" + principal.id, c.user as Rule]);
      const key = principal?.attributes?.keyId;
      const keyLimit = Number(principal?.attributes?.requestsPerMinute ?? 0);
      if (key && (c.key || keyLimit)) {
        const rule = (c.key ?? {}) as Rule;
        const limits = [rule.rpm, keyLimit].filter(
          (value): value is number => !!value,
        );
        rules.push([
          "key:" + key,
          { ...rule, ...(limits.length ? { rpm: Math.min(...limits) } : {}) },
        ]);
      }
      return rules;
    }
    function reserve(
      rules: [string, Rule][],
      tokens: number,
      checkOnly = false,
    ) {
      // A redirect may revisit one channel through a different public model.
      // Count one request per node rather than reserving that bucket twice.
      rules = [...new Map(rules).entries()];
      const window = Math.floor(Date.now() / 60000);
      // Validate all buckets first; rejection must not consume another rule's quota.
      const items = rules.map(([id, rule]) => {
        let bucket = buckets.get(id);
        if (!bucket) {
          bucket = { window, requests: 0, tokens: 0, active: 0 };
          buckets.set(id, bucket);
        }
        if (bucket.window !== window) {
          bucket.window = window;
          bucket.requests = 0;
          bucket.tokens = 0;
        }
        if (
          (rule.rpm && bucket.requests >= rule.rpm) ||
          (rule.tpm && bucket.tokens + tokens > rule.tpm) ||
          (rule.concurrency && bucket.active >= rule.concurrency)
        )
          throw new HostError(
            "rate_limit_exceeded",
            "Gateway rate or concurrency limit exceeded",
            429,
          );
        return { bucket, window, tokens };
      });
      if (checkOnly) return;
      for (const item of items) {
        item.bucket.requests++;
        item.bucket.tokens += tokens;
        item.bucket.active++;
      }
      let released = false;
      return (actual: number) => {
        if (released) return;
        released = true;
        for (const item of items) {
          item.bucket.active = Math.max(0, item.bucket.active - 1);
          if (item.bucket.window === item.window)
            item.bucket.tokens = Math.max(
              0,
              item.bucket.tokens - tokens + actual,
            );
        }
      };
    }
    host.provide(
      "ai.request-limits@1",
      (
        input:
          | { action: "preflight"; principal?: Principal }
          | { rules: [string, Rule][]; tokens: number },
      ) =>
        "action" in input
          ? reserve(principalRules(input.principal), 0, true)
          : reserve(input.rules, input.tokens),
    );
    host.hook({
      id: "admit",
      phase: "Admission",
      handle(ctx) {
        const request = ctx.state.get("ai.request") as AIRequest | undefined;
        const plan = ctx.state.get("ai.plan") as AIPlan | undefined;
        if (!request || !plan) return;
        const c = host.config();
        const rules = principalRules(ctx.principal);
        const channel = (c.channels as Record<string, Rule> | undefined)?.[
          plan.upstreamId!
        ];
        if (channel) rules.push(["channel:" + plan.upstreamId, channel]);
        for (const policy of plan.requestLimits ?? []) {
          // The channel ID includes the personal owner/channel identity. A graph
          // redirect retains policies from every traversed channel.
          rules.push([
            JSON.stringify(["graph", policy.channel, policy.node]),
            policy.rule,
          ]);
        }
        const prepared = plan.preparedRequest ?? request;
        const tokens =
          Buffer.byteLength(JSON.stringify(prepared.messages)) +
          Buffer.byteLength(JSON.stringify(prepared.tools)) +
          (prepared.maxTokens ?? 4096) +
          1024;
        ctx.state.set("limits.release", reserve(rules, tokens));
        ctx.state.set("limits.tokens", tokens);
      },
    });
    host.hook({
      id: "release",
      phase: "Finalize",
      handle(ctx) {
        const release = ctx.state.get("limits.release") as
          ((actual: number) => void) | undefined;
        const state = observation(ctx);
        const usage = state?.finished ? state.usage : undefined;
        release?.(
          usage
            ? usage.input + usage.output
            : ctx.state.get("ai.executionStarted")
              ? Number(ctx.state.get("limits.tokens"))
              : 0,
        );
        ctx.state.delete("limits.release");
      },
    });
    host.hook({
      id: "pace",
      phase: "Streaming",
      handle(ctx) {
        const plan = ctx.state.get("ai.plan") as AIPlan | undefined;
        const rates = [
          Number(host.config().bytesPerSecond ?? 0),
          ...(plan?.requestLimits ?? []).map((p) => p.rule.bytesPerSecond ?? 0),
        ].filter((n) => n > 0);
        const rate = rates.length ? Math.min(...rates) : 0;
        if (!rate || !ctx.state.has("ai.request") || !ctx.response?.body)
          return;
        const response = ctx.response;
        const headers = new Headers(response.headers);
        headers.delete("content-length");
        ctx.response = new Response(
          throttle(response.body!, rate, ctx.signal),
          { status: response.status, headers },
        );
      },
    });
    host.api({
      method: "GET",
      path: "/status",
      access: "host.manage",
      handle: () =>
        json({
          config: host.config(),
          active: [...buckets.values()].reduce((n, b) => n + b.active, 0),
        }),
    });
  },
});
