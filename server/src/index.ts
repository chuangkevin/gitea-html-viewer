import express from "express";
import cookieParser from "cookie-parser";
import crypto from "node:crypto";
import path from "node:path";
import fs from "node:fs";
import {
  createSession,
  getSession,
  deleteSession,
  createShare,
  createShareSet,
  getShare,
  listShares,
  revokeShare,
  type Session,
} from "./db.js";
import * as gh from "./github.js";

process.on("unhandledRejection", (err) => {
  console.error("[unhandledRejection]", err);
});

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3210);
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// dev 便利：設 DEV_PAT 可跳過 OAuth 直接用 PAT 登入（僅限本機開發）
const DEV_PAT = process.env.DEV_PAT || "";
// 匿名訪客讀取 public repo 用的後備 token（僅為提高 rate limit；
// 絕不能讓匿名請求透過它讀到 private repo——讀取端點會先驗 repo.private）
const FALLBACK_TOKEN = process.env.GITHUB_FALLBACK_TOKEN || "";

const COOKIE = "nb_sid";

// 部署健康檢查（CI 用；不需認證）
app.get("/healthz", (_req, res) => {
  res.json({ ok: true, oauth: Boolean(CLIENT_ID), dev: Boolean(DEV_PAT) });
});

function requireAuth(req: express.Request, res: express.Response): Session | null {
  const s = getSession(req.cookies?.[COOKIE]);
  if (!s) {
    res.status(401).json({ error: "not_authenticated" });
    return null;
  }
  return s;
}

function handleGhError(res: express.Response, e: unknown): void {
  if (e instanceof gh.GitHubError) {
    res.status(e.status === 401 ? 401 : 502).json({ error: e.message });
  } else {
    console.error(e);
    res.status(500).json({ error: "internal_error" });
  }
}

// ── auth ───────────────────────────────────────────────
app.get("/api/auth/login", (req, res) => {
  if (!CLIENT_ID) {
    // 瀏覽器導頁情境：回首頁顯示提示，而不是給使用者看 raw JSON
    res.redirect("/?login=unconfigured");
    return;
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("nb_state", state, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000 });
  const next = typeof req.query.next === "string" && req.query.next.startsWith("/") ? req.query.next : "/";
  res.cookie("nb_next", next, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000 });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", CLIENT_ID);
  url.searchParams.set("redirect_uri", `${BASE_URL}/api/auth/callback`);
  url.searchParams.set("scope", "repo");
  url.searchParams.set("state", state);
  res.redirect(url.toString());
});

app.get("/api/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || state !== req.cookies?.nb_state) {
      res.status(400).send("OAuth state mismatch — 請重新登入");
      return;
    }
    const token = await gh.exchangeCode(CLIENT_ID, CLIENT_SECRET, code);
    const user = await gh.getUser(token);
    const sid = createSession(user.login, user.avatar_url, token);
    res.cookie(COOKIE, sid, {
      httpOnly: true,
      sameSite: "lax",
      secure: BASE_URL.startsWith("https"),
      maxAge: 30 * 24 * 3600 * 1000,
    });
    res.clearCookie("nb_state");
    const next = typeof req.cookies?.nb_next === "string" && req.cookies.nb_next.startsWith("/") ? req.cookies.nb_next : "/";
    res.clearCookie("nb_next");
    res.redirect(next);
  } catch (e) {
    console.error(e);
    res.status(500).send("登入失敗，請重試");
  }
});

// dev 專用：PAT 直接建 session（正式環境不啟用）
app.post("/api/auth/dev", async (req, res) => {
  if (!DEV_PAT) {
    res.status(404).json({ error: "not_found" });
    return;
  }
  try {
    const user = await gh.getUser(DEV_PAT);
    const sid = createSession(user.login, user.avatar_url, DEV_PAT);
    res.cookie(COOKIE, sid, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
    res.json({ login: user.login });
  } catch (e) {
    handleGhError(res, e);
  }
});

app.post("/api/auth/logout", (req, res) => {
  const sid = req.cookies?.[COOKIE];
  if (sid) deleteSession(sid);
  res.clearCookie(COOKIE);
  res.json({ ok: true });
});

app.get("/api/me", (req, res) => {
  const s = getSession(req.cookies?.[COOKIE]);
  if (!s) {
    res.json({ login: null, oauthReady: Boolean(CLIENT_ID), devMode: Boolean(DEV_PAT) });
    return;
  }
  res.json({ login: s.login, avatarUrl: s.avatar_url });
});

// ── repos ──────────────────────────────────────────────
app.get("/api/repos", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  try {
    const repos = await gh.listRepos(s.token);
    res.json(
      repos.map((r) => ({
        fullName: r.full_name,
        private: r.private,
        defaultBranch: r.default_branch,
        pushedAt: r.pushed_at,
      }))
    );
  } catch (e) {
    handleGhError(res, e);
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
    const r = await gh.createRepo(s.token, name, isPrivate ?? true);
    res.json({ fullName: r.full_name, defaultBranch: r.default_branch, private: r.private });
  } catch (e) {
    handleGhError(res, e);
  }
});

