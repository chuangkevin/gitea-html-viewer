import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import http from "node:http";
import * as archiverModule from "archiver";
import { marked } from "marked";

// archiver 是 CJS 套件：ESM 下 namespace object 的 default 才是函式（本機 dev 與容器 Node 版本行為不同，取 default 優先）
const archiver = ((archiverModule as unknown as { default?: unknown }).default ??
  archiverModule) as (
  format: string,
  options?: archiverModule.ArchiverOptions
) => archiverModule.Archiver;
import {
  createSession,
  getSession,
  deleteSession,
  updateSessionTokens,
  createShare,
  createShareSet,
  getShare,
  listShares,
  listAdminShares,
  revokeShare,
  revokeAdminShare,
  encrypt,
  decrypt,
  setLastRepo,
  getLastRepo,
  createRawGrant,
  getRawGrant,
  upsertKnownIdentity,
  searchKnownIdentities,
  getUserRepoPrefs,
  upsertUserRepoPref,
  deleteUserRepoPref,
  mergeUserRepoPrefs,
  type Session,
  type RawGrantRow,
} from "./db.js";
import {
  AccessMode,
  isAccessMode,
  getMode,
  setMode,
  removeEntry,
  listEntries,
  hasEntry,
  openToken,
  openTokenReady,
  defaultGuestAuthor,
} from "./access.js";
import {
  registerProvider,
  getProvider,
  isProviderName,
  normalizeProjectInput,
  ProviderError,
  type ProviderName,
  type CommitAuthor,
} from "./providers.js";
import { github } from "./github.js";
import { gitlab } from "./gitlab.js";
import {
  encodeSelection,
  fullIdentities,
  fullRoster,
  identities,
  publicIdentities,
  resolveIdentityToken,
  resolveSelection,
  teamEnabled,
} from "./identities.js";
import {
  buildPreviewBaseUrl,
  determineEffectiveGrant,
  shouldServeCssShim,
  generateImportMap,
  injectPreviewHead,
  rewriteCssSideEffectImports,
  createCssShim,
  readClosestPackageJson,
  readWithPublicFallback,
} from "./site-preview.js";
import {
  ShortLinkError,
  createShortLink,
  listShortLinks,
  resolveShortLink,
  shortLinkToResponse,
  updateShortLink,
} from "./short-links.js";
import { attachCollab } from "./collab.js";

registerProvider(github);
registerProvider(gitlab);

function migrateRepoAccess(): void {
  const entries = listEntries();
  let fixedCount = 0;
  for (const entry of entries) {
    const norm = normalizeProjectInput(entry.project, entry.provider as ProviderName);
    if (!norm) {
      console.warn(`[migration] repo_access 有無法解析的列: ${entry.provider}/${entry.project}`);
      continue;
    }
    if (norm.projectPath !== entry.project || norm.provider !== entry.provider) {
      if (hasEntry(norm.provider, norm.projectPath)) {
        removeEntry(entry.provider as ProviderName, entry.project);
      } else {
        setMode(norm.provider, norm.projectPath, entry.mode, entry.updatedBy ?? "migration");
        removeEntry(entry.provider as ProviderName, entry.project);
      }
      fixedCount++;
    }
  }
  if (fixedCount > 0) {
    console.log(`[migration] repo_access 正規化：${fixedCount} 列已修正`);
  }
}

migrateRepoAccess();

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

export const app = express();
app.use(express.json({ limit: "30mb" }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3210);
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;

// 每個 provider 一組 OAuth 設定 + 匿名讀 public 的後備 token（僅提高 rate limit）。
interface OAuthConf {
  clientId: string;
  clientSecret: string;
  fallbackToken: string;
}
const OAUTH: Record<ProviderName, OAuthConf> = {
  github: {
    clientId: process.env.GITHUB_CLIENT_ID || "",
    clientSecret: process.env.GITHUB_CLIENT_SECRET || "",
    fallbackToken: process.env.GITHUB_FALLBACK_TOKEN || "",
  },
  gitlab: {
    clientId: process.env.GITLAB_CLIENT_ID || "",
    clientSecret: process.env.GITLAB_CLIENT_SECRET || "",
    fallbackToken: process.env.GITLAB_FALLBACK_TOKEN || "",
  },
};
const oauthReady = (p: ProviderName) => Boolean(OAUTH[p].clientId && OAUTH[p].clientSecret);

const COOKIE = "nb_sid";
const IDENT_COOKIE = "nb_ident"; // 團隊模式：只存「選了哪位成員」，不存 token
const REDIRECT_URI = `${BASE_URL}/api/auth/callback`;

async function resolveLiveSession(req: express.Request): Promise<Session | null> {
  const s = getSession(req.cookies?.[COOKIE]);
  if (!s) return null;
  // 提前 120 秒視為過期，避免踩線
  if (!s.expiresAt || Date.now() < s.expiresAt - 120_000) return s;
  const p = getProvider(s.provider as ProviderName);
  const conf = OAUTH[s.provider as ProviderName];
  if (!s.refreshToken || !p.refreshTokens || !conf?.clientId) {
    deleteSession(s.sid);            // 沒得 refresh → 當作登出，前端會顯示登入鈕
    return null;
  }
  try {
    const t = await p.refreshTokens(conf.clientId, conf.clientSecret, s.refreshToken, REDIRECT_URI);
    updateSessionTokens(s.sid, t);
    console.log(`[auth] refreshed ${s.provider} token for ${s.login}`);  // ⚠️ 只印 login，不可印 token
    return getSession(s.sid);
  } catch {
    deleteSession(s.sid);
    return null;
  }
}

declare module "express-serve-static-core" {
  interface Request {
    nbSession?: Session | null;
  }
}

app.use(async (req, _res, next) => {
  try {
    req.nbSession = await resolveLiveSession(req);
  } catch {
    req.nbSession = null;
  }
  next();
});

// 部署健康檢查（CI 用；不需認證）
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, github: oauthReady("github"), gitlab: oauthReady("gitlab") });
});

function requireAuth(req: express.Request, res: express.Response): Session | null {
  const s = req.nbSession ?? null;
  if (!s) {
    res.status(401).json({ error: "not_authenticated" });
    return null;
  }
  return s;
}

function handleError(res: express.Response, e: unknown): void {
  if (e instanceof ProviderError) {
    res.status(e.status === 401 ? 401 : 502).json({ error: e.message });
  } else {
    console.error(e);
    res.status(500).json({ error: "internal_error" });
  }
}

/** 上游 provider 的錯誤訊息是不是「檔案不存在」（新檔情境，正常狀況，不該當錯誤）。 */
export function isProviderNotFound(message: string): boolean {
  return /\b404\b/.test(message);
}

// ── auth ───────────────────────────────────────────────
// /api/auth/login?provider=github|gitlab&next=/edit/...
app.get("/api/auth/login", (req, res) => {
  const provider = String(req.query.provider || "github");
  if (!isProviderName(provider) || !oauthReady(provider)) {
    res.redirect(`/?login=unconfigured&provider=${encodeURIComponent(provider)}`);
    return;
  }
  const state = crypto.randomBytes(16).toString("hex");
  const opts = { httpOnly: true, sameSite: "lax" as const, maxAge: 10 * 60 * 1000 };
  res.cookie("nb_state", state, opts);
  res.cookie("nb_prov", provider, opts);
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") ? req.query.next : "/";
  res.cookie("nb_next", next, opts);
  res.redirect(getProvider(provider).authorizeUrl(OAUTH[provider].clientId, REDIRECT_URI, state));
});

