import type { UrlCitation } from "@pluhub/contracts/ai";

export type Message = {
  role: "user" | "assistant";
  content: string;
  images?: string[];
  model?: string;
  channel?: string;
  incomplete?: boolean;
  citations?: UrlCitation[];
  reasoning?: string;
  createdAt?: number;
};
export type ChatMeta = {
  id?: string;
  first?: number;
  elapsed?: number;
  tokens?: number;
};
export type ChatSession = {
  version: 3;
  sessionId: string;
  title?: string;
  updatedAt: number;
  channel: string;
  model: string;
  modelChannel: string;
  prompt: string;
  system: string;
  temperature: string;
  maxTokens: string;
  effort?: string;
  messages: Message[];
  meta: ChatMeta;
};
export type ChatStore = {
  version: 3;
  activeId: string;
  sessions: ChatSession[];
};

const MAX_SESSIONS = 20;
const stores = new Map<string, ChatStore>();

function storageForKey(key: string): Storage {
  return key === "pluhub.playground:" ? sessionStorage : localStorage;
}

export function chatStorageKey() {
  return (
    "pluhub.playground:" +
    (document.documentElement.dataset.languageAccount ?? "")
  );
}

let account = chatStorageKey();
window.addEventListener("pluhub:language-account", () => {
  const next = chatStorageKey();
  if (account === next) return;
  if (account === "pluhub.playground:") {
    stores.delete(account);
    try {
      sessionStorage.removeItem(account);
    } catch {}
  }
  account = next;
});

export function createChatSession(
  seed: Partial<ChatSession> = {},
): ChatSession {
  return {
    version: 3,
    sessionId: seed.sessionId ?? crypto.randomUUID(),
    title: seed.title,
    updatedAt: seed.updatedAt ?? Date.now(),
    channel: seed.channel ?? "",
    model: seed.model ?? "",
    modelChannel: seed.modelChannel ?? seed.channel ?? "",
    prompt: seed.prompt ?? "",
    system: seed.system ?? "",
    temperature: seed.temperature ?? "",
    maxTokens: seed.maxTokens ?? "",
    effort: seed.effort ?? "",
    messages: seed.messages ?? [],
    meta: seed.meta ?? {},
  };
}

export function chatSessionTitle(session: ChatSession): string {
  if (session.title?.trim()) return session.title.trim();
  for (const message of session.messages) {
    if (message.role !== "user") continue;
    const text = message.content.replace(/\s+/g, " ").trim();
    if (text) return text.length > 26 ? text.slice(0, 26) + "…" : text;
  }
  return "";
}

export function readChatStore(key: string): ChatStore {
  let store = stores.get(key);
  if (!store) {
    try {
      const raw = JSON.parse(storageForKey(key).getItem(key) ?? "null");
      if (raw?.version === 3 && Array.isArray(raw.sessions) && raw.sessions.length) {
        const valid = raw.sessions
          .filter((item: any) => item?.sessionId && Array.isArray(item.messages))
          .slice(0, MAX_SESSIONS)
          .map((item: any) => createChatSession(item));
        if (valid.length) {
          const activeId = valid.some((s: ChatSession) => s.sessionId === raw.activeId)
            ? raw.activeId
            : valid[0]!.sessionId;
          store = { version: 3, activeId, sessions: valid };
        }
      }
    } catch {}
  }
  if (!store) {
    const initial = createChatSession();
    store = { version: 3, activeId: initial.sessionId, sessions: [initial] };
  }
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const channel = params.get("channel");
  const model = params.get("model");
  if (channel !== null || model !== null) {
    store = {
      ...store,
      sessions: store.sessions.map((item) =>
        item.sessionId !== store!.activeId
          ? item
          : {
              ...item,
              ...(channel !== null
                ? { channel, modelChannel: channel }
                : {}),
              ...(model !== null ? { model } : {}),
            },
      ),
    };
  }
  stores.set(key, store);
  return store;
}

export function saveChatStore(key: string, value: ChatStore) {
  if (key !== chatStorageKey()) return;
  const trimmed: ChatStore = {
    version: 3,
    activeId: value.activeId,
    sessions: value.sessions.slice(0, MAX_SESSIONS),
  };
  stores.set(key, trimmed);
  const target = storageForKey(key);
  try {
    target.setItem(key, JSON.stringify(trimmed));
  } catch {
    try {
      const compact: ChatStore = {
        ...trimmed,
        sessions: trimmed.sessions.map((session) => ({
          ...session,
          messages: session.messages.map(({ images: _images, ...rest }) => rest),
        })),
      };
      target.setItem(key, JSON.stringify(compact));
    } catch {
      // In-memory store still preserves the conversation when storage is full.
    }
  }
}
