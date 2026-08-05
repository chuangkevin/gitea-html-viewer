import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  createSession,
  getSession,
  deleteSession,
  updateSessionTokens,
  createShare,
  createShareSet,
  getShare,
  listShares,
  revokeShare,
  encrypt,
  decrypt,
  setLastRepo,
  getLastRepo,
  type Session,
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
  identities,
  teamEnabled,
  publicIdentities,
  resolveSelection,
  encodeSelection,
} from "./identities.js";

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

const app = express();
app.use(express.json({ limit: "2mb" }));
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
    enabled: teamEnabled(),
    members: publicIdentities(),
    selected: sel ? { index: sel.index, name: sel.identity.name, email: sel.identity.email } : null,
  };
}

// 選身分：只把「第幾位成員 + 名字」寫進 cookie，token 留在 server。
// index 傳 null（或非法值）＝清除選擇，回到唯讀。
app.post("/api/identity", (req, res) => {
  const list = identities();
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
  res.cookie(IDENT_COOKIE, encodeSelection(index, list[index]), {
    ...opts,
    maxAge: 30 * 24 * 3600 * 1000,
  });
  res.json({ ok: true, selected: { index, name: list[index].name, email: list[index].email } });
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
 *   1. 個人 OAuth session（同 provider）→ 用他自己的 token
 *   2. 團隊模式所選成員（同 provider）→ 用該成員的 token，commit author 記成該成員
 *   3. 指定 repo 設為 open 模式、或設為 admin 模式且當前使用者為 admin 且已設定 open token → 用 open token
 *   4. 都沒有 → 該 provider 的後備 token（只夠讀 public）
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

function actorFor(req: express.Request, provider: ProviderName, project?: string): Actor {
  const s = req.nbSession ?? null;
  if (s && s.provider === provider) return { token: s.token, authed: true };
  const sel = resolveSelection(req.cookies?.[IDENT_COOKIE]);
  if (sel && sel.identity.provider === provider) {
    return {
      token: sel.identity.token,
      authed: true,
      author: { name: sel.identity.name, email: sel.identity.email },
    };
  }
  if (project && openTokenReady(provider)) {
    const mode = getMode(provider, project);
    if (mode === "open" || (mode === "admin" && isAdmin(req))) {
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
  html: "text/html; charset=utf-8",
  htm: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8",
  md: "text/markdown; charset=utf-8",
  txt: "text/plain; charset=utf-8",
  svg: "image/svg+xml",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  ico: "image/x-icon",
  woff: "font/woff",
  woff2: "font/woff2",
};
function mimeFor(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return MIME[ext] ?? "application/octet-stream";
}

function sendRaw(res: express.Response, filePath: string, buf: Buffer): void {
  const mime = mimeFor(filePath);
  res.setHeader("Content-Type", mime);
  res.setHeader("X-Content-Type-Options", "nosniff");
  if (mime.startsWith("text/html")) {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts");
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
    const filePath = (req.params as Record<string, string>)[0] || "";
    const f = await p.readFile(actor.token, project, filePath);
    res.json(f);
  } catch (e) {
    if (e instanceof ProviderError && e.status === 404 && !actor?.authed) {
      res.status(401).json({ error: "login_required", reason: "not_found_or_private" });
      return;
    }
    handleError(res, e);
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
    sendRaw(res, filePath, buf);
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
interface RawGrant {
  provider: ProviderName;
  project: string;
  sid: string | null;
  identName: string | null;
  exp: number;
}
const rawGrants = new Map<string, RawGrant>();

/** grant → 目前可用的 token；身分已消失時回 null。 */
function grantToken(g: RawGrant): string | null {
  if (g.sid) return getSession(g.sid)?.token ?? null;
  if (g.identName) {
    const m = identities().find((x) => x.name === g.identName && x.provider === g.provider);
    return m ? m.token : null;
  }
  return null;
}

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
  for (const [k, v] of rawGrants) if (v.exp < Date.now()) rawGrants.delete(k);
  const grant = crypto.randomBytes(12).toString("base64url");
  const s = req.nbSession ?? null;
  rawGrants.set(grant, {
    provider,
    project: repo,
    sid: s && s.provider === provider ? s.sid : null,
    identName: actor.author?.name ?? null,
    exp: Date.now() + 6 * 3600e3,
  });
  res.json({ grant });
});

app.get("/rawt/:grant/:provider/:project/*", async (req, res) => {
  const g = rawGrants.get(req.params.grant);
  try {
    const provider = routeProvider(req);
    const project = projectParam(req);
    if (!g || g.provider !== provider || g.project !== project || g.exp < Date.now()) {
      res.status(401).json({ error: "grant_invalid" });
      return;
    }
    const token = grantToken(g);
    if (!token) {
      res.status(401).json({ error: "grant_session_expired" });
      return;
    }
    const filePath = (req.params as Record<string, string>)[0] || "";
    const buf = await getProvider(provider).readFileRaw(token, project, filePath);
    sendRaw(res, filePath, buf);
  } catch (e) {
    if (e instanceof ProviderError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
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
    if (!filePath.toLowerCase().endsWith(".md")) {
      res.status(400).json({ error: "note-bridge 只管理 .md 檔" });
      return;
    }
    const { content, sha, message } = req.body as { content?: string; sha?: string; message?: string };
    if (typeof content !== "string") {
      res.status(400).json({ error: "content required" });
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
      content,
      commitMsg,
      sha,
      info.defaultBranch,
      actor.author // 團隊模式 / open guest 才有；個人登入時 undefined = 用 token 帳號
    );
    res.json(result);
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

app.listen(PORT, () => {
  console.log(`note-bridge server on :${PORT} (${BASE_URL})`);
});
