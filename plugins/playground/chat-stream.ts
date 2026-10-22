export async function readChatStream(
  body: ReadableStream<Uint8Array>,
  update: (event: any) => void,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  let doneEvent = false;
  const line = (value: string) => {
    if (!value.startsWith("data:")) return;
    const data = value.slice(5).trim();
    if (data === "[DONE]") {
      doneEvent = true;
      return;
    }
    if (!data) return;
    const event = JSON.parse(data);
    if (event.error) throw new Error(event.error.message ?? "调用失败");
    update(event);
  };
  try {
    for (;;) {
      const part = await reader.read();
      pending += part.done
        ? decoder.decode()
        : decoder.decode(part.value, { stream: true });
      if (pending.length > 1024 * 1024) throw new Error("流式事件超过大小限制");
      let index;
      while ((index = pending.indexOf("\n")) >= 0) {
        line(pending.slice(0, index).replace(/\r$/, ""));
        pending = pending.slice(index + 1);
      }
      if (part.done) {
        if (pending) line(pending);
        break;
      }
    }
    if (!doneEvent) throw new Error("响应流意外中断，请查看调用记录");
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
