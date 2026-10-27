import {
  ChannelNodeSettings,
  ingressOptions,
} from "./channel-node-settings.js";
import {
  compileWorkflow,
  WorkflowValidationError,
} from "../ai/channel-graph.js";
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
} from "./channel-flow-canvas.js";
import { workflowNodePositions } from "./channel-graph-operations.js";
import { WorkflowTemplateDialog } from "./workflow-template-dialog.js";
import { remapWorkflowInterfaces } from "./channel-interface-bindings.js";
import { isFlowTextInput } from "./use-flow-clipboard.js";
import { defaultChannelFlow } from "../ai/channel-config.js";
import { migrateWorkflowConditions } from "@pluhub/contracts/workflow-migration";
import { useUnsavedChanges } from "./unsaved-changes.js";
type GraphDraft = {
  channelName: string;
  enabled: boolean;
  priority: number;
  personalInterfaces?: UpstreamInterface[];
  flow: ChannelWorkflow;
};
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
  const platformGroups = useLoad<
    { id: string; name: string; multiplier: number }[]
  >(
    () =>
      personal
        ? host.request("/api/plugins/official.ai-router/groups")
        : Promise.resolve([]),
    [personal],
  );
  const modelCatalog = useLoad<{ id: string; channel?: { id: string; name?: string; scope?: string } }[]>(() =>
    host.request("/api/plugins/official.model-catalog/models"),
  );
  const ownChannels = useLoad<{ id: string; name?: string; enabled?: boolean; blocked?: boolean; hasCredential?: boolean }[]>(
    () => personal ? Promise.resolve([]) : host.request("/api/plugins/official.byok/personal-channels").catch(() => []),
    [personal],
  );
  const [draft, setDraft] = React.useState<GraphDraft>();
  const currentDraft = React.useRef<GraphDraft | undefined>(undefined);
  const editing = React.useRef<{ element: Element; at: number } | undefined>(
    undefined,
  );
  const [baseline, setBaseline] = React.useState("");
  const channelName = draft?.channelName ?? "";
  const enabled = draft?.enabled ?? false;
  const priority = draft?.priority ?? 0;
  const personalInterfaces = draft?.personalInterfaces;
  const flow = draft?.flow;
  const history = React.useRef<{ past: GraphDraft[]; future: GraphDraft[] }>({
    past: [],
    future: [],
  });
  const [selected, select] = React.useState("start");
  const [message, setMessage] = React.useState("");
  const [invalidNodes, setInvalidNodes] = React.useState<string[]>([]);
  const [task, setTask] = React.useState("Hello");
  const [preview, setPreview] = React.useState<any>();
  const [previewModel, setPreviewModel] = React.useState("");
  const [panel, setPanel] = React.useState<ChannelPanel | undefined>(
    personal ? undefined : initialPanel,
  );
  const [busy, setBusy] = React.useState(false);
  const [templateOpen, setTemplateOpen] = React.useState(false);
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
  const modelTargets = [...new Set([
    ...(modelCatalog.data ?? []).map((model) => model.id),
    ...Object.entries(router?.models ?? {}).map(([id, model]: [string, any]) => model.publicModel ?? id),
  ])].sort();
  const templateTargets = [...new Set(
    modelCatalog.data
      ? modelCatalog.data.filter((model) => model.channel?.id !== channelId).map((model) => model.id)
      : Object.entries(router?.models ?? {})
          .filter(([, model]: [string, any]) => !personal && model.upstream !== channelId && model.enabled !== false)
          .map(([id, model]: [string, any]) => model.publicModel ?? id),
  )].sort();
  // This endpoint only returns channels owned by the current session. The model
  // catalog can omit channels without an active or visible model mapping.
  const personalChannels = ((personal ? loaded.data : ownChannels.data) ?? [])
    .filter((item: any) => item.enabled !== false && !item.blocked && item.hasCredential)
    .map((item: any) => ({ id: item.id as string, name: item.name as string | undefined }));
  React.useEffect(() => {
    if (!channel) return;
    const next: GraphDraft = {
      channelName: channel.name ?? "",
      enabled: channel.enabled !== false,
      priority: channel.priority ?? 0,
      personalInterfaces: channel.interfaces,
      flow: migrateWorkflowConditions(structuredClone(channel.flow ?? defaultChannelFlow())),
    };
    if (JSON.stringify(currentDraft.current) === JSON.stringify(next)) {
      setBaseline(JSON.stringify(next));
      return;
    }
    setDraft(next);
    currentDraft.current = next;
    editing.current = undefined;
    setBaseline(JSON.stringify(next));
    history.current = { past: [], future: [] };
    select(next.flow.entry);
  }, [JSON.stringify(channel)]);
  const node = flow?.nodes.find((n) => n.id === selected);
  const dirty = !!draft && JSON.stringify(draft) !== baseline;
  function change(patch: Partial<GraphDraft>) {
    const previous = currentDraft.current;
    if (!previous || busy) return;
    const next = { ...previous, ...patch };
    if (JSON.stringify(previous) === JSON.stringify(next)) return;
    const element = document.activeElement;
    const at = Date.now();
    const typing =
      element &&
      editor.current?.contains(element) &&
      element.matches("input, textarea");
    if (
      !typing ||
      editing.current?.element !== element ||
      at - editing.current.at > 750
    )
      history.current.past = [...history.current.past.slice(-49), previous];
    editing.current = typing ? { element, at } : undefined;
    history.current.future = [];
    currentDraft.current = next;
    setDraft(next);
  }
  const setChannelName = (channelName: string) => change({ channelName });
  const setEnabled = (enabled: boolean) => change({ enabled });
  const setPriority = (priority: number) => change({ priority });
  const setPersonalInterfaces = (
    personalInterfaces: UpstreamInterface[] | undefined,
    remap?: readonly number[],
  ) =>
    change({
      personalInterfaces,
      ...(remap && currentDraft.current
        ? {
            flow: remapWorkflowInterfaces(
              currentDraft.current.flow,
              "",
              true,
              remap,
            ),
          }
        : {}),
    });
  const update = (flow: ChannelWorkflow) => change({ flow });
  React.useEffect(() => {
    setPreview(undefined);
    setMessage("");
    setInvalidNodes([]);
  }, [draft, task, previewModel, ingressProtocol, toolTask, streamTask]);
  const previewModels = Object.entries(router?.models ?? {}).filter(
    ([, model]: [string, any]) => personal || model.upstream === channelId,
  );
  React.useEffect(() => {
    if (!previewModels.some(([id]) => id === previewModel))
      setPreviewModel(previewModels[0]?.[0] ?? "");
  }, [JSON.stringify(previewModels.map(([id]) => id))]);
  function add(
    type: WorkflowNode["type"],
    position?: { x: number; y: number },
  ) {
    if (!flow || type === "condition" || flow.nodes.length >= 128) return;
    let key = type;
    let n = 1;
    while (flow.nodes.some((item) => item.id === key))
      key = (type + n++) as typeof key;
    const defaults: Record<string, object> = {
      value: { valueType: "integer", value: 1 },
      text: { text: "" },
      format: { value: null },
      template: { template: "", values: {} },
      replace: { text: "", find: "", replacement: "", all: true },
      llm: { model: "", prompt: "", promptMode: "append" },
      jev: {
        model: "",
        state: "",
        questions: {
          route: {
            type: "choice",
            instructions: "选择最适合的选项",
            criteria: { fast: "简单问题", quality: "复杂问题" },
          },
        },
        answerKey: "route",
      },
      response: { text: "" },
      platform: { groupId: platformGroups.data?.[0]?.id ?? "" },
      provider: {},
      routing: { profile: (loaded.data?.references?.routingProfiles ?? [])[0] ?? "$model" },
      protocol: { next: "", allow: ingressOptions.map((p) => p.value), conversion: "auto" },
      condition: { test: "hasTools", yes: "", no: "" },
      predicate: { test: "hasTools" },
      branch: { condition: false, yes: "", no: "" },
      compare: { valueType: "string", operator: "eq", left: "", right: "" },
      logic: { operator: "and", left: false, right: false },
      prompt: { next: "", text: "请准确、简洁地回答。" },
      reasoning: { next: "", effort: "medium" },
      maxTokens: { next: "", limit: 1024 },
      rateLimit: { next: "", rule: { rpm: 60 } },
      tps: { next: "", rate: 30, tokenizer: "o200k_base" },
      upstream: { target: "", mode: "implicit" },
    };
    const extra = defaults[type] ?? {};
    const positions = workflowNodePositions(flow);
    const anchorPoint = positions.get(selected);
    const point = position ?? {
      x: (anchorPoint?.x ?? 0) + 360,
      y: anchorPoint?.y ?? 40,
    };
    if (!position)
      while (
        [...positions.values()].some(
          (p) => Math.abs(p.x - point.x) < 340 && Math.abs(p.y - point.y) < 240,
        )
      )
        point.y += 260;
    update({
      ...flow,
      layout: { ...Object.fromEntries(positions), [key]: point },
      nodes: [...flow.nodes, { id: key, type, ...extra } as WorkflowNode],
    });
    select(key);
  }
  function undo() {
    if (!currentDraft.current || busy) return;
    const previous = history.current.past.pop();
    if (!previous) return;
    history.current.future.push(currentDraft.current);
    currentDraft.current = previous;
    editing.current = undefined;
    setDraft(previous);
  }
  function redo() {
    if (!currentDraft.current || busy) return;
    const next = history.current.future.pop();
    if (!next) return;
    history.current.past.push(currentDraft.current);
    currentDraft.current = next;
    editing.current = undefined;
    setDraft(next);
  }
  function showError(error: unknown) {
    if (error instanceof WorkflowValidationError) {
      setInvalidNodes(error.nodeIds);
      select(error.nodeIds[0] ?? flow?.entry ?? "start");
      setMessage(
        tr(error.reason) +
          (error.nodeIds.length ? "：" + error.nodeIds.join("、") : ""),
      );
    } else setMessage((error as Error).message);
  }
  async function save() {
    if (!flow || !draft || busy) return false;
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
      compileWorkflow(flow, personalInterfaces, personal);
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
        setBaseline(JSON.stringify(draft));
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
      setBaseline(JSON.stringify(draft));
      loaded.reload();
      saved();
      return true;
    } catch (e) {
      showError(e);
      return false;
    } finally {
      setBusy(false);
    }
  }
  async function inspect() {
    if (!flow || !previewModel || busy) return;
    setBusy(true);
    setMessage("");
    try {
      compileWorkflow(flow, personalInterfaces, personal);
      setPreview(
        await host.request(
          personal
            ? "/api/plugins/official.byok/personal-channels/preview"
            : "/api/plugins/official.ai-router/graph/preview",
          {
            method: "POST",
            body: JSON.stringify({
              ...(personal ? { id: channelId } : { upstream: channelId }),
              ...(!personal ? { mappingId: previewModel } : {}),
              ingressProtocol,
              interfaces: personalInterfaces ?? null,
              flow,
              request: {
                model: router.models[previewModel]?.publicModel ?? previewModel,
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
    } catch (e) {
      setPreview(undefined);
      showError(e);
    } finally {
      setBusy(false);
    }
  }
  const guard = useUnsavedChanges(dirty, save, busy);
  return (
    <section
      ref={editor}
      aria-label={tr("渠道流程编辑器")}
      onBlurCapture={() => {
        editing.current = undefined;
      }}
      onKeyDown={(event) => {
        if (busy || !(event.ctrlKey || event.metaKey)) return;
        const key = event.key.toLowerCase();
        if (key === "s") {
          event.preventDefault();
          if (dirty) void save();
        } else if (
          !isFlowTextInput(event.target) &&
          (key === "z" || key === "y")
        ) {
          event.preventDefault();
          if (key === "y" || event.shiftKey) redo();
          else undo();
        }
      }}
    >
      <style>{`.workflow-grid{margin-bottom:14px}.workflow-grid>*{min-width:0}.workflow-tools{display:flex;align-items:center;flex-wrap:wrap;gap:6px;margin-bottom:12px}.workflow-tools input{width:190px}.workflow-tools select{width:auto;min-width:170px}.workflow-tools input[type=checkbox]{width:auto}.workflow-preview{display:flex;flex-wrap:wrap;gap:6px;margin:12px 0}.workflow-preview span{border:1px solid var(--border);background:var(--subtle);padding:5px 8px;border-radius:6px}.workflow-tools .grow{flex:1;min-width:180px}@media(max-width:850px){.workflow-grid{grid-template-columns:minmax(0,1fr)}.workflow-tools input,.workflow-tools select{max-width:100%}}`}</style>
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
          <button
            className="secondary"
            disabled={busy}
            onClick={() => guard.leave(close)}
          >
            {tr("返回渠道")}
          </button>
          {manageModels && (
            <button
              className="secondary"
              disabled={busy || !flow}
              onClick={() => guard.leave(manageModels)}
            >
              {tr("模型与定价")}
            </button>
          )}
          <span className="muted" role="status">
            {tr(dirty ? "有未保存的修改" : "已保存")}
          </span>
          <button
            disabled={busy || !flow || !dirty}
            title={tr("保存流程") + " (Ctrl/Cmd+S)"}
            onClick={() => void save()}
          >
            {tr("保存流程")}
          </button>
        </div>
      </div>
      {guard.confirmation}
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
              disabled={busy}
              aria-label={tr("渠道名称")}
              value={channelName}
              maxLength={128}
              onChange={(e) => setChannelName(e.target.value)}
            />
            <label>
              {tr("优先级")}
              <input
                disabled={busy}
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
                disabled={busy}
                appearance="switch"
                checked={enabled}
                onCheckedChange={(value) => setEnabled(value === true)}
              />
              {tr("启用渠道")}
            </label>
            <Popover.Root>
              <Popover.Trigger asChild>
                <button className="secondary" disabled={busy}>
                  ＋ {tr("添加节点")}
                </button>
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
                        type !== "start" &&
                        type !== "condition" &&
                        (personal ? type !== "routing" : type !== "platform"),
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
            <button className="secondary" disabled={busy} onClick={() => setTemplateOpen(true)}>
              {tr("流程模板")}
            </button>
          </div>
          {templateOpen && (
            <WorkflowTemplateDialog
              targets={templateTargets}
              disabled={busy}
              close={() => setTemplateOpen(false)}
              onApply={(next) => { update(next); select(next.entry); }}
            />
          )}
          <div className="workflow-grid">
            <ChannelFlowCanvas
              disabled={busy}
              invalidNodes={invalidNodes}
              flow={flow}
              channel={channel}
              personalInterfaces={personalInterfaces}
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
                        platformGroups,
                        platformNodes: flow.nodes.filter(
                          (node) => node.type === "platform",
                        ),
                        channel,
                        personalInterfaces,
                        setPersonalInterfaces,
                        boundInputs: new Set(
                          (flow.bindings ?? [])
                            .filter((binding) => binding.target === id)
                            .map((binding) => binding.input),
                        ),
                        hasInterfaceBindings: (flow.bindings ?? []).some(
                          (binding) =>
                            binding.input.startsWith(
                              personal ? "interfaces." : "upstream.interfaces.",
                            ) &&
                            (personal
                              ? flow.nodes.some(
                                  (node) =>
                                    node.id === binding.target &&
                                    node.type === "provider",
                                )
                              : binding.target === id),
                        ),
                        sourceHasBindings: (flow.bindings ?? []).some(
                          (binding) =>
                            binding.source === id || binding.target === id,
                        ),
                        subscriptionAccounts,
                        modelTargets,
                        personalChannels,
                        references: loaded.data?.references,
                        onPanel: setPanel,
                      }}
                      change={(patch, interfaceRemap) => {
                        const latest = currentDraft.current?.flow ?? flow;
                        const updatedNode = {
                          ...latest.nodes.find((n) => n.id === id)!,
                          ...patch,
                        } as WorkflowNode;
                        let next = {
                          ...latest,
                          nodes: latest.nodes.map((n) =>
                            n.id === id ? updatedNode : n,
                          ),
                        };
                        if (interfaceRemap)
                          next = remapWorkflowInterfaces(
                            next,
                            id,
                            false,
                            interfaceRemap,
                          );
                        update(next);
                      }}
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
                disabled={busy}
                aria-label={tr("预览任务")}
                className="grow"
                value={task}
                onChange={(e) => setTask(e.target.value)}
              />
              <Select
                aria-label={tr("预览模型")}
                value={previewModel}
                disabled={busy}
                onChange={(event) => setPreviewModel(event.target.value)}
              >
                {previewModels.map(([id, model]: [string, any]) => (
                  <option key={id} value={id}>
                    {model.publicModel ?? id}
                  </option>
                ))}
              </Select>
              <Select
                disabled={busy}
                aria-label={tr("预览入口协议")}
                value={ingressProtocol}
                onChange={(e) => setIngressProtocol(e.target.value as Protocol)}
              >
                {ingressOptions.map((p) => (
                  <option key={p.value} value={p.value}>
                    {p.label}
                  </option>
                ))}
              </Select>
              <label>
                <Checkbox
                  disabled={busy}
                  checked={toolTask}
                  onCheckedChange={(e) => setToolTask(e === true)}
                />{" "}
                {tr("包含工具")}
              </label>
              <label>
                <Checkbox
                  disabled={busy}
                  checked={streamTask}
                  onCheckedChange={(e) => setStreamTask(e === true)}
                />{" "}
                {tr("流式请求")}
              </label>
              <button
                className="secondary"
                disabled={busy || !flow || !previewModel}
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
                  {[
                    tr("目标") +
                      " " +
                      (preview.provider
                        ? tr("上游调用节点 ") + preview.providerId
                        : preview.routingProfile
                          ? tr("自动路由 ") + preview.routingProfile
                          : preview.target),
                    !preview.provider &&
                      !preview.routingProfile &&
                      tr(
                        preview.mode === "explicit"
                          ? "显式重定向"
                          : "隐式重定向",
                      ),
                    preview.request.reasoning?.effort &&
                      tr("思考强度") + " " + preview.request.reasoning.effort,
                    preview.outputPolicy?.tps &&
                      "TPS " + preview.outputPolicy.tps,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
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
