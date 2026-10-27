import React from "react";
import * as Popover from "@radix-ui/react-popover";
import { ChevronDown } from "lucide-react";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { t as tr } from "./i18n.js";
import { Select } from "./select.js";
import { Checkbox } from "./checkbox.js";
import { FlowParameter } from "./flow-parameter-port.js";

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

export function ModelPatterns({
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

export function IncomingInterfaces({
  value,
  onChange,
}: {
  value: Protocol[];
  onChange: (value: Protocol[]) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const trigger = React.useRef<HTMLButtonElement>(null);
  const all = interfaceProtocols.every((option) => value.includes(option.id));
  const label = all
    ? tr("全部接口")
    : interfaceProtocols
        .filter((option) => value.includes(option.id))
        .map((option) => option.name)
        .join(" / ") || tr("选择入口接口");
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        ref={trigger}
        className="select-trigger interface-incoming-trigger"
        aria-label={tr("入口接口")}
        title={label}
      >
        <span>{label}</span>
        <ChevronDown size={14} aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal
        container={
          trigger.current?.closest<HTMLElement>(".dialog-layer, dialog") ??
          undefined
        }
      >
        <Popover.Content
          className="interface-incoming-popover"
          align="start"
          sideOffset={5}
          collisionPadding={8}
          aria-label={tr("入口接口")}
        >
          <label>
            <Checkbox
              checked={all}
              indeterminate={value.length > 0 && !all}
              onCheckedChange={(checked) =>
                onChange(
                  checked ? interfaceProtocols.map((option) => option.id) : [],
                )
              }
            />
            {tr("全部接口")}
          </label>
          {interfaceProtocols.map((option) => (
            <label key={option.id}>
              <Checkbox
                checked={value.includes(option.id)}
                onCheckedChange={(checked) =>
                  onChange(
                    checked
                      ? [...value, option.id]
                      : value.filter((protocol) => protocol !== option.id),
                  )
                }
              />
              {option.name}
            </label>
          ))}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

export function UpstreamInterfaceEditor({
  route,
  update,
  parameterPrefix,
  boundInputs,
}: {
  route: UpstreamInterface;
  update: (patch: Partial<UpstreamInterface>) => void;
  parameterPrefix?: string;
  boundInputs?: ReadonlySet<string>;
}) {
  const target = interfaceProtocols.find(
    (option) => option.id === route.protocol,
  )!;
  const parameter = (field: string, content: React.ReactNode) =>
    parameterPrefix ? (
      <FlowParameter field={`${parameterPrefix}.${field}`}>
        {content}
      </FlowParameter>
    ) : (
      content
    );
  return (
    <div className="form-grid interface-route-options">
      {parameter(
        "streamPath",
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
        </label>,
      )}
      {parameter(
        "modelsPath",
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
        </label>,
      )}
      {parameter(
        "auth.type",
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
        </label>,
      )}
      {(["header", "query"].includes(route.auth?.type ?? "") ||
        (!!parameterPrefix &&
          (boundInputs?.has(`${parameterPrefix}.auth.type`) ||
            boundInputs?.has(`${parameterPrefix}.auth.name`)))) &&
        parameter(
          "auth.name",
          <label>
            {tr("认证字段名")}
            <input
              required={["header", "query"].includes(route.auth?.type ?? "")}
              value={route.auth?.name ?? ""}
              onChange={(event) =>
                update({
                  auth: {
                    type: route.auth?.type ?? "default",
                    name: event.target.value,
                  },
                })
              }
            />
          </label>,
        )}
      {parameter(
        "headers",
        <JsonField
          label={tr("请求头")}
          value={route.headers}
          onChange={(headers) => update({ headers })}
        />,
      )}
      {parameter(
        "params",
        <JsonField
          label={tr("请求参数")}
          value={route.params}
          onChange={(params) => update({ params })}
        />,
      )}
      {(["openai-chat", "openai-responses"].includes(route.protocol) ||
        (!!parameterPrefix &&
          (boundInputs?.has(`${parameterPrefix}.protocol`) ||
            boundInputs?.has(`${parameterPrefix}.mediaPaths`)))) &&
        parameter(
          "mediaPaths",
          <JsonField
            label={tr("媒体接口路径")}
            value={route.mediaPaths}
            onChange={(mediaPaths) => update({ mediaPaths })}
          />,
        )}
    </div>
  );
}
