import { createHash } from "node:crypto";
import type { AIRequest } from "@pluhub/contracts/ai";
import type { Principal } from "@pluhub/sdk";

const bodyFields = [
  "session_id",
  "sessionId",
  "conversation_id",
  "chat_id",
  "thread_id",
  "prompt_cache_key",
  "metadata",
  "user",
];
const headers = [
  "x-pluhub-session-id",
  "x-claude-code-session-id",
  "session_id",
  "session-id",
  "conversation_id",
  "conversation-id",
  "x-http-session-id",
  "x-session-id",
  "x-session-affinity",
  "x-slot-session-id",
  "x-conversation-id",
  "x-thread-id",
  "thread-id",
];
const identity = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() && value.length <= 4096
    ? value.trim()
    : undefined;

/** Session hints are gateway metadata, never upstream identity/authorization. */
export function sessionPayload(body: any): any {
  if (!body || typeof body !== "object" || Array.isArray(body)) return body;
  const result = { ...body };
  for (const key of bodyFields) delete result[key];
  return result;
}

function claudeSession(value: unknown): string | undefined {
  const user = identity(value);
  if (!user) return;
  if (user.startsWith("{")) {
    try {
      return identity(JSON.parse(user)?.session_id);
    } catch {
      return;
    }
  }
  return /_session_([a-z0-9-]+)$/i.exec(user)?.[1];
}

export function clientSession(
  request: Request,
  body: Record<string, any>,
  decoded: AIRequest,
  principal?: Principal,
): string | undefined {
  if (!principal) return;
  let explicit: string | undefined;
  for (const header of headers) {
    explicit = identity(request.headers.get(header));
    if (explicit) break;
  }
  explicit ??= claudeSession(body.metadata?.user_id);
  for (const key of [
    "session_id",
    "sessionId",
    "conversation_id",
    "chat_id",
    "thread_id",
  ])
    explicit ??= identity(body[key]) ?? identity(body.metadata?.[key]);
  const cache = identity(body.prompt_cache_key);
  // Request IDs and bare user IDs change per turn or span unrelated chats.
  // A history's first user turn stays stable while the conversation grows.
  const first = decoded.messages.find(
    (m) => m.role === "user" && (m.text || m.content?.length),
  );
  const seed = explicit
    ? ["session", explicit]
    : cache
      ? ["cache", cache]
      : first
        ? ["first-user", first.content ?? first.text]
        : undefined;
  if (!seed) return;
  return createHash("sha256")
    .update(
      JSON.stringify([
        "pluhub-session-v1",
        principal.id,
        principal.attributes?.keyId ?? "console",
        seed,
      ]),
    )
    .digest("hex");
}

/** Opaque stable UUID, scoped to the selected channel and provider node. */
export function providerSession(sessionId: string, scope: unknown): string {
  const bytes = createHash("sha1")
    .update(JSON.stringify(["pluhub-provider-session-v1", scope, sessionId]))
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
