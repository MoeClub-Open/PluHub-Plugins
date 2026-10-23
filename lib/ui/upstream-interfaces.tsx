import React from "react";
import { ArrowDown, ArrowUp, ChevronRight } from "lucide-react";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { t as tr } from "./i18n.js";
import { Icon } from "./components.js";
import {
  UpstreamInterfaceEditor,
  interfaceProtocols,
} from "./upstream-interface-editor.js";

export function UpstreamInterfaces({
  value,
  protocol,
  onChange,
}: {
  value?: UpstreamInterface[];
  protocol: string;
  onChange: (value: UpstreamInterface[] | undefined) => void;
}) {
  const group = React.useId();
  const identities = React.useRef(new WeakMap<UpstreamInterface, string>());
  const counter = React.useRef(0);
  const [expanded, setExpanded] = React.useState(!!value?.length);
  const [selected, setSelected] = React.useState<string>();
  if (!interfaceProtocols.some((option) => option.id === protocol)) return null;
  const routes = value ?? [];
  function identity(route: UpstreamInterface) {
    let id = identities.current.get(route);
    if (!id) {
      id = group + ":" + ++counter.current;
      identities.current.set(route, id);
    }
    return id;
  }
  function update(index: number, patch: Partial<UpstreamInterface>) {
    const route = { ...routes[index]!, ...patch };
    identities.current.set(route, identity(routes[index]!));
    onChange(routes.map((current, i) => (i === index ? route : current)));
  }
  function move(index: number, direction: number) {
    const next = [...routes];
    const destination = index + direction;
    [next[index], next[destination]] = [next[destination]!, next[index]!];
    onChange(next);
  }
  const name = (protocol: Protocol) =>
    interfaceProtocols.find((option) => option.id === protocol)!.name;
  return (
    <details
      className="full interface-routing"
      open={expanded}
      onToggle={(event) => {
        if (event.target === event.currentTarget)
          setExpanded(event.currentTarget.open);
      }}
    >
      <summary>
        <ChevronRight
          className="interface-route-chevron"
          size={14}
          aria-hidden="true"
        />
        {tr("高级路由")}
        {!!routes.length && <span className="badge">{routes.length}</span>}
      </summary>
      <div className="interface-route-toolbar">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const target =
              interfaceProtocols.find(
                (option) =>
                  !routes.some((route) => route.protocol === option.id),
              )?.id ?? (protocol as Protocol);
            const route: UpstreamInterface = {
              protocol: routes.length ? target : (protocol as Protocol),
              incoming: routes.length
                ? [target]
                : interfaceProtocols.map((option) => option.id),
            };
            setSelected(identity(route));
            setExpanded(true);
            onChange([route, ...routes]);
          }}
        >
          <Icon name="plus" size={14} />
          {tr("添加路由")}
        </button>
      </div>
      {!!routes.length && (
        <div className="interface-route-list">
          {routes.map((route, index) => {
            const id = identity(route);
            const incoming =
              route.incoming.length === interfaceProtocols.length
                ? tr("全部接口")
                : route.incoming.map(name).join(" / ") || "—";
            return (
              <details
                key={id}
                name={group}
                className="interface-route"
                open={selected === id}
                onToggle={(event) => {
                  if (event.target !== event.currentTarget) return;
                  if (event.currentTarget.open) setSelected(id);
                  else
                    setSelected((current) =>
                      current === id ? undefined : current,
                    );
                }}
                onInvalidCapture={() => {
                  setExpanded(true);
                  setSelected(id);
                }}
              >
                <summary>
                  <ChevronRight
                    className="interface-route-chevron"
                    size={14}
                    aria-hidden="true"
                  />
                  <span className="interface-route-summary">
                    <span className="interface-route-mapping">
                      <span title={incoming}>{incoming}</span>
                      <Icon name="arrow" size={13} />
                      <strong>{name(route.protocol)}</strong>
                    </span>
                    <span
                      className="interface-route-models"
                      title={route.models?.join(", ")}
                    >
                      {route.models?.length
                        ? route.models.join(", ")
                        : tr("所有模型")}
                    </span>
                  </span>
                  <span className="interface-route-actions">
                    {[-1, 1].map((direction) => (
                      <button
                        key={direction}
                        type="button"
                        className="ghost icon-button"
                        aria-label={tr(direction < 0 ? "上移" : "下移")}
                        title={tr(direction < 0 ? "上移" : "下移")}
                        disabled={
                          direction < 0
                            ? index === 0
                            : index === routes.length - 1
                        }
                        onClick={(event) => {
                          event.preventDefault();
                          move(index, direction);
                        }}
                      >
                        {direction < 0 ? (
                          <ArrowUp size={14} aria-hidden="true" />
                        ) : (
                          <ArrowDown size={14} aria-hidden="true" />
                        )}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="ghost icon-button danger"
                      aria-label={tr("删除路由")}
                      title={tr("删除路由")}
                      onClick={(event) => {
                        event.preventDefault();
                        const next = routes.filter((_, i) => i !== index);
                        onChange(next.length ? next : undefined);
                        if (selected === id) setSelected(undefined);
                      }}
                    >
                      <Icon name="delete" size={14} />
                    </button>
                  </span>
                </summary>
                <UpstreamInterfaceEditor
                  route={route}
                  update={(patch) => update(index, patch)}
                />
              </details>
            );
          })}
        </div>
      )}
    </details>
  );
}
