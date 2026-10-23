import { HostError } from "@pluhub/sdk";
import { mediaKinds } from "./media.js";
import type {
  Protocol,
  Upstream,
  UpstreamHttpSettings,
  UpstreamInterface,
} from "@pluhub/contracts/ai";

export const apiProtocols: readonly Protocol[] = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
];
export const protocolPaths: Record<Protocol, string> = {
  "openai-chat": "/v1/chat/completions",
  "openai-responses": "/v1/responses",
  anthropic: "/v1/messages",
  gemini: "/v1beta/models/{model}:generateContent",
};
function bad(message: string): never {
  throw new HostError("invalid_interfaces", message);
}

export function validateInterfaces(
  value: unknown,
): UpstreamInterface[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.length) bad("请配置至少一条接口路由");
  for (const route of value) {
    if (
      !route ||
      !apiProtocols.includes(route.protocol) ||
      !Array.isArray(route.incoming) ||
      !route.incoming.length ||
      route.incoming.some((p: Protocol) => !apiProtocols.includes(p))
    )
      bad("请选择有效的入口与上游接口");
    if (
      route.models !== undefined &&
      (!Array.isArray(route.models) ||
        route.models.some(
          (model: unknown) => typeof model !== "string" || !model.trim(),
        ))
    )
      bad("模型匹配规则不能为空");
    if (
      route.mediaPaths !== undefined &&
      (!route.mediaPaths ||
        typeof route.mediaPaths !== "object" ||
        Array.isArray(route.mediaPaths) ||
        Object.keys(route.mediaPaths).some(
          (kind) => !mediaKinds.includes(kind as any),
        ))
    )
      bad("Invalid media endpoint paths");
    for (const path of [
      route.path,
      route.streamPath,
      route.modelsPath,
      ...Object.values(route.mediaPaths ?? {}),
    ])
      if (
        path !== undefined &&
        (typeof path !== "string" ||
          !path.startsWith("/") ||
          path.startsWith("//") ||
          path.includes("#"))
      )
        bad("接口路径必须以 / 开头");
    if (
      route.headers !== undefined &&
      (!route.headers ||
        typeof route.headers !== "object" ||
        Array.isArray(route.headers))
    )
      bad("请求头必须是 JSON 对象");
    for (const [name, value] of Object.entries(route.headers ?? {}))
      if (
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
        typeof value !== "string" ||
        /[\r\n]/.test(value) ||
        ["host", "content-length", "connection", "transfer-encoding"].includes(
          name.toLowerCase(),
        )
      )
        bad("请求头名称或值无效");
    if (
      route.params !== undefined &&
      (!route.params ||
        typeof route.params !== "object" ||
        Array.isArray(route.params))
    )
      bad("请求参数必须是 JSON 对象");
    if (
      [
        "model",
        "stream",
        "max_tokens",
        "max_output_tokens",
        "max_completion_tokens",
        "stream_options",
      ].some((key) => Object.hasOwn(route.params ?? {}, key)) ||
      route.params?.generationConfig?.maxOutputTokens !== undefined ||
      route.params?.generationConfig?.candidateCount !== undefined
    )
      bad("模型、输出预算和用量采集由渠道流程决定");
    if (
      route.auth &&
      (!["default", "none", "bearer", "header", "query"].includes(
        route.auth.type,
      ) ||
        (["header", "query"].includes(route.auth.type) &&
          (typeof route.auth.name !== "string" || !route.auth.name.trim())))
    )
      bad("请填写有效的认证方式与字段名");
    if (route.auth?.type === "header") {
      const name = route.auth.name as string;
      if (
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(name) ||
        ["host", "content-length", "connection", "transfer-encoding"].includes(
          name.toLowerCase(),
        )
      )
        bad("认证请求头无效");
    }
  }
  return structuredClone(value);
}

export function interfaceMatches(route: UpstreamInterface, model: string) {
  return (
    !route.models?.length ||
    route.models.some((rule) => {
      const parts = rule.split("*");
      if (parts.length === 1) return rule === model;
      if (!model.startsWith(parts[0]!)) return false;
      let cursor = parts[0]!.length;
      for (const part of parts.slice(1, -1)) {
        const index = model.indexOf(part, cursor);
        if (index < 0) return false;
        cursor = index + part.length;
      }
      const tail = parts.at(-1)!;
      return model.endsWith(tail) && model.length - tail.length >= cursor;
    })
  );
}

/** Keep the selected interface in the plan so execution cannot reselect it. */
export function resolveInterface(
  connection: Upstream,
  ingress: Protocol | undefined,
  model: string,
): Upstream {
  if (!connection.interfaces) return connection;
  const route = connection.interfaces.find(
    (route) =>
      interfaceMatches(route, model) &&
      (!ingress || route.incoming.includes(ingress)),
  );
  if (!route)
    throw new HostError(
      "interface_not_supported",
      "该渠道未配置此模型与入口的接口路由",
      400,
    );
  const { interfaces: _interfaces, ...base } = connection;
  const { protocol, incoming: _incoming, models: _models, ...http } = route;
  return { ...base, protocol, http };
}

/** Used for discovery and credential grants, without selecting a client route. */
export function connectionInterfaces<T extends Upstream>(connection: T): T[] {
  if (!connection.interfaces) return [connection];
  return connection.interfaces.map(
    ({ protocol, incoming: _incoming, models: _models, ...http }) => ({
      ...connection,
      interfaces: undefined,
      protocol,
      http,
    }),
  );
}

export function upstreamUrl(baseUrl: string, path: string, model = "") {
  const url = new URL(baseUrl);
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  )
    throw new HostError("invalid_upstream", "无效的上游地址");
  const target = path.replaceAll(
    "{model}",
    encodeURIComponent(model.replace(/^models\//, "")),
  );
  const parsed = new URL(target, "https://upstream.invalid");
  let suffix = parsed.pathname;
  const prefix = url.pathname.replace(/\/$/, "");
  for (const version of ["/v1", "/v1beta"])
    if (prefix.endsWith(version) && suffix.startsWith(version + "/"))
      suffix = suffix.slice(version.length);
  url.pathname = prefix + suffix;
  url.search = parsed.search;
  return url;
}

export function interfaceHeaders(
  protocol: string,
  http: UpstreamHttpSettings | undefined,
  key: string,
  url: URL,
) {
  const headers = new Headers({ "content-type": "application/json" });
  if (protocol === "anthropic") headers.set("anthropic-version", "2023-06-01");
  const auth = http?.auth;
  if (!auth || auth.type === "default") {
    if (protocol === "anthropic") headers.set("x-api-key", key);
    else if (protocol === "gemini") headers.set("x-goog-api-key", key);
    else headers.set("authorization", "Bearer " + key);
  } else if (auth.type === "bearer")
    headers.set("authorization", "Bearer " + key);
  else if (auth.type === "header") headers.set(auth.name!, key);
  else if (auth.type === "query") url.searchParams.set(auth.name!, key);
  for (const [name, value] of Object.entries(http?.headers ?? {}))
    headers.set(name, value.replaceAll("{key}", key));
  return Object.fromEntries(headers);
}

export function requestPath(
  protocol: Protocol,
  http: UpstreamHttpSettings | undefined,
  stream: boolean,
) {
  let path =
    (stream ? http?.streamPath : undefined) ??
    http?.path ??
    protocolPaths[protocol];
  if (protocol === "gemini" && stream && !http?.streamPath)
    path = path.replace(":generateContent", ":streamGenerateContent");
  return path;
}