app.get("/api/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || state !== req.cookies?.nb_state) {
      res.status(400).send("OAuth state mismatch — 請重新登入");
      return;
    }
    const providerName = String(req.cookies?.nb_prov || "github");
    if (!isProviderName(providerName)) {
      res.status(400).send("未知的登入來源");
      return;
    }
    const provider = getProvider(providerName);
    const conf = OAUTH[providerName];
    const tokens = await provider.exchangeCode(conf.clientId, conf.clientSecret, code, REDIRECT_URI);
    const user = await provider.getUser(tokens.accessToken);
    const sid = createSession(user.login, user.avatarUrl, tokens, providerName);
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: BASE_URL.startsWith("https"),
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.clearCookie("nb_state");
    res.clearCookie("nb_prov");
    const next = typeof req.cookies?.nb_next === "string" && req.cookies.nb_next.startsWith("/") ? req.cookies.nb_next : "/";
    res.clearCookie("nb_next");
    res.redirect(next);
  } catch (e) {
    console.error(e);
    res.status(500).send("登入失敗，請重試");
  }
});

app.post("/api/auth/logout", (req, res) => {
  const sid = req.cookies?.[COOKIE];
  if (sid) deleteSession(sid);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

// ── 團隊模式（多 token、一人一組）──────────────────────
// 回前端的資料一律不含 token：只有 name / email / provider。
function teamInfo(req: express.Request) {
  const sel = resolveSelection(req.cookies?.[IDENT_COOKIE]);
  return {
    enabled: fullRoster().length > 0,
    members: fullRoster(),
    selected: sel ? { index: sel.index, name: sel.identity.name, email: sel.identity.email } : null,
  };
}

// 選身分：只把「第幾位成員 + 名字」寫進 cookie，token 留在 server。
// index 傳 null（或非法值）＝清除選擇，回到唯讀。
app.post("/api/identity", (req, res) => {
  const list = fullIdentities();
  if (list.length === 0) {
    res.status(404).json({ error: "team_mode_disabled" });
    return;
  }
  const { index } = req.body as { index?: number | null };
  const opts = { httpOnly: true, sameSite: "lax" as const, secure: BASE_URL.startsWith("https") };
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= list.length) {
    res.clearCookie(IDENT_COOKIE);
    res.json({ ok: true, selected: null });
    return;
  }
  // 記錄到 known_identities，供 autocomplete 建議
  upsertKnownIdentity(list[index].name, list[index].email);
  res.cookie(IDENT_COOKIE, encodeSelection(index, list[index]), {
    ...opts,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  res.json({ ok: true, selected: { index, name: list[index].name, email: list[index].email } });
});

// ── identity suggest（autocomplete）─────────────────────
app.get("/api/identities/suggest", (req, res) => {
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
  const limit = 20;

  // roster 來源：data/identities.json 正式成員（完整名冊）
  const roster = fullRoster();
  const rosterFiltered = q
    ? roster.filter((m) => m.name.toLowerCase().includes(q.toLowerCase()))
    : roster;
  const sharedTokenAvailable = fullIdentities().some((m) => m.token.trim().length > 0);
  const rosterResults = rosterFiltered.map((m) => ({
    name: m.name,
    email: m.email,
    source: "roster" as const,
    hasToken: (m.hasOwnToken ?? false) || sharedTokenAvailable,
  }));

  // history 來源：known_identities 累積
  const historyRows = searchKnownIdentities(q, limit);
  const rosterNames = new Set(rosterResults.map((r) => r.name.toLowerCase()));
  const historyResults = historyRows
    .filter((r) => !rosterNames.has(r.name.toLowerCase()))
    .map((r) => ({
      name: r.name,
      email: r.email,
      source: "history" as const,
    }));

  // roster 優先，合併後上限 limit
  const combined = [...rosterResults, ...historyResults].slice(0, limit);
  res.json(combined);
});

// ── user-prefs（per-user pinned/recent repos）──────────
/** 解析 owner 身分：OAuth session > team identity > null */
function ownerFor(req: express.Request): string | null {
  const s = req.nbSession ?? null;
  if (s) return `${s.provider}:${s.login}`;
  const sel = resolveSelection(req.cookies?.[IDENT_COOKIE]);
  if (sel) return `ident:${sel.identity.name}`;
  return null;
}

app.get("/api/user-prefs", (req, res) => {
  const owner = ownerFor(req);
  if (!owner) {
    res.json({ pinned: [], recent: [] });
    return;
  }
  res.json(getUserRepoPrefs(owner));
});

app.put("/api/user-prefs", (req, res) => {
  const owner = ownerFor(req);
  if (!owner) {
    res.status(401).json({ error: "not_identified" });
    return;
  }
  const body = req.body as {
    action: "upsert" | "delete" | "merge";
    provider?: string;
    project?: string;
    pinned?: boolean;
    lastSeenAt?: number;
    items?: { provider: string; project: string; pinned: boolean; lastSeenAt: number }[];
  };
  if (body.action === "merge" && Array.isArray(body.items)) {
    mergeUserRepoPrefs(owner, body.items);
    res.json(getUserRepoPrefs(owner));
    return;
  }
  if (!body.provider || typeof body.project !== "string" || !body.project.trim()) {
    res.status(400).json({ error: "invalid parameters" });
    return;
  }
  if (body.action === "delete") {
    deleteUserRepoPref(owner, body.provider, body.project);
  } else {
    upsertUserRepoPref(
      owner,
      body.provider,
      body.project,
      body.pinned ?? false,
      body.lastSeenAt ?? Date.now(),
    );
  }
  res.json(getUserRepoPrefs(owner));
});

app.get("/api/me", (req, res) => {
  const providers = { github: oauthReady("github"), gitlab: oauthReady("gitlab") };
  const team = teamInfo(req);
  const admin = { enabled: Boolean(process.env.ADMIN_KEY), is: isAdmin(req) };
  const s = req.nbSession ?? null;
  if (!s) {
    res.json({ login: null, providers, team, admin });
    return;
  }
  res.json({ login: s.login, avatarUrl: s.avatar_url, provider: s.provider, providers, team, admin });
});

// ── 共用：解析路由上的 provider / project ──────────────
// project 參數是 URL-encode 過的 projectPath（GitLab 巢狀群組含 %2F）。
function routeProvider(req: express.Request): ProviderName {
  const p = req.params.provider;
  if (!isProviderName(p)) throw new ProviderError(400, `unknown provider: ${p}`);
  return p;
}
function projectParam(req: express.Request): string {
  return req.params.project; // Express 已 decodeURIComponent
}
/**
 * 這個請求要用「誰的 token」打 provider API。優先序：
 *   1. 指定 repo 設為 open 模式且已設定 open token → 一律用 open token（優先於個人登入，避免登入帳號無權限時反而讀不到），commit author 保留當前身分（個人 session > 團隊成員 > 訪客）
 *   2. 個人 OAuth session（同 provider）→ 用他自己的 token
 *   3. 團隊模式所選成員（同 provider）→ 用該成員的 token，commit author 記成該成員
 *   4. 指定 repo 設為 admin 模式且當前使用者為 admin 且已設定 open token → 用 open token
 *   5. 都沒有 → 該 provider 的後備 token（只夠讀 public）
 * authed = 有具名身分 → 可讀 private、可寫。token 只在 server 內流動。
 */
interface Actor {
  token: string;
  authed: boolean;
  author?: CommitAuthor;
}
function guestAuthor(req: express.Request): CommitAuthor {
  const guestName = typeof req.cookies?.nb_guest === "string" ? req.cookies.nb_guest.trim() : "";
  if (guestName) {
    return {
      name: guestName,
      email: process.env.NOTE_OPEN_AUTHOR_EMAIL || defaultGuestAuthor().email,
    };
  }
  return defaultGuestAuthor();
}

function isAdmin(req: express.Request): boolean {
  const s = req.nbSession ?? null;
  if (s && process.env.ADMIN_LOGINS) {
    const allowedLogins = process.env.ADMIN_LOGINS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (allowedLogins.includes(s.login.toLowerCase())) {
      return true;
    }
  }
  if (process.env.ADMIN_KEY && req.cookies?.nb_admin) {
    try {
      const raw = decrypt(req.cookies.nb_admin);
      const data = JSON.parse(raw) as { t?: number };
      if (typeof data.t === "number" && Date.now() - data.t < 7 * 24 * 3600 * 1000) {
        return true;
      }
    } catch {
      // ignore
    }
  }
  return false;
}

function requireAdmin(req: express.Request, res: express.Response): boolean {
  if (!isAdmin(req)) {
    res.status(403).json({ error: "admin_only" });
    return false;
  }
  return true;
}

function currentAdminName(req: express.Request): string {
  const s = req.nbSession ?? null;
  if (s && process.env.ADMIN_LOGINS) {
    const allowed = process.env.ADMIN_LOGINS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (allowed.includes(s.login.toLowerCase())) {
      return s.login;
    }
  }
  return "admin_key";
}

function handleShortLinkError(res: express.Response, e: unknown): void {
  if (e instanceof ShortLinkError) {
    res.status(e.code === "alias_exists" ? 409 : 400).json({ error: e.code });
    return;
  }
  handleError(res, e);
}

function actorFor(req: express.Request, provider: ProviderName, project?: string): Actor {
  if (project && openTokenReady(provider) && getMode(provider, project) === "open") {
    const s = req.nbSession ?? null;
    let author: CommitAuthor;
    if (s && s.provider === provider) {
      author = {
        name: s.login,
        email: process.env.NOTE_OPEN_AUTHOR_EMAIL || defaultGuestAuthor().email,
      };
    } else {
      const sel = resolveSelection(req.cookies?.[IDENT_COOKIE]);
      if (sel && sel.identity.provider === provider) {
        author = { name: sel.identity.name, email: sel.identity.email };
      } else {
        author = guestAuthor(req);
      }
    }
    return {
      token: openToken(provider),
      authed: true,
      author,
    };
  }
  const s = req.nbSession ?? null;
  if (s && s.provider === provider) return { token: s.token, authed: true };
  const sel = resolveSelection(req.cookies?.[IDENT_COOKIE]);
  if (sel && sel.identity.provider === provider) {
    return {
      token: resolveIdentityToken(sel.identity),
      authed: true,
      author: { name: sel.identity.name, email: sel.identity.email },
    };
  }
  if (project && openTokenReady(provider)) {
    const mode = getMode(provider, project);
    if (mode === "admin" && isAdmin(req)) {
      return {
        token: openToken(provider),
        authed: true,
        author: guestAuthor(req),
      };
    }
  }
  return { token: OAUTH[provider].fallbackToken, authed: false };
}

// ── repos（登入者自己的）──────────────────────────────
app.get("/api/repos", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  try {
    const repos = await getProvider(s.provider).listRepos(s.token);
    res.json(
      repos.map((r) => ({
        provider: s.provider,
        fullName: r.projectPath,
        private: r.private,
        defaultBranch: r.defaultBranch,
        pushedAt: r.pushedAt,
      }))
    );
  } catch (e) {
    handleError(res, e);
  }
});

app.post("/api/repos", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  try {
    const { name, isPrivate } = req.body as { name?: string; isPrivate?: boolean };
    if (!name || !/^[A-Za-z0-9._-]+$/.test(name)) {
      res.status(400).json({ error: "invalid repo name" });
      return;
    }
    const r = await getProvider(s.provider).createRepo(s.token, name, isPrivate ?? true);
    res.json({ provider: s.provider, fullName: r.projectPath, defaultBranch: r.defaultBranch, private: r.private });
  } catch (e) {
    handleError(res, e);
  }
});

// ── files ──────────────────────────────────────────────
const MIME: Record<string, string> = {
  pdf: "application/pdf",
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css",
  js: "text/javascript",
  mjs: "text/javascript",
  json: "application/json",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  csv: "text/csv",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
  zip: "application/zip",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function mimeFor(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function sendRaw(res: express.Response, filePath: string, buf: Buffer, asAttachment?: boolean): void {
  const mime = mimeFor(filePath);
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  // 讓沙箱 iframe（opaque origin）內的頁面能 fetch 原始檔（唯讀公開資料；帶 cookie 的請求不受 * 影響）
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (mime.startsWith("text/html")) {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-downloads allow-top-navigation-by-user-activation");
  }
  if (asAttachment) {
    const name = path.basename(filePath) || "file";
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(name)}"; filename*=UTF-8''${encodeURIComponent(name)}`
    );
  }
  res.send(buf);
}

// 讀取端點採 optional auth：
// - 有 session 且同 provider → 用使用者 token（能讀自己有權限的 private）
// - 否則 → 用該 provider 後備 token / 匿名，且【必須】驗證 repo 為 public
app.get("/api/files/:provider/:project", async (req, res) => {
  let actor: Actor | null = null;
  try {
    const provider = routeProvider(req);
    const p = getProvider(provider);
    const project = projectParam(req);
    actor = actorFor(req, provider, project);
    const info = await p.getRepo(actor.token, project);
    if (info.private && !actor.authed) {
      res.status(401).json({ error: "login_required", reason: "private_repo" });
      return;
    }
    const files = await p.listAllFiles(actor.token, project, info.defaultBranch);
    const mode = getMode(provider, project);
    res.json({
      branch: info.defaultBranch,
      private: info.private,
      canWrite: Boolean((mode !== "admin" || isAdmin(req)) && actor.authed && info.canPush),
      access: mode,
      guestName: typeof req.cookies?.nb_guest === "string" ? req.cookies.nb_guest : null,
      files: files.map((f) => ({ path: f.path })),
    });
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404 && !actor?.authed) {
      res.status(401).json({ error: "login_required", reason: "not_found_or_private" });
      return;
    }
    handleError(res, e);
  }
});

