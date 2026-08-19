import type { IncomingMessage, Server as HttpServer } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer } from "ws";
import { getYDoc, setupWSConnection } from "@y/websocket-server/utils";
import { applyTextDiff } from "./text-diff.js";

/** 連線者的 presence 身分。 */
export interface CollabUser {
  name: string;
  color: string;
}

export interface CollabAuthResult {
  ok: boolean;
  user?: CollabUser;
  /** 通過鑑權時才給：用這個人的權限去 git 讀這份文件的初始內容。 */
  readFile?: () => Promise<string | null>;
}

export interface CollabOptions {
  /** 整個共筆功能有沒有啟用（環境變數層級的總開關）。false 時連 upgrade listener 都不掛。 */
  featureEnabled(): boolean;
  /** docKey 是否在白名單內（不在就不接受連線）。 */
  enabled(docKey: string): boolean;
  /** 用 cookie 決定這個人能不能編這份文件。 */
  authorize(input: { cookies: Record<string, string>; docKey: string }): Promise<CollabAuthResult>;
}

const rooms = new Map<string, Promise<void>>();

/** Cookie header → 物件。沒有 header 回空物件。 */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    const raw = part.slice(eq + 1).trim();
    let value = raw;
    try {
      value = decodeURIComponent(raw);
    } catch {
      value = raw;
    }
    out[key] = value;
  }
  return out;
}

/** 目前記憶體裡有幾間房（測試與之後的監控用）。 */
export function roomCount(): number {
  return rooms.size;
}

function rejectUpgrade(socket: Duplex, status: number, reason: string): void {
  socket.write(`HTTP/1.1 ${status} ${reason}\r\n\r\n`);
  socket.destroy();
}

function ensureSeeded(docKey: string, readFile?: () => Promise<string | null>): Promise<void> {
  const existing = rooms.get(docKey);
  if (existing) return existing;
  const seeded = (async () => {
    const doc = getYDoc(docKey);
    try {
      const content = readFile ? await readFile() : null;
      if (content !== null && content !== undefined) {
        applyTextDiff(doc.getText("content"), content);
      }
    } catch (err) {
      console.error("[collab]", err);
    }
  })();
  rooms.set(docKey, seeded);
  return seeded;
}

/** 把 /collab 的 WebSocket upgrade 掛到既有的 http server 上。 */
export function attachCollab(server: HttpServer, opts: CollabOptions): void {
  if (!opts.featureEnabled()) return;
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    void (async () => {
      try {
        const rawUrl = req.url;
        if (!rawUrl) {
          socket.destroy();
          return;
        }
        const url = new URL(rawUrl, "http://localhost");
        if (url.pathname !== "/collab") {
          socket.destroy();
          return;
        }

        const docKey = url.searchParams.get("doc");
        if (!docKey) {
          rejectUpgrade(socket, 400, "Bad Request");
          return;
        }
        if (!opts.enabled(docKey)) {
          rejectUpgrade(socket, 403, "Forbidden");
          return;
        }
        const auth = await opts.authorize({
          cookies: parseCookies(req.headers.cookie),
          docKey,
        });
        if (!auth.ok) {
          rejectUpgrade(socket, 401, "Unauthorized");
          return;
        }
        await ensureSeeded(docKey, auth.readFile);
        wss.handleUpgrade(req, socket, head, (ws) => {
          setupWSConnection(ws, req, { docName: docKey });
        });
      } catch (err) {
        console.error("[collab]", err);
        try {
          socket.destroy();
        } catch {
          // already gone
        }
      }
    })();
  });
}
