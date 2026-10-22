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
  const [active, setActive] = React.useState(0);
  const listId = React.useId();
  const input = React.useRef<HTMLInputElement>(null);
  const results = React.useRef<HTMLDivElement>(null);
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
  const selected = Math.min(active, Math.max(0, matches.length - 1));
  React.useEffect(() => {
    results.current
      ?.querySelector('[aria-selected="true"]')
      ?.scrollIntoView({ block: "nearest" });
  }, [selected, query]);
  return (
    <Dialog title={tr("搜索页面")} close={close}>
      <div className="command-input">
        <Icon name="search" />
        <input
          ref={input}
          autoFocus
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-autocomplete="list"
          aria-controls={listId}
          aria-activedescendant={
            matches.length ? `${listId}-${selected}` : undefined
          }
          aria-label={tr("搜索页面")}
          placeholder={tr("搜索页面…")}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (
              (event.key === "ArrowDown" || event.key === "ArrowUp") &&
              matches.length
            ) {
              event.preventDefault();
              setActive(
                (selected +
                  (event.key === "ArrowDown" ? 1 : -1) +
                  matches.length) %
                  matches.length,
              );
            }
            if (event.key === "Enter" && matches[selected]) {
              event.preventDefault();
              location.hash = matches[selected].path;
              close();
            }
          }}
        />
      </div>
      <div
        ref={results}
        id={listId}
        className="command-results"
        role="listbox"
        aria-label={tr("搜索结果")}
      >
        {matches.map((entry, index) => (
          <a
            key={entry.path}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={index === selected}
            tabIndex={-1}
            href={"#" + entry.path}
            onPointerMove={() => setActive(index)}
            onClick={close}
          >
            <span>{entry.title}</span>
          </a>
        ))}
        {!matches.length && (
          <div className="empty-inline" role="status">
            {tr("没有匹配的页面")}
          </div>
        )}
      </div>
    </Dialog>
  );
}
