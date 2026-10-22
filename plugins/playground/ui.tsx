import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  Dialog,
  Icon,
  number,
  latency,
} from "../../lib/ui/components.js";
import { readChatStream } from "./chat-stream.js";
type Message = {
  role: "user" | "assistant";
  content: string;
  incomplete?: boolean;
};
function Page({ host }: { host: UIHost }) {
  const [channel, setChannel] = React.useState(
    new URLSearchParams(location.hash.split("?")[1]).get("channel") ?? "",
  );
  const channels = useLoad<any[]>(() =>
    host.request("/api/plugins/official.ai-router/channels").catch(() => []),
  );
  const models = useLoad<CatalogModel[]>(
    () =>
      host.request(
        "/api/plugins/official.playground/models?channel=" +
          encodeURIComponent(channel),
      ),
    [channel],
  );
  const [model, setModel] = React.useState(
    new URLSearchParams(location.hash.split("?")[1]).get("model") ?? "",
  );
  const [prompt, setPrompt] = React.useState("");
  const [system, setSystem] = React.useState("");
  const [temperature, setTemperature] = React.useState("0.7");
  const [maxTokens, setMaxTokens] = React.useState("1024");
  const [messages, setMessages] = React.useState<Message[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [settings, setSettings] = React.useState(false);
  const [error, setError] = React.useState("");
  const [meta, setMeta] = React.useState<{
    id?: string;
    first?: number;
    elapsed?: number;
    tokens?: number;
  }>({});
  const controller = React.useRef<AbortController | null>(null);
  const transcript = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => () => controller.current?.abort(), []);
  React.useEffect(() => {
    if (!model && models.data?.length) setModel(models.data[0]!.id);
  }, [models.data]);
  React.useEffect(() => {
    if (transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !prompt.trim() || !model) return;
    const history = [
      ...messages.filter((m) => !m.incomplete),
      { role: "user" as const, content: prompt },
    ];
    setMessages([...history, { role: "assistant", content: "" }]);
    setPrompt("");
    setBusy(true);
    setError("");
    setMeta({});
    const abort = new AbortController();
    controller.current = abort;
    let text = "";
    let first: number | undefined;
    const started = performance.now();
    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        credentials: "same-origin",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          ...(channel ? { "x-pluhub-channel": channel } : {}),
        },
        body: JSON.stringify({
          model,
          messages: [
            ...(system ? [{ role: "system", content: system }] : []),
            ...history.map(({ role, content }) => ({ role, content })),
          ],
          stream: true,
          ...(temperature !== "" ? { temperature: Number(temperature) } : {}),
          ...(maxTokens !== "" ? { max_tokens: Number(maxTokens) } : {}),
          stream_options: { include_usage: true },
        }),
      });
      if (!response.ok) {
        if (response.status === 401) host.refresh();
        const data = await response.json();
        throw new Error(data.error?.message ?? tr("请求失败"));
      }
      if (!response.body) throw new Error(tr("响应流为空"));
      setMeta({ id: response.headers.get("x-pluhub-request-id") ?? undefined });
      await readChatStream(response.body, (event) => {
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          if (first === undefined) {
            first = performance.now() - started;
            setMeta((m) => ({ ...m, first }));
          }
          text += delta;
          setMessages([...history, { role: "assistant", content: text }]);
        }
        if (event.usage)
          setMeta((m) => ({
            ...m,
            tokens:
              (event.usage.prompt_tokens ?? 0) +
              (event.usage.completion_tokens ?? 0),
          }));
      });
    } catch (e) {
      setError(abort.signal.aborted ? tr("已停止生成") : (e as Error).message);
      setMessages([
        ...history,
        {
          role: "assistant",
          content:
            text ||
            (abort.signal.aborted ? tr("已停止生成") : tr("调用未完成")),
          incomplete: true,
        },
      ]);
    } finally {
      setMeta((m) => ({ ...m, elapsed: performance.now() - started }));
      setBusy(false);
      controller.current = null;
    }
  }
  return (
    <div className="playground-page">
      <PageHeading title={tr("在线对话")}>
        <button className="secondary" onClick={() => setSettings(true)}>
          <Icon name="settings" size={15} />
          {tr("对话设置")}
        </button>
        <button
          className="secondary"
          disabled={busy}
          onClick={() => {
            setMessages([]);
            setMeta({});
            setError("");
          }}
        >
          <Icon name="plus" size={16} />
          {tr("新建对话")}
        </button>
      </PageHeading>
      <Notice message={error || models.error} />
      {!!channels.data?.length && (
        <div className="chat-toolbar">
          <label>
            {tr("模型来源")}
            <Select
              aria-label={tr("对话模型来源")}
              value={channel}
              disabled={busy}
              onChange={(e) => {
                setChannel(e.target.value);
                setModel("");
                setMessages([]);
                setMeta({});
              }}
            >
              <option value="">{tr("平台模型")}</option>
              {channels.data?.map((c) => (
                <option key={c.id} value={c.id}>
                  {c.scope === "personal" ? tr("个人 · ") : tr("平台 · ")}
                  {c.name}
                </option>
              ))}
            </Select>
          </label>
        </div>
      )}
      <div className="playground-grid">
        <section className="chat-panel">
          <div className="chat-messages" ref={transcript} aria-live="polite">
            {messages.length ? (
              messages.map((m, i) => (
                <article key={i} className={"chat-message " + m.role}>
                  <span className="avatar">
                    {m.role === "user" ? "U" : "P"}
                  </span>
                  <div>
                    <strong>
                      {m.role === "user" ? tr("你") : model}
                      {m.incomplete ? tr(" · 未完成") : ""}
                    </strong>
                    <p>{m.content || tr("正在等待模型响应…")}</p>
                  </div>
                </article>
              ))
            ) : (
              <div className="chat-welcome">
                <Icon name="chat" size={26} />
                <h2>{tr("开始新对话")}</h2>
              </div>
            )}
          </div>
          <form className="chat-composer" onSubmit={send}>
            <textarea
              aria-label={tr("消息内容")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={tr("输入消息…")}
              disabled={busy}
              maxLength={64000}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  (event.ctrlKey || event.metaKey) &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="chat-composer-bottom">
              <kbd aria-hidden="true">Ctrl / ⌘ ↵</kbd>
              <div className="chat-composer-actions">
                <Select
                  aria-label={tr("选择模型")}
                  value={model}
                  disabled={busy}
                  onChange={(e) => {
                    setModel(e.target.value);
                    setMessages([]);
                    setMeta({});
                  }}
                >
                  <option value="" disabled>
                    {tr("请选择模型")}
                  </option>
                  {models.data?.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </Select>
                {busy ? (
                  <button
                    type="button"
                    className="secondary"
                    onClick={() => controller.current?.abort()}
                  >
                    <Icon name="stop" size={15} />
                    {tr("停止生成")}
                  </button>
                ) : (
                  <button type="submit" disabled={!prompt.trim() || !model}>
                    {tr("发送")}
                    <Icon name="arrow" size={15} />
                  </button>
                )}
              </div>
            </div>
          </form>
        </section>
      </div>
      {settings && (
        <Dialog title={tr("对话设置")} close={() => setSettings(false)}>
          <div className="play-settings">
            <label>
              {tr("系统提示词")}
              <textarea
                aria-label={tr("系统提示词")}
                value={system}
                disabled={busy}
                rows={4}
                maxLength={8000}
                onChange={(e) => setSystem(e.target.value)}
                placeholder={tr("可选：设定模型的角色或回答方式")}
              />
            </label>
            <label>
              Temperature
              <input
                type="number"
                min="0"
                max="2"
                aria-label="Temperature"
                step="0.1"
                value={temperature}
                disabled={busy}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </label>
            <label>
              {tr("最大输出 Token")}
              <input
                type="number"
                min="1"
                step="1"
                max="1000000"
                value={maxTokens}
                disabled={busy}
                onChange={(e) => setMaxTokens(e.target.value)}
                placeholder={tr("留空由上游决定")}
              />
              <small>
                {tr(
                  "预付计费要求指定。Codex CLI 模式须清空此项和 Temperature。",
                )}
              </small>
            </label>
          </div>
        </Dialog>
      )}
      {(meta.id || meta.elapsed != null) && (
        <div className="chat-meta">
          <span>
            {tr("请求 {0}", { "0": textValue(meta.id?.slice(0, 8) ?? "—") })}
          </span>
          <span>
            {tr("首字延迟")}
            {latency(meta.first)}
          </span>
          <span>
            {tr("耗时")}
            {latency(meta.elapsed)}
          </span>
          <span>{number(meta.tokens)} Token</span>
        </div>
      )}
    </div>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
