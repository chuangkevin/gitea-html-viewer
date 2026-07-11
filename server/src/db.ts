import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const DATA_DIR = process.env.DATA_DIR || path.resolve(process.cwd(), "../data");
fs.mkdirSync(DATA_DIR, { recursive: true });

export const db = new Database(path.join(DATA_DIR, "note-bridge.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  sid          TEXT PRIMARY KEY,
  login        TEXT NOT NULL,
  avatar_url   TEXT,
  token_enc    TEXT NOT NULL,
  created_at   INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS shares (
  token        TEXT PRIMARY KEY,
  owner_sid    TEXT NOT NULL,
  owner_login  TEXT NOT NULL,
  repo         TEXT NOT NULL,
  path         TEXT NOT NULL,
  title        TEXT,
  created_at   INTEGER NOT NULL,
  revoked      INTEGER NOT NULL DEFAULT 0
);
`);

// ── token 加密（at rest）────────────────────────────────
// SECRET 未設定時自動產生並存檔，重啟後 session 仍可解。
const secretFile = path.join(DATA_DIR, ".secret");
function loadSecret(): Buffer {
  if (process.env.SECRET) return crypto.createHash("sha256").update(process.env.SECRET).digest();
  if (!fs.existsSync(secretFile)) {
    fs.writeFileSync(secretFile, crypto.randomBytes(32), { mode: 0o600 });
  }
  return crypto.createHash("sha256").update(fs.readFileSync(secretFile)).digest();
}
const KEY = loadSecret();

export function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", KEY, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString("base64");
}

export function decrypt(blob: string): string {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const enc = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]).toString("utf8");
}

// ── sessions ───────────────────────────────────────────
export interface Session {
  sid: string;
  login: string;
  avatar_url: string | null;
  token: string;
}

export function createSession(login: string, avatarUrl: string | null, accessToken: string): string {
  const sid = crypto.randomBytes(24).toString("hex");
  db.prepare(
    "INSERT INTO sessions (sid, login, avatar_url, token_enc, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(sid, login, avatarUrl, encrypt(accessToken), Date.now());
  return sid;
}

export function getSession(sid: string | undefined): Session | null {
  if (!sid) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE sid = ?").get(sid) as
    | { sid: string; login: string; avatar_url: string | null; token_enc: string }
    | undefined;
  if (!row) return null;
  try {
    return { sid: row.sid, login: row.login, avatar_url: row.avatar_url, token: decrypt(row.token_enc) };
  } catch {
    return null;
  }
}

export function deleteSession(sid: string): void {
  db.prepare("DELETE FROM sessions WHERE sid = ?").run(sid);
}

// ── shares ─────────────────────────────────────────────
export interface Share {
  token: string;
  owner_sid: string;
  owner_login: string;
  repo: string;
  path: string;
  title: string | null;
  revoked: number;
}

export function createShare(s: Session, repo: string, filePath: string, title: string | null): string {
  // 同一份文件重複分享時回收既有 token，避免連結氾濫
  const existing = db
    .prepare("SELECT token FROM shares WHERE owner_login = ? AND repo = ? AND path = ? AND revoked = 0")
    .get(s.login, repo, filePath) as { token: string } | undefined;
  if (existing) return existing.token;

  const token = crypto.randomBytes(8).toString("base64url");
  db.prepare(
    "INSERT INTO shares (token, owner_sid, owner_login, repo, path, title, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(token, s.sid, s.login, repo, filePath, title, Date.now());
  return token;
}

export function getShare(token: string): Share | null {
  const row = db.prepare("SELECT * FROM shares WHERE token = ? AND revoked = 0").get(token) as Share | undefined;
  return row ?? null;
}

export function listShares(login: string): Share[] {
  return db
    .prepare("SELECT * FROM shares WHERE owner_login = ? AND revoked = 0 ORDER BY created_at DESC")
    .all(login) as Share[];
}

export function revokeShare(login: string, token: string): boolean {
  const r = db.prepare("UPDATE shares SET revoked = 1 WHERE token = ? AND owner_login = ?").run(token, login);
  return r.changes > 0;
}
