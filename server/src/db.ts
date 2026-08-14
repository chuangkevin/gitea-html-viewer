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
CREATE TABLE IF NOT EXISTS short_links (
  id          TEXT PRIMARY KEY,
  alias       TEXT NOT NULL UNIQUE CHECK(alias = lower(alias)),
  target_path TEXT NOT NULL,
  label       TEXT,
  created_by  TEXT NOT NULL,
  is_enabled  INTEGER NOT NULL DEFAULT 1,
  created_at  INTEGER NOT NULL,
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

/** 管理員可檢視的分享資料；刻意不包含 owner_sid 或任何 session 資訊。 */
export interface AdminShareInventoryItem {
  token: string;
  ownerLogin: string;
  provider: string;
  repo: string;
  path: string | null;
  paths: string[] | null;
  title: string | null;
  kind: "doc" | "set";
  createdAt: number;
  revoked: boolean;
}

interface AdminShareInventoryRow {
  token: string;
  owner_login: string;
  provider: string;
  repo: string;
  path: string | null;
  paths: string | null;
  title: string | null;
  kind: string | null;
  created_at: number;
  revoked: number;
}

function parseSharePaths(raw: string | null): string[] | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) && parsed.every((value) => typeof value === "string") ? parsed : null;
  } catch {
    return null;
  }
}

