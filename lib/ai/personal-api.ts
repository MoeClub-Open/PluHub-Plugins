/** User-pasted connection data; no file access or network side effects. */
export function parseApiConnection(text: string) {
  if (text.length > 65536) throw new Error("连接 JSON 过大");
  let value: any;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("连接 JSON 格式无效");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("连接 JSON 格式无效");
  const key = value.key ?? value.api_key ?? value.apiKey,
    baseUrl = value.url ?? value.base_url ?? value.baseUrl;
  if (
    typeof key !== "string" ||
    !key.trim() ||
    key.length > 16384 ||
    /[\r\n\0]/.test(key)
  )
    throw new Error("连接 JSON 缺少有效密钥");
  if (typeof baseUrl !== "string" || baseUrl.length > 2048)
    throw new Error("连接 JSON 缺少有效地址");
  let url: URL;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error("连接 JSON 缺少有效地址");
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new Error("连接地址不允许包含凭证或参数");
  const protocol = value.protocol ?? "openai-chat";
  if (
    !["openai-chat", "openai-responses", "anthropic", "gemini"].includes(
      protocol,
    )
  )
    throw new Error("连接 JSON 包含无效协议");
  return {
    key: key.trim(),
    baseUrl: url.href.replace(/\/$/, ""),
    protocol,
    preset: value._type === "newapi_channel_conn" ? "newapi" : "custom",
    ...(typeof value.name === "string" && value.name.trim()
      ? { name: value.name.trim().slice(0, 128) }
      : {}),
  };
}
