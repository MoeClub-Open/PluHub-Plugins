import { createHash, randomBytes, randomUUID } from "node:crypto";
import { HostError, requiredString, type Host } from "@pluhub/sdk";
import {
  subscriptionDefaults,
  subscriptionKind,
  type SubscriptionKind,
} from "../ai/subscription-auth.js";
import { oauthConfig, responseObject, tokenRequest } from "./oauth.js";

const deviceOrigin = "https://auth.openai.com";
const deviceApi = deviceOrigin + "/api/accounts/deviceauth";
type Scope = { actor: string; owner: string };
type Flow = Scope & {
  provider: SubscriptionKind;
  state: string;
  verifier: string;
  expiresAt: number;
  name: string;
  accountId?: string;
  maxConcurrency: number;
  redirectUri: string;
  mode: "manual" | "callback" | "device";
  controller: AbortController;
  code?: string;
  denied?: boolean;
  deviceId?: string;
  userCode?: string;
  interval: number;
  nextPollAt: number;
  task?: Promise<any>;
};
const failure = (code: string, message: string, status = 400): never => {
  throw new HostError(code, message, status);
};

/** Short-lived OAuth state stays server-side; only the creating session can save an account. */
export function createSubscriptionOAuth(
  host: Host,
  save: (input: Record<string, any>, owner: string) => unknown,
  kind: SubscriptionKind,
) {
  const callbackPath = `/api/plugins/official.upstream-${kind}/oauth/callback`;
  const flows = new Map<string, Flow>();
  const stop = new AbortController();
  const signal = (flow: Flow) =>
    AbortSignal.any([
      stop.signal,
      flow.controller.signal,
      AbortSignal.timeout(30000),
    ]);
  function remove(id: string) {
    flows.get(id)?.controller.abort();
    flows.delete(id);
  }
  function get(id: string, scope: Scope) {
    const flow = flows.get(id);
    if (
      !flow ||
      flow.actor !== scope.actor ||
      flow.owner !== scope.owner ||
      flow.expiresAt <= Date.now()
    ) {
      if (flow?.expiresAt && flow.expiresAt <= Date.now()) remove(id);
      failure("oauth_session", "授权会话已过期，请重新开始", 409);
    }
    return flow!;
  }
  function deviceSupported(provider: SubscriptionKind) {
    const profile = oauthConfig(host, provider);
    return (
      provider === "codex" &&
      ["authorizeUrl", "tokenUrl", "clientId"].every(
        (field) =>
          profile[field] ===
          subscriptionDefaults.codex[
            field as keyof typeof subscriptionDefaults.codex
          ],
      )
    );
  }
  function automatic(redirectUri: string, requestUrl: string) {
    return redirectUri === new URL(callbackPath, requestUrl).href;
  }
  const providers = (requestUrl: string) =>
    [kind].map((provider) => {
      const config = oauthConfig(host, provider);
      return {
        provider,
        ready: provider !== "antigravity" || !!config.clientSecretRef,
        device: deviceSupported(provider),
        automatic: automatic(config.redirectUri, requestUrl),
        callbackUrl: new URL(callbackPath, requestUrl).href,
      };
    });
  async function deviceRequest(
    path: string,
    body: Record<string, string>,
    s: AbortSignal,
  ) {
    return host.call<Response>(
      "http.transport@1",
      {
        url: deviceApi + path,
        publicOnly: true,
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      s,
    );
  }
  async function complete(
    id: string,
    flow: Flow,
    code: string,
    verifier = flow.verifier,
    redirectUri = flow.redirectUri,
  ) {
    const token = await tokenRequest(
      host,
      flow.provider,
      {
        grant_type: "authorization_code",
        code,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        ...(flow.provider === "claude-subscription"
          ? { state: flow.state }
          : {}),
      },
      signal(flow),
    );
    flow.controller.signal.throwIfAborted();
    if (flows.get(id) !== flow || flow.expiresAt <= Date.now())
      failure("oauth_session", "授权会话已过期，请重新开始", 409);
    if (!token.access_token)
      failure("oauth_response", "授权响应缺少访问令牌", 502);
    return save(
      {
        id: flow.accountId,
        provider: flow.provider,
        name: flow.name,
        maxConcurrency: flow.maxConcurrency,
        authorization: token,
      },
      flow.owner,
    );
  }
  async function start(
    input: Record<string, any>,
    scope: Scope,
    requestUrl: string,
  ) {
    const provider = subscriptionKind(input.provider ?? kind),
      config = oauthConfig(host, provider);
    if (provider !== kind)
      failure("subscription_provider", "订阅账号与提供商不匹配");
    if (provider === "antigravity" && !config.clientSecretRef)
      failure(
        "oauth_client_secret",
        "请先配置 Antigravity OAuth 客户端密钥引用",
        503,
      );
    if (input.mode !== undefined && !["browser", "device"].includes(input.mode))
      failure("oauth_mode", "无效的授权方式");
    if (input.mode === "device" && !deviceSupported(provider))
      failure("oauth_mode", "当前提供商不支持设备授权");
    for (const [id, flow] of flows)
      if (flow.expiresAt <= Date.now()) remove(id);
    if (
      flows.size >= 100 ||
      [...flows.values()].filter((f) => f.actor === scope.actor).length >= 5
    )
      failure("oauth_busy", "待完成的授权过多，请稍后重试", 429);
    const id = randomUUID(),
      flow: Flow = {
        ...scope,
        provider,
        state: randomBytes(32).toString("base64url"),
        verifier: randomBytes(64).toString("base64url"),
        expiresAt: Date.now() + 600000,
        name: requiredString(input.name, "name", 128),
        accountId: input.id,
        maxConcurrency: input.maxConcurrency,
        redirectUri: config.redirectUri,
        mode:
          input.mode === "device"
            ? "device"
            : automatic(config.redirectUri, requestUrl)
              ? "callback"
              : "manual",
        controller: new AbortController(),
        interval: 5000,
        nextPollAt: 0,
      };
    flows.set(id, flow);
    try {
      if (flow.mode === "device") {
        const s = signal(flow),
          response = await deviceRequest(
            "/usercode",
            { client_id: config.clientId },
            s,
          );
        if (!response.ok) {
          await response.body?.cancel();
          failure(
            "oauth_device_unavailable",
            "设备授权暂不可用，请使用浏览器授权",
            502,
          );
        }
        const result = await responseObject(response, s);
        flow.deviceId = requiredString(
          result.device_auth_id,
          "device_auth_id",
          4096,
        );
        flow.userCode = requiredString(
          result.user_code ?? result.usercode,
          "user_code",
          128,
        );
        const interval = Number(result.interval ?? 5);
        if (!Number.isFinite(interval) || interval < 0 || interval > 300)
          failure("oauth_response", "授权响应格式无效", 502);
        flow.interval = Math.max(1000, interval * 1000);
        flow.expiresAt = Date.now() + 900000;
        flow.nextPollAt = Date.now() + flow.interval;
        return {
          id,
          mode: flow.mode,
          url: deviceOrigin + "/codex/device",
          userCode: flow.userCode,
          expiresAt: flow.expiresAt,
          retryAfterMs: flow.interval,
        };
      }
      const url = new URL(config.authorizeUrl);
      for (const [key, value] of Object.entries({
        response_type: "code",
        client_id: config.clientId,
        redirect_uri: flow.redirectUri,
        scope: config.scope,
        state: flow.state,
        code_challenge: createHash("sha256")
          .update(flow.verifier)
          .digest("base64url"),
        code_challenge_method: "S256",
      }))
        url.searchParams.set(key, String(value));
      if (provider === "codex") {
        url.searchParams.set("id_token_add_organizations", "true");
        url.searchParams.set("codex_cli_simplified_flow", "true");
      }
      if (provider === "antigravity") {
        url.searchParams.set("access_type", "offline");
        url.searchParams.set("prompt", "consent");
      }
      return {
        id,
        mode: flow.mode,
        url: url.href,
        expiresAt: flow.expiresAt,
        retryAfterMs: 1500,
      };
    } catch (error) {
      remove(id);
      throw error;
    }
  }
  async function finish(id: string, callback: string, scope: Scope) {
    const flow = get(id, scope);
    if (flow.mode === "device" || flow.task)
      failure("oauth_session", "授权会话已过期，请重新开始", 409);
    let code: string | null, state: string | null;
    if (/^https?:\/\//.test(callback)) {
      const url = new URL(callback),
        expected = new URL(flow.redirectUri);
      if (url.origin !== expected.origin || url.pathname !== expected.pathname)
        failure("oauth_redirect", "授权回调地址不匹配");
      code = url.searchParams.get("code");
      state = url.searchParams.get("state");
      if (url.searchParams.has("error") && state === flow.state) {
        remove(id);
        failure("oauth_denied", "授权已取消，请重新开始");
      }
    } else [code, state] = callback.split("#");
    if (!code || state !== flow.state) failure("oauth_state", "授权状态不匹配");
    flow.task = complete(id, flow, code!).finally(() => flows.delete(id));
    return flow.task;
  }
  async function status(id: string, scope: Scope) {
    const flow = get(id, scope);
    if (flow.denied) {
      remove(id);
      failure("oauth_denied", "授权已取消，请重新开始");
    }
    const waiting = () => ({
      status: "pending",
      retryAfterMs: Math.max(1000, flow.nextPollAt - Date.now()),
    });
    if (flow.task) return flow.task;
    if (flow.mode === "manual" || (flow.mode === "callback" && !flow.code))
      return waiting();
    if (flow.mode === "device" && Date.now() < flow.nextPollAt)
      return waiting();
    flow.task = (async () => {
      try {
        let code = flow.code!,
          verifier = flow.verifier,
          redirectUri = flow.redirectUri;
        if (flow.mode === "device") {
          flow.nextPollAt = Date.now() + flow.interval;
          const s = signal(flow),
            response = await deviceRequest(
              "/token",
              { device_auth_id: flow.deviceId!, user_code: flow.userCode! },
              s,
            );
          if ([403, 404, 429].includes(response.status)) {
            if (response.status === 429) {
              flow.interval = Math.min(300000, flow.interval + 5000);
              flow.nextPollAt = Date.now() + flow.interval;
            }
            await response.body?.cancel();
            return waiting();
          }
          if (!response.ok) {
            await response.body?.cancel();
            failure("oauth_device_failed", "设备授权失败，请重新开始", 502);
          }
          const result = await responseObject(response, s);
          code = requiredString(
            result.authorization_code,
            "authorization_code",
            8192,
          );
          verifier = requiredString(
            result.code_verifier,
            "code_verifier",
            4096,
          );
          if (
            createHash("sha256").update(verifier).digest("base64url") !==
            result.code_challenge
          )
            failure("oauth_response", "授权响应格式无效", 502);
          redirectUri = deviceOrigin + "/deviceauth/callback";
        }
        const account = await complete(id, flow, code, verifier, redirectUri);
        flows.delete(id);
        return { status: "complete", account };
      } catch (error) {
        remove(id);
        throw error;
      } finally {
        flow.task = undefined;
      }
    })();
    return flow.task;
  }
  function receive(request: Request) {
    const url = new URL(request.url),
      state = url.searchParams.get("state");
    const match = [...flows.entries()].find(
      ([, f]) =>
        f.mode === "callback" && f.state === state && f.expiresAt > Date.now(),
    );
    if (!match || url.searchParams.getAll("state").length !== 1)
      failure("oauth_state", "授权状态不匹配");
    const [, flow] = match!,
      expected = new URL(flow.redirectUri);
    if (url.origin !== expected.origin || url.pathname !== expected.pathname)
      failure("oauth_redirect", "授权回调地址不匹配");
    if (flow.code || flow.denied || flow.task)
      failure("oauth_session", "授权会话已过期，请重新开始", 409);
    if (url.searchParams.has("error")) flow.denied = true;
    else {
      if (url.searchParams.getAll("code").length !== 1)
        failure("oauth_response", "授权响应格式无效");
      flow.code = requiredString(url.searchParams.get("code"), "code", 8192);
    }
    const english = request.headers.get("accept-language")?.startsWith("en");
    const title = flow.denied
      ? english
        ? "Authorization cancelled"
        : "授权已取消"
      : english
        ? "Authorization received"
        : "授权已收到";
    const text = english
      ? "You can close this page and return to the original window."
      : "可以关闭此页面，返回原窗口完成连接。";
    return new Response(
      `<!doctype html><html lang="${english ? "en" : "zh-CN"}"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><body><h1>${title}</h1><p>${text}</p></body></html>`,
      {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "referrer-policy": "no-referrer",
          "content-security-policy":
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
        },
      },
    );
  }
  return {
    start,
    finish,
    status,
    providers,
    receive,
    cancel(id: string, scope: Scope) {
      get(id, scope);
      remove(id);
      return { ok: true };
    },
    async close() {
      stop.abort();
      const tasks = [...flows.values()].flatMap((f) =>
        f.task ? [f.task] : [],
      );
      for (const id of flows.keys()) remove(id);
      await Promise.allSettled(tasks);
    },
  };
}
