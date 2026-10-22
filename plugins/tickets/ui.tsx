import { t as tr, getLocale } from "../../lib/ui/i18n.js";
import React from "react";
import type { UIHost } from "@pluhub/ui-sdk";
import { mountPage, useLoad, Notice } from "../../lib/ui/mount.js";
import {
  PageHeading,
  Icon,
  Empty,
  Dialog,
  ListPagination,
} from "../../lib/ui/components.js";
import { Select } from "../../lib/ui/select.js";
const api = "/api/plugins/official.tickets";
const categories: Record<string, string> = {
  get general() {
    return tr("一般咨询");
  },
  get api() {
    return tr("接口与渠道");
  },
  get billing() {
    return tr("计费与支付");
  },
  get account() {
    return tr("账号与安全");
  },
};
const statuses: Record<string, string> = {
  get open() {
    return tr("待处理");
  },
  get waiting_user() {
    return tr("待用户回复");
  },
  get closed() {
    return tr("已关闭");
  },
};
const date = (n: number) =>
  new Date(n).toLocaleString(getLocale(), { hour12: false });
const badge = (status: string) => (
  <span
    className={
      "badge " +
      (status === "closed"
        ? "muted"
        : status === "waiting_user"
          ? "ready"
          : "pending")
    }
  >
    {statuses[status]}
  </span>
);
function Page({ host }: { host: UIHost }) {
  const admin = host.page === "/settings/tickets";
  const prefix = api + (admin ? "/admin" : "");
  const [status, setStatus] = React.useState("all"),
    [category, setCategory] = React.useState("all");
  const [query, setQuery] = React.useState(""),
    [search, setSearch] = React.useState("");
  const [offset, setOffset] = React.useState(0),
    [limit, setLimit] = React.useState(20);
  const [selected, setSelected] = React.useState<string>();
  const [create, setCreate] = React.useState(false);
  const [subject, setSubject] = React.useState(""),
    [newCategory, setNewCategory] = React.useState("general"),
    [priority, setPriority] = React.useState("normal"),
    [description, setDescription] = React.useState("");
  const [reply, setReply] = React.useState("");
  const [detail, setDetail] = React.useState<any>();
  const [message, setMessage] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [version, setVersion] = React.useState(0);
  const createId = React.useRef(crypto.randomUUID()),
    replyId = React.useRef(crypto.randomUUID());
  const data = useLoad<any>(
    () =>
      host.request(
        prefix +
          "/tickets?" +
          new URLSearchParams({
            status,
            category,
            q: search,
            limit: String(limit),
            offset: String(offset),
          }),
      ),
    [prefix, status, category, search, limit, offset, version],
  );
  React.useEffect(() => {
    if (!selected) {
      setDetail(undefined);
      return;
    }
    let live = true;
    setDetail(undefined);
    setMessage("");
    setReply("");
    replyId.current = crypto.randomUUID();
    host.request(prefix + "/ticket?id=" + encodeURIComponent(selected)).then(
      (value) => {
        if (live) setDetail(value);
      },
      (error) => {
        if (live) setMessage(error.message);
      },
    );
    return () => {
      live = false;
    };
  }, [selected, prefix]);
  async function reload() {
    setVersion((v) => v + 1);
    if (selected)
      setDetail(
        await host.request(
          prefix + "/ticket?id=" + encodeURIComponent(selected),
        ),
      );
  }
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setMessage("");
    try {
      await work();
    } catch (error) {
      setMessage((error as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    await run(async () => {
      const next = await host.request(api + "/tickets", {
        method: "POST",
        body: JSON.stringify({
          subject,
          category: newCategory,
          priority,
          message: description,
          clientId: createId.current,
        }),
      });
      createId.current = crypto.randomUUID();
      setCreate(false);
      setSubject("");
      setDescription("");
      setSelected(next.ticket.id);
      setVersion((v) => v + 1);
    });
  }
  const ticket = detail?.ticket;
  return (
    <section className="tickets-page">
      <style>{`.ticket-list-title{display:grid;gap:6px}.ticket-list-title small{color:var(--muted)}.ticket-thread{display:grid;gap:14px;margin:20px 0}.ticket-message{padding:14px 16px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.ticket-message.staff{border-left:3px solid var(--accent);background:var(--accent-soft)}.ticket-message header{display:flex;gap:8px;align-items:center;color:var(--muted);font-size:11px}.ticket-message header strong{color:var(--text)}.ticket-message time{margin-left:auto}.ticket-message p{white-space:pre-wrap;overflow-wrap:anywhere;margin:12px 0 0;font-size:13px}.ticket-event{text-align:center;color:var(--muted);font-size:11px;padding:5px}.ticket-meta{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--muted)}.ticket-reply{padding:18px;border:1px solid var(--border);border-radius:8px;background:var(--surface)}.ticket-reply textarea{min-height:120px;margin:10px 0}.ticket-reply .actions{justify-content:space-between}.ticket-new-form{display:grid;gap:16px}.ticket-new-form textarea{min-height:160px}.tickets-page .ticket-new-form .form-grid{margin:0}.ticket-back{margin-bottom:14px}.tickets-page table{margin-top:16px}.ticket-state{display:flex;align-items:center;gap:8px}.tickets-page .notice:empty{display:none}.ticket-detail-heading{overflow-wrap:anywhere}@media(max-width:600px){.ticket-message header{flex-wrap:wrap}.ticket-message time{margin-left:0;width:100%}.ticket-reply{padding:14px}}`}</style>
      {selected ? (
        <>
          <button
            className="ghost ticket-back"
            onClick={() => {
              setSelected(undefined);
              setMessage("");
            }}
          >
            <Icon name="back" size={15} />
            {tr("返回工单列表")}
          </button>
          {ticket ? (
            <>
              <div className="ticket-detail-heading">
                <PageHeading
                  title={ticket.subject}
                  description={
                    (admin ? ticket.ownerName + " · " : "") +
                    tr("创建于 ") +
                    date(ticket.createdAt)
                  }
                >
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() => void run(reload)}
                  >
                    <Icon name="refresh" size={15} />
                    {tr("刷新")}
                  </button>
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        setDetail(
                          await host.request(prefix + "/status", {
                            method: "POST",
                            body: JSON.stringify({
                              id: ticket.id,
                              revision: ticket.revision,
                              status:
                                ticket.status === "closed" ? "open" : "closed",
                            }),
                          }),
                        );
                        setVersion((v) => v + 1);
                      })
                    }
                  >
                    {ticket.status === "closed"
                      ? tr("重新打开")
                      : tr("关闭工单")}
                  </button>
                </PageHeading>
              </div>
              <div className="ticket-meta">
                {badge(ticket.status)}
                <span>{categories[ticket.category]}</span>
                <span>
                  {ticket.priority === "urgent"
                    ? tr("高优先级")
                    : tr("普通优先级")}
                </span>
                <span>#{ticket.id.slice(0, 8)}</span>
              </div>
              <Notice message={message} />
              <div className="ticket-thread" aria-label={tr("工单对话")}>
                {detail.hasMore && (
                  <button
                    className="secondary"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        const earlier = await host.request(
                          prefix +
                            "/ticket?id=" +
                            encodeURIComponent(ticket.id) +
                            "&before=" +
                            detail.nextBefore,
                        );
                        setDetail({
                          ...detail,
                          messages: [...earlier.messages, ...detail.messages],
                          hasMore: earlier.hasMore,
                          nextBefore: earlier.nextBefore,
                        });
                      })
                    }
                  >
                    {tr("加载更早的消息")}
                  </button>
                )}
                {detail.messages.map((m: any) =>
                  m.kind === "status" ? (
                    <div className="ticket-event" key={m.id}>
                      {m.authorRole === "admin" ? tr("客服") : m.authorName}
                      {tr("将状态改为「")}
                      {statuses[m.body] ?? m.body}」 · {date(m.createdAt)}
                    </div>
                  ) : (
                    <article
                      key={m.id}
                      className={
                        "ticket-message " +
                        (m.authorRole === "admin" ? "staff" : "")
                      }
                    >
                      <header>
                        <strong>{m.authorName}</strong>
                        <span>
                          {m.authorRole === "admin" ? tr("客服") : tr("用户")}
                        </span>
                        <time dateTime={new Date(m.createdAt).toISOString()}>
                          {date(m.createdAt)}
                        </time>
                      </header>
                      <p>{m.body}</p>
                    </article>
                  ),
                )}
              </div>
              {ticket.status === "closed" ? (
                <div className="notice" role="status">
                  {tr("此工单已关闭。如需继续沟通，请重新打开。")}
                </div>
              ) : (
                <form
                  className="ticket-reply"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void run(async () => {
                      const next = await host.request(prefix + "/reply", {
                        method: "POST",
                        body: JSON.stringify({
                          id: ticket.id,
                          revision: ticket.revision,
                          message: reply,
                          clientId: replyId.current,
                        }),
                      });
                      setDetail(next);
                      setReply("");
                      replyId.current = crypto.randomUUID();
                      setVersion((v) => v + 1);
                    });
                  }}
                >
                  <label>
                    {tr("回复内容")}
                    <textarea
                      value={reply}
                      onChange={(e) => setReply(e.target.value)}
                      required
                      maxLength={8000}
                      placeholder={
                        admin
                          ? tr("填写处理结果或需要用户补充的信息")
                          : tr("补充问题信息或回复客服")
                      }
                    />
                  </label>
                  <div className="actions">
                    <small className="muted">{reply.length} / 8000</small>
                    <button disabled={busy || !reply.trim()}>
                      {busy ? tr("正在发送…") : tr("发送回复")}
                      <Icon name="arrow" size={15} />
                    </button>
                  </div>
                </form>
              )}
            </>
          ) : (
            <>
              <Notice message={message} />
              {message ? (
                <button className="secondary" onClick={() => void run(reload)}>
                  {tr("重试")}
                </button>
              ) : (
                <p className="muted" role="status">
                  {tr("正在加载工单…")}
                </p>
              )}
            </>
          )}
        </>
      ) : (
        <>
          <PageHeading title={admin ? tr("工单管理") : tr("我的工单")}>
            <button
              className="secondary"
              onClick={() => {
                data.reload();
                setMessage("");
              }}
            >
              <Icon name="refresh" size={15} />
              {tr("刷新")}
            </button>
            {!admin && (
              <button
                onClick={() => {
                  setCreate(true);
                  setMessage("");
                }}
              >
                <Icon name="plus" size={15} />
                {tr("新建工单")}
              </button>
            )}
          </PageHeading>
          <form
            className="toolbar"
            onSubmit={(event) => {
              event.preventDefault();
              setSearch(query);
              setOffset(0);
            }}
          >
            <input
              aria-label={tr("搜索工单")}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={
                admin
                  ? tr("搜索标题、用户名或工单编号")
                  : tr("搜索工单标题或编号")
              }
            />
            <Select
              aria-label={tr("工单状态")}
              value={status}
              onChange={(e) => {
                setStatus(e.target.value);
                setOffset(0);
              }}
            >
              <option value="all">{tr("全部状态")}</option>
              {Object.entries(statuses).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <Select
              aria-label={tr("工单分类")}
              value={category}
              onChange={(e) => {
                setCategory(e.target.value);
                setOffset(0);
              }}
            >
              <option value="all">{tr("全部分类")}</option>
              {Object.entries(categories).map(([key, label]) => (
                <option key={key} value={key}>
                  {label}
                </option>
              ))}
            </Select>
            <button type="submit" className="secondary">
              {tr("搜索")}
            </button>
          </form>
          <Notice message={message || data.error} />
          {!data.data && !data.error ? (
            <p role="status" className="muted">
              {tr("正在加载工单…")}
            </p>
          ) : data.data?.total ? (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>{tr("工单")}</th>
                      {admin && <th>{tr("用户")}</th>}
                      <th>{tr("分类 / 优先级")}</th>
                      <th>{tr("状态")}</th>
                      <th>{tr("更新时间")}</th>
                      <th>{tr("操作")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.data.items.map((t: any) => (
                      <tr key={t.id}>
                        <td>
                          <div className="ticket-list-title">
                            <a
                              className="text-link"
                              href="#"
                              onClick={(e) => {
                                e.preventDefault();
                                setSelected(t.id);
                              }}
                            >
                              {t.subject}
                            </a>
                            <small>#{t.id.slice(0, 8)}</small>
                          </div>
                        </td>
                        {admin && <td>{t.ownerName}</td>}
                        <td>
                          {categories[t.category]}
                          {t.priority === "urgent" && (
                            <span className="badge pending">
                              {tr("高优先级")}
                            </span>
                          )}
                        </td>
                        <td>{badge(t.status)}</td>
                        <td>{date(t.updatedAt)}</td>
                        <td>
                          <button
                            className="secondary"
                            onClick={() => setSelected(t.id)}
                          >
                            {tr("查看")}
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ListPagination
                total={data.data.total}
                page={Math.floor(offset / limit) + 1}
                size={limit}
                setPage={(n) => setOffset((n - 1) * limit)}
                setSize={(n) => {
                  setLimit(n);
                  setOffset(0);
                }}
              />
            </>
          ) : (
            data.data && (
              <Empty
                title={
                  status !== "all" || category !== "all" || search
                    ? tr("没有符合条件的工单")
                    : tr("还没有工单")
                }
              />
            )
          )}
        </>
      )}
      {create && (
        <Dialog
          title={tr("新建工单")}
          close={() => {
            if (!busy) setCreate(false);
          }}
        >
          <form className="ticket-new-form" onSubmit={(e) => void submit(e)}>
            <label>
              {tr("标题")}
              <input
                required
                maxLength={160}
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
                placeholder={tr("简要说明遇到的问题")}
              />
            </label>
            <div className="form-grid">
              <label>
                {tr("分类")}
                <Select
                  value={newCategory}
                  onChange={(e) => setNewCategory(e.target.value)}
                >
                  {Object.entries(categories).map(([key, label]) => (
                    <option key={key} value={key}>
                      {label}
                    </option>
                  ))}
                </Select>
              </label>
              <label>
                {tr("优先级")}
                <Select
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                >
                  <option value="normal">{tr("普通")}</option>
                  <option value="urgent">{tr("高优先级")}</option>
                </Select>
              </label>
            </div>
            <label>
              {tr("问题描述")}
              <textarea
                required
                maxLength={8000}
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder={tr(
                  "描述问题、复现步骤和错误信息，便于我们协助处理",
                )}
              />
            </label>
            <Notice message={message} />
            <div className="actions">
              <button
                className="secondary"
                type="button"
                disabled={busy}
                onClick={() => setCreate(false)}
              >
                {tr("取消")}
              </button>
              <button disabled={busy || !subject.trim() || !description.trim()}>
                {busy ? tr("正在提交…") : tr("提交工单")}
              </button>
            </div>
          </form>
        </Dialog>
      )}
    </section>
  );
}
export const mount = (element: HTMLElement, host: UIHost) =>
  mountPage(element, host, Page);
