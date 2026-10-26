export type MediaAsset = { url: string; kind: "image" | "video"; name: string };

export async function mediaResult(response: Response, kind: "image" | "video") {
  if (!response.ok) {
    const error = await response.json().catch(() => ({}));
    throw new Error(
      error.error?.message ?? "请求失败（" + response.status + "）",
    );
  }
  const type = response.headers.get("content-type") ?? "";
  if (/^(video|image)\//.test(type) || type.includes("octet-stream")) {
    const blob = await response.blob();
    return {
      raw: { contentType: type, bytes: blob.size },
      assets: [
        {
          url: URL.createObjectURL(blob),
          kind,
          name: kind === "video" ? "video.mp4" : "image.png",
        },
      ],
    };
  }
  const raw = await response.json();
  const assets: MediaAsset[] = (raw.data ?? []).flatMap(
    (item: any, index: number) => {
      const format = item.output_format ?? raw.output_format ?? "png";
      const url =
        typeof item.b64_json === "string"
          ? `data:${kind === "image" ? "image/" + format : "video/mp4"};base64,${item.b64_json}`
          : (item.url ?? item.video_url);
      return typeof url === "string" &&
        /^(https?:\/\/|data:(?:image|video)\/)/i.test(url)
        ? [
            {
              url,
              kind,
              name:
                (kind === "image" ? "image" : "video") +
                "-" +
                (index + 1) +
                (kind === "image" ? "." + format : ".mp4"),
            },
          ]
        : [];
    },
  );
  if (!assets.length) throw new Error("上游未返回可展示的媒体结果");
  for (const asset of assets)
    if (asset.url.startsWith("data:"))
      asset.url = URL.createObjectURL(await (await fetch(asset.url)).blob());
  return { raw, assets };
}

export function resultJson(value: unknown) {
  return JSON.stringify(
    value,
    (key, item) =>
      key === "b64_json" && typeof item === "string"
        ? `[媒体数据，${item.length} 字符]`
        : item,
    2,
  );
}

export async function downloadMedia(asset: MediaAsset) {
  const response = await fetch(asset.url);
  if (!response.ok) throw new Error("下载失败，请尝试在新窗口打开结果");
  const url = URL.createObjectURL(await response.blob());
  const link = document.createElement("a");
  link.href = url;
  link.download = asset.name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
