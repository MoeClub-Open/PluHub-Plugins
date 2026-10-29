import { definePlugin, HostError, requiredString } from "@pluhub/sdk";
import type { PaymentCheckout } from "@pluhub/contracts/commerce";
import { epaySign, epayVerify } from "../../lib/commerce/signatures.js";
import { decimalAmount, minorAmount } from "../../lib/commerce/money.js";
import { rawBody } from "../../lib/http/body.js";
import {
  validateEpayConfig,
  type EpayConfig,
  type EpayMethod,
} from "./config.js";
import { epaySecrets } from "./secrets.js";
export default definePlugin({
  setup(host) {
    const secrets = epaySecrets(host);
    host.validateConfig((value) => {
      const config = value as EpayConfig;
      validateEpayConfig(config);
      for (const method of config.methods ?? [])
        for (const kind of method.algorithm === "RSA"
          ? (["privateKeyRef", "platformPublicKeyRef"] as const)
          : (["keyRef"] as const)) {
          const reference = method[kind];
          if (reference?.startsWith("local:")) secrets.read(reference, kind);
        }
    });
    function settings(id: string | undefined, checkout = false) {
      const config = host.config() as EpayConfig;
      const methodId = requiredString(id, "paymentMethod", 128);
      const method = config.methods?.find((m) => m.id === methodId);
      if (!method || (checkout && (!config.enabled || !method.enabled)))
        throw new HostError("payment_disabled", "Epay is disabled", 503);
      return method;
    }
    const key = (c: EpayMethod, verify = false) => {
      const kind =
        c.algorithm === "RSA"
          ? verify
            ? "platformPublicKeyRef"
            : "privateKeyRef"
          : "keyRef";
      return secrets.read(c[kind]!, kind);
    };
    host.provide(
      "payments.provider@1",
      async (input: PaymentCheckout & { action: string }, signal) => {
        if (input.action === "status") {
          const config = host.config() as EpayConfig;
          const methods = (config.methods ?? [])
            .filter((m) => m.enabled)
            .map((m) => ({
              id: m.id,
              name: m.name || m.paymentType,
              type: m.paymentType,
            }));
          return {
            id: "epay",
            name: "易支付",
            currencies: ["cny"],
            modes: ["payment", "subscription"],
            renewal: "manual",
            enabled: config.enabled === true && methods.length > 0,
            methods,
          };
        }
        if (input.action !== "checkout")
          throw new HostError(
            "unsupported_operation",
            "Unsupported Epay operation",
          );
        const c = settings(input.paymentMethod, true);
        if (input.product.currency !== "cny")
          throw new HostError(
            "unsupported_currency",
            "Epay requires an explicitly priced CNY product",
          );
        const notifyUrl = new URL(
          c.publicUrl.replace(/\/$/, "") +
            "/api/plugins/official.payments-epay/notify",
        );
        notifyUrl.searchParams.set("pluhub_method", c.id);
        const fields: Record<string, string> = {
          pid: c.pid,
          type: c.paymentType,
          out_trade_no: input.orderId,
          notify_url: notifyUrl.href,
          return_url: input.successUrl,
          name: input.product.name,
          money: decimalAmount(input.product.paymentMinor),
          sign_type: c.algorithm,
        };
        if (c.version === "v2")
          Object.assign(fields, {
            method: "jump",
            clientip: c.clientIp ?? "127.0.0.1",
            timestamp: String(Math.floor(Date.now() / 1000)),
          });
        fields.sign = epaySign(fields, c.algorithm, key(c));
        const base = new URL(c.baseUrl);
        if (c.version === "v1") {
          base.pathname = base.pathname.replace(/\/$/, "") + "/submit.php";
          base.search = new URLSearchParams(fields).toString();
          return { url: base.href, renewal: "manual" };
        }
        base.pathname = base.pathname.replace(/\/$/, "") + "/api/pay/create";
        const response = await host.call<Response>(
          "http.transport@1",
          {
            url: base.href,
            headers: { "content-type": "application/x-www-form-urlencoded" },
            body: new URLSearchParams(fields).toString(),
          },
          signal,
        );
        const result = (await response.json()) as any;
        if (
          !response.ok ||
          result.code !== 0 ||
          !epayVerify(result, c.algorithm, key(c, true)) ||
          !Number.isFinite(Number(result.timestamp)) ||
          Math.abs(Date.now() / 1000 - Number(result.timestamp)) > 300
        )
          throw new HostError("payment_gateway", "Invalid Epay response", 502);
        if (result.pay_type !== "jump" || typeof result.pay_info !== "string")
          throw new HostError(
            "payment_gateway",
            "Only safe redirect payments are supported",
            502,
          );
        return { url: result.pay_info, renewal: "manual" };
      },
    );
    const notify = async (request: Request) => {
      const url = new URL(request.url);
      if (url.searchParams.getAll("pluhub_method").length > 1)
        throw new HostError("invalid_request", "Duplicate payment method");
      const c = settings(url.searchParams.get("pluhub_method") ?? undefined);
      const paymentMethod = c.id;
      if (Number(request.headers.get("content-length") ?? 0) > 65536)
        throw new HostError("body_too_large", "Notification too large", 413);
      const params =
        request.method === "GET"
          ? new URL(request.url).searchParams
          : new URLSearchParams(
              (await rawBody(request, 65536)).toString("utf8"),
            );
      if (params.toString().length > 65536)
        throw new HostError("body_too_large", "Notification too large", 413);
      const fields: Record<string, string> = {};
      for (const [k, v] of params) {
        if (request.method === "GET" && k === "pluhub_method") continue;
        if (k in fields)
          throw new HostError("invalid_request", "Duplicate payment parameter");
        fields[k] = v;
      }
      if (
        !epayVerify(fields, c.algorithm, key(c, true)) ||
        fields.pid !== c.pid ||
        fields.type !== c.paymentType
      )
        throw new HostError("invalid_signature", "Invalid Epay notification");
      if (fields.trade_status !== "TRADE_SUCCESS")
        return new Response("success");
      requiredString(fields.trade_no, "trade_no", 256);
      // Epay is a prepaid purchase; no automatic debit is claimed.
      await host.call("commerce.payment@1", {
        provider: "epay",
        eventId: paymentMethod + ":" + fields.trade_no,
        orderId: fields.out_trade_no,
        paymentId: paymentMethod + ":" + fields.trade_no,
        paymentMethod,
        amount: minorAmount(fields.money!),
        currency: "cny",
        kind: "paid",
      });
      return new Response("success", {
        headers: { "content-type": "text/plain" },
      });
    };
    for (const method of ["GET", "POST"])
      host.api({ method, path: "/notify", access: "public", handle: notify });
  },
});
