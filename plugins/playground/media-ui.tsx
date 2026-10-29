import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import type { CatalogModel } from "@pluhub/contracts/ai";
import { useLoad, Notice } from "../../lib/ui/mount.js";
import { Select } from "../../lib/ui/select.js";
import { Icon, latency } from "../../lib/ui/components.js";
import { t as tr } from "../../lib/ui/i18n.js";
import {
  ServiceGroupSelect,
  useServiceGroups,
} from "../../lib/ui/service-groups.js";
import { chatStorageKey } from "./session.js";
import {
  mediaResult,
  resultJson,
  downloadMedia,
  type MediaAsset,
} from "./media-client.js";

export function MediaPage({
  host,
  kind,
  onBusy,
}: {
  host: UIHost;
  kind: "image" | "video";
  onBusy: (value: boolean) => void;
}) {
  const params = new URLSearchParams(location.hash.split("?")[1]);
  const storageKey = chatStorageKey() + ":" + kind;
  const [saved] = React.useState(() => {
    try {
      return JSON.parse(sessionStorage.getItem(storageKey) ?? "{}");
    } catch {
      return {};
    }
  });
  const [group, setGroup] = React.useState(
    params.get("group") ??
      saved.group ??
      (params.get("channel")?.startsWith("personal:") ? "personal" : "default"),
  );
  const [channel, setChannel] = React.useState(
    params.get("channel") ?? saved.channel ?? "",
  );
  const [selection, setSelection] = React.useState(
    params.has("model")
      ? JSON.stringify([params.get("channel") ?? "", params.get("model")])
      : (saved.selection ?? ""),
  );
  const [prompt, setPrompt] = React.useState(saved.prompt ?? "");
  const [size, setSize] = React.useState(saved.size ?? "");
  const [quality, setQuality] = React.useState(saved.quality ?? "");
  const [format, setFormat] = React.useState(saved.format ?? "");
  const [seconds, setSeconds] = React.useState(saved.seconds ?? "");
  const [files, setFiles] = React.useState<File[]>([]);
  const [inputTab, setInputTab] = React.useState(saved.inputTab ?? "form");
  const [outputTab, setOutputTab] = React.useState("preview");
  const [json, setJson] = React.useState(saved.json ?? "");
  const [extra, setExtra] = React.useState<Record<string, unknown>>(
    saved.extra ?? {},
  );
  const references = React.useMemo(
    () => files.map((file) => URL.createObjectURL(file)),
    [files],
  );
  React.useEffect(
    () => () => references.forEach((url) => URL.revokeObjectURL(url)),
    [references],
  );
  const [assets, setAssets] = React.useState<MediaAsset[]>([]);
  const [raw, setRaw] = React.useState<unknown>();
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState("");
  const [meta, setMeta] = React.useState<{ id?: string; elapsed?: number }>();
  const controller = React.useRef<AbortController | null>(null);
  const groups = useServiceGroups(host);
  const channels = useLoad<any[]>(() =>
    host.request("/api/plugins/official.ai-router/channels"),
  );
  const operation = kind === "image" ? "images" : "videos/generations";
  const models = useLoad<CatalogModel[]>(
    () =>
      host.request(
        "/api/plugins/official.playground/models?" +
          new URLSearchParams({ channel, group, operation }),
      ),
    [channel, group, kind],
  );
  const selected = models.data?.find(
    (model) =>
      JSON.stringify([model.channel?.id ?? "", model.id]) === selection,
  );
  React.useEffect(() => {
    if (!models.data?.length) return;
    const requested = params.get("model");
    if (!selection || (requested && !selected)) {
      const match =
        models.data.find((m) => m.id === requested) ??
        (!requested ? models.data[0] : undefined);
      if (match)
        setSelection(JSON.stringify([match.channel?.id ?? "", match.id]));
    }
  }, [models.data]);
  React.useEffect(() => {
    try {
      sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          group,
          channel,
          selection,
          prompt,
          size,
          quality,
          format,
          seconds,
          inputTab,
          json,
          extra,
        }),
      );
    } catch {}
  }, [
    storageKey,
    group,
    channel,
    selection,
    prompt,
    size,
    quality,
    format,
    seconds,
    inputTab,
    json,
    extra,
  ]);
  React.useEffect(() => {
    onBusy(busy);
  }, [busy, onBusy]);
  React.useEffect(() => () => controller.current?.abort(), []);
  React.useEffect(
    () => () =>
      assets.forEach((asset) => {
        if (asset.url.startsWith("blob:")) URL.revokeObjectURL(asset.url);
      }),
    [assets],
  );
  const editing = kind === "image" && files.length > 0;
  const endpoint = editing
    ? "images/edits"
    : kind === "image"
      ? "images/generations"
      : "videos/generations";
  const body = {
    ...extra,
    model: selected?.id ?? "",
    prompt,
    ...(size ? { size } : {}),
    ...(kind === "image"
      ? {
          ...(quality ? { quality } : {}),
          ...(format ? { output_format: format } : {}),
        }
      : seconds
        ? { seconds }
        : {}),
  };
  const draft = () => (inputTab === "json" ? JSON.parse(json) : body);
  function changeInputTab(tab: string) {
    if (tab === inputTab) return;
    try {
      if (tab === "json") setJson(JSON.stringify(body, null, 2));
      else {
        const {
          model: _model,
          stream: _stream,
          prompt,
          size,
          quality,
          output_format,
          seconds,
          ...extra
        } = JSON.parse(json);
        setPrompt(String(prompt ?? ""));
        setSize(String(size ?? ""));
        setQuality(String(quality ?? ""));
        setFormat(String(output_format ?? ""));
        setSeconds(String(seconds ?? ""));
        setExtra(extra);
      }
      setInputTab(tab);
      setError("");
    } catch (error) {
      setError((error as Error).message);
    }
  }
  async function send(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || busy) return;
    setError("");
    let input;
    try {
      input = { ...draft(), model: selected.id, stream: false };
      if (typeof input.prompt !== "string" || !input.prompt.trim())
        throw new Error(tr("请输入提示词"));
      if (!(selected.operations ?? []).includes(endpoint as any))
        throw new Error(tr("所选模型不支持当前操作"));
    } catch (error) {
      setError((error as Error).message);
      return;
    }
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    setMeta(undefined);
    setAssets([]);
    setRaw(undefined);
    const started = performance.now();
    try {
      let requestBody: BodyInit = JSON.stringify(input);
      const headers = new Headers({
        ...(group !== "personal" ? { "x-pluhub-group": group } : {}),
        ...(selected.channel?.id
          ? { "x-pluhub-channel": selected.channel.id }
          : {}),
      });
      if (files.length) {
        const form = new FormData();
        for (const [name, value] of Object.entries(input))
          form.append(
            name,
            typeof value === "object" ? JSON.stringify(value) : String(value),
          );
        if (kind === "image")
          files.forEach((file) => form.append("image[]", file));
        else form.append("input_reference", files[0]!);
        requestBody = form;
      } else headers.set("content-type", "application/json");
      const response = await fetch("/v1/" + endpoint, {
        method: "POST",
        credentials: "same-origin",
        headers,
        body: requestBody,
        signal: abort.signal,
      });
      setMeta({ id: response.headers.get("x-pluhub-request-id") ?? undefined });
      if (response.status === 401) host.refresh();
      const result = await mediaResult(response, kind);
      setRaw(result.raw);
      setAssets(result.assets);
      setOutputTab("preview");
    } catch (error) {
      setError(
        abort.signal.aborted
          ? tr("已停止等待，上游任务可能仍在生成，可在调用记录中核对。")
          : (error as Error).message,
      );
    } finally {
      setMeta((value) => ({ ...value, elapsed: performance.now() - started }));
      setBusy(false);
      controller.current = null;
    }
  }
  return (
    <>
      <Notice
        message={error || groups.error || models.error || channels.error}
      />
      <div className="chat-toolbar">
        <ServiceGroupSelect
          value={group}
          groups={groups.data}
          disabled={busy}
          onChange={(value) => {
            setGroup(value);
            setChannel("");
            setSelection("");
          }}
        />
        <label>
          {tr("模型来源")}
          <Select
            value={channel}
            disabled={busy}
            onChange={(e) => {
              setChannel(e.target.value);
              setSelection("");
            }}
          >
            <option value="">{tr("全部渠道")}</option>
            {channels.data
              ?.filter((c) =>
                group === "personal"
                  ? c.scope === "personal"
                  : c.scope === "platform" &&
                    groups.data
                      ?.find((g) => g.id === group)
                      ?.channelIds.includes(c.id),
              )
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </Select>
        </label>
      </div>
      <form className="media-workspace" onSubmit={send}>
        <section className="media-input" aria-label={tr("生成请求")}>
          <div className="media-pane-toolbar">
            <div
              className="compact-tabs"
              role="tablist"
              aria-label={tr("请求编辑方式")}
            >
              {[
                ["form", "参数"],
                ["json", "请求 JSON"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={inputTab === id}
                  className={inputTab === id ? "active" : ""}
                  disabled={busy}
                  onClick={() => changeInputTab(id!)}
                >
                  {tr(label!)}
                </button>
              ))}
            </div>
          </div>
          <div className="media-fields">
            <label>
              {tr("模型")}
              <Select
                aria-label={tr("生成模型")}
                value={selected ? selection : ""}
                disabled={busy}
                onChange={(e) => setSelection(e.target.value)}
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
              {!!selected?.requestFee && (
                <small>{tr("平台手续费：{0} USD / 次", { "0": String(selected.requestFee) })}</small>
              )}
            </label>
            {models.data && !models.data.length && (
              <p className="field-note">
                {tr(
                  kind === "image"
                    ? "当前分组暂无图片模型"
                    : "当前分组暂无视频模型",
                )}
              </p>
            )}
            {inputTab === "json" ? (
              <label className="media-json-label">
                {tr("请求内容")}
                <textarea
                  className="media-json"
                  value={json}
                  onChange={(e) => setJson(e.target.value)}
                  disabled={busy}
                  spellCheck={false}
                />
              </label>
            ) : (
              <>
                <label>
                  {tr("提示词")}
                  <textarea
                    className="media-prompt"
                    rows={7}
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    disabled={busy}
                    placeholder={tr(
                      kind === "image"
                        ? "描述要生成的图片…"
                        : "描述画面、动作和镜头…",
                    )}
                  />
                </label>
                <div className="media-options">
                  <label>
                    {tr("尺寸")}
                    <input
                      value={size}
                      onChange={(e) => setSize(e.target.value)}
                      disabled={busy}
                      placeholder={tr("模型默认")}
                    />
                  </label>
                  {kind === "image" ? (
                    <>
                      <label>
                        {tr("画质")}
                        <Select
                          value={quality}
                          onChange={(e) => setQuality(e.target.value)}
                          disabled={busy}
                        >
                          {[
                            ["", "模型默认"],
                            ["low", "低"],
                            ["medium", "中"],
                            ["high", "高"],
                          ].map(([v, label]) => (
                            <option key={v} value={v}>
                              {tr(label!)}
                            </option>
                          ))}
                        </Select>
                      </label>
                      <label>
                        {tr("输出格式")}
                        <Select
                          value={format}
                          onChange={(e) => setFormat(e.target.value)}
                          disabled={busy}
                        >
                          {[
                            ["", "模型默认"],
                            ["png", "PNG"],
                            ["jpeg", "JPEG"],
                            ["webp", "WebP"],
                          ].map(([v, label]) => (
                            <option key={v} value={v}>
                              {tr(label!)}
                            </option>
                          ))}
                        </Select>
                      </label>
                    </>
                  ) : (
                    <label>
                      {tr("时长（秒）")}
                      <input
                        type="number"
                        min="1"
                        value={seconds}
                        onChange={(e) => setSeconds(e.target.value)}
                        disabled={busy}
                        placeholder={tr("模型默认")}
                      />
                    </label>
                  )}
                </div>
              </>
            )}
            <label>
              {tr(kind === "image" ? "参考图片（用于编辑）" : "参考图片")}
              <input
                type="file"
                accept="image/png,image/jpeg,image/webp"
                multiple={kind === "image"}
                disabled={busy}
                onChange={(e) => {
                  setFiles(Array.from(e.target.files ?? []));
                }}
              />
            </label>
            {!!files.length && (
              <div className="media-files">
                {files.map((file, i) => (
                  <span key={i}>
                    <img src={references[i]} alt="" />
                    {file.name}
                    <button
                      type="button"
                      className="ghost"
                      disabled={busy}
                      aria-label={tr("移除") + " " + file.name}
                      onClick={() => setFiles(files.filter((_, n) => n !== i))}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
          <div className="media-submit">
            {busy ? (
              <button
                type="button"
                className="secondary"
                onClick={() => controller.current?.abort()}
              >
                {tr("停止等待")}
              </button>
            ) : (
              <button type="submit" disabled={!selected}>
                <Icon name="arrow" size={15} />
                {tr("生成")}
              </button>
            )}
          </div>
        </section>
        <section className="media-output" aria-label={tr("生成结果")}>
          <div className="media-pane-toolbar">
            <div
              className="compact-tabs"
              role="tablist"
              aria-label={tr("结果展示方式")}
            >
              {[
                ["preview", "预览"],
                ["json", "响应 JSON"],
              ].map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  role="tab"
                  aria-selected={outputTab === id}
                  className={outputTab === id ? "active" : ""}
                  onClick={() => setOutputTab(id!)}
                >
                  {tr(label!)}
                </button>
              ))}
            </div>
            {meta?.elapsed !== undefined && (
              <span className="muted">{latency(meta.elapsed)}</span>
            )}
          </div>
          <div className="media-results" aria-live="polite" aria-busy={busy}>
            {busy ? (
              <p className="media-placeholder" role="status">
                {tr(kind === "image" ? "正在生成图片…" : "正在生成视频…")}
              </p>
            ) : outputTab === "json" && raw ? (
              <pre>{resultJson(raw)}</pre>
            ) : assets.length ? (
              <div className="media-gallery">
                {assets.map((asset, i) => (
                  <figure key={asset.url}>
                    {asset.kind === "image" ? (
                      <a
                        href={asset.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        <img
                          src={asset.url}
                          alt={tr("生成图片") + " " + (i + 1)}
                        />
                      </a>
                    ) : (
                      <video
                        controls
                        playsInline
                        preload="metadata"
                        src={asset.url}
                      />
                    )}
                    <figcaption>
                      <button
                        type="button"
                        className="ghost"
                        onClick={() =>
                          void downloadMedia(asset).catch((e) =>
                            setError(e.message),
                          )
                        }
                      >
                        {tr("下载")}
                      </button>
                      <a
                        href={asset.url}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {tr("打开")}
                      </a>
                    </figcaption>
                  </figure>
                ))}
              </div>
            ) : (
              <p className="media-placeholder">{tr("暂无生成结果")}</p>
            )}
          </div>
          {meta?.id && (
            <a
              className="media-request-link"
              href={"#/observability?requestId=" + encodeURIComponent(meta.id)}
            >
              {tr("查看调用记录")}
            </a>
          )}
        </section>
      </form>
    </>
  );
}