function toAdminShareInventoryItem(row: AdminShareInventoryRow): AdminShareInventoryItem {
  const kind: "doc" | "set" = row.kind === "set" ? "set" : "doc";
  return {
    token: row.token,
    ownerLogin: row.owner_login,
    provider: row.provider || "github",
    repo: row.repo,
    path: row.path,
    paths: kind === "set" ? parseSharePaths(row.paths) : null,
    title: row.title,
    kind,
    createdAt: row.created_at,
    revoked: row.revoked !== 0,
  };
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

/**
 * 管理員總覽使用：列出所有已建立的 /s 分享，包含已撤銷的歷史資料。
 * 搜尋在 SQL 端以參數傳入，避免字串拼接。
 */
export function listAdminShares(query = ""): AdminShareInventoryItem[] {
  const normalizedQuery = query.trim().toLowerCase();
  const columns = "token, owner_login, provider, repo, path, paths, title, kind, created_at, revoked";
  let rows: AdminShareInventoryRow[];
  if (normalizedQuery) {
    const matches = `
      instr(lower(token), ?) > 0
      OR instr(lower(owner_login), ?) > 0
      OR instr(lower(provider), ?) > 0
      OR instr(lower(repo), ?) > 0
      OR instr(lower(COALESCE(path, '')), ?) > 0
      OR instr(lower(COALESCE(paths, '')), ?) > 0
      OR instr(lower(COALESCE(title, '')), ?) > 0
    `;
    rows = db
      .prepare(`SELECT ${columns} FROM shares WHERE ${matches} ORDER BY created_at DESC, token DESC`)
      .all(
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery,
        normalizedQuery
      ) as AdminShareInventoryRow[];
  } else {
    rows = db.prepare(`SELECT ${columns} FROM shares ORDER BY created_at DESC, token DESC`).all() as AdminShareInventoryRow[];
  }
  return rows.map(toAdminShareInventoryItem);
}

/** 管理員可撤銷任一仍有效的公開分享；資料保留供稽核，不硬刪。 */
export function revokeAdminShare(token: string): boolean {
  const result = db.prepare("UPDATE shares SET revoked = 1 WHERE token = ? AND revoked = 0").run(token);
  return result.changes > 0;
}

// ── raw_grants ────────────────────────────────────────
// 私有 repo 的短效 grant：存身分參照（sid / identName），不存 token 本身。
// 查驗時即時解析出 token（比照 grantToken()），session 過期或成員移除 → grant 自動失效。
db.exec(`
CREATE TABLE IF NOT EXISTS raw_grants (
  id          TEXT PRIMARY KEY,
  provider    TEXT NOT NULL,
  project     TEXT NOT NULL,
  sid         TEXT,
  ident_name  TEXT,
  expires_at  INTEGER NOT NULL
);
`);

export interface RawGrantRow {
  id: string;
  provider: string;
  project: string;
  sid: string | null;
  ident_name: string | null;
  expires_at: number;
}

export function purgeExpiredGrants(): void {
  db.prepare("DELETE FROM raw_grants WHERE expires_at < ?").run(Date.now());
}

export function createRawGrant(
  id: string,
  provider: string,
  project: string,
  sid: string | null,
  identName: string | null,
  expiresAt: number,
): void {
  purgeExpiredGrants();
  db.prepare(
    "INSERT INTO raw_grants (id, provider, project, sid, ident_name, expires_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(id, provider, project, sid, identName, expiresAt);
}

export function getRawGrant(id: string): RawGrantRow | null {
  const row = db.prepare("SELECT * FROM raw_grants WHERE id = ?").get(id) as RawGrantRow | undefined;
  if (!row) return null;
  if (row.expires_at < Date.now()) {
    db.prepare("DELETE FROM raw_grants WHERE id = ?").run(id);
    return null;
  }
  return row;
}

export function deleteRawGrant(id: string): void {
  db.prepare("DELETE FROM raw_grants WHERE id = ?").run(id);
}

// ── known_identities ──────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS known_identities (
  name          TEXT PRIMARY KEY,
  email         TEXT NOT NULL DEFAULT '',
  last_used_at  INTEGER NOT NULL,
  use_count     INTEGER NOT NULL DEFAULT 1
);
`);

export function upsertKnownIdentity(name: string, email: string): void {
  db.prepare(
    `INSERT INTO known_identities (name, email, last_used_at, use_count)
     VALUES (?, ?, ?, 1)
     ON CONFLICT(name) DO UPDATE SET
       email = CASE WHEN excluded.email != '' THEN excluded.email ELSE known_identities.email END,
       last_used_at = excluded.last_used_at,
       use_count = known_identities.use_count + 1`
  ).run(name, email, Date.now());
}

export interface KnownIdentityRow {
  name: string;
  email: string;
  last_used_at: number;
  use_count: number;
}

export function searchKnownIdentities(q: string, limit: number): KnownIdentityRow[] {
  if (q) {
    const pattern = `%${q}%`;
    return db
      .prepare(
        "SELECT * FROM known_identities WHERE name LIKE ? COLLATE NOCASE ORDER BY use_count DESC, last_used_at DESC LIMIT ?"
      )
      .all(pattern, limit) as KnownIdentityRow[];
  }
  return db
    .prepare("SELECT * FROM known_identities ORDER BY use_count DESC, last_used_at DESC LIMIT ?")
    .all(limit) as KnownIdentityRow[];
}

// ── user_repo_prefs ───────────────────────────────────
db.exec(`
CREATE TABLE IF NOT EXISTS user_repo_prefs (
  owner       TEXT NOT NULL,
  provider    TEXT NOT NULL,
  project     TEXT NOT NULL,
  pinned      INTEGER NOT NULL DEFAULT 0,
  last_seen_at INTEGER NOT NULL,
  PRIMARY KEY (owner, provider, project)
);
`);

export interface UserRepoPref {
  provider: string;
  project: string;
  pinned: boolean;
  lastSeenAt: number;
}

export function getUserRepoPrefs(owner: string): { pinned: UserRepoPref[]; recent: UserRepoPref[] } {
  const rows = db
    .prepare("SELECT provider, project, pinned, last_seen_at FROM user_repo_prefs WHERE owner = ? ORDER BY last_seen_at DESC")
    .all(owner) as { provider: string; project: string; pinned: number; last_seen_at: number }[];
  const pinned: UserRepoPref[] = [];
  const recent: UserRepoPref[] = [];
  for (const r of rows) {
    const pref: UserRepoPref = { provider: r.provider, project: r.project, pinned: r.pinned === 1, lastSeenAt: r.last_seen_at };
    if (r.pinned === 1) pinned.push(pref);
    else if (recent.length < 8) recent.push(pref);
  }
  return { pinned, recent };
}

export function upsertUserRepoPref(
  owner: string,
  provider: string,
  project: string,
  pinned: boolean,
  lastSeenAt: number,
): void {
  db.prepare(
    `INSERT INTO user_repo_prefs (owner, provider, project, pinned, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner, provider, project) DO UPDATE SET
       pinned = excluded.pinned,
       last_seen_at = CASE WHEN excluded.last_seen_at > user_repo_prefs.last_seen_at THEN excluded.last_seen_at ELSE user_repo_prefs.last_seen_at END`
  ).run(owner, provider, project, pinned ? 1 : 0, lastSeenAt);
}

export function deleteUserRepoPref(owner: string, provider: string, project: string): void {
  db.prepare("DELETE FROM user_repo_prefs WHERE owner = ? AND provider = ? AND project = ?").run(owner, provider, project);
}

/** Merge-import: only insert if not already existing for this owner */
export function mergeUserRepoPrefs(
  owner: string,
  items: { provider: string; project: string; pinned: boolean; lastSeenAt: number }[],
): void {
  const stmt = db.prepare(
    `INSERT INTO user_repo_prefs (owner, provider, project, pinned, last_seen_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner, provider, project) DO NOTHING`
  );
  const tx = db.transaction(() => {
    for (const item of items) {
      stmt.run(owner, item.provider, item.project, item.pinned ? 1 : 0, item.lastSeenAt);
    }
  });
  tx();
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
