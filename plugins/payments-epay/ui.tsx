import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";
import { Dialog, PageHeading } from "../../lib/ui/components.js";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";
import type { EpayMethod } from "./config.js";

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
  ) {
    setBusy(true);
    setMessage("");
    try {
      const config = await host.request<any>("/api/host/config");
      const plugin = findPlugin(config);
      if (!plugin) throw new Error(tr("支付插件未安装"));
      const next = { ...plugin.config, enabled, methods: nextMethods };
      // Keep legacy references for notifications from orders created before multi-method support.
      next.secretRefs = [
        ...new Set(
          [next, ...nextMethods].flatMap((m) =>
            [m.keyRef, m.privateKeyRef, m.platformPublicKeyRef].filter(Boolean),
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
          save={(method) =>
            void commit(
              methods.some((m) => m.id === method.id)
                ? methods.map((m) => (m.id === method.id ? method : m))
                : [...methods, method],
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
function MethodEditor({
  method,
  busy,
  message,
  save,
  close,
}: {
  method: EpayMethod;
  busy: boolean;
  message: string;
  save: (method: EpayMethod) => void;
  close: () => void;
}) {
  const [algorithm, setAlgorithm] = React.useState(method.algorithm);
  const [enabled, setEnabled] = React.useState(method.enabled === true);
  const input = (
    name: keyof EpayMethod,
    label: string,
    placeholder = "",
    required = true,
  ) => (
    <label>
      {tr(label)}
      <input
        name={name}
        defaultValue={String(method[name] ?? "")}
        placeholder={placeholder}
        autoComplete="off"
        required={enabled && required}
      />
    </label>
  );
  return (
    <Dialog title={tr("支付方式")} close={close}>
      <Notice message={message} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = {
            id: method.id,
            enabled,
            name: String(form.get("name") ?? "").trim(),
          } as EpayMethod;
          for (const field of fields) {
            const value = String(form.get(field) ?? "").trim();
            if (value) (next as any)[field] = value;
          }
          save(next);
        }}
      >
        <label className="checkbox">
          <Checkbox
            appearance="switch"
            checked={enabled}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          {tr("启用此支付方式")}
        </label>
        <div className="form-grid">
          {input("name", "名称", "", false)}
          <label>
            {tr("支付类型")}
            <Select name="paymentType" defaultValue={method.paymentType}>
              {Object.entries(types).map(([id, name]) => (
                <option key={id} value={id}>
                  {tr(name)}
                </option>
              ))}
            </Select>
          </label>
          <label>
            {tr("API 版本")}
            <Select name="version" defaultValue={method.version}>
              <option value="v1">V1</option>
              <option value="v2">V2</option>
            </Select>
          </label>
          <label>
            {tr("签名方式")}
            <Select
              name="algorithm"
              value={algorithm}
              onChange={(event) =>
                setAlgorithm(event.target.value as EpayMethod["algorithm"])
              }
            >
              <option>MD5</option>
              <option>RSA</option>
            </Select>
          </label>
          {input("pid", "商户 PID")}
          {input("baseUrl", "支付平台地址", "https://pay.example.com")}
          {input("publicUrl", "本站公开地址", location.origin)}
          {input("clientIp", "创建订单来源 IP", "127.0.0.1", false)}
          {algorithm === "RSA" ? (
            <>
              {input(
                "privateKeyRef",
                "RSA 商户私钥引用",
                "env:EPAY_PRIVATE_KEY",
              )}
              {input(
                "platformPublicKeyRef",
                "RSA 平台公钥引用",
                "env:EPAY_PLATFORM_PUBLIC_KEY",
              )}
            </>
          ) : (
            input("keyRef", "MD5 商户密钥引用", "env:EPAY_KEY")
          )}
        </div>
        <div className="form-actions">
          <button
            type="button"
            className="secondary"
            disabled={busy}
            onClick={close}
          >
            {tr("取消")}
          </button>
          <button disabled={busy}>{tr("保存")}</button>
        </div>
      </form>
    </Dialog>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
