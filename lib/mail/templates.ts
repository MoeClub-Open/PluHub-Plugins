import type { SiteBranding } from "@pluhub/contracts";
import type { MailMessage } from "@pluhub/contracts/security";
import { HostError, type Host } from "@pluhub/sdk";

type Language = SiteBranding["defaultLanguage"];
export type VerificationPurpose = "register" | "login" | "bind" | "reset";
export type MailTemplate = VerificationPurpose | "test";
export const verificationLifetimeMs = 10 * 60 * 1000;
const defaultBrand: SiteBranding = {
  name: "PluHub",
  defaultLanguage: "zh-CN",
  accentColor: "#635bff",
};
export function mailLanguage(
  account: unknown,
  requested: unknown,
  fallback: Language,
): Language {
  for (const value of [account, requested, fallback])
    if (value === "zh-CN" || value === "en-US") return value;
  return "zh-CN";
}
export async function mailBranding(
  host: Host,
  signal: AbortSignal,
): Promise<SiteBranding> {
  try {
    return await host.call<SiteBranding>("site.branding@1", {}, signal);
  } catch (error) {
    signal.throwIfAborted();
    if ((error as HostError).code !== "missing_capability") throw error;
    return { ...defaultBrand };
  }
}
const escape = (s: string) =>
  s.replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c]!,
  );
