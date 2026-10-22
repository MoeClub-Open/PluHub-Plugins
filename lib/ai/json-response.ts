import { HostError } from "@pluhub/sdk";
export async function responseObject(
  response: Response,
  signal: AbortSignal,
  limit = 262144,
) {
  if (!response.body)
    throw new HostError("upstream_response", "上游响应为空", 502);
  const reader = response.body.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const item = await reader.read();
      if (item.done) break;
      length += item.value.length;
      if (length > limit)
        throw new HostError("upstream_response", "上游响应过大", 502);
      chunks.push(item.value);
    }
    const value = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error();
    return value as Record<string, any>;
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (signal.aborted) throw signal.reason;
    if (error instanceof HostError) throw error;
    throw new HostError("upstream_response", "上游响应格式无效", 502);
  } finally {
    reader.releaseLock();
  }
}
