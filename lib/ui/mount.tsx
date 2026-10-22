import React from "react";
import { createRoot } from "react-dom/client";
import type { UIHost } from "@pluhub/ui-sdk";
import { useLocale } from "./language.js";
import { t as tr, bindInternationalization } from "./i18n.js";
export function mountPage(
  element: HTMLElement,
  host: UIHost,
  Page: React.ComponentType<{ host: UIHost }>,
) {
  bindInternationalization(host.i18n);
  const root = createRoot(element);
  function LocalizedPage() {
    useLocale();
    return <Page host={host} />;
  }
  root.render(<LocalizedPage />);
  return () => root.unmount();
}
export function useLoad<T>(loader: () => Promise<T>, keys: unknown[] = []) {
  const [data, setData] = React.useState<T>();
  const [error, setError] = React.useState("");
  const [version, setVersion] = React.useState(0);
  React.useEffect(() => {
    let live = true;
    loader().then(
      (value) => {
        if (live) {
          setData(value);
          setError("");
        }
      },
      (e) => {
        if (live) setError(e.message);
      },
    );
    return () => {
      live = false;
    };
  }, [...keys, version]);
  return { data, error, reload: () => setVersion((v) => v + 1) };
}
export function Notice({ message }: { message: string }) {
  return message ? (
    <div className="notice" role="status">
      {tr(message)}
    </div>
  ) : null;
}
