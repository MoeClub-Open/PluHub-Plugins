import { t as tr, textValue } from "../../lib/ui/i18n.js";
import { Select } from "../../lib/ui/select.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { CatalogModel, UrlCitation } from "@pluhub/contracts/ai";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  Dialog,
  Icon,
  number,
  latency,
} from "../../lib/ui/components.js";
import { readChatStream } from "./chat-stream.js";
import {
  chatStorageKey,
  readChat,
  saveChat,
  type Message,
  type ChatMeta,
  type ChatSession,
} from "./session.js";
function Answer({ message }: { message: Message }) {
  const citations = [...(message.citations ?? [])].sort(
    (a, b) => a.startIndex - b.startIndex,
  );
  const parts: React.ReactNode[] = [];
  let cursor = 0;
  for (const citation of citations) {
    if (
      citation.startIndex < cursor ||
      citation.endIndex > message.content.length ||
      !/^https?:\/\//i.test(citation.url)
    )
      continue;
    parts.push(message.content.slice(cursor, citation.startIndex));
    parts.push(
      <a
        key={JSON.stringify(citation)}
        className="text-link"
        href={citation.url}
        title={citation.title}
        target="_blank"
        rel="noopener noreferrer"
      >
        {message.content.slice(citation.startIndex, citation.endIndex) ||
          citation.title}
      </a>,
    );
    cursor = citation.endIndex;
  }
  parts.push(message.content.slice(cursor));
  return (
    <p>
      {message.content
        ? parts
        : message.incomplete
          ? tr("调用未完成")
          : tr("正在等待模型响应…")}
    </p>
  );
}
function Page({ host }: { host: UIHost }) {
  const [storageKey] = React.useState(chatStorageKey);
  const [initial] = React.useState(() => readChat(storageKey));
  const [channel, setChannel] = React.useState(initial.channel);
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
  const [model, setModel] = React.useState(initial.model);
  const [modelChannel, setModelChannel] = React.useState(initial.modelChannel);
  const selectedModel = models.data?.find(
    (item) => item.id === model && item.channel?.id === modelChannel,
  );
  const selection = selectedModel ? JSON.stringify([modelChannel, model]) : "";
  const [prompt, setPrompt] = React.useState(initial.prompt);
  const [system, setSystem] = React.useState(initial.system);
  const [temperature, setTemperature] = React.useState(initial.temperature);
  const [maxTokens, setMaxTokens] = React.useState(initial.maxTokens);
  const [messages, setMessages] = React.useState<Message[]>(initial.messages);
  const [busy, setBusy] = React.useState(false);
  const [settings, setSettings] = React.useState(false);
  const [error, setError] = React.useState("");
  const [meta, setMeta] = React.useState<ChatMeta>(initial.meta);
  const controller = React.useRef<AbortController | null>(null);
  const session = React.useRef(initial.sessionId);
  const transcript = React.useRef<HTMLDivElement>(null);
  const latest = React.useRef<ChatSession>(initial);
  latest.current = {
    version: 1,
    sessionId: session.current,
    channel,
    model,
    modelChannel,
    prompt,
    system,
    temperature,
    maxTokens,
    meta,
    messages: busy
      ? messages.map((message, index) =>
          index === messages.length - 1 && message.role === "assistant"
            ? { ...message, incomplete: true }
            : message,
        )
      : messages,
  };
  React.useEffect(() => {
    const timer = setTimeout(() => saveChat(storageKey, latest.current), 250);
    return () => clearTimeout(timer);
  }, [
    channel,
    model,
    modelChannel,
    prompt,
    system,
    temperature,
    maxTokens,
    messages,
    meta,
    busy,
    storageKey,
  ]);
  React.useEffect(() => {
    const save = () => saveChat(storageKey, latest.current);
    window.addEventListener("pagehide", save);
    return () => {
      save();
      window.removeEventListener("pagehide", save);
      controller.current?.abort();
    };
  }, [storageKey]);
  React.useEffect(() => {
    if (!models.data?.length) return;
    if (
      model &&
      !models.data.some(
        (item) =>
          item.id === model &&
          (!modelChannel || item.channel?.id === modelChannel),
      )
    )
      return;
    const match =
      models.data.find(
        (item) =>
          item.id === model &&
          (!modelChannel || item.channel?.id === modelChannel),
      ) ?? models.data[0]!;
    setModel(match.id);
    setModelChannel(match.channel?.id ?? "");
  }, [models.data]);
  React.useEffect(() => {
    if (transcript.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !prompt.trim() || !selectedModel) return;
    const history = [
      ...messages.filter((m) => !m.incomplete),
      { role: "user" as const, content: prompt },
    ];
    const answer = { role: "assistant" as const, model, channel: modelChannel };
    setMessages([...history, { ...answer, content: "" }]);
    setPrompt("");
    setBusy(true);
    setError("");
    setMeta({});
    const abort = new AbortController();
    controller.current = abort;
    let text = "";
    const citations: UrlCitation[] = [];
    let first: number | undefined;
    const started = performance.now();
    try {
      const response = await fetch("/v1/chat/completions", {
        method: "POST",
        credentials: "same-origin",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          "x-pluhub-session-id": session.current,
          ...(modelChannel ? { "x-pluhub-channel": modelChannel } : {}),
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
          setMessages([
            ...history,
            { ...answer, content: text, citations: [...citations] },
          ]);
        }
        for (const annotation of event.choices?.[0]?.delta?.annotations ?? []) {
          const value = annotation.url_citation;
          if (
            annotation.type !== "url_citation" ||
            !value ||
            typeof value.url !== "string" ||
            !/^https?:\/\//i.test(value.url)
          )
            continue;
          const citation: UrlCitation = {
            url: value.url,
            title: value.title ?? value.url,
            startIndex: value.start_index,
            endIndex: value.end_index,
          };
          if (
            !citations.some(
              (item) => JSON.stringify(item) === JSON.stringify(citation),
            )
          )
            citations.push(citation);
          setMessages([
            ...history,
            { ...answer, content: text, citations: [...citations] },
          ]);
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
          ...answer,
          content:
            text ||
            (abort.signal.aborted ? tr("已停止生成") : tr("调用未完成")),
          incomplete: true,
          citations: [...citations],
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
            session.current = crypto.randomUUID();
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
      {!models.error && models.data && model && !selectedModel && (
        <Notice
          message={tr(
            "所选模型或渠道已不可用，请重新选择。默认不会切换到其他渠道。",
          )}
        />
      )}
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
                setModelChannel("");
                setMeta({});
                setError("");
              }}
            >
              <option value="">{tr("全部渠道")}</option>
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
                      {m.role === "user" ? tr("你") : (m.model ?? model)}
                      {m.incomplete ? tr(" · 未完成") : ""}
                    </strong>
                    <Answer message={m} />
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
                  value={selection}
                  disabled={busy}
                  onChange={(e) => {
                    const [selectedChannel, selectedId] = JSON.parse(
                      e.target.value,
                    ) as [string, string];
                    setModel(selectedId);
                    setModelChannel(selectedChannel);
                    setMeta({});
                    setError("");
                  }}
                >
                  <option value="" disabled>
                    {tr("请选择模型")}
                  </option>
                  {models.data?.map((m) => (
                    <option
                      key={JSON.stringify([m.channel?.id, m.id])}
                      value={JSON.stringify([m.channel?.id ?? "", m.id])}
                    >
                      {m.name}
                      {!channel && m.channel ? " · " + m.channel.name : ""}
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
                  <button
                    type="submit"
                    disabled={!prompt.trim() || !selectedModel}
                  >
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
          {meta.id ? (
            <a
              className="text-link"
              href={
                "#/activity?requestId=" +
                encodeURIComponent(meta.id) +
                "&scope=me"
              }
            >
              {tr("请求 {0}", { "0": textValue(meta.id?.slice(0, 8) ?? "—") })}
            </a>
          ) : (
            <span>{tr("请求 {0}", { "0": "—" })}</span>
          )}
          <span>
            {tr("客户端首字延迟")}
            {latency(meta.first)}
          </span>
          <span>
            {tr("客户端总耗时")}
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
