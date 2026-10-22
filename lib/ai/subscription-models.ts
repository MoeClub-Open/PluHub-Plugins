import type { Host } from "@pluhub/sdk";
import { responseObject } from "./json-response.js";
import type { SubscriptionKind } from "./subscription-auth.js";

export type SubscriptionModel = {
  id: string;
  name: string;
  contextLength?: number;
  maxOutputTokens?: number;
};

const registryUrl =
  "https://raw.githubusercontent.com/router-for-me/CLIProxyAPI/main/internal/registry/models/models.json";
const cacheTtl = 15 * 60_000;
const failureTtl = 60_000;
let registryCache:
  | { expiresAt: number; data: Record<string, unknown> }
  | undefined;

const fallback: Record<SubscriptionKind, SubscriptionModel[]> = {
  codex: [
    { id: "gpt-5.5", name: "GPT 5.5" },
    { id: "gpt-5.6-sol", name: "GPT 5.6 Sol" },
    { id: "gpt-5.6-terra", name: "GPT 5.6 Terra" },
    { id: "gpt-5.6-luna", name: "GPT 5.6 Luna" },
    { id: "gpt-6-sol", name: "GPT 6.0 Sol" },
    { id: "gpt-6-astra", name: "GPT 6.0 Astra" },
    { id: "gpt-6.1-sol", name: "GPT 6.1 Sol" },
    { id: "gpt-6-luna", name: "GPT 6.0 Luna" },
    { id: "codex-auto-review", name: "Codex Auto Review" },
  ],
  "claude-subscription": [
    { id: "claude-sonnet-4-6", name: "Claude 4.6 Sonnet" },
    { id: "claude-opus-4-6", name: "Claude 4.6 Opus" },
    { id: "claude-opus-4-7", name: "Claude Opus 4.7" },
    { id: "claude-opus-4-8", name: "Claude Opus 4.8" },
    { id: "claude-opus-5", name: "Claude Opus 5" },
    { id: "claude-sonnet-5", name: "Claude Sonnet 5" },
    { id: "claude-fable-5", name: "Claude Fable 5" },
    { id: "claude-fable-5-1", name: "Claude Fable 5.1" },
    { id: "claude-opus-5-5", name: "Claude Opus 5.5" },
    { id: "claude-sonnet-5-5", name: "Claude Sonnet 5.5" },
    { id: "claude-haiku-5-5", name: "Claude Haiku 5.5" },
  ],
  antigravity: [
    {
      id: "claude-opus-4-6-thinking",
      name: "Claude Opus 4.6 (Thinking)",
    },
    { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6 (Thinking)" },
    { id: "claude-opus-5-5-high", name: "Claude Opus 5.5 (High)" },
    { id: "claude-sonnet-5-5-high", name: "Claude Sonnet 5.5 (High)" },
    { id: "gemini-4-argon-high", name: "Gemini 4 Argon" },
    { id: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash" },
    { id: "gemini-3-flash", name: "Gemini 3 Flash" },
    { id: "gemini-3.1-flash-image", name: "Gemini 3.1 Flash Image" },
    { id: "gpt-oss-120b-medium", name: "GPT-OSS 120B (Medium)" },
    { id: "gemini-3.1-flash-lite", name: "Gemini 3.1 Flash Lite" },
    { id: "gemini-3.5-flash-lite", name: "Gemini 3.5 Flash Lite" },
  ],
};

function positiveInteger(value: unknown) {
  return Number.isSafeInteger(value) && Number(value) > 0
    ? Number(value)
    : undefined;
}

function normalizeModels(value: unknown): SubscriptionModel[] {
  if (!Array.isArray(value)) return [];
  const models = new Map<string, SubscriptionModel>();
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    if (
      typeof item.id !== "string" ||
      !item.id ||
      item.id.length > 256 ||
      item.id.trim() !== item.id
    )
      continue;
    const model: SubscriptionModel = {
      id: item.id,
      name:
        typeof item.display_name === "string" && item.display_name.trim()
          ? item.display_name.trim().slice(0, 256)
          : item.id,
      contextLength: positiveInteger(item.context_length),
      maxOutputTokens: positiveInteger(item.max_completion_tokens),
    };
    const previous = models.get(model.id);
    models.set(model.id, {
      ...previous,
      ...model,
      contextLength: Math.max(
        previous?.contextLength ?? 0,
        model.contextLength ?? 0,
      ) || undefined,
      maxOutputTokens: Math.max(
        previous?.maxOutputTokens ?? 0,
        model.maxOutputTokens ?? 0,
      ) || undefined,
    });
  }
  return [...models.values()].slice(0, 256);
}

function registryKeys(kind: SubscriptionKind, plan?: unknown) {
  if (kind === "claude-subscription") return ["claude"];
  if (kind === "antigravity") return ["antigravity"];
  const value = typeof plan === "string" ? plan.toLowerCase() : "";
  if (/free/.test(value)) return ["codex-free"];
  if (/team|business|enterprise/.test(value)) return ["codex-team"];
  if (/plus/.test(value)) return ["codex-plus"];
  if (/pro/.test(value)) return ["codex-pro"];
  return ["codex-free", "codex-team", "codex-plus", "codex-pro"];
}

async function loadRegistry(host: Host, signal: AbortSignal) {
  if (registryCache && registryCache.expiresAt > Date.now())
    return registryCache.data;
  const timeout = AbortSignal.any([signal, AbortSignal.timeout(8_000)]);
  try {
    const response = await host.call<Response>(
      "http.transport@1",
      {
        url: registryUrl,
        method: "GET",
        headers: { accept: "application/json" },
        publicOnly: true,
      },
      timeout,
    );
    if (!response.ok || !response.body) {
      await response.body?.cancel();
      throw new Error("Subscription model registry unavailable");
    }
    const data = (await responseObject(response, timeout, 2_000_000)) as Record<
      string,
      unknown
    >;
    registryCache = { expiresAt: Date.now() + cacheTtl, data };
    return data;
  } catch (error) {
    if (signal.aborted) throw error;
    registryCache = { expiresAt: Date.now() + failureTtl, data: {} };
    return registryCache.data;
  }
}

export async function subscriptionModels(
  host: Host,
  kind: SubscriptionKind,
  plan: unknown,
  signal: AbortSignal,
) {
  const registry = await loadRegistry(host, signal);
  const models = normalizeModels(
    registryKeys(kind, plan).flatMap((key) =>
      Array.isArray(registry[key]) ? registry[key] : [],
    ),
  );
  return models.length ? models : fallback[kind];
}
