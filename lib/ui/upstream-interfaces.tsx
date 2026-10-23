import React from "react";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { t as tr } from "./i18n.js";
import { Select } from "./select.js";
import { Checkbox } from "./checkbox.js";
import { Icon } from "./components.js";

const protocols: { id: Protocol; name: string; path: string }[] = [
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

export function UpstreamInterfaces({
  value,
  protocol,
  onChange,
}: {
  value?: UpstreamInterface[];
  protocol: string;
  onChange: (value: UpstreamInterface[] | undefined) => void;
}) {
  if (!protocols.some((option) => option.id === protocol)) return null;
  const update = (index: number, patch: Partial<UpstreamInterface>) =>
    onChange(
      value!.map((route, i) => (i === index ? { ...route, ...patch } : route)),
    );
  return (
    <details className="full" open={value?.length ? true : undefined}>
      <summary>{tr("接口组合")}</summary>
      <div className="actions">
        <button
          type="button"
          className="secondary"
          onClick={() => {
            const target =
              protocols.find(
                (option) =>
                  !value?.some((route) => route.protocol === option.id),
              )?.id ?? (protocol as Protocol);
            const route: UpstreamInterface = {
              protocol: value?.length ? target : (protocol as Protocol),
              incoming: value?.length ? [target] : protocols.map((p) => p.id),
            };
            onChange([route, ...(value ?? [])]);
          }}
        >
          <Icon name="plus" size={14} />
          {tr("添加接口路由")}
        </button>
      </div>
      {value?.map((route, index) => (
        <fieldset key={index}>
          <legend>
            {protocols.find((p) => p.id === route.protocol)?.name}
          </legend>
          <div className="form-grid">
            <div className="full actions">
              <span>{tr("入口接口")}</span>
              {protocols.map((option) => (
                <label className="checkbox-row" key={option.id}>
                  <Checkbox
                    checked={route.incoming.includes(option.id)}
                    onCheckedChange={(checked) =>
                      update(index, {
                        incoming: checked
                          ? [...route.incoming, option.id]
                          : route.incoming.filter((p) => p !== option.id),
                      })
                    }
                  />
                  {option.name}
                </label>
              ))}
            </div>
            <label>
              {tr("上游接口")}
              <Select
                value={route.protocol}
                onChange={(e) =>
                  update(index, {
                    protocol: e.target.value as Protocol,
                    path: undefined,
                    streamPath: undefined,
                  })
                }
              >
                {protocols.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.name}
                  </option>
                ))}
              </Select>
            </label>
            <label>
              {tr("匹配模型")}
              <ModelPatterns
                value={route.models}
                onChange={(models) => update(index, { models })}
              />
            </label>
            <label>
              {tr("接口路径")}
              <input
                value={route.path ?? ""}
                placeholder={
                  protocols.find((p) => p.id === route.protocol)?.path
                }
                onChange={(e) =>
                  update(index, { path: e.target.value || undefined })
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
                    : route.path ||
                      protocols.find((p) => p.id === route.protocol)?.path
                }
                onChange={(e) =>
                  update(index, { streamPath: e.target.value || undefined })
                }
              />
            </label>
            <label>
              {tr("认证方式")}
              <Select
                value={route.auth?.type ?? "default"}
                onChange={(e) =>
                  update(index, {
                    auth: {
                      type: e.target.value as NonNullable<
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
                  onChange={(e) =>
                    update(index, {
                      auth: { ...route.auth!, name: e.target.value },
                    })
                  }
                />
              </label>
            )}
            <details className="full">
              <summary>{tr("高级参数")}</summary>
              <div className="form-grid">
                <label>
                  {tr("模型目录路径")}
                  <input
                    value={route.modelsPath ?? ""}
                    placeholder={
                      route.protocol === "gemini"
                        ? "/v1beta/models"
                        : "/v1/models"
                    }
                    onChange={(e) =>
                      update(index, { modelsPath: e.target.value || undefined })
                    }
                  />
                </label>
                <JsonField
                  label={tr("请求头")}
                  value={route.headers}
                  onChange={(headers) => update(index, { headers })}
                />
                <JsonField
                  label={tr("请求参数")}
                  value={route.params}
                  onChange={(params) => update(index, { params })}
                />
              </div>
            </details>
            <div className="full actions">
              <button
                type="button"
                className="ghost"
                disabled={index === 0}
                onClick={() => {
                  const next = [...value];
                  [next[index - 1], next[index]] = [
                    next[index]!,
                    next[index - 1]!,
                  ];
                  onChange(next);
                }}
              >
                {tr("上移")}
              </button>
              <button
                type="button"
                className="ghost"
                disabled={index === value.length - 1}
                onClick={() => {
                  const next = [...value];
                  [next[index + 1], next[index]] = [
                    next[index]!,
                    next[index + 1]!,
                  ];
                  onChange(next);
                }}
              >
                {tr("下移")}
              </button>
              <button
                type="button"
                className="ghost danger"
                onClick={() => {
                  const next = value.filter((_, i) => i !== index);
                  onChange(next.length ? next : undefined);
                }}
              >
                <Icon name="delete" size={14} />
                {tr("删除")}
              </button>
            </div>
          </div>
        </fieldset>
      ))}
    </details>
  );
}