// ── files ──────────────────────────────────────────────
function repoParam(req: express.Request): string {
  return `${req.params.owner}/${req.params.repo}`;
}

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

/** raw 回應共用：HTML 一律掛 CSP sandbox——即使直接開 raw 網址，
 *  頁內 script 也拿不到本站 origin 的權限（防止惡意 repo HTML 借
 *  登入者 cookie 打 /api）。 */
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
// - 有 session → 用使用者自己的 token（能讀自己有權限的 private）
// - 無 session → 用 FALLBACK_TOKEN / 匿名，且【必須】驗證 repo 為 public
//   才回傳，否則後備 token 會把站主的 private repo 洩漏給訪客。
app.get("/api/files/:owner/:repo", async (req, res) => {
  const s = getSession(req.cookies?.[COOKIE]);
  const token = s?.token ?? FALLBACK_TOKEN;
  try {
    const repo = repoParam(req);
    const info = await gh.getRepo(token, repo);
    if (info.private && !s) {
      res.status(401).json({ error: "login_required", reason: "private_repo" });
      return;
    }
    const files = await gh.listAllFiles(token, repo, info.default_branch);
    res.json({
      branch: info.default_branch,
      private: info.private,
      canWrite: Boolean(s && info.permissions?.push),
      files: files.map((f) => ({ path: f.path })),
    });
  } catch (e) {
    if (e instanceof gh.GitHubError && e.status === 404 && !s) {
      // 匿名看不到＝不存在或 private，提示登入
      res.status(401).json({ error: "login_required", reason: "not_found_or_private" });
      return;
    }
    handleGhError(res, e);
  }
});

app.get("/api/file/:owner/:repo/*", async (req, res) => {
  const s = getSession(req.cookies?.[COOKIE]);
  const token = s?.token ?? FALLBACK_TOKEN;
  try {
    const repo = repoParam(req);
    const info = await gh.getRepo(token, repo);
    if (info.private && !s) {
      res.status(401).json({ error: "login_required", reason: "private_repo" });
      return;
    }
    const filePath = (req.params as Record<string, string>)[0] || "";
    const f = await gh.readFile(token, repo, filePath);
    res.json(f);
  } catch (e) {
    if (e instanceof gh.GitHubError && e.status === 404 && !s) {
      res.status(401).json({ error: "login_required", reason: "not_found_or_private" });
      return;
    }
    handleGhError(res, e);
  }
});

