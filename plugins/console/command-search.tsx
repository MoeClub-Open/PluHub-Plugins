import { t as tr } from "../../lib/ui/i18n.js";
import React from "react";
import type { Extension } from "@pluhub/ui-sdk";
import { Dialog, Icon } from "../../lib/ui/components.js";
export function CommandSearch({
  entries,
  close,
}: {
  entries: (Pick<Extension, "path" | "title"> & { searchTerms?: string })[];
  close: () => void;
}) {
  const [query, setQuery] = React.useState("");
  const input = React.useRef<HTMLInputElement>(null);
  React.useEffect(() => {
    input.current?.focus();
  }, []);
  const words = query.toLocaleLowerCase().trim().split(/\s+/).filter(Boolean);
  const matches = entries.filter((entry) =>
    words.every((word) =>
      [entry.title, entry.path, entry.searchTerms]
        .join(" ")
        .toLocaleLowerCase()
        .includes(word),
    ),
  );
  return (
    <Dialog title={tr("搜索页面")} close={close}>
      <div className="command-input">
        <Icon name="search" />
        <input
          ref={input}
          autoFocus
          type="search"
          aria-label={tr("搜索页面")}
          placeholder={tr("搜索页面…")}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && matches[0]) {
              location.hash = matches[0].path;
              close();
            }
          }}
        />
      </div>
      <nav className="command-results" aria-label={tr("搜索结果")}>
        {matches.map((entry) => (
          <a key={entry.path} href={"#" + entry.path} onClick={close}>
            <span>{entry.title}</span>
            <Icon name="arrow" size={15} />
          </a>
        ))}
        {!matches.length && (
          <p className="empty-inline">{tr("没有匹配的页面")}</p>
        )}
      </nav>
    </Dialog>
  );
}
