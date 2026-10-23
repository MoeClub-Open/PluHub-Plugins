import {
  ChannelNodeSettings,
  ingressOptions,
} from "./channel-node-settings.js";
import { compileWorkflow } from "../ai/channel-graph.js";
import * as Popover from "@radix-ui/react-popover";
import { Checkbox } from "./checkbox.js";
import { listSubscriptionAccounts } from "./subscription-providers.js";
import { t as tr, textValue } from "./i18n.js";
import { Select } from "./select.js";
import { ChannelExtension } from "./channel-extension.js";
import { Dialog } from "./components.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { ChannelWorkflow, WorkflowNode } from "@pluhub/contracts/workflow";
import type { Protocol, UpstreamInterface } from "@pluhub/contracts/ai";
import { useLoad, Notice } from "./mount.js";
import type { ChannelPanel } from "./channel-location.js";
import {
  ChannelFlowCanvas,
  workflowNodeLabels as labels,
  workflowNodePositions,
} from "./channel-flow-canvas.js";
import { defaultChannelFlow } from "../ai/channel-config.js";
export function ChannelGraphEditor({
  host,
  channelId,
  close,
  saved,
  personal = false,
  initialPanel,
  manageModels,
}: {
  host: UIHost;
  channelId: string;
  close: () => void;
  saved: () => void;
  personal?: boolean;
  initialPanel?: ChannelPanel;
  manageModels?: () => void;
}) {
  const loaded = useLoad<any>(() =>
    host.request(
      personal
        ? "/api/plugins/official.byok/personal-channels"
        : "/api/plugins/official.ai-router/configuration",
    ),
  );
  const [channelName, setChannelName] = React.useState("");
  const [enabled, setEnabled] = React.useState(false);
  const [priority, setPriority] = React.useState(0);
  const [personalInterfaces, setPersonalInterfaces] =
    React.useState<UpstreamInterface[]>();
  const [flow, setFlow] = React.useState<ChannelWorkflow>();
  const history = React.useRef<{
    past: ChannelWorkflow[];
    future: ChannelWorkflow[];
  }>({ past: [], future: [] });
  const [selected, select] = React.useState("start");
  const [message, setMessage] = React.useState("");
  const [task, setTask] = React.useState("Hello");
  const [preview, setPreview] = React.useState<any>();
  const [panel, setPanel] = React.useState<ChannelPanel | undefined>(
    personal ? undefined : initialPanel,
  );
  const [busy, setBusy] = React.useState(false);
  const editor = React.useRef<HTMLElement>(null);
  const subscriptionAccounts = useLoad<any[]>(
    () => (personal ? Promise.resolve([]) : listSubscriptionAccounts(host)),
    [personal],
  );
  const [toolTask, setToolTask] = React.useState(false);
  const [streamTask, setStreamTask] = React.useState(false);
  const [ingressProtocol, setIngressProtocol] =
    React.useState<Protocol>("openai-chat");
  const router = React.useMemo(() => {
    if (!loaded.data) return undefined;
    if (!personal) return loaded.data.config;
    const own = loaded.data.find((c: any) => c.id === channelId);
    return { upstreams: { [channelId]: own }, models: own?.models ?? {} };
  }, [loaded.data, personal, channelId]);
  const channel = router?.upstreams?.[channelId];
  const targets = [
    ...Object.keys(router?.models ?? {}),
    ...Object.keys(router?.redirects ?? {}),
  ];
  React.useEffect(() => {
    if (channel) {
      setChannelName(channel.name ?? "");
      setEnabled(channel.enabled !== false);
      setPriority(channel.priority ?? 0);
      setPersonalInterfaces(channel.interfaces);
      const next = structuredClone(channel.flow ?? defaultChannelFlow());
      setFlow(next);
      history.current = { past: [], future: [] };
      select(next.entry);
    }
  }, [JSON.stringify(channel)]);
  const node = flow?.nodes.find((n) => n.id === selected);
  function update(next: ChannelWorkflow) {
    if (flow && JSON.stringify(flow) !== JSON.stringify(next)) {
      history.current.past = [...history.current.past.slice(-49), flow];
      history.current.future = [];
    }
    setFlow(next);
    setPreview(undefined);
    setMessage("");
  }
  function add(
    type: WorkflowNode["type"],
    position?: { x: number; y: number },
  ) {
    if (!flow || flow.nodes.length >= 64) return;
    let key = type;
    let n = 1;
    while (flow.nodes.some((item) => item.id === key))
      key = (type + n++) as typeof key;
    const anchor = position
      ? undefined
      : flow.nodes.find((n) => n.id === selected);
    const next = position
      ? ""
      : anchor && "next" in anchor
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
                (loaded.data?.references?.routingProfiles ?? [])[0] ?? "$model",
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
    const anchorPoint = workflowNodePositions(flow).get(selected);
    update({
      ...flow,
      layout:
        position || anchorPoint
          ? {
              ...flow.layout,
              [key]: {
                x: position?.x ?? anchorPoint!.x + 360,
                y: position?.y ?? anchorPoint!.y,
              },
            }
          : flow.layout,
      nodes: [
        ...flow.nodes.map((n) =>
          type === "provider" || type === "routing" || type === "upstream"
            ? n
            : !position && n.id === selected && "next" in n
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
  function undo() {
    const previous = history.current.past.pop();
    if (!previous || !flow) return;
    history.current.future.push(flow);
    setFlow(previous);
    setPreview(undefined);
  }
  function redo() {
    const next = history.current.future.pop();
    if (!next || !flow) return;
    history.current.past.push(flow);
    setFlow(next);
    setPreview(undefined);
  }
  async function save() {
    if (!flow) return false;
    const invalid = editor.current?.querySelector<
      HTMLInputElement | HTMLTextAreaElement
    >("input:invalid, textarea:invalid");
    if (invalid) {
      invalid.reportValidity();
      return false;
    }
    setBusy(true);
    setMessage("");
    try {
      compileWorkflow(flow);
      if (personal) {
        await host.request("/api/plugins/official.byok/personal-channels", {
          method: "PUT",
          body: JSON.stringify({
            ...channel,
            interfaces: personalInterfaces,
            flow,
            name: channelName,
            priority,
            enabled,
          }),
        });
        setMessage(tr("流程已保存。"));
        loaded.reload();
        saved();
        return true;
      }
      const next = structuredClone(router);
      const current = next?.upstreams?.[channelId];
      if (!current) throw new Error(tr("渠道已被删除，请刷新。"));
      current.flow = flow;
      current.name = channelName;
      current.enabled = enabled;
      current.priority = priority;
      await host.request("/api/plugins/official.ai-router/configuration", {
        method: "PUT",
        body: JSON.stringify({ config: next, revision: loaded.data.revision }),
      });
      setMessage(tr("已保存"));
      loaded.reload();
      saved();
      return true;
    } catch (e) {
      setMessage((e as Error).message);
      return false;
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
              flow,
              request: {
                model:
                  (personal
                    ? targets[0]
                    : Object.keys(router?.models ?? {}).find(
                        (id) => router.models[id].upstream === channelId,
                      )) ?? "preview",
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
      setMessage(tr("预览完成"));
    } catch (e) {
      setPreview(undefined);
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <section ref={editor} aria-label={tr("渠道流程编辑器")}>
      <style>{`.workflow-grid{margin-bottom:14px}.workflow-grid>*{min-width:0}.workflow-tools{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:12px}.workflow-tools input{width:190px}.workflow-tools select{width:auto;min-width:170px}.workflow-tools input[type=checkbox]{width:auto}.workflow-preview{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.workflow-preview span{border:1px solid var(--border);background:var(--subtle);padding:5px 8px;border-radius:6px}.workflow-tools .grow{flex:1;min-width:180px}.workflow-panel{margin-top:14px}@media(max-width:850px){.workflow-grid{grid-template-columns:minmax(0,1fr)}.workflow-tools input,.workflow-tools select{max-width:100%}}`}</style>
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
          {manageModels && (
            <button
              className="secondary"
              disabled={busy || !flow}
              onClick={async () => {
                const changed =
                  channelName !== (channel?.name ?? "") ||
                  enabled !== (channel?.enabled !== false) ||
                  priority !== (channel?.priority ?? 0) ||
                  JSON.stringify(flow) !==
                    JSON.stringify(channel?.flow ?? defaultChannelFlow());
                if (!changed || (await save())) manageModels();
              }}
            >
              {tr("模型与定价")}
            </button>
          )}
          <button disabled={busy || !flow} onClick={() => void save()}>
            {tr("保存流程")}
          </button>
        </div>
      </div>
      <Notice message={message || loaded.error || ""} />
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
            <input
              aria-label={tr("渠道名称")}
              value={channelName}
              maxLength={128}
              onChange={(e) => setChannelName(e.target.value)}
            />
            <label>
              {tr("优先级")}
              <input
                aria-label={tr("优先级")}
                type="number"
                min="-1000000"
                max="1000000"
                step="1"
                value={priority}
                onChange={(e) => setPriority(Number(e.target.value))}
                style={{ width: 80 }}
              />
            </label>
            <label className="checkbox-row">
              <Checkbox
                appearance="switch"
                checked={enabled}
                onCheckedChange={(value) => setEnabled(value === true)}
              />
              {tr("启用渠道")}
            </label>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button className="secondary">＋ {tr("添加节点")}</button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content
                  className="flow-add-menu"
                  sideOffset={6}
                  align="start"
                >
                  {(Object.keys(labels) as WorkflowNode["type"][])
                    .filter(
                      (type) =>
                        type !== "start" && (!personal || type !== "routing"),
                    )
                    .map((type) => (
                      <Popover.Close asChild key={type}>
                        <button
                          className="ghost"
                          draggable
                          onDragStart={(event) => {
                            event.dataTransfer.setData(
                              "application/pluhub-node",
                              type,
                            );
                            event.dataTransfer.effectAllowed = "move";
                          }}
                          onClick={() => add(type)}
                        >
                          {labels[type]}
                        </button>
                      </Popover.Close>
                    ))}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          </div>
          <div className="workflow-grid">
            <ChannelFlowCanvas
              flow={flow}
              channel={channel}
              selected={selected}
              personal={personal}
              select={select}
              update={update}
              add={(type, position) => add(type, position)}
              undo={undo}
              redo={redo}
              canUndo={history.current.past.length > 0}
              canRedo={history.current.future.length > 0}
              renderSettings={(id) => {
                const current = flow.nodes.find((n) => n.id === id);
                return (
                  current && (
                    <ChannelNodeSettings
                      node={current}
                      context={{
                        personal,
                        channel,
                        personalInterfaces,
                        setPersonalInterfaces,
                        subscriptionAccounts,
                        targets,
                        references: loaded.data?.references,
                        onPanel: setPanel,
                      }}
                      change={(patch) =>
                        update({
                          ...flow,
                          nodes: flow.nodes.map((n) =>
                            n.id === id ? { ...n, ...patch } : n,
                          ),
                        })
                      }
                    />
                  )
                );
              }}
            />
          </div>
          <details className="workflow-preview-panel">
            <summary>{tr("路径预览")}</summary>

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
                <Checkbox
                  checked={toolTask}
                  onCheckedChange={(e) => setToolTask(e === true)}
                />{" "}
                {tr("包含工具")}
              </label>
              <label>
                <Checkbox
                  checked={streamTask}
                  onCheckedChange={(e) => setStreamTask(e === true)}
                />{" "}
                {tr("流式请求")}
              </label>
              <button
                className="secondary"
                disabled={busy || !flow}
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
          </details>
        </>
      )}
    </section>
  );
}
