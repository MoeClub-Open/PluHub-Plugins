import { it, expect } from "vitest";
import { readChatStream } from "../plugins/playground/chat-stream.js";
const bytes = new TextEncoder();
function body(text: string) {
  const encoded = bytes.encode(text);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (offset === encoded.length) c.close();
      else c.enqueue(encoded.slice(offset, ++offset));
    },
  });
}
it("reads split UTF-8 SSE frames and usage without losing text", async () => {
  const events: any[] = [];
  await readChatStream(
    body(
      ': ping\r\ndata: {"choices":[{"delta":{"content":"你好"}}]}\r\n\r\ndata: {"usage":{"prompt_tokens":2,"completion_tokens":1}}\n\ndata: [DONE]\n\n',
    ),
    (e) => events.push(e),
  );
  expect(events[0].choices[0].delta.content).toBe("你好");
  expect(events[1].usage.completion_tokens).toBe(1);
});
it("reports interrupted streams and provider error events", async () => {
  await expect(
    readChatStream(body('data: {"choices":[]}\n\n'), () => {}),
  ).rejects.toThrow("意外中断");
  await expect(
    readChatStream(body('data: {"error":{"message":"denied"}}\n\n'), () => {}),
  ).rejects.toThrow("denied");
});
