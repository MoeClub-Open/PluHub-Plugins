import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Dialog, PageHeading } from "../../lib/ui/components.js";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";
import type { EpayMethod } from "./config.js";
import type { PaymentSecrets } from "./secrets.js";
import { MethodEditor } from "./method-editor.js";

const types: Record<string, string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
  qqpay: "QQ 钱包",
};
const fields = [
  "version",
  "algorithm",
  "pid",
  "baseUrl",
  "publicUrl",
  "paymentType",
  "clientIp",
  "keyRef",
  "privateKeyRef",
  "platformPublicKeyRef",
] as const;
const findPlugin = (config: any) =>
  config.plugins.find((p: any) =>
    /\/(?:official\.)?payments-epay$/.test(p.path.replaceAll("\\", "/")),
  );

function Page({ host }: { host: UIHost }) {
  const data = useLoad<any>(() => host.request("/api/host/config"));
  const settings = data.data ? (findPlugin(data.data)?.config ?? {}) : {};
  const methods: EpayMethod[] =
    settings.methods ??
    (settings.pid
      ? [
          {
            ...Object.fromEntries(
              fields
                .filter((f) => settings[f] !== undefined)
                .map((f) => [f, settings[f]]),
            ),
            id: "default",
            enabled: settings.enabled === true,
            paymentType: settings.paymentType ?? "alipay",
          },
        ]
      : []);
  const [editor, setEditor] = React.useState<EpayMethod>();
  const [removing, setRemoving] = React.useState<EpayMethod>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function commit(
    nextMethods: EpayMethod[],
    enabled = settings.enabled === true,
    secrets?: { methodId: string; values: PaymentSecrets },
  ) {
    setBusy(true);
    setMessage("");
    try {
      if (secrets && Object.keys(secrets.values).length) {
        const references = await host.request<PaymentSecrets>(
          "/api/plugins/official.payments-epay/secrets",
          {
            method: "POST",
            body: JSON.stringify(secrets.values),
          },
        );
        nextMethods = nextMethods.map((method) =>
          method.id === secrets.methodId
            ? { ...method, ...references }
            : method,
        );
      }
      const config = await host.request<any>("/api/host/config");
      const plugin = findPlugin(config);
      if (!plugin) throw new Error(tr("支付插件未安装"));
      const next = { ...plugin.config, enabled, methods: nextMethods };
      // Keep legacy references for notifications from orders created before multi-method support.
      next.secretRefs = [
        ...new Set(
          [next, ...nextMethods].flatMap((m) =>
            [m.keyRef, m.privateKeyRef, m.platformPublicKeyRef].filter(
              (reference) =>
                typeof reference === "string" && reference.startsWith("env:"),
            ),
          ),
        ),
      ];
      plugin.config = next;
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setEditor(undefined);
      setRemoving(undefined);
      setMessage(tr("已保存"));
      data.reload();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const add = (source?: EpayMethod) => {
    setMessage("");
    setEditor({
      version: "v1",
      algorithm: "MD5",
      paymentType: "alipay",
      pid: "",
      baseUrl: "",
      publicUrl: location.origin,
      ...source,
      id: crypto.randomUUID(),
      name: "",
      enabled: false,
    });
  };
  return (
    <>
      <PageHeading title={tr("易支付")}>
        <button disabled={!data.data || busy} onClick={() => add()}>
          {tr("添加支付方式")}
        </button>
      </PageHeading>
      {!editor && !removing && <Notice message={message || data.error} />}
      {data.data && (
        <>
          <label className="checkbox">
            <Checkbox
              appearance="switch"
              checked={settings.enabled === true}
              disabled={busy}
              onCheckedChange={(enabled) =>
                void commit(methods, enabled === true)
              }
            />
            {tr("启用支付渠道")}
          </label>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  {[
                    "名称",
                    "支付类型",
                    "API 版本",
                    "签名方式",
                    "状态",
                    "操作",
                  ].map((label) => (
                    <th key={label}>{tr(label)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {methods.map((method) => (
                  <tr key={method.id}>
                    <td>{method.name || tr(types[method.paymentType])}</td>
                    <td>{tr(types[method.paymentType])}</td>
                    <td>{method.version?.toUpperCase()}</td>
                    <td>{method.algorithm}</td>
                    <td>{method.enabled ? tr("已启用") : tr("已停用")}</td>
                    <td>
                      <div className="actions">
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() => {
                            setMessage("");
                            setEditor(method);
                          }}
                        >
                          {tr("编辑")}
                        </button>
                        <button
                          className="ghost"
                          disabled={busy}
                          onClick={() => add(method)}
                        >
                          {tr("复制")}
                        </button>
                        <button
                          className="ghost danger"
                          disabled={busy}
                          onClick={() => {
                            setMessage("");
                            setRemoving(method);
                          }}
                        >
                          {tr("删除")}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {!methods.length && (
              <p className="empty-inline">{tr("尚无支付方式")}</p>
            )}
          </div>
        </>
      )}
      {editor && (
        <MethodEditor
          method={editor}
          busy={busy}
          message={message}
          close={() => {
            if (!busy) setEditor(undefined);
          }}
          save={(method, secrets) =>
            void commit(
              methods.some((m) => m.id === method.id)
                ? methods.map((m) => (m.id === method.id ? method : m))
                : [...methods, method],
              settings.enabled === true,
              { methodId: method.id, values: secrets },
            )
          }
        />
      )}
      {removing && (
        <Dialog
          title={tr("删除支付方式")}
          close={() => {
            if (!busy) setRemoving(undefined);
          }}
        >
          <Notice message={message} />
          <p>{tr("删除后，尚未完成的订单将无法接收此支付方式的回调。")}</p>
          <div className="form-actions">
            <button
              className="secondary"
              disabled={busy}
              onClick={() => setRemoving(undefined)}
            >
              {tr("取消")}
            </button>
            <button
              className="danger"
              disabled={busy}
              onClick={() =>
                void commit(methods.filter((m) => m.id !== removing.id))
              }
            >
              {tr("删除")}
            </button>
          </div>
        </Dialog>
      )}
    </>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
