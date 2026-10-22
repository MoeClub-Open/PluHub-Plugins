import { HostError, requiredString } from "@pluhub/sdk";
import type {
  ContentPart,
  Message,
  Protocol,
  ReasoningContent,
} from "@pluhub/contracts/ai";
export function unsupported(field: string): never {
  throw new HostError("unsupported_feature", "Unsupported feature: " + field);
}
export function object(value: any, name = "object"): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new HostError("invalid_request", "Invalid " + name);
  return value;
}
export function keys(value: any, allowed: string[], where: string) {
  object(value, where);
  for (const key of Object.keys(value))
    if (!allowed.includes(key)) unsupported(where + "." + key);
}
export function string(value: unknown, name: string, max = 1048576) {
  if (typeof value !== "string" || value.length > max)
    throw new HostError("invalid_request", "Invalid " + name);
  return value;
}
const imageTypes = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export function image(
  url: unknown,
  mediaType?: string,
  detail?: string,
): ContentPart {
  const value = requiredString(url, "image URL", 20 * 1024 * 1024);
  if (value.startsWith("data:")) {
    const m =
      /^data:(image\/(?:png|jpeg|gif|webp));base64,([A-Za-z0-9+/]+={0,2})$/.exec(
        value,
      );
    if (!m || Buffer.from(m[2]!, "base64").toString("base64") !== m[2])
      throw new HostError("invalid_request", "Invalid image data URL");
    if (mediaType && mediaType !== m[1])
      throw new HostError("invalid_request", "Conflicting image media types");
    mediaType = m[1];
  } else {
    let target: URL;
    try {
      target = new URL(value);
    } catch {
      throw new HostError("invalid_request", "Invalid image URL");
    }
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.hash
    )
      throw new HostError("invalid_request", "Invalid image URL");
  }
  if (mediaType && !imageTypes.includes(mediaType))
    unsupported("image media type");
  if (detail !== undefined && !["auto", "low", "high"].includes(detail))
    throw new HostError("invalid_request", "Invalid image detail");
  return {
    type: "image",
    url: value,
    ...(mediaType ? { mediaType } : {}),
    ...(detail ? { detail: detail as "auto" | "low" | "high" } : {}),
  };
}
export function readContent(protocol: Protocol, value: unknown): ContentPart[] {
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (value === null || value === undefined) return [];
  if (!Array.isArray(value))
    throw new HostError(
      "invalid_request",
      "Content must be text or content parts",
    );
  return value.map((part: any) => {
    object(part, "content part");
    if (["text", "input_text", "output_text"].includes(part.type)) {
      keys(part, ["type", "text", "annotations"], "text part");
      if (part.annotations?.length) unsupported("input annotations");
      return { type: "text", text: string(part.text, "text") };
    }
    if (protocol === "openai-chat" && part.type === "image_url") {
      keys(part, ["type", "image_url"], "image");
      keys(part.image_url, ["url", "detail"], "image_url");
      return image(part.image_url.url, undefined, part.image_url.detail);
    }
    if (protocol === "openai-responses" && part.type === "input_image") {
      keys(part, ["type", "image_url", "detail"], "image");
      return image(part.image_url, undefined, part.detail);
    }
    if (protocol === "anthropic" && part.type === "image") {
      keys(part, ["type", "source"], "image");
      const source = object(part.source);
      if (source.type === "url") {
        keys(source, ["type", "url"], "image source");
        return image(source.url);
      }
      if (source.type === "base64") {
        keys(source, ["type", "media_type", "data"], "image source");
        return image(
          "data:" + source.media_type + ";base64," + source.data,
          source.media_type,
        );
      }
    }
    if (protocol === "gemini") {
      if (part.text !== undefined) {
        keys(part, ["text"], "text part");
        return { type: "text", text: string(part.text, "text") };
      }
      const inline = part.inlineData ?? part.inline_data,
        file = part.fileData ?? part.file_data;
      if (inline) {
        keys(part, ["inlineData", "inline_data"], "image");
        keys(inline, ["mimeType", "mime_type", "data"], "inline image");
        return image(
          "data:" +
            (inline.mimeType ?? inline.mime_type) +
            ";base64," +
            inline.data,
          inline.mimeType ?? inline.mime_type,
        );
      }
      if (file) {
        keys(part, ["fileData", "file_data"], "image");
        keys(
          file,
          ["mimeType", "mime_type", "fileUri", "file_uri"],
          "file image",
        );
        return image(
          file.fileUri ?? file.file_uri,
          file.mimeType ?? file.mime_type,
        );
      }
    }
    return unsupported(
      "content part " + (part.type ?? Object.keys(part).join(",")),
    );
  });
}
export function contentMessage(
  role: Message["role"],
  parts: ContentPart[],
): Message {
  return {
    role,
    text: parts
      .filter((p) => p.type === "text")
      .map((p) => p.text)
      .join(""),
    ...(parts.some((p) => p.type === "image") ? { content: parts } : {}),
  };
}
export function writeContent(protocol: Protocol, m: Message): any {
  const parts = m.content ?? [{ type: "text", text: m.text }];
  if (!m.content && protocol !== "gemini") return m.text;
  return parts.map((p) => {
    if (p.type === "image" && m.role === "tool" && protocol !== "anthropic")
      return unsupported("multimodal tool output in " + protocol);
    if (p.type === "text")
      return protocol === "gemini"
        ? { text: p.text }
        : {
            type:
              protocol === "openai-responses"
                ? m.role === "assistant"
                  ? "output_text"
                  : "input_text"
                : "text",
            text: p.text,
          };
    if (m.role !== "user" && m.role !== "tool")
      return unsupported("image in " + m.role + " message");
    if (protocol === "openai-chat")
      return {
        type: "image_url",
        image_url: { url: p.url, ...(p.detail ? { detail: p.detail } : {}) },
      };
    if (protocol === "openai-responses")
      return {
        type: "input_image",
        image_url: p.url,
        ...(p.detail ? { detail: p.detail } : {}),
      };
    if (p.detail && p.detail !== "auto")
      return unsupported("image detail for " + protocol);
    const data = /^data:([^;]+);base64,(.+)$/.exec(p.url);
    if (protocol === "anthropic")
      return {
        type: "image",
        source: data
          ? { type: "base64", media_type: data[1], data: data[2] }
          : { type: "url", url: p.url },
      };
    if (data) return { inlineData: { mimeType: data[1], data: data[2] } };
    if (!p.mediaType)
      return unsupported("Gemini remote image requires media type");
    return { fileData: { mimeType: p.mediaType, fileUri: p.url } };
  });
}
const signaturePrefix = "pluhub.v1.";
/** Gateway envelopes preserve provider provenance; they are never sent to a different provider. */
export function packReasoning(
  block: ReasoningContent,
  target: Protocol,
): string | undefined {
  if (block.source === target)
    return block.signature ?? block.encrypted ?? block.redacted;
  const { source, signature, encrypted, redacted, id } = block;
  return (
    signaturePrefix +
    Buffer.from(
      JSON.stringify({ source, text: "", signature, encrypted, redacted, id }),
    ).toString("base64url")
  );
}
export function readReasoning(
  source: Protocol,
  text: unknown,
  signature?: unknown,
  extra: Partial<ReasoningContent> = {},
): ReasoningContent {
  const result = {
    source,
    text: string(text ?? "", "reasoning text"),
    ...extra,
  };
  if (signature === undefined || signature === "") return result;
  const value = string(signature, "reasoning signature");
  if (!value.startsWith(signaturePrefix))
    return { ...result, signature: value };
  try {
    const raw = object(
      JSON.parse(
        Buffer.from(
          value.slice(signaturePrefix.length),
          "base64url",
        ).toString(),
      ),
    );
    if (
      !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(
        raw.source,
      )
    )
      throw new Error();
    keys(
      raw,
      ["source", "text", "signature", "encrypted", "redacted", "id"],
      "reasoning envelope",
    );
    for (const key of ["text", "signature", "encrypted", "redacted", "id"])
      if (raw[key] !== undefined) string(raw[key], key);
    return { ...raw, text: result.text || raw.text || "" } as ReasoningContent;
  } catch {
    throw new HostError(
      "invalid_request",
      "Invalid reasoning signature envelope",
    );
  }
}
export function assertReasoningTarget(
  block: ReasoningContent,
  target: Protocol,
) {
  if (
    block.source !== target &&
    (block.signature || block.encrypted || block.redacted)
  )
    unsupported("signed reasoning belongs to " + block.source);
}
