import { requestErrorHint } from "../../lib/ui/request-error.js";
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
import { RichText } from "./rich-text.js";
import { MediaPage } from "./media-ui.js";
import { readChatStream } from "./chat-stream.js";
import {
  chatStorageKey,
  readChat,
  saveChat,
  type Message,
  type ChatMeta,
  type ChatSession,
} from "./session.js";
function Answer({
  message,
  streaming,
}: {
  message: Message;
  streaming: boolean;
}) {
  const [copied, setCopied] = React.useState(false);
  const citations = [
    ...new Map(
      (message.citations ?? [])
        .filter((c) => /^https?:\/\//i.test(c.url))
        .map((c) => [c.url, c]),
    ).values(),
  ];
  return (
    <>
      {message.reasoning && (
        <details className="chat-reasoning">
          <summary>{tr("思考过程")}</summary>
          <RichText text={message.reasoning} streaming={streaming} />
        </details>
      )}
      {message.content ? (
        message.role === "assistant" ? (
          <RichText text={message.content} streaming={streaming} />
        ) : (
          <p className="chat-user-text">{message.content}</p>
        )
      ) : (
        <p className="muted" role="status">
          {tr(
            message.incomplete
              ? "调用未完成"
              : !streaming
                ? "模型未返回回答"
                : message.reasoning
                  ? "正在思考…"
                  : "正在等待模型响应…",
          )}
        </p>
      )}
      {!!citations.length && (
        <div className="chat-sources">
          {citations.map((c) => (
            <a
              key={c.url}
              href={c.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              {c.title || c.url}
            </a>
          ))}
        </div>
      )}
      {message.role === "assistant" && message.content && !streaming && (
        <button
          type="button"
          className="ghost chat-copy"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message.content);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              setCopied(false);
            }
          }}
        >
          {tr(copied ? "已复制" : "复制回答")}
        </button>
      )}
    </>
  );
}
function ChatPage({
  host,
  onBusy,
}: {
  host: UIHost;
  onBusy: (value: boolean) => void;
}) {
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
  const [effort, setEffort] = React.useState(initial.effort ?? "");
  const efforts = selectedModel?.reasoningEfforts ?? ["low", "medium", "high"];
  const follow = React.useRef(true);
  const [away, setAway] = React.useState(false);
  const [messages, setMessages] = React.useState<Message[]>(initial.messages);
  const [busy, setBusy] = React.useState(false);
  React.useEffect(() => onBusy(busy), [busy, onBusy]);
  const [settings, setSettings] = React.useState(false);
  const [error, setError] = React.useState("");
  const [meta, setMeta] = React.useState<ChatMeta>(initial.meta);
  const controller = React.useRef<AbortController | null>(null);
  const session = React.useRef(initial.sessionId);
  const transcript = React.useRef<HTMLDivElement>(null);
  const latest = React.useRef<ChatSession>(initial);
  latest.current = {
    version: 2,
    sessionId: session.current,
    channel,
    model,
    modelChannel,
    prompt,
    system,
    temperature,
    maxTokens,
    effort,
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
    effort,
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
    if (transcript.current && follow.current)
      transcript.current.scrollTop = transcript.current.scrollHeight;
  }, [messages]);
  React.useEffect(() => {
    const element = transcript.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (follow.current) element.scrollTop = element.scrollHeight;
    });
    for (const child of element.children) observer.observe(child);
    return () => observer.disconnect();
  }, [messages.length]);
  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (busy || !prompt.trim() || !selectedModel) return;
    const history = [
      ...messages.filter((m) => !m.incomplete),
      { role: "user" as const, content: prompt, createdAt: Date.now() },
    ];
    const answer = {
      role: "assistant" as const,
      model,
      channel: modelChannel,
      createdAt: Date.now(),
    };
    follow.current = true;
    setAway(false);
    setMessages([...history, { ...answer, content: "" }]);
    setPrompt("");
    setBusy(true);
    setError("");
    setMeta({});
    const abort = new AbortController();
    controller.current = abort;
    let text = "",
      reasoning = "";
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
          ...(effort && efforts.includes(effort as any)
            ? { reasoning_effort: effort }
            : {}),
          ...(temperature !== "" ? { temperature: Number(temperature) } : {}),
          ...(maxTokens !== "" ? { max_tokens: Number(maxTokens) } : {}),
          stream_options: { include_usage: true },
        }),
      });
      setMeta({ id: response.headers.get("x-pluhub-request-id") ?? undefined });
      if (!response.ok) {
        if (response.status === 401) host.refresh();
        const data = await response.json();
        throw new Error(
          requestErrorHint(data.error?.code) ||
            data.error?.message ||
            tr("请求失败"),
        );
      }
      if (!response.body) throw new Error(tr("响应流为空"));
      await readChatStream(response.body, (event) => {
        const thought = event.choices?.[0]?.delta?.reasoning_content;
        if (typeof thought === "string" && thought) {
          reasoning += thought;
          setMessages([
            ...history,
            { ...answer, content: text, reasoning, citations: [...citations] },
          ]);
        }
        const delta = event.choices?.[0]?.delta?.content;
        if (typeof delta === "string" && delta) {
          if (first === undefined) {
            first = performance.now() - started;
            setMeta((m) => ({ ...m, first }));
          }
          text += delta;
          setMessages([
            ...history,
            { ...answer, content: text, reasoning, citations: [...citations] },
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
            { ...answer, content: text, reasoning, citations: [...citations] },
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
          reasoning,
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
    <div className="chat-page">
      <Notice message={error || models.error} />
      {!models.error && models.data && model && !selectedModel && (
        <Notice
          message={tr(
            "所选模型或渠道已不可用，请重新选择。默认不会切换到其他渠道。",
          )}
        />
      )}
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
        <div className="actions">
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
        </div>
      </div>
      {!!selectedModel?.requestFee && (
        <p className="field-note">
          {tr("平台手续费：{0} USD / 次", {
            "0": textValue(selectedModel.requestFee),
          })}
        </p>
      )}
      <div className="playground-grid">
        <section className="chat-panel">
          <div
            className="chat-messages"
            ref={transcript}
            role="log"
            aria-label={tr("对话记录")}
            onScroll={() => {
              const e = transcript.current!;
              follow.current =
                e.scrollHeight - e.scrollTop - e.clientHeight < 100;
              setAway(!follow.current);
            }}
          >
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
                    {m.createdAt && (
                      <time dateTime={new Date(m.createdAt).toISOString()}>
                        {new Date(m.createdAt).toLocaleTimeString([], {
                          hour: "2-digit",
                          minute: "2-digit",
                        })}
                      </time>
                    )}
                    <Answer
                      message={m}
                      streaming={busy && i === messages.length - 1}
                    />
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
          {away && (
            <button
              type="button"
              className="secondary chat-latest"
              onClick={() => {
                follow.current = true;
                setAway(false);
                transcript.current?.scrollTo({
                  top: transcript.current.scrollHeight,
                  behavior: "smooth",
                });
              }}
            >
              {tr("回到最新")}
            </button>
          )}
          <form className="chat-composer" onSubmit={send}>
            <textarea
              aria-label={tr("消息内容")}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={tr("输入消息…")}
              maxLength={64000}
              onKeyDown={(event) => {
                if (
                  event.key === "Enter" &&
                  !event.shiftKey &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault();
                  event.currentTarget.form?.requestSubmit();
                }
              }}
            />
            <div className="chat-composer-bottom">
              <kbd aria-hidden="true">Enter ↵ · Shift + Enter</kbd>
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
              {tr("思考强度")}
              <Select
                value={efforts.includes(effort as any) ? effort : ""}
                disabled={busy}
                onChange={(e) => setEffort(e.target.value)}
              >
                <option value="">{tr("模型默认")}</option>
                {efforts.map((value) => (
                  <option value={value} key={value}>
                    {tr(
                      value === "none"
                        ? "关闭"
                        : value === "minimal"
                          ? "最低"
                          : value === "low"
                            ? "低"
                            : value === "medium"
                              ? "中"
                              : value === "high"
                                ? "高"
                                : value === "xhigh"
                                  ? "很高"
                                  : "最高",
                    )}
                  </option>
                ))}
              </Select>
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
                placeholder={tr("模型默认")}
              />
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
function Page({ host }: { host: UIHost }) {
  const [mode, setMode] = React.useState(
    () =>
      new URLSearchParams(location.hash.split("?")[1]).get("mode") ?? "chat",
  );
  const [busy, setBusy] = React.useState(false);
  return (
    <div className="playground-page">
      <link rel="stylesheet" href="/extensions/official.playground/ui.css" />
      <PageHeading title={tr("模型试用")} />
      <div className="tabs" role="tablist" aria-label={tr("试用类型")}>
        {[
          ["chat", "对话"],
          ["image", "图片"],
          ["video", "视频"],
        ].map(([id, label]) => (
          <button
            key={id}
            role="tab"
            aria-selected={mode === id}
            className={mode === id ? "active" : ""}
            disabled={busy}
            onClick={() => {
              if (mode === id) return;
              const params = new URLSearchParams(location.hash.split("?")[1]);
              params.delete("model");
              params.set("mode", id!);
              history.replaceState(history.state, "", "#/playground?" + params);
              setMode(id!);
            }}
          >
            {tr(label!)}
          </button>
        ))}
      </div>
      {mode === "image" || mode === "video" ? (
        <MediaPage key={mode} host={host} kind={mode} onBusy={setBusy} />
      ) : (
        <ChatPage host={host} onBusy={setBusy} />
      )}
    </div>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
