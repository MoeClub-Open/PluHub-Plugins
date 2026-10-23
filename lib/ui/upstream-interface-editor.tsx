import React from "react";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { t as tr } from "./i18n.js";
import { Select } from "./select.js";
import { Checkbox } from "./checkbox.js";

export const interfaceProtocols: {
  id: Protocol;
  name: string;
  path: string;
}[] = [
  { id: "openai-chat", name: "Chat Completions", path: "/v1/chat/completions" },
  { id: "openai-responses", name: "Responses", path: "/v1/responses" },
  { id: "anthropic", name: "Messages", path: "/v1/messages" },
  {
    id: "gemini",
    name: "Gemini",
    path: "/v1beta/models/{model}:generateContent",
  },
];

function JsonField({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: object;
  onChange: (value: any) => void;
}) {
  const [text, setText] = React.useState(
    value ? JSON.stringify(value, null, 2) : "",
  );
  const field = React.useRef<HTMLTextAreaElement>(null);
  React.useEffect(() => {
    try {
      if (
        JSON.stringify(text.trim() ? JSON.parse(text) : undefined) ===
        JSON.stringify(value)
      )
        return;
    } catch {}
    setText(value ? JSON.stringify(value, null, 2) : "");
    field.current?.setCustomValidity("");
  }, [JSON.stringify(value)]);
  return (
    <label>
      {label}
      <textarea
        ref={field}
        rows={3}
        value={text}
        spellCheck={false}
        placeholder="{}"
        onChange={(event) => {
          const text = event.target.value;
          setText(text);
          try {
            const parsed = text.trim() ? JSON.parse(text) : undefined;
            if (
              parsed !== undefined &&
              (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
            )
              throw new Error();
            event.target.setCustomValidity("");
            onChange(parsed);
          } catch {
            event.target.setCustomValidity(tr("请输入 JSON 对象"));
          }
        }}
      />
    </label>
  );
}

function ModelPatterns({
  value,
  onChange,
}: {
  value?: string[];
  onChange: (value: string[]) => void;
}) {
  const [text, setText] = React.useState(value?.join(", ") ?? "");
  const parse = (text: string) =>
    text
      .split(",")
      .map((model) => model.trim())
      .filter(Boolean);
  React.useEffect(() => {
    if (JSON.stringify(parse(text)) !== JSON.stringify(value ?? []))
      setText(value?.join(", ") ?? "");
  }, [JSON.stringify(value)]);
  return (
    <input
      value={text}
      placeholder="*"
      onChange={(event) => {
        setText(event.target.value);
        onChange(parse(event.target.value));
      }}
    />
  );
}

export function UpstreamInterfaceEditor({
  route,
  update,
}: {
  route: UpstreamInterface;
  update: (patch: Partial<UpstreamInterface>) => void;
}) {
  const [customIncoming, setCustomIncoming] = React.useState(
    route.incoming.length > 1 &&
      route.incoming.length < interfaceProtocols.length,
  );
  const incoming = customIncoming
    ? "custom"
    : route.incoming.length === interfaceProtocols.length
      ? "all"
      : (route.incoming[0] ?? "");
  const target = interfaceProtocols.find(
    (option) => option.id === route.protocol,
  )!;
  return (
    <div className="form-grid interface-route-fields">
      <label>
        {tr("入口接口")}
        <Select
          value={incoming}
          onChange={(event) => {
            const choice = event.target.value;
            setCustomIncoming(choice === "custom");
            if (choice !== "custom")
              update({
                incoming:
                  choice === "all"
                    ? interfaceProtocols.map((option) => option.id)
                    : [choice as Protocol],
              });
          }}
        >
          <option value="all">{tr("全部接口")}</option>
          {interfaceProtocols.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
          <option value="custom">{tr("自定义")}</option>
        </Select>
      </label>
      <label>
        {tr("上游接口")}
        <Select
          value={route.protocol}
          onChange={(event) =>
            update({
              protocol: event.target.value as Protocol,
              path: undefined,
              streamPath: undefined,
            })
          }
        >
          {interfaceProtocols.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </Select>
      </label>
      {customIncoming && (
        <div
          className="full interface-incoming"
          role="group"
          aria-label={tr("入口接口")}
        >
          {interfaceProtocols.map((option) => (
            <label key={option.id}>
              <Checkbox
                checked={route.incoming.includes(option.id)}
                onCheckedChange={(checked) =>
                  update({
                    incoming: checked
                      ? [...route.incoming, option.id]
                      : route.incoming.filter(
                          (protocol) => protocol !== option.id,
                        ),
                  })
                }
              />
              {option.name}
            </label>
          ))}
        </div>
      )}
      <label className="full">
        {tr("匹配模型")}
        <ModelPatterns
          value={route.models}
          onChange={(models) => update({ models })}
        />
      </label>
      <details className="full interface-route-options">
        <summary>{tr("路径与认证")}</summary>
        <div className="form-grid">
          <label>
            {tr("接口路径")}
            <input
              value={route.path ?? ""}
              placeholder={target.path}
              onChange={(event) =>
                update({ path: event.target.value || undefined })
              }
            />
          </label>
          <label>
            {tr("流式接口路径")}
            <input
              value={route.streamPath ?? ""}
              placeholder={
                route.protocol === "gemini"
                  ? "/v1beta/models/{model}:streamGenerateContent"
                  : route.path || target.path
              }
              onChange={(event) =>
                update({ streamPath: event.target.value || undefined })
              }
            />
          </label>
          <label>
            {tr("模型目录路径")}
            <input
              value={route.modelsPath ?? ""}
              placeholder={
                route.protocol === "gemini" ? "/v1beta/models" : "/v1/models"
              }
              onChange={(event) =>
                update({ modelsPath: event.target.value || undefined })
              }
            />
          </label>
          <label>
            {tr("认证方式")}
            <Select
              value={route.auth?.type ?? "default"}
              onChange={(event) =>
                update({
                  auth: {
                    type: event.target.value as NonNullable<
                      UpstreamInterface["auth"]
                    >["type"],
                    name: route.auth?.name,
                  },
                })
              }
            >
              <option value="default">{tr("接口默认")}</option>
              <option value="bearer">Bearer</option>
              <option value="header">{tr("自定义请求头")}</option>
              <option value="query">{tr("查询参数")}</option>
              <option value="none">{tr("无认证")}</option>
            </Select>
          </label>
          {["header", "query"].includes(route.auth?.type ?? "") && (
            <label>
              {tr("认证字段名")}
              <input
                required
                value={route.auth?.name ?? ""}
                onChange={(event) =>
                  update({ auth: { ...route.auth!, name: event.target.value } })
                }
              />
            </label>
          )}
          {["openai-chat", "openai-responses"].includes(route.protocol) && (
            <JsonField
              label={tr("媒体接口路径")}
              value={route.mediaPaths}
              onChange={(mediaPaths) => update({ mediaPaths })}
            />
          )}
        </div>
      </details>
      <details className="full interface-route-options">
        <summary>{tr("参数覆盖")}</summary>
        <div className="form-grid">
          <JsonField
            label={tr("请求头")}
            value={route.headers}
            onChange={(headers) => update({ headers })}
          />
          <JsonField
            label={tr("请求参数")}
            value={route.params}
            onChange={(params) => update({ params })}
          />
        </div>
      </details>
    </div>
  );
}
