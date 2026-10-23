import type { Protocol } from "@pluhub/contracts/ai";
import {
  subscriptionDefaults,
  type SubscriptionKind,
} from "./subscription-auth.js";
export const channelPresets: {
  id: string;
  name: string;
  protocol: Protocol | SubscriptionKind;
  baseUrl: string;
  pricing?: "newapi";
  authorization?: "subscription";
}[] = [
  {
    id: "custom",
    name: "自定义兼容服务",
    protocol: "openai-chat",
    baseUrl: "",
  },
  {
    id: "openai",
    name: "OpenAI",
    protocol: "openai-chat",
    baseUrl: "https://api.openai.com",
  },
  {
    id: "anthropic",
    name: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com",
  },
  {
    id: "gemini",
    name: "Google Gemini",
    protocol: "gemini",
    baseUrl: "https://generativelanguage.googleapis.com",
  },
  {
    id: "deepseek",
    name: "DeepSeek",
    protocol: "openai-chat",
    baseUrl: "https://api.deepseek.com",
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    protocol: "openai-chat",
    baseUrl: "https://openrouter.ai/api",
  },
  {
    id: "newapi",
    name: "New API / One API",
    protocol: "openai-chat",
    baseUrl: "",
    pricing: "newapi",
  },
  ...(
    [
      "codex",
      "claude-subscription",
      "antigravity",
      "grok",
    ] as SubscriptionKind[]
  ).map((protocol) => ({
    id: protocol,
    name:
      protocol === "codex"
        ? "Codex"
        : protocol === "claude-subscription"
          ? "Claude"
          : protocol === "grok"
            ? "Grok"
            : "Antigravity",
    protocol,
    baseUrl: subscriptionDefaults[protocol].baseUrl,
    authorization: "subscription" as const,
  })),
];
