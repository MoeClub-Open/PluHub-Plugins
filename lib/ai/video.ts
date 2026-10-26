import { setTimeout } from "node:timers/promises";
import { HostError, type Host } from "@pluhub/sdk";
import { responseObject } from "./json-response.js";

/** Keep one gateway execution and reservation until an accepted provider job finishes. */
export async function completedVideo(
  host: Host,
  response: Response,
  endpoint: URL,
  headers: Headers,
  publicOnly: boolean | undefined,
  signal: AbortSignal,
): Promise<Response> {
  if (!response.headers.get("content-type")?.includes("json")) return response;
  const get = async (suffix: string) => {
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/$/, "") + suffix;
    const result = await host.call<Response>(
      "http.transport@1",
      {
        url: url.href,
        method: "GET",
        headers: Object.fromEntries(headers),
        publicOnly,
      },
      signal,
    );
    if (!result.ok) {
      await result.body?.cancel();
      throw new HostError("upstream_error", "视频任务查询或下载失败", 502);
    }
    return result;
  };
  let job = await responseObject(response, signal, 64 * 1024 * 1024);
  const id = typeof job.id === "string" ? job.id : undefined;
  while (
    ["queued", "pending", "in_progress", "processing", "running"].includes(
      job.status,
    )
  ) {
    if (!id) throw new HostError("upstream_protocol", "视频任务缺少标识", 502);
    await setTimeout(2000, undefined, { signal });
    job = await responseObject(await get("/" + encodeURIComponent(id)), signal);
  }
  if (
    job.error ||
    ["failed", "cancelled", "canceled", "expired"].includes(job.status)
  )
    throw new HostError(
      "upstream_generation_failed",
      "视频生成失败，请查看调用记录",
      502,
    );
  if (Array.isArray(job.data) && job.data.length) return Response.json(job);
  const url = job.url ?? job.video_url;
  if (typeof url === "string")
    return Response.json({ ...job, data: [{ url }] });
  if (id && job.status === "completed")
    return get("/" + encodeURIComponent(id) + "/content");
  throw new HostError("upstream_protocol", "上游未返回已完成的视频", 502);
}
