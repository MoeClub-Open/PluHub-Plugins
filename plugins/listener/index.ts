import { createServer, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { Socket } from "node:net";
import { definePlugin } from "@pluhub/sdk";
import { clientAddress } from "./proxy.js";
export default definePlugin({
  async setup(host) {
    const config = host.config();
    const peerAddress = clientAddress(
      (config.trustedProxies ?? []) as string[],
    );
    const publicOrigin = config.publicOrigin
      ? new URL(String(config.publicOrigin)).origin
      : undefined;
    if (
      publicOrigin &&
      String(config.publicOrigin).replace(/\/$/, "") !== publicOrigin
    )
      throw new Error(
        "publicOrigin must be an HTTP(S) origin without path or credentials",
      );
    const sockets = new Set<Socket>();
    const server = createServer(async (req, res) => {
      if (
        req.method === "GET" &&
        ["/healthz", "/readyz"].includes(req.url ?? "")
      ) {
        let ready = req.url === "/healthz";
        try {
          ready ||=
            host.hasCapability("ai.routing@2") &&
            host.hasCapability("auth.admit@1");
        } catch {
          /* A missing dependency must fail readiness, not terminate the listener. */
        }
        res.writeHead(ready ? 200 : 503, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(JSON.stringify({ status: ready ? "ready" : "starting" }));
        return;
      }
      const controller = new AbortController();
      req.once("aborted", () => controller.abort());
      req.on("error", () => controller.abort());
      res.once("close", () => {
        if (!res.writableEnded) controller.abort();
      });
      try {
        const headers = new Headers();
        for (const [name, value] of Object.entries(req.headers))
          if (value !== undefined)
            headers.set(name, Array.isArray(value) ? value.join(", ") : value);
        headers.set(
          "x-pluhub-peer",
          peerAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
        );
        const init: RequestInit & { duplex?: string } = {
          method: req.method,
          headers,
          signal: controller.signal,
        };
        if (!["GET", "HEAD"].includes(req.method ?? "GET")) {
          init.body = Readable.toWeb(req) as ReadableStream<Uint8Array>;
          init.duplex = "half";
        }
        const response = await host.dispatch(
          new Request(
            (publicOrigin ?? "http://" + (req.headers.host ?? "localhost")) +
              (req.url ?? "/"),
            init,
          ),
        );
        if (controller.signal.aborted) {
          await response.body?.cancel().catch(() => {});
          return;
        }
        const outgoing: any = Object.fromEntries(response.headers);
        const cookies = response.headers.getSetCookie();
        if (cookies.length) outgoing["set-cookie"] = cookies;
        res.writeHead(response.status, outgoing);
        if (response.body) {
          const body = Readable.fromWeb(response.body as any);
          // A disconnect can precede pipeline's attachment of error handlers.
          // Pipeline still propagates stream failures to the surrounding catch.
          body.on("error", () => {});
          await pipeline(body, res, {
            signal: controller.signal,
          });
        } else res.end();
      } catch {
        if (!res.headersSent) res.writeHead(502);
        res.destroy();
      }
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    server.on("upgrade", async (req, socket, head) => {
      let release = () => {};
      try {
        const headers = new Headers();
        for (const [k, v] of Object.entries(req.headers))
          if (v) headers.set(k, Array.isArray(v) ? v.join(",") : v);
        headers.set(
          "x-pluhub-peer",
          peerAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"]),
        );
        const request = new Request(
          (publicOrigin ?? "http://" + (req.headers.host ?? "localhost")) +
            (req.url ?? "/"),
          { headers },
        );
        const plan = await host.acceptUpgrade(request);
        release = plan.release;
        const url = new URL(plan.url);
        url.protocol =
          url.protocol === "wss:"
            ? "https:"
            : url.protocol === "ws:"
              ? "http:"
              : url.protocol;
        const upstream = (
          url.protocol === "https:" ? httpsRequest : httpRequest
        )(url, {
          headers: { ...req.headers, ...plan.headers, host: url.host },
        });
        const abort = () => {
          upstream.destroy();
          socket.destroy();
          release();
        };
        plan.signal.addEventListener("abort", abort, { once: true });
        socket.once("close", () => {
          plan.signal.removeEventListener("abort", abort);
          upstream.destroy();
          release();
        });
        upstream.once("upgrade", (response, peer, upHead) => {
          const lines = ["HTTP/1.1 101 Switching Protocols"];
          for (let i = 0; i < response.rawHeaders.length; i += 2)
            lines.push(
              response.rawHeaders[i] + ": " + response.rawHeaders[i + 1],
            );
          socket.write(lines.join("\r\n") + "\r\n\r\n");
          if (upHead.length) socket.write(upHead);
          if (head.length) peer.write(head);
          socket.pipe(peer).pipe(socket);
          peer.on("error", () => socket.destroy());
          socket.on("error", () => peer.destroy());
          peer.once("close", () => socket.destroy());
          plan.signal.addEventListener("abort", () => peer.destroy(), {
            once: true,
          });
        });
        upstream.once("response", (response) => {
          socket.end(
            "HTTP/1.1 " +
              response.statusCode +
              " Upgrade rejected\r\nConnection: close\r\n\r\n",
          );
          response.resume();
          release();
        });
        upstream.once("error", () => {
          socket.destroy();
          release();
        });
        upstream.end();
      } catch {
        socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
        release();
      }
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(
        Number(config.port ?? 8080),
        String(config.host ?? "127.0.0.1"),
        () => {
          server.off("error", reject);
          resolve();
        },
      );
    });
    host.provide("listener.address@1", () => server.address());
    host.cleanup(
      () =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          for (const socket of sockets) socket.destroy();
          server.closeAllConnections();
        }),
    );
  },
});
