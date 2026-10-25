import type { UrlCitation } from "@pluhub/contracts/ai";

export type Message = {
  role: "user" | "assistant";
  content: string;
  model?: string;
  channel?: string;
  incomplete?: boolean;
  citations?: UrlCitation[];
};
export type ChatMeta = {
  id?: string;
  first?: number;
  elapsed?: number;
  tokens?: number;
};
export type ChatSession = {
  version: 1;
  sessionId: string;
  channel: string;
  group?: string;
  model: string;
  modelChannel: string;
  prompt: string;
  system: string;
  temperature: string;
  maxTokens: string;
  messages: Message[];
  meta: ChatMeta;
};
const sessions = new Map<string, ChatSession>();
export function chatStorageKey() {
  return (
    "pluhub.playground:" + document.documentElement.dataset.languageAccount
  );
}
let account = chatStorageKey();
window.addEventListener("pluhub:language-account", () => {
  const next = chatStorageKey();
  if (account === next) return;
  sessions.delete(account);
  try {
    sessionStorage.removeItem(account);
  } catch {}
  account = next;
});
export function readChat(key: string): ChatSession {
  let saved = sessions.get(key);
  if (!saved) {
    try {
      const value = JSON.parse(sessionStorage.getItem(key) ?? "null");
      if (value?.version === 1 && Array.isArray(value.messages)) saved = value;
    } catch {}
  }
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const channel = params.get("channel"),
    model = params.get("model"),
    group = params.get("group");
  if (
    saved &&
    (channel === null || channel === saved.channel) &&
    (model === null || model === saved.model) &&
    (group === null || group === saved.group)
  )
    return saved;
  return {
    version: 1,
    sessionId: crypto.randomUUID(),
    channel: channel ?? "",
    group: group ?? (channel?.startsWith("personal:") ? "personal" : "default"),
    model: model ?? "",
    modelChannel: channel ?? "",
    prompt: "",
    system: saved?.system ?? "",
    temperature: saved?.temperature ?? "0.7",
    maxTokens: saved?.maxTokens ?? "1024",
    messages: [],
    meta: {},
  };
}
export function saveChat(key: string, value: ChatSession) {
  if (key !== chatStorageKey()) return;
  sessions.set(key, value);
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Navigation still preserves the conversation when browser storage is full.
  }
}
