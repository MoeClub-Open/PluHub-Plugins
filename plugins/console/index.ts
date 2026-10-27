import { definePlugin, HostError } from "@pluhub/sdk";
import { readBranding, escapeHtml } from "./branding.js";
import { readPortal, publicPortal } from "./portal.js";
const google =
  "https://www.google.com/recaptcha/ https://www.recaptcha.net/recaptcha/";
const geetest =
  "https://static.geetest.com https://static.geevisit.com https://gcaptcha4.geetest.com https://gcaptcha4.geevisit.com";
const hcaptcha = "https://hcaptcha.com https://*.hcaptcha.com";
const captchaPolicy = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline' https://challenges.cloudflare.com ${google} https://www.gstatic.com/recaptcha/ ${geetest} ${hcaptcha}`,
  `style-src 'self' 'unsafe-inline' ${geetest} ${hcaptcha}`,
  `font-src 'self' data: ${geetest}`,
  `connect-src 'self' https://challenges.cloudflare.com ${google} ${geetest} ${hcaptcha}`,
  `frame-src https://challenges.cloudflare.com ${google} https://recaptcha.google.com/recaptcha/ ${geetest} ${hcaptcha}`,
  "img-src 'self' data: blob: https:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
export default definePlugin({
  setup(host) {
    host.validateConfig((config) => {
      try {
        readBranding(config);
        readPortal(config);
      } catch (error) {
        throw new HostError("invalid_branding", (error as Error).message, 400);
      }
    });
    host.provide("site.branding@1", () => {
      const { name, defaultLanguage, accentColor } = readBranding(
        host.config(),
      );
      return { name, defaultLanguage, accentColor };
    });
    host.route({
      method: "GET",
      path: "/console/public",
      access: "public",
      pipeline: false,
      handle: () =>
        Response.json(
          {
            branding: readBranding(host.config()),
            portal: publicPortal(host.config()),
          },
          { headers: { "cache-control": "no-store" } },
        ),
    });
    host.route({
      method: "GET",
      path: "/console/branding",
      access: "public",
      pipeline: false,
      handle: () =>
        Response.json(readBranding(host.config()), {
          headers: { "cache-control": "no-store" },
        }),
    });
    host.route({
      method: "GET",
      path: "/favicon.ico",
      access: "public",
      pipeline: false,
      handle: () => new Response(null, { status: 204 }),
    });
    for (const method of ["GET", "HEAD"])
      host.route({
        method,
        path: "/",
        access: "public",
        pipeline: false,
        handle: (request) => {
          const brand = readBranding(host.config());
          const portal = publicPortal(host.config());
          const bootstrap = JSON.stringify(brand)
            .replace(/</g, "\\u003c")
            .replace(/&/g, "\\u0026");
          return new Response(
            request.method === "HEAD"
              ? null
              : '<!doctype html><html lang="' +
                  brand.defaultLanguage +
                  '"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
                  escapeHtml(brand.name) +
                  '</title><meta name="description" content="' +
                  escapeHtml(
                    portal.enabled ? portal.description : brand.description,
                  ) +
                  '"><link rel="icon" href="' +
                  escapeHtml(brand.faviconUrl || "/favicon.ico") +
                  '"><link rel="stylesheet" href="/extensions/official.console/ui.css"><script id="pluhub-branding" type="application/json">' +
                  bootstrap +
                  '</script><div id="root"></div><script type="module">import { mount } from "/extensions/official.console/ui.js"; mount(document.getElementById("root"));</script></html>',
            {
              headers: {
                "content-type": "text/html; charset=utf-8",
                "cache-control": "no-store",
                "content-security-policy": captchaPolicy,
                "permissions-policy":
                  "publickey-credentials-get=(self), publickey-credentials-create=(self)",
              },
            },
          );
        },
      });
  },
});
