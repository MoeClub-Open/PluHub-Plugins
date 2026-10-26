import { HostError } from "@pluhub/sdk";
import type { AIEvent, AIRequest } from "@pluhub/contracts/ai";
import { parseSSE } from "./sse.js";

export function codexImageRequest(request: AIRequest): AIRequest {
  const operation = request.operation!;
  if (!["images/generations", "images/edits"].includes(operation.kind))
    throw new HostError(
      "operation_not_supported",
      "Codex 订阅仅支持图片生成与编辑",
    );
  if (operation.input.n !== undefined && operation.input.n !== 1)
    throw new HostError("invalid_request", "Codex 图片接口每次生成一张图片");
  const images = [
    ...(
      (operation.input.images as { image_url: string }[] | undefined) ?? []
    ).map((image) => image.image_url),
    ...(operation.parts ?? []).flatMap((part) =>
      typeof part.value !== "string" && ["image", "image[]"].includes(part.name)
        ? [
            "data:" +
              part.value.contentType +
              ";base64," +
              Buffer.from(part.value.data).toString("base64"),
          ]
        : [],
    ),
  ];
  return {
    ...request,
    model:
      typeof operation.input.response_model === "string"
        ? operation.input.response_model
        : /^gpt-image-|^chatgpt-image-/.test(request.model)
          ? "gpt-6.1-sol"
          : request.model,
    messages: [
      {
        role: "user",
        text: String(operation.input.prompt),
        content: [
          { type: "text", text: String(operation.input.prompt) },
          ...images.map((url) => ({ type: "image" as const, url })),
        ],
      },
    ],
    stream: true,
  };
}

export function codexImageTool(request: AIRequest) {
  const input = request.operation!.input;
  const tool: Record<string, unknown> = {
    type: "image_generation",
    model:
      input.image_model ??
      (/^gpt-image-|^chatgpt-image-/.test(request.model)
        ? request.model
        : "gpt-image-2.5-sunburst"),
    action: request.operation!.kind === "images/edits" ? "edit" : "generate",
  };
  for (const name of [
    "size",
    "quality",
    "background",
    "output_format",
    "output_compression",
    "moderation",
  ])
    if (input[name] !== undefined) tool[name] = input[name];
  return tool;
}

export async function* codexImageEvents(
  body: ReadableStream<Uint8Array>,
  model: string,
  stream: boolean,
  format = "png",
): AsyncGenerator<AIEvent> {
  const images = new Map<string, any>();
  let completed: any;
  let started = false;
  for await (const frame of parseSSE(body, 64 * 1024 * 1024)) {
    if (frame.data === "[DONE]") continue;
    const data = JSON.parse(frame.data);
    if (
      !started &&
      (data.type?.startsWith("response.image_generation_call.") ||
        data.item?.type === "image_generation_call")
    ) {
      started = true;
      yield {
        type: "tool",
        index: 0,
        id: data.item_id ?? data.item?.id,
        name: "image_generation",
      };
    }
    if (data.item?.type === "image_generation_call" && data.item.result)
      images.set(data.item.id, data.item);
    if (data.type === "response.completed") {
      completed = data.response;
      for (const item of completed.output ?? [])
        if (item.type === "image_generation_call" && item.result)
          images.set(item.id, item);
    }
  }
  if (!completed || !images.size)
    throw new HostError(
      "upstream_truncated",
      "Codex 未返回完整图片，请查看调用记录",
      502,
    );
  const usage = completed.usage;
  if (
    Number.isSafeInteger(usage?.input_tokens) &&
    Number.isSafeInteger(usage?.output_tokens)
  )
    yield {
      type: "usage",
      usage: { input: usage.input_tokens, output: usage.output_tokens },
    };
  const data = [...images.values()].map((item) => ({
    b64_json: item.result,
    revised_prompt: item.revised_prompt,
    output_format: item.output_format ?? format,
  }));
  yield {
    type: "media",
    contentType: stream ? "text/event-stream" : "application/json",
    body: stream
      ? new TextEncoder().encode(
          "event: image_generation.completed\ndata: " +
            JSON.stringify({
              type: "image_generation.completed",
              ...data[0],
              usage,
            }) +
            "\n\n",
        )
      : { created: Math.floor(Date.now() / 1000), model, data, usage },
  };
  yield { type: "finish", reason: "stop" };
}
