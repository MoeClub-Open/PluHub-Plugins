import React from "react";
import type { UpstreamInterface } from "@pluhub/contracts/ai";
import { validateInterfaces } from "../ai/upstream-interfaces.js";
import { t as tr } from "./i18n.js";

export function InterfaceJsonEditor({
  value,
  onChange,
  reveal,
  disabled = false,
}: {
  value?: UpstreamInterface[];
  onChange: (value: UpstreamInterface[] | undefined) => void;
  reveal: () => void;
  disabled?: boolean;
}) {
  const serialized = JSON.stringify(value ?? []);
  const applied = React.useRef(serialized);
  const field = React.useRef<HTMLTextAreaElement>(null);
  const errorId = React.useId();
  const [text, setText] = React.useState(() =>
    JSON.stringify(value ?? [], null, 2),
  );
  const [error, setError] = React.useState("");
  React.useEffect(() => {
    if (serialized === applied.current) return;
    applied.current = serialized;
    setText(JSON.stringify(value ?? [], null, 2));
    setError("");
    field.current?.setCustomValidity("");
  }, [serialized]);
  return (
    <div className="interface-json-editor">
      <textarea
        ref={field}
        aria-label={tr("路由 JSON")}
        aria-invalid={!!error}
        aria-describedby={error ? errorId : undefined}
        value={text}
        rows={16}
        disabled={disabled}
        spellCheck={false}
        autoCapitalize="off"
        autoComplete="off"
        onInvalid={(event) => {
          event.preventDefault();
          reveal();
          requestAnimationFrame(() => field.current?.focus());
        }}
        onChange={(event) => {
          const text = event.target.value;
          setText(text);
          try {
            const parsed: unknown = JSON.parse(text);
            if (!Array.isArray(parsed))
              throw new Error(tr("路由 JSON 必须是数组"));
            const next = parsed.length ? validateInterfaces(parsed) : undefined;
            applied.current = JSON.stringify(next ?? []);
            event.target.setCustomValidity("");
            setError("");
            onChange(next);
          } catch (cause) {
            const message =
              cause instanceof SyntaxError
                ? tr("JSON 格式无效")
                : cause instanceof Error
                  ? tr(cause.message)
                  : tr("JSON 格式无效");
            setError(message);
            event.target.setCustomValidity(message);
          }
        }}
      />
      {disabled && (
        <p className="field-note">
          {tr("断开接口规则的参数连线后可编辑 JSON")}
        </p>
      )}
      {error && (
        <p className="danger-text" role="alert" id={errorId}>
          {error}
        </p>
      )}
    </div>
  );
}
