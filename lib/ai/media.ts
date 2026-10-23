import { HostError, requiredString, readObject } from "@pluhub/sdk";
import type {
  AIRequest,
  MediaKind,
  MediaOperation,
  Usage,
  ModelRoute,
} from "@pluhub/contracts/ai";

export const mediaKinds: readonly MediaKind[] = [
  "embeddings",
  "images/generations",
  "images/edits",
  "audio/speech",
  "audio/transcriptions",
  "audio/translations",
];
export const mediaPaths = Object.fromEntries(
  mediaKinds.map((kind) => [kind, "/v1/" + kind]),
) as Record<MediaKind, string>;
const limit = 32 * 1024 * 1024;
const bad = (message: string): never => {
  throw new HostError("invalid_request", message);
};

export function validateOperations(operations: ModelRoute["operations"]) {
  if (
    operations !== undefined &&
    (!Array.isArray(operations) ||
      !operations.length ||
      operations.some((op) => op !== "chat" && !mediaKinds.includes(op)))
  )
    bad("Select valid model endpoints");
}

export async function readMedia(
  request: Request,
  kind: MediaKind,
): Promise<AIRequest> {
  let input: Record<string, any>;
  let parts: MediaOperation["parts"];
  if (request.headers.get("content-type")?.includes("multipart/form-data")) {
    if (!request.body) bad("Missing multipart body");
    // Bound the encoded body before invoking the multipart parser, including chunked requests.
    const bytes = await readBytes(request.body!, limit, request.signal);
    const form = await new Response(new Uint8Array(bytes), {
      headers: { "content-type": request.headers.get("content-type")! },
    })
      .formData()
      .catch(() => bad("Invalid multipart body"));
    input = {};
    parts = [];
    for (const [name, value] of form) {
      if (typeof value === "string") {
        if (["model", "stream"].includes(name) && Object.hasOwn(input, name))
          bad("Duplicate " + name);
        input[name] = value;
        parts.push({ name, value });
      } else {
        parts.push({
          name,
          value: {
            filename: value.name,
            contentType: value.type,
            data: new Uint8Array(await value.arrayBuffer()),
          },
        });
      }
    }
    for (const key of ["stream", "n", "partial_images", "temperature", "speed"])
      if (input[key] !== undefined) {
        if (key === "stream") {
          if (!["true", "false"].includes(input[key])) bad("Invalid stream");
          input[key] = input[key] === "true";
        } else input[key] = Number(input[key]);
      }
  } else input = await readObject(request, limit);
  const model = requiredString(input.model, "model", 256);
  if (input.stream !== undefined && typeof input.stream !== "boolean")
    bad("Invalid stream");
  if (kind === "embeddings") {
    const value = input.input;
    const tokens = (v: unknown): boolean =>
      Array.isArray(v) &&
      v.length > 0 &&
      v.every((n) => Number.isSafeInteger(n) && n >= 0);
    if (!(
      (typeof value === "string" && value.length) ||
      tokens(value) ||
      (Array.isArray(value) &&
        value.length &&
        value.every((v) => (typeof v === "string" && v.length) || tokens(v)))
    ))
      bad("Invalid embedding input");
    if (input.stream) bad("Embeddings do not support streaming");
  } else if (kind.startsWith("images/")) {
    requiredString(input.prompt, "prompt", 32000);
    if (
      input.n !== undefined &&
      (!Number.isSafeInteger(input.n) || input.n < 1)
    )
      bad("Invalid image count");
    if (
      kind === "images/edits" &&
      !parts?.some(
        (p) =>
          ["image", "image[]"].includes(p.name) && typeof p.value !== "string",
      ) &&
      !(Array.isArray(input.images) && input.images.length)
    )
      bad("Provide an input image");
  } else if (kind === "audio/speech") {
    requiredString(input.input, "input", 65536);
    if (
      !input.voice ||
      (typeof input.voice !== "string" && typeof input.voice !== "object")
    )
      bad("Provide a voice");
    if (input.stream && input.stream_format !== "sse")
      bad(
        "Use stream_format: sse for speech events; binary audio is streamed by default",
      );
    if (input.stream_format === "sse") input.stream = true;
  } else if (
    !parts?.some((p) => p.name === "file" && typeof p.value !== "string")
  )
    bad("Provide an audio file");
  if (kind === "audio/translations" && input.stream)
    bad("Audio translation does not support streaming");
  return {
    model,
    messages: [],
    tools: [],
    stream: !!input.stream,
    operation: { kind, input, ...(parts ? { parts } : {}) },
  };
}

export async function readBytes(
  body: ReadableStream<Uint8Array>,
  maximum: number,
  signal: AbortSignal,
): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  const abort = () => {
    void reader.cancel(signal.reason).catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      signal.throwIfAborted();
      if (item.done) break;
      length += item.value.length;
      if (length > maximum)
        throw new HostError(
          "body_too_large",
          "Media body exceeds the configured limit",
          413,
        );
      chunks.push(item.value);
    }
    return new Uint8Array(Buffer.concat(chunks));
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function mediaUsage(kind: MediaKind, body: any): Usage | undefined {
  const raw = body?.usage;
  const input = kind === "embeddings" ? raw?.prompt_tokens : raw?.input_tokens;
  const output = kind === "embeddings" ? 0 : raw?.output_tokens;
  if (![input, output].every((n) => Number.isSafeInteger(n) && n >= 0)) return;
  return { input, output };
}

/** Media output has no text-token cap; reserve the configured fixed price without inventing usage. */
export function mediaInputBound(request: AIRequest): number {
  const input = request.operation!.input.input;
  return (
    Buffer.byteLength(JSON.stringify(input ?? request.operation!.input)) + 1024
  );
}