app.get("/api/file/:provider/:project/*", async (req, res) => {
  let actor: Actor | null = null;
  let filePath: string | null = null;
  try {
    const provider = routeProvider(req);
    const p = getProvider(provider);
    const project = projectParam(req);
    actor = actorFor(req, provider, project);
    const info = await p.getRepo(actor.token, project);
    if (info.private && !actor.authed) {
      res.status(401).json({ error: "login_required", reason: "private_repo" });
      return;
    }
    filePath = (req.params as Record<string, string>)[0] || "";
    const f = await p.readFile(actor.token, project, filePath);
    res.json(f);
  } catch (e) {
    if (filePath !== null && e instanceof ProviderError && e.status === 404 && isProviderNotFound(e.message)) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    if (e instanceof ProviderError && e.status === 404 && !actor?.authed) {
      res.status(401).json({ error: "login_required", reason: "not_found_or_private" });
      return;
    }
    handleError(res, e);
  }
});

app.get("/api/zip/:provider/:project/*", async (req, res) => {
  let actor: Actor | null = null;
  try {
    const provider = routeProvider(req);
    const p = getProvider(provider);
    const project = projectParam(req);
    actor = actorFor(req, provider, project);
    const info = await p.getRepo(actor.token, project);
    if (info.private && !actor.authed) {
      res.status(401).json({ error: "login_required", reason: "private_repo" });
      return;
    }
    const dirPath = (req.params as Record<string, string>)[0] || "";
    const cleanDir = dirPath.replace(/^\/+|\/+$/g, "");
    const prefix = cleanDir ? cleanDir + "/" : "";

    const files = await p.listAllFiles(actor.token, project, info.defaultBranch);
    const matchingFiles = files.filter((f) => (cleanDir ? f.path.startsWith(prefix) : true));

    if (matchingFiles.length === 0) {
      res.status(404).json({ error: "not_found", reason: "folder_empty_or_not_found" });
      return;
    }

    if (matchingFiles.length > 300) {
      res.status(413).json({ error: "payload_too_large", reason: "too_many_files", count: matchingFiles.length, limit: 300 });
      return;
    }

    const folderName = cleanDir ? (cleanDir.split("/").pop() || "folder") : (project.split("/").pop() || "repository");
    // ?name= 可自訂下載檔名（去除路徑分隔與控制字元，避免 header injection）
    const customName = String(req.query.name || "").replace(/[/\\\r\n"]/g, "").trim().slice(0, 120);
    const zipFileName = `${customName || folderName}.zip`;

    res.setHeader("Content-Type", "application/zip");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${encodeURIComponent(zipFileName)}"; filename*=UTF-8''${encodeURIComponent(zipFileName)}`
    );

    const archive = archiver("zip", { zlib: { level: 9 } });

    archive.on("warning", (err: archiverModule.ArchiverError) => {
      if (err.code === "ENOENT") {
        console.warn("[archiver warning]", err);
      } else {
        throw err;
      }
    });

    archive.on("error", (err: archiverModule.ArchiverError) => {
      console.error("[archiver error]", err);
      if (!res.headersSent) {
        res.status(500).json({ error: "zip_error" });
      }
    });

    archive.pipe(res);

    for (const file of matchingFiles) {
      const buf = await p.readFileRaw(actor.token, project, file.path);
      const relPath = prefix ? file.path.slice(prefix.length) : file.path;
      archive.append(buf, { name: relPath });
    }

    await archive.finalize();
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404 && !actor?.authed) {
      res.status(401).json({ error: "login_required", reason: "not_found_or_private" });
      return;
    }
    if (!res.headersSent) {
      handleError(res, e);
    } else {
      console.error("[zip route error]", e);
    }
  }
});

