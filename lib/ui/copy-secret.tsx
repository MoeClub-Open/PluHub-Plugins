import React from "react";
import { t as tr } from "./i18n.js";

/** Reserve clipboard access while the click gesture is active. */
export async function copySecret(
  value: string | Promise<string>,
): Promise<boolean> {
  if (
    typeof value !== "string" &&
    navigator.clipboard?.write &&
    typeof ClipboardItem !== "undefined"
  ) {
    try {
      await navigator.clipboard.write([
        new ClipboardItem({
          "text/plain": value.then(
            (text) => new Blob([text], { type: "text/plain" }),
          ),
        }),
      ]);
      return true;
    } catch {
      /* A rejected clipboard permission still allows manual copying. */
    }
  }
  const text = await value;
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    /* Embedded browsers may not expose the Clipboard API. */
  }
  const active = document.activeElement as HTMLElement | null;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.style.cssText = "position:fixed;top:0;left:-9999px";
  document.body.append(field);
  field.select();
  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    field.remove();
    active?.focus({ preventScroll: true });
  }
}

export function SecretCopy({
  value,
  close,
  onMessage,
}: {
  value: string;
  close: () => void;
  onMessage: (message: string) => void;
}) {
  const field = React.useRef<HTMLTextAreaElement>(null);
  return (
    <>
      <textarea
        ref={field}
        className="code issued-token"
        aria-label={tr("API 密钥")}
        value={value}
        readOnly
        spellCheck={false}
        rows={Math.min(6, value.split("\n").length)}
        onFocus={(event) => event.currentTarget.select()}
        onClick={(event) => event.currentTarget.select()}
      />
      <div className="form-actions">
        <button
          className="secondary"
          onClick={async () => {
            if (await copySecret(value)) onMessage(tr("密钥已复制"));
            else {
              field.current?.focus();
              field.current?.select();
              onMessage(tr("已选中密钥，请手动复制"));
            }
          }}
        >
          {tr("复制密钥")}
        </button>
        <button onClick={close}>{tr("关闭")}</button>
      </div>
    </>
  );
}
