import { randomUUID } from "node:crypto";
import { join } from "node:path";
import {
  definePlugin,
  HostError,
  json,
  readObject,
  requiredString,
  type RequestContext,
} from "@pluhub/sdk";
import { openDatabase, transaction } from "../../lib/storage/sqlite.js";
import { adminTarget, pageQuery } from "../../lib/admin/access.js";
import { requireAdminSession } from "../../lib/admin/session.js";
const categories = ["general", "api", "billing", "account"];
const statuses = ["open", "waiting_user", "closed"];
function fields(body: Record<string, any>, allowed: string[]) {
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    throw new HostError("invalid_request", "存在不支持的工单字段");
}
function text(value: unknown, field: string, max: number) {
  return requiredString(
    typeof value === "string" ? value.trim() : value,
    field,
    max,
  );
}
function revision(value: unknown) {
  if (!Number.isSafeInteger(value) || Number(value) < 1)
    throw new HostError("invalid_request", "缺少有效的工单版本");
  return Number(value);
}
export default definePlugin({
  setup(host) {
    const db = openDatabase(join(host.dataDir, "tickets.sqlite"), [
      `CREATE TABLE tickets(id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, owner_name TEXT NOT NULL, subject TEXT NOT NULL, category TEXT NOT NULL, priority TEXT NOT NULL, status TEXT NOT NULL, revision INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, client_id TEXT NOT NULL, UNIQUE(owner_id,client_id));
       CREATE INDEX tickets_owner ON tickets(owner_id,updated_at);
       CREATE INDEX tickets_status ON tickets(status,updated_at);
       CREATE TABLE messages(id INTEGER PRIMARY KEY AUTOINCREMENT, ticket_id TEXT NOT NULL, author_id TEXT NOT NULL, author_name TEXT NOT NULL, author_role TEXT NOT NULL, kind TEXT NOT NULL, body TEXT NOT NULL, created_at INTEGER NOT NULL, client_id TEXT NOT NULL, UNIQUE(ticket_id,author_id,client_id));
       CREATE INDEX ticket_messages ON messages(ticket_id,id);
       CREATE INDEX author_messages ON messages(author_id,created_at);`,
    ]);
    host.cleanup(() => db.close());
    const session = (ctx: RequestContext) => {
      if (!ctx.principal?.session)
        throw new HostError("session_required", "请登录后使用工单", 403);
      return ctx.principal.id;
    };
    const actor = async (ctx: RequestContext) => {
      const user = await host.call<any>(
        "users.lookup@1",
        { id: session(ctx) },
        ctx.signal,
      );
      if (!user?.enabled)
        throw new HostError("unauthorized", "账号不可用", 401);
      return user;
    };
    const ownerTicket = (id: string, owner?: string) => {
      const row = db
        .prepare(
          "SELECT * FROM tickets WHERE id=?" + (owner ? " AND owner_id=?" : ""),
        )
        .get(...(owner ? [id, owner] : [id])) as any;
      if (!row) throw new HostError("not_found", "工单不存在", 404);
      return row;
    };
    const ensureVersion = (ticket: any, value: unknown) => {
      if (ticket.revision !== revision(value))
        throw new HostError("ticket_conflict", "工单已更新，请刷新后重试", 409);
    };
    const openQuota = (userId: string) => {
      const count = (
        db
          .prepare(
            "SELECT count(*) n FROM tickets WHERE owner_id=? AND status!='closed'",
          )
          .get(userId) as any
      ).n;
      if (count >= Number(host.config().maxOpenPerUser ?? 10))
        throw new HostError(
          "ticket_limit",
          "未关闭的工单已达上限，请先处理现有工单",
          429,
        );
    };
    const messageQuota = (userId: string) => {
      const count = (
        db
          .prepare(
            "SELECT count(*) n FROM messages WHERE author_id=? AND created_at>?",
          )
          .get(userId, Date.now() - 3600000) as any
      ).n;
      if (count >= Number(host.config().hourlyMessageLimit ?? 120))
        throw new HostError("reply_limit", "工单操作过于频繁，请稍后重试", 429);
    };
    const message = (
      ticketId: string,
      user: any,
      role: string,
      kind: string,
      body: string,
      clientId: string,
    ) =>
      db
        .prepare(
          "INSERT INTO messages(ticket_id,author_id,author_name,author_role,kind,body,created_at,client_id) VALUES(?,?,?,?,?,?,?,?)",
        )
        .run(
          ticketId,
          user.id,
          user.username,
          role,
          kind,
          body,
          Date.now(),
          clientId,
        );
    const view = (ticket: any) => ({
      id: ticket.id,
      ownerId: ticket.owner_id,
      ownerName: ticket.owner_name,
      subject: ticket.subject,
      category: ticket.category,
      priority: ticket.priority,
      status: ticket.status,
      revision: ticket.revision,
      createdAt: ticket.created_at,
      updatedAt: ticket.updated_at,
    });
    const detail = (ticket: any, before = Number.MAX_SAFE_INTEGER) => {
      const rows = db
        .prepare(
          "SELECT * FROM messages WHERE ticket_id=? AND id<? ORDER BY id DESC LIMIT 51",
        )
        .all(ticket.id, before) as any[];
      const messages = rows
        .slice(0, 50)
        .reverse()
        .map((r) => ({
          id: r.id,
          authorName: r.author_name,
          authorRole: r.author_role,
          kind: r.kind,
          body: r.body,
          createdAt: r.created_at,
        }));
      return {
        ticket: view(ticket),
        messages,
        hasMore: rows.length > 50,
        nextBefore: messages[0]?.id,
      };
    };
    for (const admin of [false, true]) {
      const prefix = admin ? "/admin" : "";
      const authorize = async (_request: Request, ctx: RequestContext) => {
        session(ctx);
        if (admin) requireAdminSession(ctx);
        return admin ? undefined : ctx.principal!.id;
      };
      host.api({
        method: "GET",
        path: prefix + "/tickets",
        access: "authenticated",
        handle: async (request, ctx) => {
          const owner = await authorize(request, ctx),
            { query, limit, offset, q } = pageQuery(request);
          const status = query.get("status") ?? "all",
            category = query.get("category") ?? "all";
          if (
            (status !== "all" && !statuses.includes(status)) ||
            (category !== "all" && !categories.includes(category))
          )
            throw new HostError("invalid_request", "工单筛选条件无效");
          const where = ["1=1"],
            params: (string | number)[] = [];
          if (owner) {
            where.push("owner_id=?");
            params.push(owner);
          }
          if (status !== "all") {
            where.push("status=?");
            params.push(status);
          }
          if (category !== "all") {
            where.push("category=?");
            params.push(category);
          }
          if (q) {
            where.push(
              "(instr(lower(subject),lower(?))>0 OR instr(lower(owner_name),lower(?))>0 OR id=?)",
            );
            params.push(q, q, q);
          }
          const clause = where.join(" AND ");
          const total = (
            db
              .prepare("SELECT count(*) n FROM tickets WHERE " + clause)
              .get(...params) as any
          ).n;
          const items = db
            .prepare(
              "SELECT * FROM tickets WHERE " +
                clause +
                " ORDER BY updated_at DESC,id DESC LIMIT ? OFFSET ?",
            )
            .all(...params, limit, offset)
            .map(view);
          return json({ items, total, limit, offset });
        },
      });
      host.api({
        method: "GET",
        path: prefix + "/ticket",
        access: "authenticated",
        handle: async (request, ctx) => {
          const owner = await authorize(request, ctx),
            query = new URL(request.url).searchParams;
          const before = Number(query.get("before") ?? Number.MAX_SAFE_INTEGER);
          if (!Number.isSafeInteger(before) || before < 1)
            throw new HostError("invalid_request", "消息分页参数无效");
          return json(
            detail(
              ownerTicket(text(query.get("id"), "id", 128), owner),
              before,
            ),
          );
        },
      });
      host.api({
        method: "POST",
        path: prefix + "/reply",
        access: "authenticated",
        handle: async (request, ctx) => {
          const owner = await authorize(request, ctx),
            body = await readObject(request);
          fields(body, ["id", "message", "revision", "clientId"]);
          const id = text(body.id, "id", 128),
            content = text(body.message, "message", 8000),
            clientId = text(body.clientId, "clientId", 128),
            user = await actor(ctx);
          const result = transaction(db, () => {
            const ticket = ownerTicket(id, owner);
            if (
              db
                .prepare(
                  "SELECT id FROM messages WHERE ticket_id=? AND author_id=? AND client_id=?",
                )
                .get(id, user.id, clientId)
            )
              return detail(ticket);
            ensureVersion(ticket, body.revision);
            if (ticket.status === "closed")
              throw new HostError(
                "ticket_closed",
                "工单已关闭，请先重新打开",
                409,
              );
            messageQuota(user.id);
            message(
              id,
              user,
              admin ? "admin" : "user",
              "reply",
              content,
              clientId,
            );
            db.prepare(
              "UPDATE tickets SET status=?,revision=revision+1,updated_at=? WHERE id=?",
            ).run(admin ? "waiting_user" : "open", Date.now(), id);
            return detail(ownerTicket(id, owner));
          });
          if (admin) adminTarget(ctx, result.ticket.ownerId, id, "工单回复");
          return json(result);
        },
      });
      host.api({
        method: "POST",
        path: prefix + "/status",
        access: "authenticated",
        handle: async (request, ctx) => {
          const owner = await authorize(request, ctx),
            body = await readObject(request);
          fields(body, ["id", "status", "revision"]);
          const id = text(body.id, "id", 128),
            user = await actor(ctx);
          if (!(admin ? statuses : ["open", "closed"]).includes(body.status))
            throw new HostError("invalid_request", "工单状态无效");
          const result = transaction(db, () => {
            const ticket = ownerTicket(id, owner);
            ensureVersion(ticket, body.revision);
            if (ticket.status === body.status) return detail(ticket);
            if (!admin && body.status === "open" && ticket.status === "closed")
              openQuota(user.id);
            messageQuota(user.id);
            db.prepare(
              "UPDATE tickets SET status=?,revision=revision+1,updated_at=? WHERE id=?",
            ).run(body.status, Date.now(), id);
            message(
              id,
              user,
              admin ? "admin" : "user",
              "status",
              body.status,
              randomUUID(),
            );
            return detail(ownerTicket(id, owner));
          });
          if (admin)
            adminTarget(
              ctx,
              result.ticket.ownerId,
              id,
              "工单状态：" + body.status,
            );
          return json(result);
        },
      });
    }
    host.api({
      method: "POST",
      path: "/tickets",
      access: "authenticated",
      handle: async (request, ctx) => {
        const user = await actor(ctx),
          body = await readObject(request);
        fields(body, [
          "subject",
          "category",
          "priority",
          "message",
          "clientId",
        ]);
        const subject = text(body.subject, "subject", 160),
          content = text(body.message, "message", 8000),
          clientId = text(body.clientId, "clientId", 128);
        const category = body.category ?? "general",
          priority = body.priority ?? "normal";
        if (
          !categories.includes(category) ||
          !["normal", "urgent"].includes(priority)
        )
          throw new HostError("invalid_request", "工单分类或优先级无效");
        let created = false;
        const result = transaction(db, () => {
          const existing = db
            .prepare("SELECT * FROM tickets WHERE owner_id=? AND client_id=?")
            .get(user.id, clientId);
          if (existing) return detail(existing);
          openQuota(user.id);
          const count = (
            db
              .prepare(
                "SELECT count(*) n FROM tickets WHERE owner_id=? AND created_at>?",
              )
              .get(user.id, Date.now() - 86400000) as any
          ).n;
          if (count >= Number(host.config().dailyCreateLimit ?? 20))
            throw new HostError(
              "ticket_limit",
              "今日新建工单已达上限，请稍后重试",
              429,
            );
          messageQuota(user.id);
          const id = randomUUID(),
            now = Date.now();
          db.prepare("INSERT INTO tickets VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(
            id,
            user.id,
            user.username,
            subject,
            category,
            priority,
            "open",
            1,
            now,
            now,
            clientId,
          );
          message(id, user, "user", "reply", content, clientId);
          created = true;
          return detail(ownerTicket(id, user.id));
        });
        return json(result, created ? 201 : 200);
      },
    });
  },
});
