import React from "react";
import { Dialog } from "./components.js";
import { t as tr } from "./i18n.js";

type NavigationEvent = Event & {
  destination: { url: string; key: string };
  navigationType: string;
};
type Navigation = EventTarget & { traverseTo(key: string): unknown };

export function useUnsavedChanges(
  dirty: boolean,
  save: () => Promise<boolean>,
  busy = false,
) {
  const [pending, setPending] = React.useState<(() => void) | null>(null);
  const bypass = React.useRef(false);
  const leave = React.useCallback(
    (action: () => void) => {
      if (!dirty || bypass.current) action();
      else setPending(() => action);
    },
    [dirty],
  );
  React.useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      if (bypass.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    const navigation = (window as unknown as { navigation?: Navigation })
      .navigation;
    const navigate = (event: Event) => {
      if (bypass.current || !event.cancelable) return;
      const next = event as NavigationEvent;
      if (next.destination.url === location.href) return;
      event.preventDefault();
      leave(() => {
        if (next.navigationType === "traverse")
          navigation!.traverseTo(next.destination.key);
        else location.assign(next.destination.url);
      });
    };
    const click = (event: MouseEvent) => {
      if (
        bypass.current ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey
      )
        return;
      const anchor = (event.target as Element).closest<HTMLAnchorElement>(
        "a[href]",
      );
      if (
        !anchor ||
        anchor.target === "_blank" ||
        anchor.hasAttribute("download") ||
        anchor.href === location.href
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      leave(() => {
        location.href = anchor.href;
      });
    };
    window.addEventListener("beforeunload", unload);
    if (navigation) navigation.addEventListener("navigate", navigate);
    else document.addEventListener("click", click, true);
    return () => {
      window.removeEventListener("beforeunload", unload);
      if (navigation) navigation.removeEventListener("navigate", navigate);
      else document.removeEventListener("click", click, true);
    };
  }, [dirty, leave]);
  const proceed = () => {
    bypass.current = true;
    const action = pending;
    setPending(null);
    action?.();
    // Keep bypass active until the navigation commits or this editor unmounts.
    setTimeout(() => {
      bypass.current = false;
    }, 1000);
  };
  return {
    leave,
    confirmation: pending && (
      <Dialog
        title={tr("有未保存的修改")}
        close={() => {
          if (!busy) setPending(null);
        }}
      >
        <div className="actions">
          <button
            className="secondary"
            disabled={busy}
            onClick={() => setPending(null)}
          >
            {tr("继续编辑")}
          </button>
          <button
            className="secondary danger"
            disabled={busy}
            onClick={proceed}
          >
            {tr("放弃更改并离开")}
          </button>
          <button
            disabled={busy}
            onClick={async () => {
              if (await save()) proceed();
            }}
          >
            {tr("保存并离开")}
          </button>
        </div>
      </Dialog>
    ),
  };
}