export function mailBrandName(brand: SiteBranding): string {
  return (
    brand.name
      .replace(/[\u0000-\u001f\u007f]+/g, " ")
      .trim()
      .slice(0, 64) || "PluHub"
  );
}
function layout(
  brand: SiteBranding,
  language: Language,
  title: string,
  intro: string,
  detail: string,
  footer: string,
  code?: string,
  notice?: string,
): string {
  const accent = /^#[a-f0-9]{6}$/i.test(brand.accentColor)
    ? brand.accentColor
    : defaultBrand.accentColor;
  const name = escape(mailBrandName(brand));
  const preheader = escape(intro);
  return `<!doctype html>
<html lang="${language}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><title>${escape(title)}</title><style>@media screen and (max-width:480px){.mail-outer{padding:20px 8px!important}.mail-card td{padding-left:20px!important;padding-right:20px!important}.mail-code{font-size:28px!important;letter-spacing:5px!important}}</style></head>
<body style="margin:0;padding:0;background-color:#f6f8fa;color:#182230;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Arial,'Microsoft YaHei',sans-serif;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;mso-hide:all;">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f6f8fa;"><tr><td class="mail-outer" align="center" style="padding:40px 16px;">
<table role="presentation" class="mail-card" width="520" cellpadding="0" cellspacing="0" style="width:100%;max-width:520px;background-color:#ffffff;border:1px solid #e3e8ee;border-radius:12px;">
<tr><td style="height:4px;background-color:${accent};border-radius:12px 12px 0 0;font-size:1px;line-height:4px;">&nbsp;</td></tr>
<tr><td style="padding:32px 28px 0;font-size:18px;font-weight:700;line-height:26px;">${name}</td></tr>
${notice ? `<tr><td style="padding:16px 28px 0;font-size:12px;line-height:20px;color:#687585;">${escape(notice)}</td></tr>` : ""}
<tr><td style="padding:24px 28px 0;"><h1 style="margin:0;font-size:24px;font-weight:600;line-height:32px;">${escape(title)}</h1></td></tr>
<tr><td style="padding:16px 28px 0;font-size:15px;line-height:25px;color:#455365;">${escape(intro)}</td></tr>
${code ? `<tr><td style="padding:24px 28px 0;"><div class="mail-code" dir="ltr" style="padding:20px 12px;background-color:#f4f6f9;border:1px solid #e3e8ee;border-radius:8px;text-align:center;font-family:Consolas,'Courier New',monospace;font-size:34px;font-weight:700;letter-spacing:8px;line-height:44px;white-space:nowrap;">${escape(code)}</div></td></tr>` : ""}
<tr><td style="padding:20px 28px 28px;font-size:14px;line-height:24px;color:#455365;">${escape(detail)}</td></tr>
<tr><td style="padding:20px 28px;border-top:1px solid #e3e8ee;font-size:12px;line-height:20px;color:#687585;">${escape(footer)}</td></tr>
</table></td></tr></table></body></html>`;
}
export function verificationMail(input: {
  to: string;
  purpose: VerificationPurpose;
  code: string;
  language: Language;
  brand: SiteBranding;
  sample?: boolean;
}): MailMessage {
  if (!/^[0-9]{6}$/.test(input.code))
    throw new HostError("invalid_request", "Invalid verification code");
  const { to, purpose, code, language, brand } = input;
  const name = mailBrandName(brand);
  const english = language === "en-US";
  const title = english
    ? {
        register: "Verify your email",
        login: "Your sign-in code",
        bind: "Confirm your email address",
        reset: "Reset your password",
      }[purpose]
    : {
        register: "验证注册邮箱",
        login: "登录验证码",
        bind: "确认绑定邮箱",
        reset: "重置登录密码",
      }[purpose];
  const intro = english
    ? {
        register: `Use this code to create your ${name} account.`,
        login: `Use this code to sign in to ${name}.`,
        bind: `Use this code to link this email address to your ${name} account.`,
        reset: `Use this code to reset your ${name} password. Any enabled two-step verification is still required.`,
      }[purpose]
    : {
        register: `请使用以下验证码创建你的 ${name} 账号。`,
        login: `请使用以下验证码登录 ${name}。`,
        bind: `请使用以下验证码，将此邮箱绑定到你的 ${name} 账号。`,
        reset: `请使用以下验证码重置你的 ${name} 登录密码。已启用的两步验证仍需完成。`,
      }[purpose];
  const minutes = verificationLifetimeMs / 60000;
  const detail = english
    ? `This code expires in ${minutes} minutes and can only be used once. Never share it with anyone.`
    : `验证码 ${minutes} 分钟内有效，仅可使用一次。请勿向他人提供。`;
  const footer = english
    ? "If you didn't request this, you can ignore this email."
    : "如果不是你本人操作，请忽略此邮件。";
  const notice = input.sample
    ? english
      ? "Test email · This sample code cannot verify an account."
      : "测试邮件 · 示例验证码不能用于账号验证。"
    : undefined;
  return {
    to,
    subject: `${name} · ${input.sample ? (english ? "Test · " : "测试 · ") : ""}${title}`,
    text: [name, notice, title, intro, code, detail, footer]
      .filter(Boolean)
      .join("\n\n"),
    html: layout(brand, language, title, intro, detail, footer, code, notice),
  };
}
export function testMail(
  to: string,
  language: Language,
  brand: SiteBranding,
): MailMessage {
  const name = mailBrandName(brand),
    english = language === "en-US";
  const title = english ? "Email delivery test" : "邮件发送测试";
  const intro = english
    ? `Email delivery is working for ${name}.`
    : `${name} 的邮件服务已连接成功。`;
  const detail = english
    ? "This test email was sent from the site administration settings."
    : "这封测试邮件由管理员从站点设置中发送。";
  const footer = english ? "No action is needed." : "无需进行任何操作。";
  return {
    to,
    subject: `${name} · ${title}`,
    text: `${name}\n\n${title}\n\n${intro}\n\n${detail}\n\n${footer}`,
    html: layout(brand, language, title, intro, detail, footer),
  };
}
export function mailTemplate(value: unknown): MailTemplate {
  if (value === undefined) return "test";
  if (
    value === "test" ||
    value === "register" ||
    value === "login" ||
    value === "bind" ||
    value === "reset"
  )
    return value;
  throw new HostError("invalid_request", "Invalid email template");
}
/** Samples never create authentication challenges or usable verification codes. */
export function sampleMail(
  to: string,
  template: MailTemplate,
  language: Language,
  brand: SiteBranding,
): MailMessage {
  return template === "test"
    ? testMail(to, language, brand)
    : verificationMail({
        to,
        purpose: template,
        code: "123456",
        language,
        brand,
        sample: true,
      });
}
