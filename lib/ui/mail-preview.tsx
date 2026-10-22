import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { t as tr, getLocale } from "./i18n.js";
import { Dialog } from "./components.js";
import { Select } from "./select.js";
import { Notice, useLoad } from "./mount.js";

const templates = [
  ["test", "邮件发送测试"],
  ["register", "验证注册邮箱"],
  ["login", "登录验证码"],
  ["bind", "确认绑定邮箱"],
  ["reset", "重置登录密码"],
] as const;

function TemplatePreview({
  host,
  template,
  close,
}: {
  host: UIHost;
  template: string;
  close: () => void;
}) {
  const locale = getLocale();
  const [format, setFormat] = React.useState("html");
  const loaded = useLoad<{
    subject: string;
    html: string;
    text: string;
    language: string;
  }>(
    () =>
      host.request("/api/plugins/official.mailer/preview", {
        method: "POST",
        body: JSON.stringify({ template, language: locale }),
      }),
    [host, template, locale],
  );
  return (
    <Dialog title={tr("邮件模板预览")} close={close}>
      <Notice message={loaded.error} />
      {loaded.data ? (
        <div className="mail-preview">
          <div className="mail-preview-heading">
            <strong>{loaded.data.subject}</strong>
            <span className="muted">
              {loaded.data.language === "en-US" ? "English" : "简体中文"}
            </span>
          </div>
          <div className="tabs" role="group" aria-label={tr("邮件格式")}>
            {[
              ["html", "HTML"],
              ["text", tr("纯文本")],
            ].map(([id, label]) => (
              <button
                key={id}
                type="button"
                aria-pressed={format === id}
                className={format === id ? "active" : ""}
                onClick={() => setFormat(id!)}
              >
                {label}
              </button>
            ))}
          </div>
          {format === "html" ? (
            <iframe
              title={tr("邮件正文")}
              sandbox=""
              referrerPolicy="no-referrer"
              srcDoc={loaded.data.html}
            />
          ) : (
            <pre>{loaded.data.text}</pre>
          )}
        </div>
      ) : (
        !loaded.error && <p role="status">{tr("加载中…")}</p>
      )}
    </Dialog>
  );
}

export function MailTemplateTools({
  host,
  disabled = false,
}: {
  host: UIHost;
  disabled?: boolean;
}) {
  const [template, setTemplate] = React.useState("test");
  const [to, setTo] = React.useState("");
  const [preview, setPreview] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  return (
    <>
      <Notice message={message} />
      <form
        className="card inline-form mail-template-tools"
        onSubmit={async (e) => {
          e.preventDefault();
          if (disabled || busy) return;
          setBusy(true);
          setMessage("");
          try {
            await host.request("/api/plugins/official.mailer/test", {
              method: "POST",
              body: JSON.stringify({ to, template, language: getLocale() }),
            });
            setMessage("测试邮件已提交给 SMTP 服务器");
          } catch (error) {
            setMessage((error as Error).message);
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          {tr("邮件模板")}
          <Select
            value={template}
            disabled={busy}
            onChange={(e) => setTemplate(e.target.value)}
          >
            {templates.map(([id, label]) => (
              <option key={id} value={id}>
                {tr(label)}
              </option>
            ))}
          </Select>
        </label>
        <button
          type="button"
          className="secondary"
          onClick={() => setPreview(true)}
        >
          {tr("预览模板")}
        </button>
        <label>
          {tr("测试收件邮箱")}
          <input
            type="email"
            required
            value={to}
            disabled={busy}
            onChange={(e) => setTo(e.target.value)}
          />
        </label>
        <button
          className="secondary"
          disabled={disabled || busy}
          title={disabled ? tr("请先保存配置") : undefined}
        >
          {tr("发送测试邮件")}
        </button>
      </form>
      {preview && (
        <TemplatePreview
          host={host}
          template={template}
          close={() => setPreview(false)}
        />
      )}
    </>
  );
}
