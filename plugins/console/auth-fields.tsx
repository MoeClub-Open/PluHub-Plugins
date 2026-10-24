import React from "react";
import { t as tr } from "../../lib/ui/i18n.js";
import { Icon } from "../../lib/ui/components.js";
export function PasswordField({
  name,
  label,
  value,
  change,
  register = false,
  disabled = false,
  error,
}: {
  name: string;
  label: string;
  value: string;
  change: (value: string) => void;
  register?: boolean;
  disabled?: boolean;
  error?: string;
}) {
  const [visible, setVisible] = React.useState(false);
  const id = "auth-" + name;
  return (
    <div className="auth-field">
      <label htmlFor={id}>{label}</label>
      <div className="auth-password">
        <input
          id={id}
          name={name}
          disabled={disabled}
          type={visible ? "text" : "password"}
          autoComplete={register ? "new-password" : "current-password"}
          minLength={register ? 12 : undefined}
          maxLength={1024}
          required
          aria-invalid={!!error || undefined}
          aria-describedby={error ? id + "-error" : undefined}
          value={value}
          onChange={(e) => change(e.target.value)}
          placeholder={
            name === "confirmPassword"
              ? tr("再次输入密码")
              : register
                ? tr("至少 12 个字符")
                : tr("输入密码")
          }
        />
        <button
          type="button"
          className="auth-password-toggle"
          aria-label={tr(visible ? tr("隐藏{label}") : tr("显示{label}"), {
            label,
          })}
          aria-pressed={visible}
          aria-controls={id}
          onClick={() => setVisible((v) => !v)}
        >
          <Icon name={visible ? "eye-off" : "eye"} size={17} />
        </button>
      </div>
      {error && (
        <small
          id={id + "-error"}
          className="field-note field-error"
          role="alert"
        >
          {tr(error)}
        </small>
      )}
    </div>
  );
}