// raw 靜態服務（把 repo 當靜態網站 host）
app.get("/raw/:provider/:project/*", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const p = getProvider(provider);
    const project = projectParam(req);
    const actor = actorFor(req, provider, project);
    const info = await p.getRepo(actor.token, project);
    if (info.private && !actor.authed) {
      res.status(401).json({ error: "login_required" });
      return;
    }
    const filePath = (req.params as Record<string, string>)[0] || "";
    const buf = await p.readFileRaw(actor.token, project, filePath);
    const download = req.query.download !== undefined && req.query.download !== "0" && req.query.download !== "false";
    sendRaw(res, filePath, buf, download);
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
});

// 私有 repo 的 HTML 展示：sandbox iframe 是 opaque origin，子資源不帶 cookie，
// 改發短效 grant 放在路徑裡，相對路徑資產自然繼承授權。
// grant 只記「用誰的身分」（session id 或成員名字），token 每次現查——
// 成員被移出清單或 session 過期，既有 grant 就自動失效。
// grant 資料持久化於 SQLite raw_grants 表。

/** grant row → 目前可用的 token；身分已消失時回 null。 */
function grantToken(g: RawGrantRow): string | null {
  if (g.sid) return getSession(g.sid)?.token ?? null;
  if (g.ident_name) {
    const m = fullIdentities().find((x) => x.name === g.ident_name && x.provider === g.provider);
    return m ? resolveIdentityToken(m) : null;
  }
  return null;
}

/**
 * 共用 grant 驗證：查 DB、比對 provider/project、檢查過期，
 * 通過回傳可用 token，否則 null。
 */
function resolveGrant(grantId: string, provider: ProviderName, project: string): string | null {
  const g = getRawGrant(grantId);
  if (!g || g.provider !== provider || g.project !== project) return null;
  return grantToken(g);
}

// 分享連結的授權效期。原本 6 小時，實務上「早上分享、下午就失效」，
// 收到的人只看到「需要授權」。grant 本身不含 token（每次現查），
// 撤銷靠移除成員或關掉 repo 的 open 模式，所以長效期並不等於長期風險。
const RAW_GRANT_TTL_MS = 90 * 24 * 3600e3;   // 90 天

app.post("/api/raw-grant", async (req, res) => {
  const { provider: pv, repo } = req.body as { provider?: string; repo?: string };
  if (!repo || !isProviderName(pv || "")) {
    res.status(400).json({ error: "provider/repo required" });
    return;
  }
  const provider = pv as ProviderName;
  const actor = actorFor(req, provider, repo);
  if (!actor.authed) {
    res.status(401).json({ error: "not_authenticated" });
    return;
  }
  try {
    await getProvider(provider).getRepo(actor.token, repo); // 驗證這個身分讀得到
  } catch (e) {
    handleError(res, e);
    return;
  }
  const grant = crypto.randomBytes(12).toString("base64url");
  const s = req.nbSession ?? null;
  // 綁「成員身分」優先於綁 session：session 一過期，綁 sid 的 grant 就死了，
  // 分享出去的連結會在幾小時後變成「需要授權」——那正是要避免的事。
  // 綁成員身分則是每次現查 token，人還在清單裡連結就一直有效。
  const identName = actor.author?.name ?? null;
  const sid = identName ? null : (s && s.provider === provider ? s.sid : null);
  createRawGrant(
    grant,
    provider,
    repo,
    sid,
    identName,
    Date.now() + RAW_GRANT_TTL_MS,
  );
  res.json({ grant });
});

app.get("/rawt/:grant/:provider/:project/*", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const project = projectParam(req);
    const token = resolveGrant(req.params.grant, provider, project);
    if (!token) {
      res.status(401).json({ error: "grant_invalid" });
      return;
    }
    const filePath = (req.params as Record<string, string>)[0] || "";
    const buf = await getProvider(provider).readFileRaw(token, project, filePath);
    const download = req.query.download !== undefined && req.query.download !== "0" && req.query.download !== "false";
    sendRaw(res, filePath, buf, download);
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status === 404 ? 404 : 500).end();
      return;
    }
    res.status(500).end();
  }
});

async function servePreviewAsset(
  req: express.Request,
  res: express.Response,
  p: ReturnType<typeof getProvider>,
  token: string,
  project: string,
  filePath: string
): Promise<void> {
  const buf = await readWithPublicFallback((path) => p.readFileRaw(token, project, path), filePath);

  if (shouldServeCssShim(filePath, req.query.site_preview_css)) {
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(createCssShim());
    return;
  }

  const ext = path.extname(filePath).toLowerCase();

  if (ext === ".js" || ext === ".mjs") {
    const code = buf.toString("utf8");
    const transformed = rewriteCssSideEffectImports(code);
    res.setHeader("Content-Type", "text/javascript; charset=utf-8");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.send(transformed);
    return;
  }

  sendRaw(res, filePath, buf, false);
}

app.get("/site-assets/:provider/:project/*", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const p = getProvider(provider);
    const project = projectParam(req);
    const actor = actorFor(req, provider, project);
    const info = await p.getRepo(actor.token, project);
    if (info.private && !actor.authed) {
      res.status(401).json({ error: "login_required" });
      return;
    }
    const filePath = (req.params as Record<string, string>)[0] || "";
    await servePreviewAsset(req, res, p, actor.token, project, filePath);
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
});

