import React from "react";
import { t as tr } from "./i18n.js";

export function SecretInput({
  value,
  onChange,
  name,
  multiline = false,
  disabled,
  label,
}: {
  value?: string | string[];
  onChange?: (value: string | string[]) => void;
  name?: string;
  multiline?: boolean;
  disabled?: boolean;
  label?: string;
}) {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  const managed =
    values.length > 0 && values.every((item) => /^(secret:|local:)/.test(item));
  const saved = React.useRef(value);
  if (managed) saved.current = value;
  const [entered, setEntered] = React.useState<string>();
  const stored = managed ? values.join("\n") : "";
  React.useEffect(() => {
    if (stored) setEntered(undefined);
  }, [stored]);
  const text = entered ?? (managed ? "" : values.join("\n"));
  const effective =
    entered === undefined || (!entered && saved.current)
      ? (saved.current ?? value)
      : multiline
        ? entered
            .split(/\r?\n/)
            .map((item) => item.trim())
            .filter(Boolean)
        : entered;
  const props = {
    value: text,
    disabled,
    "aria-label": label,
    autoComplete: "new-password",
    placeholder:
      managed || saved.current
        ? tr("已设置，留空保留")
        : tr(multiline ? "每行一个 API Key" : "填写密钥"),
    onChange: (
      event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
    ) => {
      const next = event.target.value;
      setEntered(next);
      onChange?.(
        !next && saved.current
          ? saved.current
          : multiline
            ? next
                .split(/\r?\n/)
                .map((item) => item.trim())
                .filter(Boolean)
            : next,
      );
    },
  };
  return (
    <>
      {name && (
        <input
          type="hidden"
          name={name}
          value={
            Array.isArray(effective) ? effective.join("\n") : (effective ?? "")
          }
        />
      )}
      {multiline ? (
        <textarea {...props} rows={3} spellCheck={false} />
      ) : (
        <input {...props} type="password" />
      )}
    </>
  );
}
