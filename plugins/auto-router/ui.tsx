import { Checkbox } from "../../lib/ui/checkbox.js";
import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type {
  RoutingProfile,
  RoutingCandidate,
} from "@pluhub/contracts/routing";
import type { ReasoningEffort } from "@pluhub/contracts/ai";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import { PageHeading, Dialog, Empty } from "../../lib/ui/components.js";
const api = "/api/plugins/official.auto-router";
const levels: ReasoningEffort[] = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];
const fresh = (): RoutingProfile => ({
  mode: "model",
  strategy: "balanced",
  candidates: [],
  decision: { kind: "rules" },
  onFailure: "fallback",
  minConfidence: 0.65,
  preserveClientEffort: true,
});
const find = (c: any, name: string) =>
  c.plugins.find((p: any) =>
    new RegExp("/(?:official\\.)?" + name + "$").test(
      p.path.replaceAll("\\", "/"),
    ),
  );
function Page({ host }: { host: UIHost }) {
  const config = useLoad<any>(() => host.request("/api/host/config"));
  const targets = useLoad<any[]>(() => host.request(api + "/targets"));
  const [selected, setSelected] = React.useState(
    new URLSearchParams(host.page?.split("?")[1]).get("profile") ?? "",
  );
  const [draft, setDraft] = React.useState<RoutingProfile>(fresh);
  const [newId, setNewId] = React.useState("");
  const [creating, setCreating] = React.useState(false);
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [task, setTask] = React.useState("");
  const [result, setResult] = React.useState<any>();
  const profiles = config.data
    ? (find(config.data, "auto-router")?.config.profiles ?? {})
    : {};
  const router = config.data ? find(config.data, "ai-router")?.config : undefined;
  const decisionTargetRows = Object.entries(router?.models ?? {}).flatMap(([id, value]) => {
    const model = value as any;
    const channel = router?.upstreams?.[model.upstream];
    if (!channel || model.enabled === false || channel.enabled === false) return [];
    const protocols = [channel.protocol, ...(channel.flow?.nodes ?? [])
      .filter((node: any) => node.type === "provider")
      .map((node: any) => node.upstream?.protocol ?? channel.protocol)];
    if (!protocols.includes(draft.decision.kind)) return [];
    const priced = ["request", "expression"].includes(model.pricing?.mode) ||
      (typeof model.inputPrice === "number" && typeof model.outputPrice === "number");
    return [{ id, model: model.publicModel ?? id, name: model.name ?? id,
      channelId: model.upstream, channelName: channel.name ?? model.upstream, priced }];
  });
  const uniqueTargets = new Map<string, (typeof decisionTargetRows)[number]>();
  for (const target of decisionTargetRows) {
    const key = JSON.stringify([target.model, target.channelId]);
    const previous = uniqueTargets.get(key);
    uniqueTargets.set(key, previous ? { ...previous, priced: previous.priced && target.priced } : target);
  }
  const decisionTargets = [...uniqueTargets.values()];
  React.useEffect(() => {
    if (config.data) {
      const p = find(config.data, "auto-router")?.config.profiles ?? {};
      const id = selected || Object.keys(p)[0] || "";
      setSelected(id);
      setDraft(p[id] ? structuredClone(p[id]) : fresh());
    }
  }, [config.data, selected]);
  const update = (patch: Partial<RoutingProfile>) =>
    setDraft((d) => ({ ...d, ...patch }));
  const candidate = (id: string, patch: Partial<RoutingCandidate>) =>
    setDraft((d) => ({
      ...d,
      candidates: d.candidates.map((c) =>
        c.id === id ? { ...c, ...patch } : c,
      ),
    }));
  function add() {
    const target = targets.data?.[0];
    if (!target) return;
    const id = "c-" + crypto.randomUUID().slice(0, 8);
    const item: RoutingCandidate = {
      id,
      target: target.id,
      strength: 50,
      reasoningEfforts: target.reasoningEfforts ?? [],
    };
    update({
      candidates: [...draft.candidates, item],
      ...(!draft.fixedCandidate ? { fixedCandidate: id } : {}),
      ...(!draft.fallbackCandidate ? { fallbackCandidate: id } : {}),
    });
  }
  async function save() {
    setBusy(true);
    try {
      if (!selected) throw new Error(tr("请先新建一个策略"));
      const c = await host.request<any>("/api/host/config");
      const plugin = find(c, "auto-router");
      if (!plugin) throw new Error(tr("自动路由插件尚未安装"));
      const saved = structuredClone(draft);
      if (!saved.name?.trim()) delete saved.name;
      if (saved.mode !== "manual" && saved.decision.kind !== "rules" &&
        !saved.decision.model)
        throw new Error(tr("请选择已配置价格的决策模型"));
      if (saved.mode !== "manual" && saved.decision.kind !== "rules") {
        const matched = decisionTargets.filter((item) =>
          item.model === saved.decision.model &&
          (!saved.decision.channelId || item.channelId === saved.decision.channelId));
        if (!matched.length || matched.some((item) => !item.priced))
          throw new Error(tr("请选择已配置价格的决策模型"));
      }
      plugin.config = {
        ...plugin.config,
        profiles: { ...plugin.config.profiles, [selected]: saved },
      };
      await host.request("/api/host/config", {
        method: "PUT",
        body: JSON.stringify(c),
      });
      setMessage(tr("已保存"));
      config.reload();
      if (host.slot !== "channel.settings") host.refresh();
    } catch (e) {
      setMessage((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function preview() {
    setBusy(true);
    try {
      setResult(
        await host.request(api + "/preview", {
          method: "POST",
          body: JSON.stringify({ profile: selected, text: task }),
        }),
      );
      setMessage("");
    } catch (e) {
      setMessage((e as Error).message);
      setResult(undefined);
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      {host.slot !== "channel.settings" && (
        <PageHeading title={tr("自动路由")} />
      )}
      <Notice message={message || config.error || targets.error} />
      <div className="section-heading">
        <label>
          {tr("路由策略")}
          <Select
            value={selected}
            onChange={(e) => {
              setSelected(e.target.value);
              setResult(undefined);
            }}
          >
            <option value="" disabled>
              {tr("选择策略")}
            </option>
            {[
              ...new Set([
                ...Object.keys(profiles),
                ...(selected ? [selected] : []),
              ]),
            ].map((id) => (
              <option key={id} value={id}>
                {profiles[id]?.name || id}
              </option>
            ))}
          </Select>
        </label>
        <div className="actions">
          <button className="secondary" onClick={() => setCreating(true)}>
            {tr("新建策略")}
          </button>
          <button disabled={busy || !selected} onClick={() => void save()}>
            {tr("保存策略")}
          </button>
        </div>
      </div>
      {!selected ? (
        <Empty title={tr("创建自动路由策略")} />
      ) : (
        <>
          <div className="card">
            <div className="form-grid">
              <label>
                {tr("显示名称")}
                <input
                  value={draft.name ?? ""}
                  onChange={(e) => update({ name: e.target.value })}
                />
              </label>
              <label>
                {tr("路由模式")}
                <Select
                  value={draft.mode}
                  onChange={(e) => {
                    const mode = e.target.value as RoutingProfile["mode"];
                    const fixedCandidate =
                      draft.fixedCandidate ?? draft.candidates[0]?.id;
                    update({
                      mode,
                      ...(["effort", "manual"].includes(mode)
                        ? { fixedCandidate }
                        : {}),
                      ...(mode === "effort"
                        ? { fallbackCandidate: fixedCandidate }
                        : {}),
                    });
                  }}
                >
                  <option value="model">
                    {tr("自动选模型 · 保留思考设置")}
                  </option>
                  <option value="effort">
                    {tr("自动选思考强度 · 固定模型")}
                  </option>
                  <option value="both">{tr("同时选模型和思考强度")}</option>
                  <option value="manual">{tr("固定模型和强度")}</option>
                </Select>
              </label>
              <label>
                {tr("选择偏好")}
                <Select
                  value={draft.strategy ?? "balanced"}
                  onChange={(e) =>
                    update({
                      strategy: e.target.value as RoutingProfile["strategy"],
                    })
                  }
                >
                  <option value="balanced">{tr("满足难度的最小强度")}</option>
                  <option value="cost">{tr("满足难度后优先低成本")}</option>
                  <option value="quality">{tr("优先最高强度")}</option>
                </Select>
              </label>
              {["effort", "manual"].includes(draft.mode) && (
                <label>
                  {tr("固定候选")}
                  <Select
                    value={draft.fixedCandidate ?? ""}
                    onChange={(e) =>
                      update({
                        fixedCandidate: e.target.value,
                        ...(draft.mode === "effort"
                          ? { fallbackCandidate: e.target.value }
                          : {}),
                      })
                    }
                  >
                    {draft.candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.target}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <label>
                {tr("决策后端")}
                <Select
                  value={draft.decision.kind}
                  onChange={(e) => {
                    const kind = e.target
                      .value as RoutingProfile["decision"]["kind"];
                    update({
                      decision: {
                        kind,
                      },
                    });
                  }}
                >
                  <option value="rules">{tr("本地规则 · 离线")}</option>
                  <option value="luna">Luna · OpenAI Decisions</option>
                  <option value="systemone">Clef / Jev · SystemOne</option>
                  <option value="jev">{tr("JEV · 自部署 decide")}</option>
                </Select>
              </label>
              {draft.decision.kind !== "rules" && (
                <label>
                  {tr("决策模型")}
                  <Select
                    value={!draft.decision.model ? "" : JSON.stringify([draft.decision.model, draft.decision.channelId ?? ""])}
                    onChange={(e) => {
                      if (!e.target.value) return;
                      const [model, channelId] = JSON.parse(e.target.value) as [string, string];
                      update({ decision: { ...draft.decision, model, channelId } });
                    }}
                  >
                    <option value="">{tr("请选择已配置价格的决策模型")}</option>
                    {decisionTargets.map((target) => (
                      <option key={target.id} value={JSON.stringify([target.model, target.channelId])} disabled={!target.priced}>
                        {target.name} · {target.channelName} / {target.model}{target.priced ? "" : ` · ${tr("未配置价格")}`}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <label>
                {tr("失败或低置信度")}
                <Select
                  value={draft.onFailure ?? "fallback"}
                  onChange={(e) =>
                    update({
                      onFailure: e.target.value as "fallback" | "reject",
                    })
                  }
                >
                  <option value="fallback">{tr("使用指定保底候选")}</option>
                  <option value="reject">{tr("拒绝调用")}</option>
                </Select>
              </label>
              {draft.onFailure !== "reject" && (
                <label>
                  {tr("保底候选")}
                  <Select
                    value={draft.fallbackCandidate ?? ""}
                    onChange={(e) =>
                      update({ fallbackCandidate: e.target.value })
                    }
                  >
                    {draft.candidates.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.target}
                      </option>
                    ))}
                  </Select>
                </label>
              )}
              <label>
                {tr("最低置信度")}
                <input
                  type="number"
                  min="0"
                  max="1"
                  step=".01"
                  value={draft.minConfidence ?? 0.65}
                  onChange={(e) =>
                    update({ minConfidence: Number(e.target.value) })
                  }
                />
              </label>
              {draft.onFailure !== "reject" && (
                <label>
                  {tr("保底思考档位")}
                  <Select
                    value={draft.fallbackEffort ?? ""}
                    onChange={(e) => {
                      const next = { ...draft };
                      if (e.target.value)
                        next.fallbackEffort = e.target.value as ReasoningEffort;
                      else delete next.fallbackEffort;
                      setDraft(next);
                    }}
                  >
                    <option value="">
                      {tr("按困难任务映射 / 候选默认值")}
                    </option>
                    {levels.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </Select>
                </label>
              )}
              <label>
                {tr("决策超时（毫秒）")}
                <input
                  type="number"
                  min="50"
                  max="30000"
                  value={draft.decision.timeoutMs ?? 3000}
                  onChange={(e) =>
                    update({
                      decision: {
                        ...draft.decision,
                        timeoutMs: Number(e.target.value),
                      },
                    })
                  }
                />
              </label>
              {draft.mode === "manual" && (
                <label>
                  {tr("固定思考强度")}
                  <Select
                    value={draft.fixedEffort ?? ""}
                    onChange={(e) => {
                      const next = { ...draft };
                      if (e.target.value)
                        next.fixedEffort = e.target.value as ReasoningEffort;
                      else delete next.fixedEffort;
                      setDraft(next);
                    }}
                  >
                    <option value="">{tr("使用候选默认值")}</option>
                    {levels.map((l) => (
                      <option key={l}>{l}</option>
                    ))}
                  </Select>
                </label>
              )}
            </div>
            <label className="checkbox">
              <Checkbox
                appearance="switch"
                checked={draft.preserveClientEffort !== false}
                onCheckedChange={(e) =>
                  update({ preserveClientEffort: e === true })
                }
              />
              {tr("保留客户端显式指定的思考强度")}
            </label>
          </div>
          <div className="section-heading">
            <h2>{tr("候选模型与动态强度")}</h2>
            <button
              className="secondary"
              disabled={!targets.data?.length}
              onClick={add}
            >
              {tr("添加候选")}
            </button>
          </div>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>{tr("真实上游模型")}</th>
                  <th>{tr("强度（0–100）")}</th>
                  <th>{tr("支持的思考档位")}</th>
                  <th>{tr("状态")}</th>
                </tr>
              </thead>
              <tbody>
                {draft.candidates.map((c) => (
                  <tr key={c.id}>
                    <td>
                      <Select
                        aria-label={tr("候选模型")}
                        value={c.target}
                        onChange={(e) =>
                          candidate(c.id, {
                            target: e.target.value,
                            reasoningEfforts:
                              targets.data?.find((t) => t.id === e.target.value)
                                ?.reasoningEfforts ?? [],
                          })
                        }
                      >
                        {targets.data?.map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.name} · {t.channel} / {t.model}
                          </option>
                        ))}
                      </Select>
                      <small>{c.id}</small>
                    </td>
                    <td>
                      <div className="strength-control">
                        <input
                          aria-label={c.id + tr(" 模型强度")}
                          type="range"
                          min="0"
                          max="100"
                          value={c.strength}
                          onChange={(e) =>
                            candidate(c.id, {
                              strength: Number(e.target.value),
                            })
                          }
                        />
                        <strong>{c.strength}</strong>
                      </div>
                    </td>
                    <td>
                      <div className="reasoning-chips">
                        {levels.map((l) => (
                          <label key={l}>
                            <Checkbox
                              checked={c.reasoningEfforts?.includes(l) ?? false}
                              onCheckedChange={(e) =>
                                candidate(c.id, {
                                  reasoningEfforts:
                                    e === true
                                      ? [...(c.reasoningEfforts ?? []), l]
                                      : c.reasoningEfforts?.filter(
                                          (x) => x !== l,
                                        ),
                                })
                              }
                            />
                            {l}
                          </label>
                        ))}
                      </div>

                      <label>
                        {tr("默认思考档位")}
                        <Select
                          value={c.defaultEffort ?? ""}
                          onChange={(e) => {
                            setDraft((d) => ({
                              ...d,
                              candidates: d.candidates.map((item) => {
                                if (item.id !== c.id) return item;
                                const next = { ...item };
                                if (e.target.value)
                                  next.defaultEffort = e.target
                                    .value as ReasoningEffort;
                                else delete next.defaultEffort;
                                return next;
                              }),
                            }));
                          }}
                        >
                          <option value="">{tr("服务商默认")}</option>
                          {(c.reasoningEfforts ?? []).map((l) => (
                            <option key={l}>{l}</option>
                          ))}
                        </Select>
                      </label>
                    </td>
                    <td>
                      <label className="checkbox">
                        <Checkbox
                          appearance="switch"
                          checked={c.enabled !== false}
                          onCheckedChange={(e) =>
                            candidate(c.id, { enabled: e === true })
                          }
                        />
                        {tr("参与路由")}
                      </label>
                      <button
                        className="ghost danger"
                        onClick={() =>
                          update({
                            candidates: draft.candidates.filter(
                              (x) => x.id !== c.id,
                            ),
                          })
                        }
                      >
                        {tr("移除")}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <details className="card">
            <summary>{tr("难度阈值和思考映射")}</summary>
            <div className="form-grid">
              {[
                ["easy", tr("简单")],
                ["standard", tr("常规")],
                ["hard", tr("困难")],
                ["expert", tr("专家")],
              ].map(([level, name]) => (
                <React.Fragment key={level}>
                  <label>
                    {name} {tr("· 所需强度")}
                    <input
                      type="number"
                      min="0"
                      max="100"
                      value={
                        draft.difficultyStrength?.[level as "easy"] ??
                        (
                          {
                            easy: 20,
                            standard: 45,
                            hard: 70,
                            expert: 95,
                          } as any
                        )[level!]
                      }
                      onChange={(e) =>
                        update({
                          difficultyStrength: {
                            ...draft.difficultyStrength,
                            [level!]: Number(e.target.value),
                          },
                        })
                      }
                    />
                  </label>
                  <label>
                    {name} {tr("· 思考档位")}
                    <Select
                      value={
                        draft.effortByDifficulty?.[level as "easy"] ??
                        (
                          {
                            easy: "low",
                            standard: "medium",
                            hard: "high",
                            expert: "max",
                          } as any
                        )[level!]
                      }
                      onChange={(e) =>
                        update({
                          effortByDifficulty: {
                            ...draft.effortByDifficulty,
                            [level!]: e.target.value as ReasoningEffort,
                          },
                        })
                      }
                    >
                      {levels.map((l) => (
                        <option key={l}>{l}</option>
                      ))}
                    </Select>
                  </label>
                </React.Fragment>
              ))}
            </div>
          </details>

          <div className="card">
            <h2>{tr("决策预览")}</h2>
            <label>
              {tr("测试任务")}
              <textarea
                rows={3}
                value={task}
                onChange={(e) => setTask(e.target.value)}
                placeholder={tr("描述一个简单问题或复杂任务")}
              />
            </label>
            <button
              className="secondary"
              disabled={busy || !task.trim() || !profiles[selected] || (profiles[selected]?.decision?.kind !== "rules" && profiles[selected]?.mode !== "manual")}
              onClick={() => void preview()}
            >
              {tr("测试已保存策略")}
            </button>
            {profiles[selected]?.decision?.kind !== "rules" && profiles[selected]?.mode !== "manual" && (
              <small>{tr("远程决策请通过渠道测试请求")}</small>
            )}

            {result && (
              <>
                <div className="routing-result">
                  <div>
                    <small>{tr("选中模型")}</small>
                    <strong>{result.target ?? result.model}</strong>
                    <small>
                      {result.channel} / {result.model}
                    </small>
                  </div>
                  <div>
                    <small>{tr("任务难度")}</small>
                    <strong>
                      {(
                        {
                          easy: tr("简单"),
                          standard: tr("常规"),
                          hard: tr("困难"),
                          expert: tr("专家"),
                        } as any
                      )[result.decision?.difficulty] ?? "—"}
                    </strong>
                    <small>
                      {result.decision?.source === "rules"
                        ? tr("本地规则")
                        : tr("置信度 {0}%", {
                            "0": textValue(
                              Math.round(
                                (result.decision?.confidence ?? 0) * 100,
                              ),
                            ),
                          })}
                    </small>
                  </div>
                  <div>
                    <small>{tr("思考强度")}</small>
                    <strong>
                      {result.reasoning?.effort ?? tr("服务商默认")}
                    </strong>
                    <small>{result.decision?.elapsedMs} ms</small>
                  </div>
                </div>
                <details>
                  <summary>{tr("完整决策记录")}</summary>
                  <pre className="code">{JSON.stringify(result, null, 2)}</pre>
                </details>
              </>
            )}
          </div>
        </>
      )}
      {creating && (
        <Dialog title={tr("新建路由策略")} close={() => setCreating(false)}>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (profiles[newId]) {
                setMessage(tr("策略 ID 已存在"));
                return;
              }
              setSelected(newId);
              setDraft(fresh());
              setCreating(false);
            }}
          >
            <label>
              {tr("策略 ID")}
              <input
                required
                pattern={"[a-zA-Z0-9_\\-]+"}
                value={newId}
                onChange={(e) => setNewId(e.target.value)}
              />
            </label>
            <button>{tr("创建策略")}</button>
          </form>
        </Dialog>
      )}
    </>
  );
}
export const mount = (el: HTMLElement, host: UIHost) =>
  mountPage(el, host, Page);