// raw 靜態服務：HTML 獨立網頁展示的基礎。相對路徑（./style.css 等）
// 會自然解析回同一個 /raw 前綴底下，等於把 repo 當靜態網站 host。
app.get("/raw/:owner/:repo/*", async (req, res) => {
  const s = getSession(req.cookies?.[COOKIE]);
  const token = s?.token ?? FALLBACK_TOKEN;
  try {
    const repo = repoParam(req);
    const info = await gh.getRepo(token, repo);
    if (info.private && !s) {
      res.status(401).json({ error: "login_required" });
      return;
    }
    const filePath = (req.params as Record<string, string>)[0] || "";
    const buf = await gh.readFileRaw(token, repo, filePath);
    sendRaw(res, filePath, buf);
  } catch (e) {
    if (e instanceof gh.GitHubError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
});

// 私有 repo 的 HTML 展示：sandbox iframe 是 opaque origin，子資源請求
// 不帶 cookie，改發短效 grant 放在路徑裡，相對路徑資產自然繼承授權。
const rawGrants = new Map<string, { repo: string; sid: string; exp: number }>();
app.post("/api/raw-grant", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  const { repo } = req.body as { repo?: string };
  if (!repo) {
    res.status(400).json({ error: "repo required" });
    return;
  }
  try {
    await gh.getRepo(s.token, repo); // 驗證此使用者可讀
  } catch (e) {
    handleGhError(res, e);
    return;
  }
  // 簡單清掉過期的，避免無限成長
  for (const [k, v] of rawGrants) if (v.exp < Date.now()) rawGrants.delete(k);
  const grant = crypto.randomBytes(12).toString("base64url");
  rawGrants.set(grant, { repo, sid: s.sid, exp: Date.now() + 6 * 3600e3 });
  res.json({ grant });
});

app.get("/rawt/:grant/:owner/:repo/*", async (req, res) => {
  const g = rawGrants.get(req.params.grant);
  const repo = repoParam(req);
  if (!g || g.repo !== repo || g.exp < Date.now()) {
    res.status(401).json({ error: "grant_invalid" });
    return;
  }
  const owner = getSession(g.sid);
  if (!owner) {
    res.status(401).json({ error: "grant_session_expired" });
    return;
  }
  try {
    const filePath = (req.params as Record<string, string>)[0] || "";
    const buf = await gh.readFileRaw(owner.token, repo, filePath);
    sendRaw(res, filePath, buf);
  } catch (e) {
    if (e instanceof gh.GitHubError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
});

app.put("/api/file/:owner/:repo/*", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  try {
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
    const commitMsg = message || `docs: update ${filePath} via note-bridge`;
    const result = await gh.writeFile(s.token, repoParam(req), filePath, content, commitMsg, sha);
    res.json(result);
  } catch (e) {
    handleGhError(res, e);
  }
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
  // 多檔展示集
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

// 公開端點：訪客不需登入。內容用「分享者」的 session token 即時從 GitHub 拉。
function resolveShare(req: express.Request, res: express.Response) {
  const share = getShare(req.params.token);
  if (!share) {
    res.status(404).json({ error: "share_not_found" });
    return null;
  }
  const owner = getSession(share.owner_sid);
  if (!owner) {
    res.status(410).json({ error: "share_owner_session_expired" });
    return null;
  }
  return { share, owner };
}

app.get("/api/public/:token", async (req, res) => {
  const ctx = resolveShare(req, res);
  if (!ctx) return;
  const { share, owner } = ctx;
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
    const f = await gh.readFile(owner.token, share.repo, share.path);
    res.json({
      kind: "doc",
      title: share.title || share.path.split("/").pop(),
      ownerLogin: share.owner_login,
      repo: share.repo,
      path: share.path,
      content: f.content,
    });
  } catch (e) {
    handleGhError(res, e);
  }
});

// set 內單一 md 檔內容（限展示集內的路徑）
app.get("/api/public/:token/file/*", async (req, res) => {
  const ctx = resolveShare(req, res);
  if (!ctx) return;
  const { share, owner } = ctx;
  const filePath = (req.params as Record<string, string>)[0] || "";
  const allowed: string[] = share.kind === "set" && share.paths ? JSON.parse(share.paths) : [share.path];
  if (!allowed.includes(filePath)) {
    res.status(403).json({ error: "not_in_share" });
    return;
  }
  try {
    const f = await gh.readFile(owner.token, share.repo, filePath);
    res.json({ path: f.path, content: f.content });
  } catch (e) {
    handleGhError(res, e);
  }
});

// 分享的 HTML 需要相對資產（css/js/圖），開放該 repo 範圍的 raw 讀取。
// 分享任何一頁 HTML 等同分享其資產，token 即授權範圍（可撤銷）。
app.get("/api/public/:token/raw/*", async (req, res) => {
  const ctx = resolveShare(req, res);
  if (!ctx) return;
  const { share, owner } = ctx;
  const filePath = (req.params as Record<string, string>)[0] || "";
  try {
    const buf = await gh.readFileRaw(owner.token, share.repo, filePath);
    sendRaw(res, filePath, buf);
  } catch (e) {
    if (e instanceof gh.GitHubError) {
      res.status(e.status === 404 ? 404 : 502).end();
      return;
    }
    res.status(500).end();
  }
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
