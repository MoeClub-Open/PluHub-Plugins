import { readFileSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { Tokenizer } from "@huggingface/tokenizers";
import { definePlugin, HostError, json } from "@pluhub/sdk";
import type { AIEvent, AIPlan } from "@pluhub/contracts/ai";
import { TokenPacer, paceEvents } from "./pacing.js";
type TokenizerConfig =
  | { kind: "huggingface"; tokenizerPath: string; configPath: string }
  | { kind: "tiktoken"; encoding: "o200k_base" | "cl100k_base" };
type Rule = {
  channel?: string;
  model?: string;
  tps?: number;
  aggregateTps?: number;
  tokenizer: string;
};
export default definePlugin({
  setup(host) {
    const cache = new Map<string, Promise<(text: string) => number>>();
    const models = new Map<
      string,
      { rates: Map<symbol, number>; pacer: TokenPacer }
    >();
    const shutdown = new AbortController();
    host.cleanup(() => {
      shutdown.abort(new DOMException("Plugin stopped", "AbortError"));
      cache.clear();
      models.clear();
    });
    const definition = (name: string, c: any): TokenizerConfig | undefined =>
      ["o200k_base", "cl100k_base"].includes(name)
        ? { kind: "tiktoken", encoding: name as "o200k_base" }
        : c.tokenizers?.[name];
    function loadHf(config: Extract<TokenizerConfig, { kind: "huggingface" }>) {
      function file(path: string) {
        const name = resolve(host.dataDir, path);
        if (statSync(name).size > 32 * 1024 * 1024)
          throw new Error("Tokenizer file too large");
        return JSON.parse(readFileSync(name, "utf8"));
      }
      return new Tokenizer(file(config.tokenizerPath), file(config.configPath));
    }
    host.validateConfig((c) => {
      const ids = new Set();
      const all = [
        ...(c.default ? [c.default] : []),
        ...((c.models ?? []) as Rule[]),
      ];
      for (const rule of all as Rule[]) {
        if (!rule.tps && !rule.aggregateTps)
          throw new HostError(
            "invalid_config",
            "TPS rule needs a request or aggregate rate",
          );
        const def = definition(rule.tokenizer, c);
        if (!def)
          throw new HostError(
            "invalid_config",
            "Choose an explicitly configured tokenizer",
          );
        if (rule !== c.default) {
          const id = JSON.stringify([rule.channel, rule.model]);
          if (ids.has(id))
            throw new HostError("invalid_config", "Duplicate model TPS rule");
          ids.add(id);
        }
        if (def.kind === "huggingface")
          try {
            loadHf(def);
          } catch {
            throw new HostError(
              "invalid_config",
              "Unable to load configured tokenizer files",
            );
          }
      }
    });
    function tokenizer(
      name: string,
      c: any,
    ): Promise<(text: string) => number> {
      const def = definition(name, c);
      if (!def) throw new HostError("invalid_config", "Tokenizer unavailable");
      const key = JSON.stringify(def);
      let work = cache.get(key);
      if (!work) {
        work = (async () => {
          if (def.kind === "huggingface") {
            const t = loadHf(def);
            return (s: string) =>
              t.encode(s, { add_special_tokens: false }).ids.length;
          }
          const { getEncoding } = await import("js-tiktoken");
          const t = getEncoding(def.encoding);
          return (s: string) => t.encode(s, [], []).length;
        })();
        cache.set(key, work);
        work.catch(() => cache.delete(key));
      }
      return work;
    }
    const pace = (
      { events, plan }: { events: AsyncIterable<AIEvent>; plan: AIPlan },
      signal: AbortSignal,
    ) => {
      const c = host.config();
      const baseRule =
        ((c.models ?? []) as Rule[]).find(
          (r) => r.channel === plan.upstreamId && r.model === plan.model,
        ) ??
        (plan.outputPolicy?.inheritDefault === false
          ? undefined
          : (c.default as Rule | undefined));
      const rule = plan.outputPolicy
        ? {
            ...baseRule,
            tps:
              baseRule?.tps || plan.outputPolicy.tps
                ? Math.min(
                    baseRule?.tps ?? Infinity,
                    plan.outputPolicy.tps ?? Infinity,
                  )
                : undefined,
            aggregateTps:
              baseRule?.aggregateTps || plan.outputPolicy.aggregateTps
                ? Math.min(
                    baseRule?.aggregateTps ?? Infinity,
                    plan.outputPolicy.aggregateTps ?? Infinity,
                  )
                : undefined,
            tokenizer: baseRule?.tokenizer ?? plan.outputPolicy.tokenizer,
          }
        : baseRule;
      if (!rule) return events;
      const activeSignal = AbortSignal.any([signal, shutdown.signal]);
      return (async function* () {
        const count = await tokenizer(rule.tokenizer, c);
        const id = Symbol();
        const key = JSON.stringify([plan.upstreamId, plan.model]);
        let shared: ReturnType<typeof models.get>;
        if (rule.aggregateTps) {
          shared = models.get(key);
          if (!shared) {
            const rates = new Map<symbol, number>();
            shared = {
              rates,
              pacer: new TokenPacer(() => Math.min(...rates.values())),
            };
            models.set(key, shared);
          }
          shared.rates.set(id, rule.aggregateTps);
        }
        const local = rule.tps ? new TokenPacer(() => rule.tps!) : undefined;
        try {
          yield* paceEvents(
            events,
            count,
            async (cost) => {
              await Promise.all([
                local?.take(cost, activeSignal),
                shared?.pacer.take(cost, activeSignal),
              ]);
            },
            activeSignal,
            Number(c.maxTrackedChars ?? 65536),
            Number(c.quantumTokens ?? 1),
          );
        } finally {
          if (shared) {
            shared.rates.delete(id);
            if (!shared.rates.size) models.delete(key);
          }
        }
      })();
    };
    host.provide("ai.output-pace@1", pace);
    host.provide("ai.output-pace@2", pace);
    host.api({
      method: "GET",
      path: "/status",
      access: "host.manage",
      handle: () =>
        json({
          config: host.config(),
          activeModels: models.size,
          tokenizers: [
            "o200k_base",
            "cl100k_base",
            ...Object.keys(host.config().tokenizers ?? {}),
          ],
        }),
    });
  },
});
