import { listSubscriptionAccounts } from "./subscription-providers.js";
import { t as tr, textValue } from "./i18n.js";
import { Select } from "./select.js";
import { ChannelExtension } from "./channel-extension.js";
import { Dialog } from "./components.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ChannelWorkflow, WorkflowNode } from "@pluhub/contracts/workflow";
import type { Protocol } from "@pluhub/contracts/ai";
import { useLoad, Notice } from "./mount.js";
import { syncChannelSecrets } from "../ai/channel-list.js";
import type { ChannelPanel } from "./channel-location.js";
import {
  defaultChannelFlow,
  migrateLegacyChannels,
} from "../ai/channel-config.js";
const labels: Record<WorkflowNode["type"], string> = {
  get start() {
    return tr("请求入口");
  },
  get provider() {
    return tr("调用上游");
  },
  get routing() {
    return tr("自动路由");
  },
  get condition() {
    return tr("条件分支");
  },
  get protocol() {
    return tr("协议准入");
  },
  get prompt() {
    return tr("系统提示词");
  },
  get reasoning() {
    return tr("思考强度");
  },
  get maxTokens() {
    return tr("输出预算");
  },
  get tps() {
    return tr("输出 TPS");
  },
  get rateLimit() {
    return tr("请求限流");
  },
  get upstream() {
    return tr("转到其他模型");
  },
};
const ingressOptions: { value: Protocol; label: string }[] = [
  { value: "openai-chat", label: "OpenAI Chat Completions" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic Messages" },
  { value: "gemini", label: "Gemini" },
];
const routerConfig = (config: any) =>
  config.plugins.find((p: any) =>
    /\/(?:official\.)?ai-router$/.test(p.path.replaceAll("\\", "/")),
  )?.config;
export function ChannelGraphEditor({
  host,
  channelId,
  close,
  saved,
  personal = false,
  initialPanel,
}: {
  host: UIHost;
  channelId: string;
  close: () => void;
  saved: () => void;
  personal?: boolean;
  initialPanel?: ChannelPanel;
}) {
  const loaded = useLoad<any>(() =>
    host.request(
      personal
        ? "/api/plugins/official.byok/personal-channels"
        : "/api/host/config",
    ),
  );
  const [channelName, setChannelName] = React.useState("");
  const [enabled, setEnabled] = React.useState(false);
  const [flow, setFlow] = React.useState<ChannelWorkflow>();
  const [selected, select] = React.useState("start");
  const [message, setMessage] = React.useState("");
  const [task, setTask] = React.useState("Hello");
  const [preview, setPreview] = React.useState<any>();
  const [panel, setPanel] = React.useState<ChannelPanel | undefined>(
    personal ? undefined : initialPanel,
  );
  const [busy, setBusy] = React.useState(false);
  const subscriptionAccounts = useLoad<any[]>(
    () => (personal ? Promise.resolve([]) : listSubscriptionAccounts(host)),
    [personal],
  );
  const [zoom, setZoom] = React.useState(1);
  const canvas = React.useRef<HTMLElement>(null);
  const [toolTask, setToolTask] = React.useState(false);
  const [streamTask, setStreamTask] = React.useState(false);
  const [ingressProtocol, setIngressProtocol] =
    React.useState<Protocol>("openai-chat");
  const normalized = React.useMemo(() => {
    if (!loaded.data) return undefined;
    if (personal) {
      const own = loaded.data.find((c: any) => c.id === channelId);
      return {
        plugins: [
          {
            path: "/ai-router",
            config: {
              upstreams: { [channelId]: own },
              models: own?.models ?? {},
            },
          },
        ],
      };
    }
    const config = structuredClone(loaded.data);
    try {
      migrateLegacyChannels(config);
      return config;
    } catch (error) {
      return { error: (error as Error).message };
    }
  }, [loaded.data]);
  const router = normalized?.plugins ? routerConfig(normalized) : undefined;
  const channel = router?.upstreams?.[channelId];
  const targets = [
    ...Object.keys(router?.models ?? {}),
    ...Object.keys(router?.redirects ?? {}),
  ];
  React.useEffect(() => {
    if (channel) {
      setChannelName(channel.name ?? "");
      setEnabled(channel.enabled !== false);
      const next = structuredClone(channel.flow ?? defaultChannelFlow());
      setFlow(next);
      select(next.entry);
    }
  }, [JSON.stringify(channel)]);
  const node = flow?.nodes.find((n) => n.id === selected);
  function update(next: ChannelWorkflow) {
    setFlow(next);
    setPreview(undefined);
    setMessage("");
  }
  const protocols = [
    "openai-chat",
    "openai-responses",
    "anthropic",
    "gemini",
    "codex",
    "claude-subscription",
    "antigravity",
  ];
  function connection(patch: Record<string, unknown>) {
    if (node?.type !== "provider") return;
    change({
      upstream: {
        ...(node.upstream ?? {
          protocol: "openai-chat",
          baseUrl: "",
          keyRef: "",
        }),
        ...patch,
      },
    });
  }
  function change(patch: any) {
    if (flow && node)
      update({
        ...flow,
        nodes: flow.nodes.map((n) =>
          n.id === node.id ? { ...n, ...patch } : n,
        ),
      });
  }
  function add(type: WorkflowNode["type"]) {
    if (!flow || flow.nodes.length >= 64) return;
    let key = type;
    let n = 1;
    while (flow.nodes.some((item) => item.id === key))
      key = (type + n++) as typeof key;
    const anchor = flow.nodes.find((n) => n.id === selected);
    const next =
      anchor && "next" in anchor
        ? anchor.next
        : anchor &&
            (anchor.type === "provider" ||
              anchor.type === "upstream" ||
              anchor.type === "routing")
          ? anchor.id
          : (flow.nodes.find(
              (n) =>
                n.type === "upstream" ||
                n.type === "provider" ||
                n.type === "routing",
            )?.id ?? "provider");
    const extra =
      type === "provider"
        ? {}
        : type === "routing"
          ? {
              profile:
                Object.keys(
                  normalized?.plugins?.find((p: any) =>
                    /\/(?:official\.)?auto-router$/.test(
                      p.path.replaceAll("\\", "/"),
                    ),
                  )?.config?.profiles ?? {},
                )[0] ?? "$model",
            }
          : type === "protocol"
            ? {
                next,
                allow: ingressOptions.map((p) => p.value),
                conversion: "auto",
              }
            : type === "condition"
              ? { test: "hasTools", yes: next, no: next }
              : type === "prompt"
                ? { next, text: "请准确、简洁地回答。" }
                : type === "reasoning"
                  ? { next, effort: "medium" }
                  : type === "maxTokens"
                    ? { next, limit: 1024 }
                    : type === "rateLimit"
                      ? { next, rule: { rpm: 60 } }
                      : type === "tps"
                        ? { next, rate: 30, tokenizer: "o200k_base" }
                        : { target: targets[0] ?? "", mode: "implicit" };
    update({
      ...flow,
      nodes: [
        ...flow.nodes.map((n) =>
          type === "provider" || type === "routing" || type === "upstream"
            ? n
            : n.id === selected && "next" in n
              ? { ...n, next: key }
              : anchor &&
                  (anchor.type === "provider" ||
                    anchor.type === "upstream" ||
                    anchor.type === "routing")
                ? n.type === "condition"
                  ? {
                      ...n,
                      yes: n.yes === selected ? key : n.yes,
                      no: n.no === selected ? key : n.no,
                    }
                  : "next" in n && n.next === selected
                    ? { ...n, next: key }
                    : n
                : n,
        ),
        { id: key, type, ...extra } as WorkflowNode,
      ],
    });
    select(key);
  }
  async function save() {
    if (!flow) return;
    setBusy(true);
    setMessage("");
    try {
      if (personal) {
        await host.request("/api/plugins/official.byok/personal-channels", {
          method: "PUT",
          body: JSON.stringify({
            ...channel,
            flow,
            name: channelName,
            enabled,
          }),
        });
        setMessage(tr("流程已保存。"));
        loaded.reload();
        saved();
        return;
      }
      const config: any = await host.request("/api/host/config");
      migrateLegacyChannels(config);
      const current = routerConfig(config)?.upstreams?.[channelId];
      if (!current) throw new Error(tr("渠道已被删除，请刷新。"));
      if (
        JSON.stringify(current.flow ?? defaultChannelFlow()) !==
        JSON.stringify(channel.flow ?? defaultChannelFlow())
      )
        throw new Error(tr("渠道流程已被其他操作修改，请关闭并重新打开。"));
      const previous = structuredClone(routerConfig(config).upstreams);
      current.flow = flow;
      current.name = channelName;
      current.enabled = enabled;
      syncChannelSecrets(
        config.plugins,
        previous,
        routerConfig(config).upstreams,
        protocols,
      );
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(config),
      });
      setMessage(tr("已保存"));
      loaded.reload();
      saved();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    setBusy(true);
    try {
      setPreview(
        await host.request(
          personal
            ? "/api/plugins/official.byok/personal-channels/preview"
            : "/api/plugins/official.ai-router/graph/preview",
          {
            method: "POST",
            body: JSON.stringify({
              ...(personal ? { id: channelId } : { upstream: channelId }),
              ingressProtocol,
              request: {
                model: "preview",
                messages: [{ role: "user", text: task }],
                tools: toolTask
                  ? [{ name: "preview_tool", parameters: { type: "object" } }]
                  : [],
                stream: streamTask,
              },
            }),
          },
        ),
      );
      setMessage(tr("已预览保存的渠道流程，没有调用上游。"));
    } catch (e) {
      setPreview(undefined);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const edges = (n: WorkflowNode) =>
    n.type === "upstream" || n.type === "provider" || n.type === "routing"
      ? []
      : n.type === "condition"
        ? [n.yes, n.no]
        : [n.next];
  const columns = new Map<string, number>();
  if (flow) {
    const visit = (key: string, depth: number, seen: Set<string>) => {
      if (seen.has(key) || depth > 64 || (columns.get(key) ?? -1) >= depth)
        return;
      columns.set(key, depth);
      const n = flow.nodes.find((n) => n.id === key);
      if (n)
        for (const target of edges(n))
          visit(target, depth + 1, new Set([...seen, key]));
    };
    visit(flow.entry, 0, new Set());
  }
  const rows = new Map<number, number>();
  const points = new Map(
    (flow?.nodes ?? []).map((n) => {
      const col = columns.get(n.id) ?? 0;
      const row = rows.get(col) ?? 0;
      rows.set(col, row + 1);
      return [n.id, { x: 20 + col * 205, y: 20 + row * 105 }];
    }),
  );
  const width = Math.max(420, ...[...points.values()].map((p) => p.x + 190));
  const height = Math.max(260, ...[...points.values()].map((p) => p.y + 95));
  React.useLayoutEffect(() => {
    if (flow && canvas.current)
      setZoom(
        Math.max(0.75, Math.min(1, (canvas.current.clientWidth - 32) / width)),
      );
  }, [channelId, !!flow]);
  const connect = (field: string, value: string) => (
    <label>
      {field === "yes"
        ? tr("满足条件")
        : field === "no"
          ? tr("不满足条件")
          : tr("连接到")}
      <Select
        value={value}
        onChange={(e) => change({ [field]: e.target.value })}
      >
        <option value="">{tr("选择节点")}</option>
        {flow?.nodes
          .filter((n) => n.id !== selected)
          .map((n) => (
            <option key={n.id} value={n.id}>
              {n.id} · {labels[n.type]}
            </option>
          ))}
      </Select>
    </label>
  );
  return (
    <section aria-label={tr("渠道流程编辑器")}>
      <style>{`.workflow-grid{display:grid;grid-template-columns:minmax(0,1fr) minmax(230px,290px);gap:16px;margin-bottom:14px}.workflow-grid>*{min-width:0}.workflow-canvas{overflow:auto;min-height:260px}.workflow-node{cursor:pointer}.workflow-node:focus{outline:2px solid currentColor}.workflow-tools{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:12px}.workflow-tools input{width:190px}.workflow-tools select{width:auto;min-width:170px}.workflow-tools input[type=checkbox]{width:auto}.workflow-side label{display:block;margin:10px 0}.workflow-side input,.workflow-side select,.workflow-side textarea{width:100%}.workflow-preview{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.workflow-preview span{border:1px solid var(--border);background:var(--subtle);padding:5px 8px;border-radius:6px}.workflow-tools .grow{flex:1;min-width:180px}.workflow-panel{margin-top:14px}@media(max-width:850px){.workflow-grid{grid-template-columns:minmax(0,1fr)}.workflow-tools input,.workflow-tools select{max-width:100%}}`}</style>
      <div className="page-heading">
        <div>
          {personal ? (
            <h1>
              {tr("{0} · 流程图", {
                "0": textValue(channel?.name || channelId),
              })}
            </h1>
          ) : (
            <h2>
              {tr("{0} · 流程图", {
                "0": textValue(channel?.name || channelId),
              })}
            </h2>
          )}
        </div>
        <div className="actions">
          <button className="secondary" disabled={busy} onClick={close}>
            {tr("返回渠道")}
          </button>
          <button disabled={busy || !flow} onClick={() => void save()}>
            {tr("保存流程")}
          </button>
        </div>
      </div>
      <Notice message={message || loaded.error || normalized?.error} />
      {!personal && panel && (
        <Dialog
          title={panel === "limits" ? tr("全局限制") : tr("路由策略")}
          close={() => {
            setPanel(undefined);
            loaded.reload();
          }}
        >
          <div className="channel-policy-settings">
            <style>{`.modal:has(.channel-policy-settings){width:min(1060px,calc(100vw - 24px));max-width:1060px}`}</style>
            {panel === "limits" ? (
              <>
                <p className="field-note">{tr("对全部渠道生效")}</p>
                <ChannelExtension host={host} path="/rate-limit" />
                <ChannelExtension host={host} path="/token-speed" />
              </>
            ) : (
              <ChannelExtension
                host={host}
                path="/auto-router"
                query={
                  node?.type === "routing" && node.profile !== "$model"
                    ? "?profile=" + encodeURIComponent(node.profile)
                    : ""
                }
              />
            )}
          </div>
        </Dialog>
      )}
      {flow && (
        <>
          <div className="workflow-tools">
            {(Object.keys(labels) as WorkflowNode["type"][])
              .filter((t) => t !== "start" && (!personal || t !== "routing"))
              .map((type) => (
                <button
                  className="secondary"
                  key={type}
                  onClick={() => add(type)}
                >
                  ＋ {labels[type]}
                </button>
              ))}
          </div>
          <div className="workflow-grid">
            <div>
              <div className="workflow-tools">
                <button
                  className="secondary"
                  aria-label={tr("缩小画布")}
                  onClick={() => setZoom((z) => Math.max(0.3, z - 0.1))}
                >
                  －
                </button>
                <span>{Math.round(zoom * 100)}%</span>
                <button
                  className="secondary"
                  aria-label={tr("放大画布")}
                  onClick={() => setZoom((z) => Math.min(2, z + 0.1))}
                >
                  ＋
                </button>
                <button
                  className="secondary"
                  onClick={() =>
                    setZoom(
                      Math.max(
                        0.3,
                        Math.min(
                          1,
                          ((canvas.current?.clientWidth ?? width) - 36) / width,
                        ),
                      ),
                    )
                  }
                >
                  {tr("适应画布")}
                </button>
              </div>
              <section
                ref={canvas}
                className="panel workflow-canvas"
                aria-label={tr("渠道流程画布")}
              >
                <svg
                  width={width * zoom}
                  height={height * zoom}
                  viewBox={`0 0 ${width} ${height}`}
                  role="img"
                  aria-label={tr("渠道功能连接图")}
                >
                  <defs>
                    <marker
                      id="flow-arrow"
                      markerWidth="8"
                      markerHeight="8"
                      refX="7"
                      refY="3"
                      orient="auto"
                    >
                      <path d="M0,0 L0,6 L7,3 z" fill="currentColor" />
                    </marker>
                  </defs>
                  {flow.nodes.flatMap((n) =>
                    edges(n).map((target, i) => {
                      const a = points.get(n.id)!,
                        b = points.get(target);
                      return b ? (
                        <g key={n.id + i}>
                          <path
                            d={`M${a.x + 170},${a.y + 35} C${a.x + 190},${a.y + 35} ${b.x - 20},${b.y + 35} ${b.x},${b.y + 35}`}
                            fill="none"
                            stroke="currentColor"
                            opacity=".4"
                            markerEnd="url(#flow-arrow)"
                          />
                          {n.type === "condition" && (
                            <text
                              x={b.x - 24}
                              y={b.y + 26 + (n.yes === n.no ? i * 16 : 0)}
                              fontSize="11"
                              fill="currentColor"
                            >
                              {i ? tr("否") : tr("是")}
                            </text>
                          )}
                        </g>
                      ) : null;
                    }),
                  )}
                  {flow.nodes.map((n) => {
                    const p = points.get(n.id)!;
                    return (
                      <g
                        key={n.id}
                        className="workflow-node"
                        role="button"
                        tabIndex={0}
                        aria-label={n.id + " " + labels[n.type]}
                        onClick={() => select(n.id)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            select(n.id);
                          }
                        }}
                      >
                        <rect
                          x={p.x}
                          y={p.y}
                          width="170"
                          height="70"
                          rx="10"
                          fill="currentColor"
                          fillOpacity={n.id === selected ? ".14" : ".05"}
                          stroke="currentColor"
                          strokeOpacity={n.id === selected ? ".8" : ".2"}
                        />
                        <text
                          x={p.x + 12}
                          y={p.y + 27}
                          fill="currentColor"
                          fontSize="13"
                        >
                          {labels[n.type]}
                        </text>
                        <text
                          x={p.x + 12}
                          y={p.y + 48}
                          fill="currentColor"
                          opacity=".65"
                          fontSize="11"
                        >
                          {n.type === "provider"
                            ? (n.upstream?.protocol ??
                              (personal
                                ? (channel?.protocol ?? tr("渠道上游"))
                                : tr("尚未配置上游")))
                            : n.type === "protocol"
                              ? n.allow.length +
                                tr(" 种入口 · ") +
                                (n.conversion === "auto"
                                  ? tr("自动转换")
                                  : tr("仅同协议"))
                              : n.type === "routing"
                                ? n.profile
                                : n.type === "upstream"
                                  ? n.target
                                  : n.type === "reasoning"
                                    ? n.effort
                                    : n.type === "rateLimit"
                                      ? Object.entries(n.rule)
                                          .map(
                                            ([key, value]) => value + " " + key,
                                          )
                                          .join(" · ")
                                      : n.type === "tps"
                                        ? (n.rate ?? n.aggregateRate) +
                                          " token/s"
                                        : n.type === "maxTokens"
                                          ? n.limit + " tokens"
                                          : n.id}
                        </text>
                      </g>
                    );
                  })}
                </svg>
              </section>
            </div>
            <section className="panel workflow-side">
              <h2>{tr("节点设置")}</h2>
              <label>
                {tr("渠道名称")}
                <input
                  value={channelName}
                  maxLength={128}
                  onChange={(e) => setChannelName(e.target.value)}
                />
              </label>
              <label>
                <input
                  type="checkbox"
                  style={{ width: "auto" }}
                  checked={enabled}
                  onChange={(e) => setEnabled(e.target.checked)}
                />{" "}
                {tr("启用渠道")}
              </label>
              {node && (
                <>
                  <p>
                    <code>{node.id}</code> · {labels[node.type]}
                  </p>
                  {node.type === "start" && !personal && (
                    <button
                      className="secondary"
                      onClick={() => setPanel("limits")}
                    >
                      {tr("全局限制")}
                    </button>
                  )}
                  {node.type !== "upstream" &&
                    node.type !== "provider" &&
                    node.type !== "routing" &&
                    node.type !== "condition" &&
                    connect("next", node.next)}
                  {node.type === "condition" && (
                    <>
                      <label>
                        {tr("判断")}
                        <Select
                          value={node.test}
                          onChange={(e) =>
                            change({
                              test: e.target.value,
                              protocol:
                                e.target.value === "protocol"
                                  ? "openai-chat"
                                  : undefined,
                            })
                          }
                        >
                          <option value="hasTools">{tr("包含工具")}</option>
                          <option value="stream">{tr("流式请求")}</option>
                          <option value="protocol">{tr("入口协议为")}</option>
                          <option value="textLengthAbove">
                            {tr("任务字符数大于")}
                          </option>
                        </Select>
                      </label>
                      {node.test === "protocol" && (
                        <Select
                          aria-label={tr("条件入口协议")}
                          value={node.protocol ?? "openai-chat"}
                          onChange={(e) => change({ protocol: e.target.value })}
                        >
                          {ingressOptions.map((p) => (
                            <option key={p.value} value={p.value}>
                              {p.label}
                            </option>
                          ))}
                        </Select>
                      )}
                      {node.test === "textLengthAbove" && (
                        <input
                          aria-label={tr("字符数阈值")}
                          type="number"
                          min="0"
                          value={node.value ?? 0}
                          onChange={(e) =>
                            change({ value: Number(e.target.value) })
                          }
                        />
                      )}
                      {connect("yes", node.yes)}
                      {connect("no", node.no)}
                    </>
                  )}
                  {node.type === "protocol" && (
                    <fieldset>
                      <legend>{tr("允许的入口协议")}</legend>
                      {ingressOptions.map((p) => (
                        <label key={p.value}>
                          <input
                            type="checkbox"
                            style={{ width: "auto" }}
                            checked={node.allow.includes(p.value)}
                            onChange={(e) =>
                              change({
                                allow: e.target.checked
                                  ? [...node.allow, p.value]
                                  : node.allow.filter((v) => v !== p.value),
                              })
                            }
                          />{" "}
                          {p.label}
                        </label>
                      ))}
                      <label>
                        {tr("协议转换")}
                        <Select
                          value={node.conversion}
                          onChange={(e) =>
                            change({ conversion: e.target.value })
                          }
                        >
                          <option value="auto">
                            {tr("自动转换为上游协议")}
                          </option>
                          <option value="disabled">
                            {tr("仅允许与上游相同的协议")}
                          </option>
                        </Select>
                      </label>
                    </fieldset>
                  )}
                  {node.type === "prompt" && (
                    <label>
                      {tr("系统提示词")}
                      <textarea
                        rows={5}
                        value={node.text}
                        onChange={(e) => change({ text: e.target.value })}
                      />
                    </label>
                  )}
                  {node.type === "reasoning" && (
                    <label>
                      {tr("思考强度")}
                      <Select
                        value={node.effort}
                        onChange={(e) => change({ effort: e.target.value })}
                      >
                        {[
                          "none",
                          "minimal",
                          "low",
                          "medium",
                          "high",
                          "xhigh",
                          "max",
                        ].map((e) => (
                          <option key={e}>{e}</option>
                        ))}
                      </Select>
                    </label>
                  )}
                  {node.type === "maxTokens" && (
                    <label>
                      {tr("最大输出 Token")}
                      <input
                        type="number"
                        min="1"
                        value={node.limit}
                        onChange={(e) =>
                          change({ limit: Number(e.target.value) })
                        }
                      />
                    </label>
                  )}
                  {node.type === "rateLimit" && (
                    <fieldset>
                      <legend>{tr("当前渠道 · 经过此节点的请求")}</legend>
                      <div className="form-grid">
                        {[
                          ["rpm", "每分钟请求"],
                          ["tpm", "每分钟 Token"],
                          ["concurrency", "最大并发"],
                          ["bytesPerSecond", "响应字节 / 秒"],
                        ].map(([key, title]) => (
                          <label key={key}>
                            {tr(title!)}
                            <input
                              type="number"
                              min="0"
                              max="1000000000"
                              step="1"
                              value={
                                node.rule[key as keyof typeof node.rule] ?? ""
                              }
                              onChange={(e) => {
                                const rule = { ...node.rule };
                                const value = Number(e.target.value);
                                if (value > 0)
                                  rule[key as keyof typeof rule] = value;
                                else delete rule[key as keyof typeof rule];
                                change({ rule });
                              }}
                            />
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  )}
                  {node.type === "tps" && (
                    <>
                      <label>
                        {tr("每请求 TPS")}
                        <input
                          type="number"
                          min="0.1"
                          step="0.1"
                          value={node.rate ?? ""}
                          onChange={(e) =>
                            change({
                              rate: Number(e.target.value) || undefined,
                            })
                          }
                        />
                      </label>
                      <label>
                        {tr("分词器")}
                        <Select
                          value={node.tokenizer}
                          onChange={(e) =>
                            change({ tokenizer: e.target.value })
                          }
                        >
                          <option>o200k_base</option>
                          <option>cl100k_base</option>
                          {!personal &&
                            Object.keys(
                              normalized?.plugins?.find((p: any) =>
                                /\/(?:official\.)?token-speed$/.test(
                                  p.path.replaceAll("\\", "/"),
                                ),
                              )?.config?.tokenizers ?? {},
                            ).map((name) => <option key={name}>{name}</option>)}
                        </Select>
                      </label>
                      {!personal && (
                        <>
                          <label>
                            {tr("共享模型 TPS")}
                            <input
                              type="number"
                              min="0.1"
                              step="0.1"
                              value={node.aggregateRate ?? ""}
                              onChange={(e) =>
                                change({
                                  aggregateRate:
                                    Number(e.target.value) || undefined,
                                })
                              }
                            />
                          </label>
                          <label>
                            {tr("限定上游模型")}
                            <input
                              value={node.model ?? ""}
                              placeholder={tr("全部模型")}
                              onChange={(e) =>
                                change({ model: e.target.value || undefined })
                              }
                            />
                          </label>
                          <label>
                            <input
                              type="checkbox"
                              style={{ width: "auto" }}
                              checked={node.inheritDefault !== false}
                              onChange={(e) =>
                                change({ inheritDefault: e.target.checked })
                              }
                            />{" "}
                            {tr("同时应用默认 TPS")}
                          </label>
                        </>
                      )}
                    </>
                  )}
                  {node.type === "provider" && (
                    <>
                      {!personal && (
                        <>
                          <label>
                            {tr("上游调用协议")}
                            <Select
                              aria-label={tr("上游调用协议")}
                              value={node.upstream?.protocol ?? "openai-chat"}
                              onChange={(e) =>
                                change({
                                  upstream: {
                                    protocol: e.target.value,
                                    baseUrl: node.upstream?.baseUrl ?? "",
                                    keyRef: node.upstream?.keyRef ?? "",
                                  },
                                })
                              }
                            >
                              {protocols.map((p) => (
                                <option key={p}>{p}</option>
                              ))}
                            </Select>
                          </label>
                          {[
                            "codex",
                            "claude-subscription",
                            "antigravity",
                          ].includes(node.upstream?.protocol ?? "") && (
                            <>
                              <label>
                                {tr("授权来源")}
                                <Select
                                  value={
                                    node.upstream?.subscriptionAccountIds
                                      ? "accounts"
                                      : "static"
                                  }
                                  onChange={(e) => {
                                    const upstream: any = { ...node.upstream };
                                    if (e.target.value === "accounts") {
                                      upstream.subscriptionAccountIds = [];
                                      delete upstream.keyRef;
                                      delete upstream.baseUrl;
                                    } else {
                                      delete upstream.subscriptionAccountIds;
                                      upstream.baseUrl = "";
                                      upstream.keyRef = "";
                                    }
                                    change({ upstream });
                                  }}
                                >
                                  <option value="accounts">
                                    {tr("订阅账号")}
                                  </option>
                                  <option value="static">
                                    {tr("环境变量")}
                                  </option>
                                </Select>
                              </label>
                              {node.upstream?.subscriptionAccountIds && (
                                <div className="full">
                                  <Notice
                                    message={subscriptionAccounts.error}
                                  />
                                  {(subscriptionAccounts.data ?? [])
                                    .filter(
                                      (a) =>
                                        a.provider === node.upstream?.protocol,
                                    )
                                    .map((a) => (
                                      <label
                                        className="checkbox-row"
                                        key={a.id}
                                      >
                                        <input
                                          type="checkbox"
                                          checked={node.upstream!.subscriptionAccountIds!.includes(
                                            a.id,
                                          )}
                                          onChange={(e) =>
                                            connection({
                                              subscriptionAccountIds: e.target
                                                .checked
                                                ? [
                                                    ...node.upstream!
                                                      .subscriptionAccountIds!,
                                                    a.id,
                                                  ]
                                                : node.upstream!.subscriptionAccountIds!.filter(
                                                    (id) => id !== a.id,
                                                  ),
                                            })
                                          }
                                        />
                                        {a.name}
                                        {!a.enabled ? " · " + tr("已停用") : ""}
                                      </label>
                                    ))}
                                  {(node.upstream.subscriptionAccountIds ?? [])
                                    .filter(
                                      (id) =>
                                        !subscriptionAccounts.data?.some(
                                          (a) => a.id === id,
                                        ),
                                    )
                                    .map((id) => (
                                      <label className="checkbox-row" key={id}>
                                        <input
                                          type="checkbox"
                                          checked
                                          onChange={() =>
                                            connection({
                                              subscriptionAccountIds:
                                                node.upstream!.subscriptionAccountIds!.filter(
                                                  (v) => v !== id,
                                                ),
                                            })
                                          }
                                        />
                                        {tr("账号已删除")}: {id}
                                      </label>
                                    ))}
                                  <a
                                    href={
                                      "#/settings/subscriptions/" +
                                      node.upstream?.protocol
                                    }
                                  >
                                    {tr("管理订阅账号")}
                                  </a>
                                </div>
                              )}
                            </>
                          )}
                          {!node.upstream?.subscriptionAccountIds && (
                            <>
                              <label>
                                Base URL
                                <input
                                  aria-label={tr("上游地址")}
                                  type="url"
                                  value={node.upstream?.baseUrl ?? ""}
                                  onChange={(e) =>
                                    connection({ baseUrl: e.target.value })
                                  }
                                  placeholder="https://api.openai.com/v1"
                                />
                              </label>
                              <label>
                                {tr("密钥引用")}
                                <input
                                  aria-label={tr("上游密钥引用")}
                                  value={node.upstream?.keyRef ?? ""}
                                  onChange={(e) =>
                                    connection({ keyRef: e.target.value })
                                  }
                                  placeholder="env:OPENAI_API_KEY"
                                />
                              </label>
                            </>
                          )}
                        </>
                      )}
                      <label>
                        {tr("上游模型（可选）")}
                        <input
                          value={node.model ?? ""}
                          onChange={(e) => {
                            const next = { ...node };
                            if (e.target.value) next.model = e.target.value;
                            else delete next.model;
                            update({
                              ...flow,
                              nodes: flow.nodes.map((n) =>
                                n.id === node.id ? next : n,
                              ),
                            });
                          }}
                          placeholder={tr("留空使用模型映射中的实际模型")}
                        />
                      </label>
                      {node.upstream?.protocol === "codex" && (
                        <>
                          <label>
                            {tr("Codex 授权模式")}
                            <Select
                              value={
                                node.upstream.authMode ??
                                (node.upstream.subscriptionAccountIds
                                  ? "cli"
                                  : "siwc")
                              }
                              onChange={(e) =>
                                connection({ authMode: e.target.value })
                              }
                            >
                              <option value="siwc">SIWC / Responses</option>
                              <option value="cli">{tr("CLI 兼容")}</option>
                            </Select>
                          </label>
                          {!node.upstream.subscriptionAccountIds && (
                            <label>
                              ChatGPT Account ID
                              <input
                                value={node.upstream.accountId ?? ""}
                                onChange={(e) =>
                                  connection({ accountId: e.target.value })
                                }
                              />
                            </label>
                          )}
                        </>
                      )}
                      {node.upstream?.protocol === "antigravity" &&
                        !node.upstream.subscriptionAccountIds && (
                          <label>
                            Project ID
                            <input
                              value={node.upstream.projectId ?? ""}
                              onChange={(e) =>
                                connection({ projectId: e.target.value })
                              }
                            />
                          </label>
                        )}
                    </>
                  )}
                  {node.type === "routing" && (
                    <label>
                      {tr("自动路由策略")}
                      <input
                        list="routing-profiles"
                        value={node.profile}
                        onChange={(e) => change({ profile: e.target.value })}
                      />
                      <datalist id="routing-profiles">
                        <option value="$model">
                          {tr("使用模型映射中的策略 ID")}
                        </option>
                        {Object.keys(
                          normalized?.plugins?.find((p: any) =>
                            /\/(?:official\.)?auto-router$/.test(
                              p.path.replaceAll("\\", "/"),
                            ),
                          )?.config?.profiles ?? {},
                        ).map((id) => (
                          <option key={id}>{id}</option>
                        ))}
                      </datalist>
                      <span className="muted">
                        {tr("$model 使用模型映射中的实际模型 ID。")}
                      </span>
                      <button
                        className="secondary"
                        onClick={() => setPanel("routing")}
                      >
                        {tr("编辑路由策略")}
                      </button>
                    </label>
                  )}
                  {node.type === "upstream" && (
                    <>
                      <label>
                        {tr("目标公开模型")}
                        <input
                          list="workflow-models"
                          value={node.target}
                          onChange={(e) => change({ target: e.target.value })}
                        />
                      </label>
                      <datalist id="workflow-models">
                        {targets.map((t) => (
                          <option key={t} value={t} />
                        ))}
                      </datalist>
                      <label>
                        {tr("模型重定向")}
                        <Select
                          value={node.mode}
                          onChange={(e) => change({ mode: e.target.value })}
                        >
                          <option value="implicit">
                            {tr("隐式 · 保持请求模型名")}
                          </option>
                          <option value="explicit">
                            {tr("显式 · 显示目标模型名")}
                          </option>
                        </Select>
                      </label>
                    </>
                  )}
                  {node.type !== "start" && (
                    <button
                      className="secondary"
                      onClick={() => {
                        const incoming = flow.nodes.some((n) =>
                          n.type === "condition"
                            ? n.yes === selected || n.no === selected
                            : "next" in n && n.next === selected,
                        );
                        if (!("next" in node) && incoming) {
                          setMessage(
                            tr(
                              "请先将前置节点连接到其他节点，再删除此分支或终点。",
                            ),
                          );
                          return;
                        }
                        update({
                          ...flow,
                          nodes: flow.nodes
                            .filter((n) => n.id !== selected)
                            .map((n) =>
                              "next" in node
                                ? n.type === "condition"
                                  ? {
                                      ...n,
                                      yes:
                                        n.yes === selected ? node.next : n.yes,
                                      no: n.no === selected ? node.next : n.no,
                                    }
                                  : "next" in n && n.next === selected
                                    ? { ...n, next: node.next }
                                    : n
                                : n,
                            ),
                        });
                        select(flow.entry);
                      }}
                    >
                      {tr("删除节点")}
                    </button>
                  )}
                </>
              )}
            </section>
          </div>
          <section className="panel">
            <h2>{tr("路径预览")}</h2>

            <div className="workflow-tools">
              <input
                aria-label={tr("预览任务")}
                className="grow"
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />
              <Select
                aria-label={tr("预览入口协议")}
                value={ingressProtocol}
                onChange={(e) => {
                  setIngressProtocol(e.target.value as Protocol);
                  setPreview(undefined);
                }}
              >
                {ingressOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <label>
                <input
                  type="checkbox"
                  checked={toolTask}
                  onChange={(e) => setToolTask(e.target.checked)}
                />{" "}
                {tr("包含工具")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={streamTask}
                  onChange={(e) => setStreamTask(e.target.checked)}
                />{" "}
                {tr("流式请求")}
              </label>
              <button
                className="secondary"
                disabled={
                  busy ||
                  (!personal &&
                    !!routerConfig(normalized)?.upstreams?.[channelId]
                      ?.protocol) ||
                  JSON.stringify(flow) !==
                    JSON.stringify(channel?.flow ?? defaultChannelFlow())
                }
                onClick={() => void inspect()}
              >
                {tr("预览路径")}
              </button>
            </div>
            {preview && (
              <>
                <div className="workflow-preview">
                  {preview.trace.nodes.map((key: string) => (
                    <span key={key}>
                      {
                        labels[
                          flow.nodes.find((n) => n.id === key)?.type ?? "start"
                        ]
                      }
                    </span>
                  ))}
                </div>
                <p className="muted">
                  {tr("目标 {0} · {1} {2} {3}", {
                    "0": textValue(
                      preview.provider
                        ? tr("上游调用节点 ") + preview.providerId
                        : preview.routingProfile
                          ? tr("自动路由 ") + preview.routingProfile
                          : preview.target,
                    ),
                    "1": textValue(
                      preview.mode === "explicit"
                        ? tr("显式重定向")
                        : tr("隐式重定向"),
                    ),
                    "2": textValue(
                      preview.request.reasoning?.effort
                        ? tr(" · 思考 ") + preview.request.reasoning.effort
                        : "",
                    ),
                    "3": textValue(
                      preview.outputPolicy
                        ? " · TPS " + preview.outputPolicy.tps
                        : "",
                    ),
                  })}
                </p>
                <details>
                  <summary>{tr("预览详情")}</summary>
                  <pre>
                    {JSON.stringify(
                      {
                        target: preview.target,
                        mode: preview.mode,
                        path: preview.trace.nodes,
                        reasoning: preview.request.reasoning,
                        maxTokens: preview.request.maxTokens,
                        outputPolicy: preview.outputPolicy,
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              </>
            )}
          </section>
        </>
      )}
    </section>
  );
}
