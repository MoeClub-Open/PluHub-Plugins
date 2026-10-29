import { SecretInput } from "./secret-input.js";
import { Checkbox } from "./checkbox.js";
import { Select } from "./select.js";
import { Notice } from "./mount.js";
import { t as tr } from "./i18n.js";
import { subscriptionDefaults } from "../ai/subscription-auth.js";
import { UpstreamInterfaces } from "./upstream-interfaces.js";
import { FlowParameter } from "./flow-parameter-port.js";
import type { WorkflowNode } from "@pluhub/contracts/workflow";
import type { ChannelNodeContext } from "./channel-node-settings.js";
const protocols = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
  "systemone",
  "luna",
  "jev",
  "codex",
  "claude-subscription",
  "antigravity",
  "grok",
];
const subscriptionProtocols = new Set([
  "codex",
  "claude-subscription",
  "antigravity",
  "grok",
]);
export function ProviderNodeSettings({
  node,
  change,
  context,
}: {
  node: Extract<WorkflowNode, { type: "provider" }>;
  change: (patch: any, interfaceRemap?: readonly number[]) => void;
  context: ChannelNodeContext;
}) {
  const {
    personal,
    channel,
    personalInterfaces,
    setPersonalInterfaces,
    subscriptionAccounts,
  } = context;
  const providedModels = context.providedModels.filter(route =>
    personal || (node.modelMap ? Object.hasOwn(node.modelMap, route.model) : node.model !== undefined));
  function changeProtocol(protocol: string) {
    if (node?.type !== "provider") return;
    const upstream: any = { protocol };
    if (subscriptionProtocols.has(protocol)) {
      upstream.subscriptionAccountIds = [];
      if (protocol === "codex") upstream.authMode = "cli";
    } else {
      upstream.baseUrl = node.upstream?.baseUrl ?? "";
      upstream.keyRef = node.upstream?.keyRef ?? "";
    }
    change(
      { upstream, model: undefined, modelMap: {} },
      node.upstream?.interfaces?.map(() => -1),
    );
  }
  function connection(
    patch: Record<string, unknown>,
    interfaceRemap?: readonly number[],
  ) {
    if (node?.type !== "provider") return;
    change(
      {
        upstream: {
          ...(node.upstream ?? {
            protocol: "openai-chat",
            baseUrl: "",
            keyRef: "",
          }),
          ...patch,
        },
      },
      interfaceRemap,
    );
  }
  return (
    <>
      {node.type === "provider" && (
        <>
          {!personal && (
            <>
              <FlowParameter field="upstream.protocol">
                <label>
                  {tr("上游调用协议")}
                  <Select
                    aria-label={tr("上游调用协议")}
                    value={node.upstream?.protocol ?? "openai-chat"}
                    onChange={(e) => changeProtocol(e.target.value)}
                  >
                    {protocols.map((p) => (
                      <option key={p} value={p}>
                        {p === "systemone"
                          ? "Jev / System One"
                          : p === "luna"
                            ? "Luna / Decisions"
                            : p === "jev"
                              ? "JEV / Decide"
                              : p}
                      </option>
                    ))}
                  </Select>
                </label>
              </FlowParameter>
              {([
                "codex",
                "claude-subscription",
                "antigravity",
                "grok",
              ].includes(node.upstream?.protocol ?? "") ||
                context.boundInputs.has("upstream.protocol")) && (
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
                      <option value="accounts">{tr("订阅账号")}</option>
                      <option value="static">{tr("API Key")}</option>
                    </Select>
                  </label>
                  {node.upstream?.subscriptionAccountIds && (
                    <FlowParameter field="upstream.subscriptionAccountIds">
                      <div className="full">
                        <Notice message={subscriptionAccounts.error ?? ""} />
                        {(subscriptionAccounts.data ?? [])
                          .filter((a) => a.provider === node.upstream?.protocol)
                          .map((a) => (
                            <label className="checkbox-row" key={a.id}>
                              <Checkbox
                                checked={node.upstream!.subscriptionAccountIds!.includes(
                                  a.id,
                                )}
                                onCheckedChange={(e) =>
                                  connection({
                                    ...(a.provider === "codex" && e === true
                                      ? {
                                          authMode: a.authMode ?? "cli",
                                          baseUrl:
                                            a.authMode === "siwc"
                                              ? "https://api.openai.com/v1"
                                              : subscriptionDefaults.codex
                                                  .baseUrl,
                                        }
                                      : {}),
                                    subscriptionAccountIds:
                                      e === true
                                        ? [
                                            ...node.upstream!.subscriptionAccountIds!.filter(
                                              (id) =>
                                                a.provider !== "codex" ||
                                                (subscriptionAccounts.data?.find(
                                                  (item) => item.id === id,
                                                )?.authMode ?? "cli") ===
                                                  (a.authMode ?? "cli"),
                                            ),
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
                        {subscriptionAccounts.data &&
                          !subscriptionAccounts.data.some(
                            (a) => a.provider === node.upstream?.protocol,
                          ) && (
                            <span className="muted">
                              {tr("暂无可用订阅账号")}
                            </span>
                          )}
                        {(node.upstream.subscriptionAccountIds ?? [])
                          .filter(
                            (id) =>
                              !subscriptionAccounts.data?.some(
                                (a) => a.id === id,
                              ),
                          )
                          .map((id) => (
                            <label className="checkbox-row" key={id}>
                              <Checkbox
                                checked
                                onCheckedChange={() =>
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
                    </FlowParameter>
                  )}
                </>
              )}
              {!node.upstream?.subscriptionAccountIds && (
                <>
                  <FlowParameter field="upstream.baseUrl">
                    <label>
                      Base URL
                      <input
                        aria-label={tr("上游地址")}
                        type="url"
                        value={node.upstream?.baseUrl ?? ""}
                        onChange={(e) =>
                          connection({ baseUrl: e.target.value })
                        }
                        placeholder={
                          node.upstream?.protocol === "systemone"
                            ? "https://api.typesafe.ai/v1"
                            : node.upstream?.protocol === "jev"
                              ? "https://api.example.com/v1"
                              : "https://api.openai.com/v1"
                        }
                      />
                    </label>
                  </FlowParameter>
                  <FlowParameter field="upstream.keyRef">
                    <label>
                      {tr("API Key")}
                      <SecretInput
                        key={node.id}
                        multiline
                        value={node.upstream?.keyRef}
                        label={tr("上游 API Key")}
                        onChange={(keyRef) => connection({ keyRef })}
                      />
                    </label>
                  </FlowParameter>
                </>
              )}
            </>
          )}
          <UpstreamInterfaces
            protocol={
              personal
                ? channel.protocol
                : (node.upstream?.protocol ?? "openai-chat")
            }
            value={personal ? personalInterfaces : node.upstream?.interfaces}
            parameterPrefix={personal ? "interfaces" : "upstream.interfaces"}
            boundInputs={context.boundInputs}
            hasParameterBindings={context.hasInterfaceBindings}
            onChange={(interfaces, remap) =>
              personal
                ? setPersonalInterfaces(interfaces, remap)
                : connection({ interfaces }, remap)
            }
          />
          <FlowParameter field={context.boundInputs.has("model") ? "model" : "modelMap"}>
            <span>{tr("提供模型")}</span>
            {context.boundInputs.has("model") || context.boundInputs.has("modelMap") ? (
              <p>{tr("由参数连线提供")}</p>
            ) : providedModels.length ? (
              <dl className="provider-model-summary">
                {providedModels.map((route) => {
                  const target = node.modelMap ? node.modelMap[route.model] : (node.model ?? route.model);
                  return <div key={route.id}>
                    <dt>{route.name}</dt>
                    <dd>{personal ? (
                      <Select aria-label={tr("上游模型 ID")} value={target ?? ""}
                        onChange={(event) => change({
                          model: undefined,
                          modelMap: {
                            ...(node.modelMap ?? Object.fromEntries(context.providedModels.map((item) => [item.model, node.model ?? item.model]))),
                            [route.model]: event.target.value,
                          },
                        })}>
                        <option value="" disabled>{tr("未映射")}</option>
                        {[...new Set(context.providedModels.map((item) => item.model))].map((model) => <option key={model} value={model}>{model}</option>)}
                      </Select>
                    ) : <code>{target ?? tr("未映射")}</code>}</dd>
                  </div>;
                })}
              </dl>
            ) : <p className="muted">{tr("暂无模型")}</p>}
          </FlowParameter>
          <FlowParameter field="recordResponseModel">
            <label className="checkbox-row">
              <Checkbox
                appearance="switch"
                checked={node.recordResponseModel === true}
                onCheckedChange={(value) =>
                  change({
                    recordResponseModel: value === true ? true : undefined,
                  })
                }
              />
              {tr("记录上游响应模型 ID")}
            </label>
          </FlowParameter>
          {(node.upstream?.protocol === "codex" ||
            context.boundInputs.has("upstream.protocol") ||
            context.boundInputs.has("upstream.authMode") ||
            context.boundInputs.has("upstream.accountId")) && (
            <>
              <FlowParameter field="upstream.authMode">
                <label>
                  {tr("Codex 授权模式")}
                  <Select
                    value={
                      node.upstream?.authMode ??
                      (node.upstream?.subscriptionAccountIds ? "cli" : "siwc")
                    }
                    onChange={(e) => connection({ authMode: e.target.value })}
                  >
                    <option value="siwc">SIWC / Responses</option>
                    <option value="cli">{tr("CLI 兼容")}</option>
                  </Select>
                </label>
              </FlowParameter>
              {!node.upstream?.subscriptionAccountIds && (
                <FlowParameter field="upstream.accountId">
                  <label>
                    ChatGPT Account ID
                    <input
                      value={node.upstream?.accountId ?? ""}
                      onChange={(e) =>
                        connection({ accountId: e.target.value })
                      }
                    />
                  </label>
                </FlowParameter>
              )}
            </>
          )}
          {(node.upstream?.protocol === "antigravity" ||
            context.boundInputs.has("upstream.protocol") ||
            context.boundInputs.has("upstream.projectId")) &&
            !node.upstream?.subscriptionAccountIds && (
              <FlowParameter field="upstream.projectId">
                <label>
                  Project ID
                  <input
                    value={node.upstream?.projectId ?? ""}
                    onChange={(e) => connection({ projectId: e.target.value })}
                  />
                </label>
              </FlowParameter>
            )}
        </>
      )}
    </>
  );
}
