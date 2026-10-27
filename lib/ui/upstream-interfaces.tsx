import React from "react";
import * as Tabs from "@radix-ui/react-tabs";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { t as tr } from "./i18n.js";
import { Icon } from "./components.js";
import { Select } from "./select.js";
import { InterfaceJsonEditor } from "./upstream-interface-json.js";
import { FlowParameter } from "./flow-parameter-port.js";
import {
  IncomingInterfaces,
  ModelPatterns,
  UpstreamInterfaceEditor,
  interfaceProtocols,
} from "./upstream-interface-editor.js";

export function UpstreamInterfaces({
  value,
  protocol,
  onChange,
  parameterPrefix,
  hasParameterBindings = false,
  boundInputs,
}: {
  value?: UpstreamInterface[];
  protocol: string;
  onChange: (
    value: UpstreamInterface[] | undefined,
    oldToNew?: readonly number[],
  ) => void;
  parameterPrefix?: string;
  hasParameterBindings?: boolean;
  boundInputs?: ReadonlySet<string>;
}) {
  const group = React.useId();
  const identities = React.useRef(new WeakMap<UpstreamInterface, string>());
  const counter = React.useRef(0);
  const [view, setView] = React.useState("rules");
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
    onChange(
      next,
      routes.map((_, i) =>
        i === index ? destination : i === destination ? index : i,
      ),
    );
  }
  return (
    <Tabs.Root
      className="full interface-routing"
      value={view}
      onValueChange={setView}
    >
      <div className="interface-routing-heading">
        <h3>{tr("高级路由")}</h3>
        <Tabs.List
          className="interface-view-switch"
          aria-label={tr("路由编辑方式")}
        >
          <Tabs.Trigger className="ghost" value="rules">
            {tr("规则")}
          </Tabs.Trigger>
          <Tabs.Trigger className="ghost" value="json">
            JSON
          </Tabs.Trigger>
        </Tabs.List>
        {view === "rules" && (
          <button
            type="button"
            className="secondary"
            onClick={() => {
              const target = routes.length
                ? (interfaceProtocols.find(
                    (option) =>
                      !routes.some((route) => route.protocol === option.id),
                  )?.id ?? (protocol as Protocol))
                : (protocol as Protocol);
              const route: UpstreamInterface = {
                protocol: target,
                incoming: routes.length
                  ? [target]
                  : interfaceProtocols.map((option) => option.id),
              };
              onChange(
                [route, ...routes],
                routes.map((_, index) => index + 1),
              );
            }}
          >
            <Icon name="plus" size={14} />
            {tr("添加路由")}
          </button>
        )}
      </div>
      <Tabs.Content
        className="interface-routing-content"
        value="rules"
        forceMount
        hidden={view !== "rules"}
      >
        {routes.length ? (
          <div
            role="table"
            aria-label={tr("路由规则")}
            className="interface-route-list"
          >
            <div
              role="row"
              className="interface-route-grid interface-route-head"
            >
              {["入口接口", "上游接口", "匹配模型", "接口路径", "操作"].map(
                (title) => (
                  <span role="columnheader" key={title}>
                    {tr(title)}
                  </span>
                ),
              )}
            </div>
            {routes.map((route, index) => {
              const id = identity(route);
              const prefix = parameterPrefix
                ? `${parameterPrefix}.${index}`
                : undefined;
              const parameter = (field: string, content: React.ReactNode) =>
                prefix ? (
                  <FlowParameter field={`${prefix}.${field}`}>
                    {content}
                  </FlowParameter>
                ) : (
                  content
                );
              return (
                <div className="interface-route" key={id}>
                  <div className="interface-route-grid" role="row">
                    {parameter(
                      "incoming",
                      <label role="cell">
                        <span>{tr("入口接口")}</span>
                        <IncomingInterfaces
                          value={route.incoming}
                          onChange={(incoming) => update(index, { incoming })}
                        />
                      </label>,
                    )}
                    {parameter(
                      "protocol",
                      <label role="cell">
                        <span>{tr("上游接口")}</span>
                        <Select
                          value={route.protocol}
                          onChange={(event) =>
                            update(index, {
                              protocol: event.target.value as Protocol,
                            })
                          }
                        >
                          {interfaceProtocols.map((option) => (
                            <option key={option.id} value={option.id}>
                              {option.name}
                            </option>
                          ))}
                        </Select>
                      </label>,
                    )}
                    {parameter(
                      "models",
                      <label role="cell">
                        <span>{tr("匹配模型")}</span>
                        <ModelPatterns
                          value={route.models}
                          onChange={(models) => update(index, { models })}
                        />
                      </label>,
                    )}
                    {parameter(
                      "path",
                      <label role="cell">
                        <span>{tr("接口路径")}</span>
                        <input
                          value={route.path ?? ""}
                          placeholder={
                            interfaceProtocols.find(
                              (option) => option.id === route.protocol,
                            )!.path
                          }
                          onChange={(event) =>
                            update(index, {
                              path: event.target.value || undefined,
                            })
                          }
                        />
                      </label>,
                    )}
                    <div className="interface-route-actions" role="cell">
                      <button
                        type="button"
                        className="ghost"
                        aria-expanded={selected === id}
                        aria-controls={id + "-options"}
                        onClick={() =>
                          setSelected(selected === id ? undefined : id)
                        }
                      >
                        {tr(selected === id ? "收起设置" : "更多设置")}
                      </button>
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
                          onClick={() => move(index, direction)}
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
                        onClick={() => {
                          const next = routes.filter((_, i) => i !== index);
                          onChange(
                            next.length ? next : undefined,
                            routes.map((_, i) =>
                              i === index ? -1 : i > index ? i - 1 : i,
                            ),
                          );
                          if (selected === id) setSelected(undefined);
                        }}
                      >
                        <Icon name="delete" size={14} />
                      </button>
                    </div>
                  </div>
                  <div
                    id={id + "-options"}
                    className="interface-route-settings"
                    hidden={selected !== id}
                    onInvalidCapture={() => {
                      setView("rules");
                      setSelected(id);
                    }}
                  >
                    <UpstreamInterfaceEditor
                      route={route}
                      update={(patch) => update(index, patch)}
                      parameterPrefix={prefix}
                      boundInputs={boundInputs}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="empty-inline">{tr("未配置自定义路由")}</p>
        )}
      </Tabs.Content>
      <Tabs.Content
        className="interface-routing-content"
        value="json"
        forceMount
        hidden={view !== "json"}
      >
        <InterfaceJsonEditor
          value={value}
          onChange={onChange}
          reveal={() => setView("json")}
          disabled={hasParameterBindings}
        />
      </Tabs.Content>
    </Tabs.Root>
  );
}
