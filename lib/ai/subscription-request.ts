import { createHash, randomUUID } from "node:crypto";
import { HostError, requiredString } from "@pluhub/sdk";
import type { AIRequest, Upstream, Protocol } from "@pluhub/contracts/ai";
import { encodeRequest } from "./protocols.js";
import {
  normalizeOutputOptions,
  supportsOutputLimit,
} from "./output-budget.js";
import {
  subscriptionDefaults,
  type SubscriptionKind,
} from "./subscription-auth.js";
import { antigravityUserAgent } from "./antigravity-control.js";
import { validateWebSearchTarget } from "./web-search.js";
import { prepareAntigravityRequest } from "./antigravity-reasoning.js";
import { codexImageRequest, codexImageTool } from "./codex-images.js";
export function subscriptionRequest(
  kind: SubscriptionKind,
  request: AIRequest,
  upstream: Upstream,
  credential: {
    secret: string;
    accountId?: string;
    projectId?: string;
    authMode?: "siwc";
  },
) {
  const imageTool =
    kind === "codex" && request.operation ? codexImageTool(request) : undefined;
  if (imageTool) request = codexImageRequest(request);
  if (kind === "antigravity") request = prepareAntigravityRequest(request);
  if (credential.authMode === "siwc")
    upstream = {
      ...upstream,
      authMode: "siwc",
      baseUrl: "https://api.openai.com/v1",
    };
  request = normalizeOutputOptions(request, { ...upstream, protocol: kind });
  validateWebSearchTarget(request, { ...upstream, protocol: kind });
  const protocol: Protocol =
    kind === "codex" || kind === "grok"
      ? "openai-responses"
      : kind === "claude-subscription"
        ? "anthropic"
        : "gemini";
  let body: any = encodeRequest(protocol, request);
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: "Bearer " + credential.secret,
  };
  const url = new URL(
    requiredString(
      upstream.baseUrl ||
        (upstream.subscriptionAccountIds
          ? subscriptionDefaults[kind].baseUrl
          : undefined),
      "subscription URL",
      2048,
    ),
  );
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HostError(
      "invalid_upstream",
      "Invalid subscription upstream URL",
    );
  let suffix = "";
  if (kind === "codex") {
    suffix = "/responses";
    if (upstream.authMode === "siwc") {
      body.stream = true;
      body.store = false;
    }
    if (!supportsOutputLimit({ ...upstream, protocol: kind })) {
      body.stream = true;
      body.store = false;
      body.input = encodeRequest("openai-responses", {
        ...request,
        messages: request.messages.filter(
          (m) => m.role !== "system" && m.role !== "developer",
        ),
      }).input;
      body.instructions = request.messages
        .filter((m) => m.role === "system" || m.role === "developer")
        .map((m) => m.text)
        .join("\n");
      headers.originator = "codex-tui";
      headers["openai-beta"] = "responses=experimental";
    }
    const account = credential.accountId ?? upstream.accountId;
    if (account && upstream.authMode !== "siwc")
      headers["chatgpt-account-id"] = account;
    if (request.sessionId) headers.session_id = request.sessionId;
    if (imageTool) {
      body.tools = [imageTool];
      body.tool_choice = { type: "image_generation" };
    }
  } else if (kind === "grok") {
    suffix = "/responses";
    body.stream = true;
    body.store = false;
    delete body.previous_response_id;
    headers["x-xai-token-auth"] = "xai-grok-cli";
    headers["x-grok-client-identifier"] = "grok-shell";
    headers["x-authenticateresponse"] = "authenticate-response";
    headers["accept"] = "text/event-stream";
    headers["x-grok-client-version"] = "1.0.46";
    headers["user-agent"] = "xai-grok-workspace/1.0.46";
    if (request.sessionId) {
      headers["x-grok-conv-id"] = request.sessionId;
      body.prompt_cache_key = request.sessionId;
    }
  } else if (kind === "claude-subscription") {
    suffix = url.pathname.replace(/\/$/, "").endsWith("/v1")
      ? "/messages"
      : "/v1/messages";
    headers["anthropic-version"] = "2023-06-01";
    headers["anthropic-beta"] =
      "claude-code-20250219,oauth-2025-04-20,interleaved-thinking-2025-05-14";
    if (request.sessionId)
      headers["x-claude-code-session-id"] = request.sessionId;
  } else {
    const project = credential.projectId ?? upstream.projectId;
    if (!project)
      throw new HostError(
        "project_required",
        "Antigravity requires an authorized project ID",
      );
    // OpenAI clients often retain call IDs but omit Google's signature extension.
    // Antigravity accepts this compatibility marker for unsigned tool history.
    for (const content of body.contents ?? [])
      for (const part of content.parts ?? [])
        if (part.functionCall && !part.thoughtSignature)
          part.thoughtSignature = "skip_thought_signature_validator";
    // Both client modes share the provider's terminal signature and usage frames.
    suffix = "/v1internal:streamGenerateContent";
    body = {
      project,
      model: request.model,
      userAgent: "antigravity",
      requestType: "agent",
      requestId: "agent-" + randomUUID(),
      request: {
        ...body,
        sessionId:
          "-" +
          String(
            BigInt(
              "0x" +
                createHash("sha256")
                  .update(request.sessionId ?? randomUUID())
                  .digest("hex")
                  .slice(0, 14),
            ),
          ),
      },
    };
    delete body.request.model;
    headers["user-agent"] = antigravityUserAgent;
    url.searchParams.set("alt", "sse");
  }
  url.pathname = url.pathname.replace(/\/$/, "") + suffix;
  return { url: url.href, headers, body, protocol };
}