app.get("/site-assetst/:grant/:provider/:project/*", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const project = projectParam(req);
    const token = resolveGrant(req.params.grant, provider, project);
    if (!token) {
      res.status(401).json({ error: "grant_invalid" });
      return;
    }
    const p = getProvider(provider);
    const filePath = (req.params as Record<string, string>)[0] || "";
    await servePreviewAsset(req, res, p, token, project, filePath);
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
});

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function renderSitePage(title: string, bodyHtml: string): string {
  return `<!DOCTYPE html>
<html lang="zh-TW">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0d1117;
      --fg: #c9d1d9;
      --border: #30363d;
      --code-bg: #161b22;
      --accent: #58a6ff;
      --muted: #8b949e;
    }
    * { box-sizing: border-box; }
    body {
      background-color: var(--bg);
      color: var(--fg);
      font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      line-height: 1.6;
      margin: 0;
      padding: 2rem 1rem;
    }
    .container {
      max-width: 46rem;
      margin: 0 auto;
    }
    a { color: var(--accent); text-decoration: none; }
    a:hover { text-decoration: underline; }
    h1, h2, h3, h4, h5, h6 {
      color: #f0f6fc;
      margin-top: 1.5em;
      margin-bottom: 0.5em;
      font-weight: 600;
      line-height: 1.25;
    }
    h1 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    h2 { border-bottom: 1px solid var(--border); padding-bottom: 0.3em; }
    hr {
      height: 0.25em;
      padding: 0;
      margin: 2.5rem 0;
      background-color: var(--border);
      border: 0;
    }
    pre {
      background-color: var(--code-bg);
      border-radius: 6px;
      padding: 1rem;
      overflow-x: auto;
      border: 1px solid var(--border);
    }
    code {
      background-color: var(--code-bg);
      padding: 0.2em 0.4em;
      border-radius: 4px;
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, Liberation Mono, monospace;
      font-size: 85%;
    }
    pre code {
      background-color: transparent;
      padding: 0;
      border-radius: 0;
    }
    blockquote {
      margin: 0;
      padding: 0 1em;
      color: var(--muted);
      border-left: 0.25em solid var(--border);
    }
    table {
      border-collapse: collapse;
      width: 100%;
      margin: 1rem 0;
    }
    table th, table td {
      padding: 6px 13px;
      border: 1px solid var(--border);
    }
    table tr:nth-child(2n) {
      background-color: #161b22;
    }
    img { max-width: 100%; height: auto; }
    .doc-section { margin-bottom: 2rem; }
    .doc-header {
      font-size: 1.1rem;
      color: var(--muted);
      font-family: ui-monospace, SFMono-Regular, SF Mono, Menlo, Consolas, monospace;
      background: #161b22;
      padding: 0.4rem 0.8rem;
      border-radius: 4px;
      border: 1px solid var(--border);
      margin-bottom: 1.5rem;
    }
    .footer-notice {
      margin-top: 3rem;
      padding: 1rem;
      text-align: center;
      color: var(--muted);
      border-top: 1px dashed var(--border);
      font-size: 0.9rem;
    }
  </style>
</head>
<body>
  <div class="container">
    ${bodyHtml}
  </div>
</body>
</html>`;
}

// GET /site/:provider/:project —— 分享為獨立網站
app.get("/site/:provider/:project", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const p = getProvider(provider);
    const project = projectParam(req);

    // 優先嘗試 grant query：分享連結帶 ?grant=xxx 可在無 session 時授權
    let grantToken: string | null = null;
    const rawGrant = typeof req.query.grant === "string" && req.query.grant ? req.query.grant : null;
    if (rawGrant) {
      grantToken = resolveGrant(rawGrant, provider, project);
    }

    // grant 只是「加分」，不該讓事情變糟：grant 背後的 session 過期、或那個人
    // 已經沒有該 repo 的權限時，舊做法直接 403，反而比完全不帶 grant 還糟
    // （repo 若是 open 模式，不帶 grant 本來就打得開）。改成失敗就退回 actorFor。
    const fallbackActor = actorFor(req, provider, project);
    let actor: Actor = grantToken
      ? ({ token: grantToken, authed: true } as Actor)
      : fallbackActor;
    let usingGrant = Boolean(grantToken);
    let info;
    try {
      info = await p.getRepo(actor.token, project);
    } catch (e) {
      if (grantToken && actor.token !== fallbackActor.token) {
        actor = fallbackActor;                 // grant 的 token 不管用 → 用一般路徑再試一次
        usingGrant = false;
        info = await p.getRepo(actor.token, project);
      } else {
        throw e;
      }
    }
    if (info.private && !actor.authed) {
      const err = new ProviderError(403, "login_required");
      throw err;
    }

    const f = typeof req.query.f === "string" ? req.query.f : undefined;
    const dir = typeof req.query.dir === "string" ? req.query.dir : undefined;

    if (!f && dir === undefined) {
      res.status(400).json({ error: "missing f or dir parameter" });
      return;
    }

    if (f) {
      const ext = path.extname(f).toLowerCase();
      if (ext === ".html" || ext === ".htm") {
        const buf = await p.readFileRaw(actor.token, project, f);
        let html = buf.toString("utf8");
        const previewPath = f.replace(/\\/g, "/").replace(/^\/+/, "");
        const dirName = path.posix.dirname(previewPath);
        const folderPath = dirName === "." || dirName === "" ? "" : dirName + "/";

        const validGrant = determineEffectiveGrant(rawGrant, grantToken, usingGrant);
        const baseHref = buildPreviewBaseUrl({
          provider,
          project,
          folderPath,
          grant: validGrant,
        });

        const pkgJson = await readClosestPackageJson(
          (filePath) => p.readFileRaw(actor.token, project, filePath),
          previewPath
        );
        const importMap = pkgJson ? generateImportMap(pkgJson) : null;

        html = injectPreviewHead(html, baseHref, importMap);

        // Note: Content-Security-Policy: sandbox is intentionally omitted to allow JS execution for standalone site view.
        // Trust model: Internal / self-hosted usage where repository contents are treated as trusted.
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(html);
        return;
      }

      if (ext === ".md") {
        const repoFile = await p.readFile(actor.token, project, f);
        // Note: Server-side markdown rendering for /site router does not sanitize HTML.
        // Trust model: Repository contents are trusted for internal usage.
        const contentHtml = await marked.parse(repoFile.content);
        const pageTitle = f.split("/").pop() || project;
        const pageHtml = renderSitePage(pageTitle, contentHtml);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        res.send(pageHtml);
        return;
      }

      // 其他副檔名：302 轉到 /raw/<provider>/<project>/<f>
      const encodedF = f.split("/").map(encodeURIComponent).join("/");
      res.redirect(302, `/raw/${provider}/${encodeURIComponent(project)}/${encodedF}`);
      return;
    }

    // query dir=<資料夾路徑>（沒有 f 時）
    const files = await p.listAllFiles(actor.token, project, info.defaultBranch);
    const targetDir = (dir || "").trim().replace(/^\/+|\/+$/g, "");
    const mdFiles = files
      .filter((file) => {
        if (!file.path.toLowerCase().endsWith(".md")) return false;
        if (!targetDir || targetDir === ".") return true;
        return file.path.startsWith(targetDir + "/");
      })
      .sort((a, b) => a.path.localeCompare(b.path));

    const sliceFiles = mdFiles.slice(0, 50);
    const renderedParts: string[] = [];

    for (let i = 0; i < sliceFiles.length; i++) {
      const file = sliceFiles[i];
      const repoFile = await p.readFile(actor.token, project, file.path);
      // Note: Server-side markdown rendering for /site router does not sanitize HTML.
      // Trust model: Repository contents are trusted for internal usage.
      const fileHtml = await marked.parse(repoFile.content);
      const relPath =
        targetDir && targetDir !== "." && file.path.startsWith(targetDir + "/")
          ? file.path.slice(targetDir.length + 1)
          : file.path;

      let section = "";
      if (i > 0) {
        section += `<hr>\n`;
      }
      section += `<div class="doc-section">\n`;
      section += `  <div class="doc-header">${escapeHtml(relPath)}</div>\n`;
      section += fileHtml + `\n</div>`;
      renderedParts.push(section);
    }

    if (mdFiles.length > 50) {
      renderedParts.push(`<div class="footer-notice">僅顯示前 50 份</div>`);
    }

    const pageTitle = targetDir || project;
    const bodyHtml = renderedParts.join("\n");
    const pageHtml = renderSitePage(pageTitle, bodyHtml);
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.send(pageHtml);
  } catch (e) {
    if (e instanceof ProviderError) {
      if (e.status === 404) {
        res.status(404).end();
        return;
      }
      if (e.status === 401 || e.status === 403) {
        res.status(403).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>需要授權</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#18181b;color:#e4e4e7}div{text-align:center;max-width:420px;padding:2rem}h1{font-size:1.25rem;margin-bottom:.75rem}p{color:#a1a1aa;font-size:.875rem;line-height:1.6}a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}</style>
</head><body><div><h1>這份文件需要授權</h1><p>請先登入，或透過有效的分享連結開啟。</p><p><a href="/">← 回首頁</a></p></div></body></html>`);
        return;
      }
      // 其餘 provider 錯誤
      res.status(500).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>伺服器錯誤</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#18181b;color:#e4e4e7}div{text-align:center;max-width:420px;padding:2rem}h1{font-size:1.25rem;margin-bottom:.75rem}p{color:#a1a1aa;font-size:.875rem;line-height:1.6}a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}</style>
</head><body><div><h1>伺服器發生錯誤</h1><p>請稍後再試，或聯繫管理員。</p><p><a href="/">← 回首頁</a></p></div></body></html>`);
      return;
    }
    res.status(500).setHeader("Content-Type", "text/html; charset=utf-8").send(`<!DOCTYPE html>
<html lang="zh-TW"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>伺服器錯誤</title>
<style>body{font-family:system-ui,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#18181b;color:#e4e4e7}div{text-align:center;max-width:420px;padding:2rem}h1{font-size:1.25rem;margin-bottom:.75rem}p{color:#a1a1aa;font-size:.875rem;line-height:1.6}a{color:#38bdf8;text-decoration:none}a:hover{text-decoration:underline}</style>
</head><body><div><h1>伺服器發生錯誤</h1><p>請稍後再試，或聯繫管理員。</p><p><a href="/">← 回首頁</a></p></div></body></html>`);
  }
});

