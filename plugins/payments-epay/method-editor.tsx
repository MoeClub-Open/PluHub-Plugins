import React from "react";
import { Checkbox } from "../../lib/ui/checkbox.js";
import { Select } from "../../lib/ui/select.js";
import { Dialog } from "../../lib/ui/components.js";
import { Notice } from "../../lib/ui/mount.js";
import { t as tr } from "../../lib/ui/i18n.js";
import type { EpayMethod } from "./config.js";
import type { PaymentSecrets, SecretField } from "./secrets.js";

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
export function MethodEditor({
  method,
  busy,
  message,
  save,
  close,
}: {
  method: EpayMethod;
  busy: boolean;
  message: string;
  save: (method: EpayMethod, secrets: PaymentSecrets) => void;
  close: () => void;
}) {
  const [algorithm, setAlgorithm] = React.useState(method.algorithm);
  const [enabled, setEnabled] = React.useState(method.enabled === true);
  const [error, setError] = React.useState("");
  const credential = (field: SecretField, title: string) => {
    const saved = method[field]?.startsWith("local:");
    const props = {
      name: field,
      defaultValue: saved ? "" : (method[field] ?? ""),
      placeholder: saved ? tr("已保存，留空保持不变") : tr("填写密钥"),
      autoComplete: "off",
      required: enabled && !method[field],
      maxLength: 32768,
    };
    return (
      <label>
        {tr(title)}
        {field === "keyRef" ? (
          <input {...props} type="password" />
        ) : (
          <textarea {...props} rows={3} />
        )}
      </label>
    );
  };
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
        maxLength={name === "name" ? 128 : undefined}
        required={enabled && required}
      />
    </label>
  );
  return (
    <Dialog title={tr("支付方式")} close={close}>
      <Notice message={error || message} />
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const form = new FormData(event.currentTarget);
          const next = {
            id: method.id,
            enabled,
            name: String(form.get("name") ?? "").trim(),
          } as EpayMethod;
          const secrets: PaymentSecrets = {};
          setError("");
          for (const field of fields.filter((name) => !name.endsWith("Ref"))) {
            const value = String(form.get(field) ?? "").trim();
            if (value) (next as any)[field] = value;
          }
          for (const field of algorithm === "RSA"
            ? (["privateKeyRef", "platformPublicKeyRef"] as const)
            : (["keyRef"] as const)) {
            const value = String(form.get(field) ?? "").trim();
            if (!value) {
              if (method[field]) next[field] = method[field];
            } else if (/^env:[A-Z][A-Z0-9_]*$/.test(value)) next[field] = value;
            else if (value.startsWith("env:")) {
              setError(tr("环境变量引用格式应为 env:NAME"));
              return;
            } else secrets[field] = value;
          }
          save(next, secrets);
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
              {credential("privateKeyRef", "RSA 商户私钥")}
              {credential("platformPublicKeyRef", "RSA 平台公钥")}
            </>
          ) : (
            credential("keyRef", "MD5 商户密钥")
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
