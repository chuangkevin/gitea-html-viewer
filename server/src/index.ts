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
  getShare,
  listShares,
  revokeShare,
  type Session,
} from "./db.js";
import * as gh from "./github.js";

const app = express();
app.use(express.json({ limit: "2mb" }));
app.use(cookieParser());

const PORT = Number(process.env.PORT || 3210);
const CLIENT_ID = process.env.GITHUB_CLIENT_ID || "";
const CLIENT_SECRET = process.env.GITHUB_CLIENT_SECRET || "";
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
// dev 便利：設 DEV_PAT 可跳過 OAuth 直接用 PAT 登入（僅限本機開發）
const DEV_PAT = process.env.DEV_PAT || "";

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
    res.status(500).json({ error: "GITHUB_CLIENT_ID not configured" });
    return;
  }
  const state = crypto.randomBytes(16).toString("hex");
  res.cookie("nb_state", state, { httpOnly: true, sameSite: "lax", maxAge: 10 * 60 * 1000 });
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
    res.redirect("/");
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
  const user = await gh.getUser(DEV_PAT);
  const sid = createSession(user.login, user.avatar_url, DEV_PAT);
  res.cookie(COOKIE, sid, { httpOnly: true, sameSite: "lax", maxAge: 30 * 24 * 3600 * 1000 });
  res.json({ login: user.login });
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

app.get("/api/files/:owner/:repo", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  try {
    const repo = repoParam(req);
    const info = await gh.getRepo(s.token, repo);
    const files = await gh.listMarkdownFiles(s.token, repo, info.default_branch);
    res.json({ branch: info.default_branch, files: files.map((f) => ({ path: f.path })) });
  } catch (e) {
    handleGhError(res, e);
  }
});

app.get("/api/file/:owner/:repo/*", async (req, res) => {
  const s = requireAuth(req, res);
  if (!s) return;
  try {
    const filePath = (req.params as Record<string, string>)[0] || "";
    const f = await gh.readFile(s.token, repoParam(req), filePath);
    res.json(f);
  } catch (e) {
    handleGhError(res, e);
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
  const { repo, path: filePath, title } = req.body as { repo?: string; path?: string; title?: string };
  if (!repo || !filePath) {
    res.status(400).json({ error: "repo and path required" });
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
app.get("/api/public/:token", async (req, res) => {
  const share = getShare(req.params.token);
  if (!share) {
    res.status(404).json({ error: "share_not_found" });
    return;
  }
  const owner = getSession(share.owner_sid);
  if (!owner) {
    res.status(410).json({ error: "share_owner_session_expired" });
    return;
  }
  try {
    const f = await gh.readFile(owner.token, share.repo, share.path);
    res.json({
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

// ── SPA（production）───────────────────────────────────
const clientDist = path.resolve(process.cwd(), "../client/dist");
if (fs.existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get("*", (_req, res) => res.sendFile(path.join(clientDist, "index.html")));
}

app.listen(PORT, () => {
  console.log(`note-bridge server on :${PORT} (${BASE_URL})`);
});