app.put("/api/file/:provider/:project/*", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const project = projectParam(req);
    const mode = getMode(provider, project);

    if (mode === "admin") {
      if (!isAdmin(req)) {
        res.status(403).json({ error: "admin_only" });
        return;
      }
    }

    const actor = actorFor(req, provider, project);

    if (mode === "open") {
      if (!openTokenReady(provider) && !actor.authed) {
        res.status(401).json({ error: "open_token_missing" });
        return;
      }
    } else if (mode === "admin") {
      if (!actor.authed) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
    } else {
      if (!actor.authed) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
    }

    const filePath = (req.params as Record<string, string>)[0] || "";

    // 檔名安全檢查
    if (filePath.startsWith("/") || filePath.includes("\\") || filePath.includes("..")) {
      res.status(400).json({ error: "invalid_path" });
      return;
    }

    const { content, contentBase64, sha, message } = req.body as {
      content?: string;
      contentBase64?: string;
      sha?: string;
      message?: string;
    };

    let writeContent: string;
    let isBase64 = false;

    if (typeof contentBase64 === "string") {
      writeContent = contentBase64;
      isBase64 = true;
    } else if (typeof content === "string") {
      writeContent = content;
      isBase64 = false;
    } else {
      res.status(400).json({ error: "content required" });
      return;
    }

    // 樂觀鎖：前端把讀到的 sha 一起送來，寫入前先確認檔案沒被別人改過。
    // GitLab 的寫入 API 不吃舊 sha（provider 層的 _sha 是被忽略的），
    // 所以「最後寫的人贏」——兩個人同時存檔會靜默弄丟先存的那份。
    // 這裡自己補一層：對不上就回 409，讓前端重讀合併後再試。
    // 沒帶 sha 的舊呼叫端維持原行為，不受影響。
    if (typeof sha === "string" && sha) {
      try {
        const cur = await getProvider(provider).readFile(actorFor(req, provider, project).token, project, filePath);
        if (cur.sha && cur.sha !== sha) {
          res.status(409).json({ error: "sha_mismatch", currentSha: cur.sha });
          return;
        }
      } catch {
        // 讀不到就當作是新檔，照原流程往下走
      }
    }

    const MAX_SIZE = 20 * 1024 * 1024;
    const byteLength = isBase64
      ? Buffer.from(writeContent, "base64").byteLength
      : Buffer.byteLength(writeContent, "utf8");

    if (byteLength > MAX_SIZE) {
      res.status(413).json({ error: "file_too_large" });
      return;
    }

    const p = getProvider(provider);
    const info = await p.getRepo(actor.token, project); // 取預設分支（GitLab 寫入需要）
    if (!info.canPush) {
      res.status(403).json({ error: "no_write_permission" });
      return;
    }
    const commitMsg = message || `docs: update ${filePath} via note-bridge`;
    const result = await p.writeFile(
      actor.token,
      project,
      filePath,
      writeContent,
      commitMsg,
      sha,
      info.defaultBranch,
      actor.author, // 團隊模式 / open guest 才有；個人登入時 undefined = 用 token 帳號
      isBase64
    );
    res.json(result);
  } catch (e) {
    handleError(res, e);
  }
});

app.post("/api/upload/:provider/:project", async (req, res) => {
  try {
    const provider = routeProvider(req);
    const project = projectParam(req);
    const mode = getMode(provider, project);

    if (mode === "admin") {
      if (!isAdmin(req)) {
        res.status(403).json({ error: "admin_only" });
        return;
      }
    }

    const actor = actorFor(req, provider, project);

    if (mode === "open") {
      if (!openTokenReady(provider) && !actor.authed) {
        res.status(401).json({ error: "open_token_missing" });
        return;
      }
    } else if (mode === "admin") {
      if (!actor.authed) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
    } else {
      if (!actor.authed) {
        res.status(401).json({ error: "not_authenticated" });
        return;
      }
    }

    const { files, message } = req.body as {
      files?: Array<{ path: string; contentBase64: string }>;
      message?: string;
    };

    if (!Array.isArray(files) || files.length === 0) {
      res.status(400).json({ error: "files_required" });
      return;
    }

    if (files.length > 200) {
      res.status(413).json({ error: "too_many_files", message: "單次最多上傳 200 個檔案" });
      return;
    }

    const MAX_SINGLE_SIZE = 20 * 1024 * 1024;
    const MAX_TOTAL_SIZE = 50 * 1024 * 1024;
    let totalSize = 0;

    for (const f of files) {
      if (!f || typeof f.path !== "string" || typeof f.contentBase64 !== "string") {
        res.status(400).json({ error: "invalid_file_format" });
        return;
      }
      const size = Buffer.from(f.contentBase64, "base64").byteLength;
      if (size > MAX_SINGLE_SIZE) {
        res.status(413).json({ error: "file_too_large", message: `單檔 ${f.path} 超過 20MB 限制` });
        return;
      }
      totalSize += size;
    }

    if (totalSize > MAX_TOTAL_SIZE) {
      res.status(413).json({ error: "batch_too_large", message: "單次總上傳量超過 50MB 限制" });
      return;
    }

    const failed: { path: string; error: string }[] = [];
    const validFiles: { path: string; contentBase64: string }[] = [];

    for (const f of files) {
      const filePath = f.path;
      if (
        !filePath ||
        filePath.startsWith("/") ||
        filePath.includes("\\") ||
        filePath.includes("..")
      ) {
        failed.push({ path: filePath || "", error: "invalid_path" });
        continue;
      }
      const segments = filePath.split("/");
      let hasInvalidSeg = false;
      for (const seg of segments) {
        if (seg === "" || seg === "." || seg === "..") {
          hasInvalidSeg = true;
          break;
        }
      }
      if (hasInvalidSeg) {
        failed.push({ path: filePath, error: "invalid_path" });
        continue;
      }
      validFiles.push(f);
    }

    const p = getProvider(provider);
    const info = await p.getRepo(actor.token, project);
    if (!info.canPush) {
      res.status(403).json({ error: "no_write_permission" });
      return;
    }

    const commitMsg = message || `上傳 ${validFiles.length} 個檔案`;

    if (p.batchWriteFiles) {
      const result = await p.batchWriteFiles(
        actor.token,
        project,
        validFiles,
        commitMsg,
        info.defaultBranch,
        actor.author
      );
      res.json({
        ok: true,
        count: result.count,
        batched: true,
        failed: [...failed, ...result.failed],
      });
    } else {
      let count = 0;
      for (const f of validFiles) {
        try {
          await p.writeFile(
            actor.token,
            project,
            f.path,
            f.contentBase64,
            commitMsg,
            undefined,
            info.defaultBranch,
            actor.author,
            true
          );
          count++;
        } catch (e: any) {
          failed.push({ path: f.path, error: e?.message || "write_failed" });
        }
      }
      res.json({ ok: true, count, batched: false, failed });
    }
  } catch (e) {
    handleError(res, e);
  }
});

