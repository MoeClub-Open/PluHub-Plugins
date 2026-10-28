import nodemailer from "nodemailer";
import type { MailMessage, MailReceipt } from "@pluhub/contracts/security";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
  type RequestContext,
} from "@pluhub/sdk";
import { emailAddress } from "../../lib/identity/email.js";
import {
  mailBranding,
  mailBrandName,
  mailLanguage,
  mailTemplate,
  sampleMail,
} from "../../lib/mail/templates.js";
export default definePlugin({
  setup(host) {
    const active = new Set<ReturnType<typeof nodemailer.createTransport>>();
    host.cleanup(() => {
      for (const t of active) t.close();
      active.clear();
    });
    host.validateConfig((c) => {
      if (!c.enabled) return;
      requiredString(c.host, "SMTP host", 253);
      emailAddress(c.from);
      if (c.user && !c.passwordRef)
        throw new HostError(
          "invalid_config",
          "SMTP password reference required",
        );
      if (
        c.allowInsecure &&
        !["localhost", "127.0.0.1", "::1"].includes(String(c.host))
      )
        throw new HostError(
          "invalid_config",
          "Plain SMTP is allowed only for a local test server",
        );
    });
    host.provide("mail.options@1", () => ({
      enabled: host.config().enabled === true,
    }));
    async function send(
      input: MailMessage,
      signal: AbortSignal,
    ): Promise<MailReceipt> {
      signal.throwIfAborted();
      if (active.size >= 8)
        throw new HostError("mail_busy", "Email delivery queue is busy", 503);
      const c = host.config();
      if (!c.enabled)
        throw new HostError(
          "mail_unavailable",
          "Email delivery is disabled",
          503,
        );
      const to = emailAddress(input.to),
        subject = requiredString(input.subject, "subject", 256),
        text = requiredString(input.text, "text", 65536);
      const html =
        input.html === undefined
          ? undefined
          : requiredString(input.html, "html", 262144);
      if (/[\r\n]/.test(subject))
        throw new HostError("invalid_request", "Invalid mail subject");
      const brand = await mailBranding(host, signal);
      signal.throwIfAborted();
      if (active.size >= 8)
        throw new HostError("mail_busy", "Email delivery queue is busy", 503);
      const transport = nodemailer.createTransport({
        host: String(c.host),
        port: Number(c.port ?? 587),
        secure: c.secure === true,
        requireTLS: !c.allowInsecure,
        ...(c.tlsServerName
          ? { tls: { servername: String(c.tlsServerName) } }
          : {}),
        ...(c.user
          ? {
              auth: {
                user: String(c.user),
                pass: host.secret(String(c.passwordRef)),
              },
            }
          : {}),
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000,
        disableFileAccess: true,
        disableUrlAccess: true,
        logger: false,
        debug: false,
      });
      active.add(transport);
      const abort = () => transport.close();
      signal.addEventListener("abort", abort, { once: true });
      try {
        const result = await transport.sendMail({
          from: { address: emailAddress(c.from), name: mailBrandName(brand) },
          to,
          subject,
          text,
          ...(html === undefined ? {} : { html }),
        });
        signal.throwIfAborted();
        if (!result.accepted?.length) throw Error("rejected");
        return { messageId: result.messageId };
      } catch {
        signal.throwIfAborted();
        throw new HostError("mail_unavailable", "Email delivery failed", 503);
      } finally {
        signal.removeEventListener("abort", abort);
        transport.close();
        active.delete(transport);
      }
    }
    host.provide("mail.send@1", send);
    async function sample(b: Record<string, unknown>, ctx: RequestContext) {
      const template = mailTemplate(b.template);
      const brand = await mailBranding(host, ctx.signal);
      let user: { language?: string } | undefined;
      if (ctx.principal?.id) {
        try {
          user = await host.call(
            "users.lookup@1",
            { id: ctx.principal.id },
            ctx.signal,
          );
        } catch (error) {
          if ((error as HostError).code !== "missing_capability") throw error;
        }
      }
      const language = mailLanguage(
        user?.language,
        b.language,
        brand.defaultLanguage,
      );
      return {
        template,
        language,
        message: sampleMail("preview@example.test", template, language, brand),
      };
    }
    host.api({
      method: "POST",
      path: "/preview",
      audit: false,
      access: "host.manage",
      handle: async (r, ctx) => {
        const { message, ...metadata } = await sample(await readObject(r), ctx);
        const { subject, text, html } = message;
        return Response.json(
          { ...metadata, subject, text, html },
          { headers: { "cache-control": "no-store" } },
        );
      },
    });
    host.api({
      method: "GET",
      path: "/status",
      access: "host.manage",
      handle: () => json({ config: host.config() }),
    });
    host.api({
      method: "POST",
      path: "/test",
      access: "host.manage",
      handle: async (r, ctx) => {
        const b = await readObject(r);
        const { message } = await sample(b, ctx);
        return json(
          await send({ ...message, to: emailAddress(b.to) }, ctx.signal),
        );
      },
    });
  },
});
