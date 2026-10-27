import {
  definePlugin,
  HostError,
  json,
  type RequestContext,
  type Principal,
} from "@pluhub/sdk";
import type { AIRequest, AIPlan } from "@pluhub/contracts/ai";
import type { ChannelRequestLimit, RequestLimitRule } from "@pluhub/contracts/workflow";
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
      skipRequests = new Set<string>(),
      skipActive = new Set<string>(),
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
          (rule.rpm && !skipRequests.has(id) && bucket.requests >= rule.rpm) ||
          (rule.tpm && bucket.tokens + tokens > rule.tpm) ||
          (rule.concurrency &&
            !skipActive.has(id) &&
            bucket.active >= rule.concurrency)
        )
          throw new HostError(
            "rate_limit_exceeded",
            "Gateway rate or concurrency limit exceeded",
            429,
          );
        return { id, bucket, window, tokens };
      });
      if (checkOnly) return;
      for (const item of items) {
        if (!skipRequests.has(item.id)) item.bucket.requests++;
        item.bucket.tokens += tokens;
        if (!skipActive.has(item.id)) item.bucket.active++;
      }
      let released = false;
      return (actual: number) => {
        if (released) return;
        released = true;
        for (const item of items) {
          if (!skipActive.has(item.id))
            item.bucket.active = Math.max(0, item.bucket.active - 1);
          if (item.bucket.window === item.window)
            item.bucket.tokens = Math.max(
              0,
              item.bucket.tokens - tokens + actual,
            );
        }
      };
    }
    function admit(ctx: RequestContext, retry = false) {
      const request = ctx.state.get("ai.request") as AIRequest | undefined;
      const plan = ctx.state.get("ai.plan") as AIPlan | undefined;
      if (!request || !plan) return;
      const c = host.config();
      const rules = principalRules(ctx.principal);
      const coordinator = !!plan.workflowDeferred;
      // The external request owns the user/key request and concurrency slots.
      // Every child still reserves its own tokens in those same buckets.
      const inherited = new Set(ctx.parent || ctx.state.has("limits.earlyRelease") ? rules.map(([id]) => id) : []);
      const earlyRules = (ctx.state.get("limits.workflowRules") as Set<string> | undefined) ?? new Set<string>();
      const channel = (c.channels as Record<string, Rule> | undefined)?.[
        plan.upstreamId!
      ];
      if (channel && !coordinator && !earlyRules.has("channel:" + plan.upstreamId) && !(ctx.parent && plan.workflowParentChannel === plan.upstreamId))
        rules.push(["channel:" + plan.upstreamId, channel]);
      for (const policy of coordinator ? [] : plan.requestLimits ?? []) {
        // The channel ID includes the personal owner/channel identity. A graph
        // redirect retains policies from every traversed channel.
        const id = JSON.stringify(["graph", policy.channel, policy.node]);
        if (!earlyRules.has(id)) rules.push([id, policy.rule]);
      }
      const prepared = plan.preparedRequest ?? request;
      const tokens = coordinator
        ? 0
        : Buffer.byteLength(JSON.stringify(prepared.messages)) +
          Buffer.byteLength(JSON.stringify(prepared.tools)) +
          (prepared.maxTokens ?? 4096) +
          1024;
      const previous = retry
        ? new Set<string>(
            (ctx.state.get("limits.rules") as string[] | undefined) ?? [],
          )
        : new Set<string>();
      for (const id of inherited) previous.add(id);
      if (retry)
        (
          ctx.state.get("limits.release") as
            ((actual: number) => void) | undefined
        )?.(0);
      ctx.state.set(
        "limits.release",
        reserve(rules, tokens, false, previous, inherited),
      );
      ctx.state.set(
        "limits.rules",
        rules.map(([id]) => id),
      );
      ctx.state.set("limits.tokens", tokens);
      ctx.state.set("limits.coordinator", coordinator);
    }
    function reserveWorkflow(ctx: RequestContext, policies: ChannelRequestLimit[], channelId?: string) {
      const request = ctx.state.get("ai.request") as AIRequest;
      const tokens = Buffer.byteLength(JSON.stringify(request.messages)) +
        Buffer.byteLength(JSON.stringify(request.tools)) +
        (request.maxTokens ?? 4096) + 1024;
      const previous = (ctx.state.get("limits.workflowRules") as Set<string> | undefined) ?? new Set<string>();
      const allRules: [string, Rule][] = policies.map((policy) => [
        JSON.stringify(["graph", policy.channel, policy.node]), policy.rule,
      ]);
      const plan = ctx.state.get("ai.plan") as AIPlan | undefined;
      const effectiveChannel = channelId ?? plan?.upstreamId;
      const channel = (host.config().channels as Record<string, Rule> | undefined)?.[effectiveChannel ?? ""];
      if (channel) allRules.push(["channel:" + effectiveChannel, channel]);
      const rules = [...new Map(allRules).entries()].filter(([id]) => !previous.has(id));
      if (!rules.length) return;
      const release = reserve(rules, tokens)!;
      for (const [id] of rules) previous.add(id);
      const releases = (ctx.state.get("limits.workflowReleases") as Array<{ release: (actual: number) => void; tokens: number }> | undefined) ?? [];
      releases.push({ release, tokens });
      ctx.state.set("limits.workflowRules", previous);
      ctx.state.set("limits.workflowReleases", releases);
      const existing = (ctx.state.get("limits.workflowPolicies") as ChannelRequestLimit[] | undefined) ?? [];
      ctx.state.set("limits.workflowPolicies", [...existing, ...policies]);
    }
    host.provide(
      "ai.request-limits@1",
      (
        input:
          | {
              action: "preflight";
              principal?: Principal;
              context?: RequestContext;
            }
          | { action: "admit"; context: RequestContext; retry?: boolean }
          | { action: "early-admit"; context: RequestContext; policies?: ChannelRequestLimit[]; channelId?: string }
          | {
              action: "workflow";
              context: RequestContext;
              policies: ChannelRequestLimit[];
            }
          | { rules: [string, Rule][]; tokens: number },
      ) => {
        if ("action" in input) {
          if (input.action === "early-admit") {
            const ctx = input.context;
            if (!ctx.parent && !ctx.state.has("limits.earlyRelease"))
              ctx.state.set("limits.earlyRelease", reserve(principalRules(ctx.principal), 0));
            reserveWorkflow(ctx, input.policies ?? [], input.channelId);
            ctx.state.set("limits.earlyDecision", true);
            return;
          }
          if (input.action === "workflow") {
            reserveWorkflow(input.context, input.policies);
            return;
          }
          return input.action === "preflight"
            ? input.context?.parent
              ? undefined
              : reserve(principalRules(input.principal), 0, true)
            : admit(input.context, input.retry);
        }
        return reserve(input.rules, input.tokens);
      },
    );
    host.hook({ id: "admit", phase: "Admission", handle: (ctx) => admit(ctx) });
    host.hook({
      id: "release",
      phase: "Finalize",
      handle(ctx) {
        const release = ctx.state.get("limits.release") as
          ((actual: number) => void) | undefined;
        const state = observation(ctx);
        const usage = state?.finished ? state.usage : undefined;
        release?.(
          ctx.state.get("limits.coordinator")
            ? 0
            : usage
              ? usage.input + usage.output
              : ctx.state.get("ai.executionRejected")
                ? 0
                : ctx.state.get("ai.executionStarted")
                  ? Number(ctx.state.get("limits.tokens"))
                  : 0,
        );
        ctx.state.delete("limits.release");
        const workflowReleases = ctx.state.get("limits.workflowReleases") as
          Array<{ release: (actual: number) => void; tokens: number }> | undefined;
        for (const item of workflowReleases ?? [])
          item.release(usage ? usage.input + usage.output : ctx.state.get("ai.executionStarted") || ctx.state.get("limits.earlyDecision") ? item.tokens : 0);
        ctx.state.delete("limits.workflowReleases");
        (ctx.state.get("limits.earlyRelease") as ((actual: number) => void) | undefined)?.(0);
        ctx.state.delete("limits.earlyRelease");
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
          ...((ctx.state.get("limits.workflowPolicies") as ChannelRequestLimit[] | undefined) ?? [])
            .map((p) => p.rule.bytesPerSecond ?? 0),
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