// ── guest & admin endpoints ───────────────────────────
app.post("/api/guest-name", (req, res) => {
  const rawName = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const cleanName = rawName.slice(0, 40);
  const opts = {
    httpOnly: false,
    sameSite: "lax" as const,
    secure: BASE_URL.startsWith("https"),
    maxAge: 90 * 24 * 3600 * 1000,
  };
  if (cleanName) {
    res.cookie("nb_guest", cleanName, opts);
    res.json({ ok: true, name: cleanName });
  } else {
    res.clearCookie("nb_guest");
    res.json({ ok: true, name: null });
  }
});

app.post("/api/admin/login", (req, res) => {
  if (!process.env.ADMIN_KEY) {
    res.status(501).json({ error: "admin_disabled" });
    return;
  }
  const inputKey = typeof req.body?.key === "string" ? req.body.key : "";
  const keyBuf = crypto.createHash("sha256").update(inputKey).digest();
  const envBuf = crypto.createHash("sha256").update(process.env.ADMIN_KEY).digest();
  if (crypto.timingSafeEqual(keyBuf, envBuf)) {
    const enc = encrypt(JSON.stringify({ t: Date.now() }));
    res.cookie("nb_admin", enc, {
      httpOnly: true,
      sameSite: "lax",
      secure: BASE_URL.startsWith("https"),
      maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ ok: true });
  } else {
    console.warn(`[admin] login failure from ${req.ip || req.socket.remoteAddress}`);
    res.status(401).json({ error: "bad_key" });
  }
});

app.post("/api/admin/logout", (_req, res) => {
  res.clearCookie("nb_admin");
  res.json({ ok: true });
});

app.get("/api/admin/state", (req, res) => {
  const adminEnabled = Boolean(process.env.ADMIN_KEY);
  const authedAdmin = isAdmin(req);
  if (!authedAdmin) {
    res.json({ adminEnabled, isAdmin: false });
    return;
  }
  res.json({
    adminEnabled,
    isAdmin: true,
    openTokenReady: {
      github: openTokenReady("github"),
      gitlab: openTokenReady("gitlab"),
    },
    entries: listEntries(),
  });
});

app.put("/api/admin/repos", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { provider, project, mode } = req.body as { provider?: string; project?: string; mode?: string };
  if (!provider || !isProviderName(provider) || !project || !project.trim() || !mode || !isAccessMode(mode)) {
    res.status(400).json({ error: "invalid parameters" });
    return;
  }
  const norm = normalizeProjectInput(project, provider as ProviderName);
  if (!norm) {
    res.status(400).json({ error: "invalid_project" });
    return;
  }
  const s = req.nbSession ?? null;
  let by = "admin_key";
  if (s && process.env.ADMIN_LOGINS) {
    const allowed = process.env.ADMIN_LOGINS.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean);
    if (allowed.includes(s.login.toLowerCase())) {
      by = s.login;
    }
  }
  setMode(norm.provider, norm.projectPath, mode, by);
  res.json({ ok: true, entries: listEntries() });
});

app.delete("/api/admin/repos", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { provider, project } = req.body as { provider?: string; project?: string };
  if (!provider || !isProviderName(provider) || !project || !project.trim()) {
    res.status(400).json({ error: "invalid parameters" });
    return;
  }
  const norm = normalizeProjectInput(project, provider as ProviderName);
  if (!norm) {
    res.status(400).json({ error: "invalid_project" });
    return;
  }
  removeEntry(norm.provider, norm.projectPath);
  res.json({ ok: true, entries: listEntries() });
});

app.get("/api/admin/short-links", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json({ links: listShortLinks(q).map((link) => shortLinkToResponse(link, BASE_URL)) });
});

app.post("/api/admin/short-links", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { alias, targetPath, label } = req.body as { alias?: string | null; targetPath?: string; label?: string | null };
  if (typeof targetPath !== "string") {
    res.status(400).json({ error: "invalid_target" });
    return;
  }
  try {
    const link = createShortLink({ alias, targetPath, label, createdBy: currentAdminName(req) });
    res.status(201).json({ link: shortLinkToResponse(link, BASE_URL) });
  } catch (e) {
    handleShortLinkError(res, e);
  }
});

app.put("/api/admin/short-links/:id", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { targetPath, label, isEnabled } = req.body as {
    targetPath?: string;
    label?: string | null;
    isEnabled?: boolean;
  };
  try {
    const link = updateShortLink(req.params.id, { targetPath, label, isEnabled });
    if (!link) {
      res.status(404).json({ error: "not_found" });
      return;
    }
    res.json({ link: shortLinkToResponse(link, BASE_URL) });
  } catch (e) {
    handleShortLinkError(res, e);
  }
});

const publicShareBaseUrl = BASE_URL.replace(/\/+$/, "");

function adminShareResponse(share: ReturnType<typeof listAdminShares>[number]) {
  const shareUrl = `${publicShareBaseUrl}/s/${encodeURIComponent(share.token)}`;
  return {
    ...share,
    shareUrl,
    // 展示集本身就是 Presenter；單一文件才有獨立的 /slides route。
    slidesUrl: share.kind === "set" ? shareUrl : `${shareUrl}/slides`,
  };
}

app.get("/api/admin/shares", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = typeof req.query.q === "string" ? req.query.q : "";
  res.json({ shares: listAdminShares(q).map(adminShareResponse) });
});

app.delete("/api/admin/shares/:token", (req, res) => {
  if (!requireAdmin(req, res)) return;
  if (!revokeAdminShare(req.params.token)) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  res.json({ ok: true, revoked: true });
});

app.get("/go/:alias", (req, res) => {
  const link = resolveShortLink(req.params.alias);
  if (!link) {
    res.status(404).setHeader("Cache-Control", "no-store").end();
    return;
  }
  // Links can be retargeted or disabled, so intermediaries must never retain
  // an old Location response after the administrator changes it.
  res.status(302).set({ Location: link.targetPath, "Cache-Control": "no-store" }).end();
});

// ── prefs ──────────────────────────────────────────────
app.post("/api/prefs/last-repo", (req, res) => {
  const { provider, project, file } = req.body as { provider?: string; project?: string; file?: string | null };
  if (!provider || !isProviderName(provider) || typeof project !== "string" || !project.trim()) {
    res.status(400).json({ error: "invalid parameters" });
    return;
  }
  const norm = normalizeProjectInput(project, provider as ProviderName);
  if (!norm) {
    res.status(400).json({ error: "invalid_project" });
    return;
  }
  const filePath = typeof file === "string" && file.trim() ? file.trim() : null;

  const s = req.nbSession ?? getSession(req.cookies?.[COOKIE]);
  if (s) {
    setLastRepo(`${s.provider}:${s.login}`, norm.provider, norm.projectPath, filePath);
  }

  const payload = { provider: norm.provider, project: norm.projectPath, file: filePath };
  res.cookie("nb_last", encodeURIComponent(JSON.stringify(payload)), {
    httpOnly: true,
    sameSite: "lax",
    secure: BASE_URL.startsWith("https"),
    maxAge: 180 * 24 * 3600 * 1000,
  });

  res.json({ ok: true });
});


// ── shares ─────────────────────────────────────────────
app.post("/api/share", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const { repo, path: filePath, paths, title } = req.body as {
    repo?: string;
    path?: string;
    paths?: string[];
    title?: string;
  };
  if (!repo) {
    res.status(400).json({ error: "repo required" });
    return;
  }
  if (Array.isArray(paths) && paths.length > 0) {
    if (paths.length > 200 || paths.some((p) => typeof p !== "string")) {
      res.status(400).json({ error: "invalid paths" });
      return;
    }
    const token = createShareSet(s, repo, paths, title ?? null);
    res.json({ token, url: `${BASE_URL}/s/${token}`, slidesUrl: `${BASE_URL}/s/${token}/slides` });
    return;
  }
  if (!filePath) {
    res.status(400).json({ error: "path or paths required" });
    return;
  }
  const token = createShare(s, repo, filePath, title ?? null);
  res.json({ token, url: `${BASE_URL}/s/${token}`, slidesUrl: `${BASE_URL}/s/${token}/slides` });
});

