import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { OAuthTokens } from "./providers.js";

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
CREATE TABLE IF NOT EXISTS repo_access (
  provider    TEXT NOT NULL,
  project     TEXT NOT NULL,
  mode        TEXT NOT NULL,
  updated_at  INTEGER NOT NULL,
  updated_by  TEXT,
  PRIMARY KEY (provider, project)
);
CREATE TABLE IF NOT EXISTS user_prefs (
  owner       TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  project     TEXT NOT NULL,
  file        TEXT,
  updated_at  INTEGER NOT NULL
);
`);

// 既有部署的漸進式 migration
const shareCols = (db.prepare("PRAGMA table_info(shares)").all() as { name: string }[]).map((c) => c.name);
if (!shareCols.includes("kind")) db.exec("ALTER TABLE shares ADD COLUMN kind TEXT NOT NULL DEFAULT 'doc'");
if (!shareCols.includes("paths")) db.exec("ALTER TABLE shares ADD COLUMN paths TEXT");
// 多 provider：舊資料一律視為 github
if (!shareCols.includes("provider")) db.exec("ALTER TABLE shares ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'");

const sessionCols = (db.prepare("PRAGMA table_info(sessions)").all() as { name: string }[]).map((c) => c.name);
if (!sessionCols.includes("provider")) db.exec("ALTER TABLE sessions ADD COLUMN provider TEXT NOT NULL DEFAULT 'github'");
if (!sessionCols.includes("refresh_enc")) db.exec("ALTER TABLE sessions ADD COLUMN refresh_enc TEXT");
if (!sessionCols.includes("expires_at")) db.exec("ALTER TABLE sessions ADD COLUMN expires_at INTEGER");

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
  provider: string;
  refreshToken: string | null;
  expiresAt: number | null;
}

export function createSession(
  login: string,
  avatarUrl: string | null,
  tokens: OAuthTokens,
  provider: string
): string {
  const sid = crypto.randomBytes(24).toString("hex");
  const refreshEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;
  const expiresAt = tokens.expiresAt ?? null;
  db.prepare(
    "INSERT INTO sessions (sid, login, avatar_url, token_enc, created_at, provider, refresh_enc, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(sid, login, avatarUrl, encrypt(tokens.accessToken), Date.now(), provider, refreshEnc, expiresAt);
  return sid;
}

export function getSession(sid: string | undefined): Session | null {
  if (!sid) return null;
  const row = db.prepare("SELECT * FROM sessions WHERE sid = ?").get(sid) as
    | {
        sid: string;
        login: string;
        avatar_url: string | null;
        token_enc: string;
        provider?: string;
        refresh_enc?: string | null;
        expires_at?: number | null;
      }
    | undefined;
  if (!row) return null;
  try {
    let refreshToken: string | null = null;
    if (row.refresh_enc) {
      try {
        refreshToken = decrypt(row.refresh_enc);
      } catch {
        refreshToken = null;
      }
    }
    return {
      sid: row.sid,
      login: row.login,
      avatar_url: row.avatar_url,
      token: decrypt(row.token_enc),
      provider: row.provider || "github",
      refreshToken,
      expiresAt: row.expires_at ?? null,
    };
  } catch {
    return null;
  }
}

export function updateSessionTokens(sid: string, tokens: OAuthTokens): void {
  const tokenEnc = encrypt(tokens.accessToken);
  const refreshEnc = tokens.refreshToken ? encrypt(tokens.refreshToken) : null;
  const expiresAt = tokens.expiresAt ?? null;
  db.prepare("UPDATE sessions SET token_enc = ?, refresh_enc = ?, expires_at = ? WHERE sid = ?").run(
    tokenEnc,
    refreshEnc,
    expiresAt,
    sid
  );
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
  kind: "doc" | "set";
  paths: string | null; // set 專用：JSON string[]，依資料夾排序
  provider: string;
}

/** 多檔展示集：勾選的檔案（已排序）打包成一個分享 token。 */
export function createShareSet(s: Session, repo: string, paths: string[], title: string | null): string {
  const token = crypto.randomBytes(8).toString("base64url");
  db.prepare(
    "INSERT INTO shares (token, owner_sid, owner_login, repo, path, title, created_at, kind, paths, provider) VALUES (?, ?, ?, ?, ?, ?, ?, 'set', ?, ?)"
  ).run(token, s.sid, s.login, repo, paths[0] ?? "", title, Date.now(), JSON.stringify(paths), s.provider);
  return token;
}

export function createShare(s: Session, repo: string, filePath: string, title: string | null): string {
  // 同一份文件重複分享時回收既有 token，避免連結氾濫
  const existing = db
    .prepare("SELECT token FROM shares WHERE owner_login = ? AND provider = ? AND repo = ? AND path = ? AND revoked = 0")
    .get(s.login, s.provider, repo, filePath) as { token: string } | undefined;
  if (existing) return existing.token;

  const token = crypto.randomBytes(8).toString("base64url");
  db.prepare(
    "INSERT INTO shares (token, owner_sid, owner_login, repo, path, title, created_at, provider) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
  ).run(token, s.sid, s.login, repo, filePath, title, Date.now(), s.provider);
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

// ── user_prefs ─────────────────────────────────────────
export interface LastRepo {
  provider: string;
  project: string;
  file: string | null;
}

export function setLastRepo(owner: string, provider: string, project: string, file: string | null): void {
  db.prepare(
    "INSERT OR REPLACE INTO user_prefs (owner, provider, project, file, updated_at) VALUES (?, ?, ?, ?, ?)"
  ).run(owner, provider, project, file, Date.now());
}

export function getLastRepo(owner: string): LastRepo | null {
  const row = db.prepare("SELECT provider, project, file FROM user_prefs WHERE owner = ?").get(owner) as
    | { provider: string; project: string; file: string | null }
    | undefined;
  if (!row) return null;
  return { provider: row.provider, project: row.project, file: row.file };
}

