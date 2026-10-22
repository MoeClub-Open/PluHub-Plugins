import { definePlugin, HostError } from "@pluhub/sdk";
import type { PaymentCheckout } from "@pluhub/contracts/commerce";
import { epaySign, epayVerify } from "../../lib/commerce/signatures.js";
import { decimalAmount, minorAmount } from "../../lib/commerce/money.js";
import { rawBody } from "../../lib/http/body.js";
export default definePlugin({
  setup(host) {
    host.validateConfig((c) => {
      if (c.enabled) {
        for (const field of [
          "version",
          "algorithm",
          "pid",
          "baseUrl",
          "publicUrl",
          ...(c.algorithm === "RSA"
            ? ["privateKeyRef", "platformPublicKeyRef"]
            : ["keyRef"]),
        ])
          if (typeof c[field] !== "string" || !c[field])
            throw new HostError("invalid_config", "Missing Epay " + field);
      }
    });
    function settings() {
      const c = host.config();
      if (!c.enabled)
        throw new HostError("payment_disabled", "Epay is disabled", 503);
      return c as any;
    }
    const key = (c: any, verify = false) =>
      host.secret(
        c.algorithm === "RSA"
          ? verify
            ? c.platformPublicKeyRef
            : c.privateKeyRef
          : c.keyRef,
      );
    host.provide(
      "payments.epay@1",
      async (input: PaymentCheckout & { action: string }, signal) => {
        if (input.action === "status")
          return { enabled: host.config().enabled === true };
        const c = settings();
        if (input.action !== "checkout")
          throw new HostError(
            "unsupported_operation",
            "Unsupported Epay operation",
          );
        if (input.product.currency !== "cny")
          throw new HostError(
            "unsupported_currency",
            "Epay requires an explicitly priced CNY product",
          );
        const fields: Record<string, string> = {
          pid: c.pid,
          type: c.paymentType ?? "alipay",
          out_trade_no: input.orderId,
          notify_url:
            c.publicUrl.replace(/\/$/, "") +
            "/api/plugins/official.payments-epay/notify",
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
        if (
          !["https:", "http:"].includes(base.protocol) ||
          base.username ||
          base.password ||
          base.search ||
          base.hash
        )
          throw new HostError("invalid_config", "Invalid payment URL");
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
      const c = settings();
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
        if (k in fields)
          throw new HostError("invalid_request", "Duplicate payment parameter");
        fields[k] = v;
      }
      if (
        !epayVerify(fields, c.algorithm, key(c, true)) ||
        fields.pid !== c.pid
      )
        throw new HostError("invalid_signature", "Invalid Epay notification");
      if (fields.trade_status !== "TRADE_SUCCESS")
        return new Response("success");
      // Epay is a prepaid purchase; no automatic debit is claimed.
      await host.call("commerce.payment@1", {
        provider: "epay",
        eventId: fields.trade_no,
        orderId: fields.out_trade_no,
        paymentId: fields.trade_no,
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