app.get("/api/shares", (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  res.json(listShares(s.login));
});

app.delete("/api/share/:token", (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const ok = revokeShare(s.login, req.params.token);
  res.status(ok ? 200 : 404).json({ ok });
});

// 公開端點：訪客不需登入。內容用「分享者」的 session token + 該分享的 provider 即時拉。
function resolveShare(req: express.Request, res: express.Response) {
  const share = getShare(req.params.token);
  if (!share) {
    res.status(404).json({ error: "share_not_found" });
    return null;
  }
  // TODO: 分享連結在擁有者 token 過期後會失效（維持現有行為）
  const owner = getSession(share.owner_sid);
  if (!owner) {
    res.status(410).json({ error: "share_owner_session_expired" });
    return null;
  }
  if (!isProviderName(share.provider)) {
    res.status(500).json({ error: "bad_share_provider" });
    return null;
  }
  return { share, owner, provider: getProvider(share.provider) };
}

app.get("/api/public/:token", async (req, res) => {
  const ctx = resolveShare(req, res);
  if (!ctx) return;
  const { share, owner, provider } = ctx;
  try {
    if (share.kind === "set" && share.paths) {
      const items = JSON.parse(share.paths) as string[];
      res.json({
        kind: "set",
        title: share.title || `${share.repo} 展示`,
        ownerLogin: share.owner_login,
        repo: share.repo,
        items,
      });
      return;
    }
    const f = await provider.readFile(owner.token, share.repo, share.path);
    res.json({
      kind: "doc",
      title: share.title || share.path.split("/").pop(),
      ownerLogin: share.owner_login,
      repo: share.repo,
      path: share.path,
      content: f.content,
    });
  } catch (e) {
    handleError(res, e);
  }
});

app.get("/api/public/:token/file/*", async (req, res) => {
  const ctx = resolveShare(req, res);
  if (!ctx) return;
  const { share, owner, provider } = ctx;
  const filePath = (req.params as Record<string, string>)[0] || "";
  const allowed: string[] = share.kind === "set" && share.paths ? JSON.parse(share.paths) : [share.path];
  if (!allowed.includes(filePath)) {
    res.status(403).json({ error: "not_in_share" });
    return;
  }
  try {
    const f = await provider.readFile(owner.token, share.repo, filePath);
    res.json({ path: f.path, content: f.content });
  } catch (e) {
    handleError(res, e);
  }
});

app.get("/api/public/:token/raw/*", async (req, res) => {
  const ctx = resolveShare(req, res);
  if (!ctx) return;
  const { share, owner, provider } = ctx;
  const filePath = (req.params as Record<string, string>)[0] || "";
  try {
    const buf = await provider.readFileRaw(owner.token, share.repo, filePath);
    sendRaw(res, filePath, buf);
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
});

// ── 首頁預設落地 ───────────────────────────────────────
// 優先序：
// 1. 登入者在 user_prefs 的紀錄
// 2. cookie nb_last
// 3. DEFAULT_REPO / DEFAULT_FILE（維持現有行為）
// 帶 query 的「/」（?login=unconfigured、或想看原本首頁時用 /?home=1）不導轉。
const DEFAULT_REPO = process.env.DEFAULT_REPO || "";
const DEFAULT_FILE = process.env.DEFAULT_FILE || "README.md";
app.get("/", (req, res, next) => {
  if (Object.keys(req.query).length > 0) {
    next();
    return;
  }

  // 1. 登入者在 user_prefs 的紀錄
  const s = req.nbSession ?? getSession(req.cookies?.[COOKIE]);
  if (s) {
    const last = getLastRepo(`${s.provider}:${s.login}`);
    if (last) {
      const fStr = last.file ? `?f=${encodeURIComponent(last.file)}` : "";
      res.redirect(`/edit/${encodeURIComponent(last.provider)}/${encodeURIComponent(last.project)}${fStr}`);
      return;
    }
  }

  // 2. cookie nb_last
  if (req.cookies?.nb_last) {
    try {
      const raw = decodeURIComponent(req.cookies.nb_last);
      const data = JSON.parse(raw) as { provider?: string; project?: string; file?: string | null };
      if (data && typeof data.provider === "string" && typeof data.project === "string" && data.project) {
        const fStr = typeof data.file === "string" && data.file ? `?f=${encodeURIComponent(data.file)}` : "";
        res.redirect(`/edit/${encodeURIComponent(data.provider)}/${encodeURIComponent(data.project)}${fStr}`);
        return;
      }
    } catch {
      // ignore
    }
  }

  // 3. DEFAULT_REPO / DEFAULT_FILE（維持現有行為）
  if (DEFAULT_REPO) {
    res.redirect(`/edit/${DEFAULT_REPO}${DEFAULT_FILE ? `?f=${encodeURIComponent(DEFAULT_FILE)}` : ""}`);
    return;
  }

  next();
});


// ── SPA（production）───────────────────────────────────
const clientDist = path.resolve(process.cwd(), "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

if (process.env.NODE_ENV !== "test") {
  const server = http.createServer(app);
  attachCollab(server, collabOptions());
  server.listen(PORT, () => {
    console.log(`note-bridge server on :${PORT} (${BASE_URL})`);
  });
}

function collabEnvDocs(): Set<string> {
  const raw = (process.env.NOTE_COLLAB_DOCS || "").trim();
  if (!raw) return new Set();
  return new Set(raw.split(",").map((s) => s.trim()).filter(Boolean));
}

function collabOptions() {
  return {
    featureEnabled() {
      return /^(1|true|yes)$/i.test(process.env.NOTE_COLLAB || "");
    },
    enabled(docKey: string) {
      return collabEnvDocs().has(docKey);
    },
    async authorize({ cookies, docKey }: { cookies: Record<string, string>; docKey: string }) {
      // docKey = `${provider}/${encodeURIComponent(projectPath)}/${filePath}`
      // 前兩段是 provider 與 project，其餘（可能含 /）全部是檔案路徑
      const parts = docKey.split("/");
      if (parts.length < 3) return { ok: false };
      const provider = parts[0];
      const project = decodeURIComponent(parts[1]);
      const filePath = parts.slice(2).join("/");
      if (!isProviderName(provider)) return { ok: false };

      const fake = { cookies } as unknown as express.Request;
      fake.nbSession = await resolveLiveSession(fake);

      const mode = getMode(provider, project);
      if (mode === "admin" && !isAdmin(fake)) return { ok: false };
      const actor = actorFor(fake, provider, project);
      if (mode !== "open" && !actor.authed) return { ok: false };

      // 要有寫入權才進房（唯讀連線是後面的步驟）
      let canPush = false;
      try {
        canPush = (await getProvider(provider).getRepo(actor.token, project)).canPush;
      } catch {
        canPush = false;
      }
      if (!canPush) return { ok: false };

      const name =
        fake.nbSession?.login ||
        actor.author?.name ||
        (typeof cookies.nb_guest === "string" && cookies.nb_guest.trim()) ||
        "訪客";

      return {
        ok: true,
        user: { name, color: collabColorFor(name) },
        readFile: async () => {
          try {
            const f = await getProvider(provider).readFile(actor.token, project, filePath);
            return f.content;
          } catch {
            return null; // 新檔或讀不到 → 空房間
          }
        },
      };
    },
  };
}

/** 由名字決定 presence 顏色：同一個人每次進來顏色一樣。 */
function collabColorFor(name: string): string {
  const palette = ["#38bdf8", "#f472b6", "#4ade80", "#fbbf24", "#a78bfa", "#fb7185", "#2dd4bf", "#facc15"];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
