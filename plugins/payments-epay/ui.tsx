import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Dialog, PageHeading } from "../../lib/ui/components.js";
import { mountPage, Notice } from "../../lib/ui/mount.js";
import { usePluginConfig } from "../../lib/ui/plugin-config.js";
import { t as tr } from "../../lib/ui/i18n.js";
import type { EpayMethod } from "./config.js";
import type { PaymentSecrets } from "./secrets.js";
import { MethodEditor } from "./method-editor.js";
import { nextNumericId } from "../../lib/numeric-id.js";

const types: Record<string, string> = {
  alipay: "支付宝",
  wxpay: "微信支付",
  qqpay: "QQ 钱包",
};

function Page({ host }: { host: UIHost }) {
  const data = usePluginConfig(host, "official.payments-epay");
  const settings = data.data ?? {};
  const methods: EpayMethod[] = settings.methods ?? [];
  const [editor, setEditor] = React.useState<EpayMethod>();
  const [removing, setRemoving] = React.useState<EpayMethod>();
  const [busy, setBusy] = React.useState(false);
  const [message, setMessage] = React.useState("");
  async function saveRate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const rate = Number(new FormData(event.currentTarget).get("usdToCny"));
    setBusy(true);
    setMessage("");
    try {
      await data.save((current) => ({ ...current, usdToCny: rate }));
      setMessage(tr("已保存"));
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
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
      await data.save((current) => ({
        ...current,
        enabled,
        methods: nextMethods,
        nextMethodId: nextNumericId(
          nextMethods.map((method) => method.id),
          current?.nextMethodId,
        ),
        secretRefs: [
          ...new Set(
            nextMethods.flatMap((m) =>
              [m.keyRef, m.privateKeyRef, m.platformPublicKeyRef].filter(
                (reference) =>
                  typeof reference === "string" &&
                  reference.startsWith("secret:"),
              ),
            ),
          ),
        ],
      }));
      setEditor(undefined);
      setRemoving(undefined);
      setMessage(tr("已保存"));
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
      id: nextNumericId(
        methods.map((method) => method.id),
        settings.nextMethodId,
      ),
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
          <form className="form-grid" onSubmit={saveRate}>
            <label>
              {tr("人民币转换比例（CNY / USD）")}
              <input
                key={settings.usdToCny}
                name="usdToCny"
                type="number"
                min="0.000001"
                step="any"
                required
                defaultValue={settings.usdToCny ?? 7}
              />
            </label>
            <div className="form-actions">
              <button disabled={busy}>{tr("保存转换比例")}</button>
            </div>
          </form>
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
