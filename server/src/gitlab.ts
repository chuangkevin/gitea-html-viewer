/**
 * GitLab REST API v4 薄封裝，實作 Provider 介面。針對 gitlab.com（非自架）。
 *
 * 與 GitHub 的主要差異（實作重點）：
 *   - 專案識別用 project id = URL-encode 後的 path_with_namespace（可巢狀群組）
 *   - 檔案路徑要整串 URL-encode（含斜線 → %2F）
 *   - 列檔 tree 是分頁的（每頁上限 100，靠 x-next-page 續抓）
 *   - 寫檔不需要舊 sha：更新用 PUT、建立用 POST，帶 branch + commit_message
 */
import type { Provider, ProviderUser, RepoMeta, RepoFile, OAuthTokens } from "./providers.js";
import { ProviderError } from "./providers.js";

const HOST = "https://gitlab.com";
const API = `${HOST}/api/v4`;

async function glRaw(token: string, path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      "User-Agent": "note-bridge",
      ...(init?.headers || {}),
    },
  });
}

async function gl<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await glRaw(token, path, init);
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(res.status, `GitLab ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

/** project id：整串 path_with_namespace URL-encode（含斜線）。 */
function pid(projectPath: string): string {
  return encodeURIComponent(projectPath);
}
/** GitLab 檔案路徑要整串編碼（斜線也要）。 */
function encFile(p: string): string {
  return encodeURIComponent(p);
}

interface GlProject {
  path_with_namespace: string;
  visibility: "private" | "internal" | "public";
  default_branch: string | null;
  last_activity_at: string;
  permissions?: {
    project_access?: { access_level: number } | null;
    group_access?: { access_level: number } | null;
  };
}

function accessLevel(p: GlProject): number {
  return Math.max(p.permissions?.project_access?.access_level ?? 0, p.permissions?.group_access?.access_level ?? 0);
}

function toMeta(p: GlProject): RepoMeta {
  return {
    projectPath: p.path_with_namespace,
    private: p.visibility !== "public",
    defaultBranch: p.default_branch || "main",
    pushedAt: p.last_activity_at,
    canPush: accessLevel(p) >= 30, // 30 = Developer
  };
}

export const gitlab: Provider = {
  name: "gitlab",

  authorizeUrl(clientId, redirectUri, state) {
    const url = new URL(`${HOST}/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "api");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const res = await fetch(`${HOST}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        code,
        grant_type: "authorization_code",
        redirect_uri: redirectUri,
      }),
    });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!data.access_token) throw new ProviderError(401, data.error_description || "OAuth token exchange failed");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
  },

  async refreshTokens(clientId, clientSecret, refreshToken, redirectUri) {
    const res = await fetch(`${HOST}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: refreshToken,
        grant_type: "refresh_token",
        redirect_uri: redirectUri,
      }),
    });
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!data.access_token) throw new ProviderError(401, data.error_description || "OAuth token refresh failed");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 7200) * 1000,
    };
  },

  async getUser(token) {
    const u = await gl<{ username: string; avatar_url: string }>(token, "/user");
    return { login: u.username, avatarUrl: u.avatar_url } satisfies ProviderUser;
  },

  async listRepos(token) {
    const repos = await gl<GlProject[]>(
      token,
      "/projects?membership=true&min_access_level=30&order_by=last_activity_at&per_page=100&simple=false"
    );
    return repos.map(toMeta);
  },

  async createRepo(token, name, isPrivate) {
    const p = await gl<GlProject>(token, "/projects", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        visibility: isPrivate ? "private" : "public",
        initialize_with_readme: true,
        description: "Notes managed with note-bridge",
      }),
    });
    return toMeta(p);
  },

  async getRepo(token, projectPath) {
    return toMeta(await gl<GlProject>(token, `/projects/${pid(projectPath)}`));
  },

  async listAllFiles(token, projectPath, branch) {
    const out: { path: string }[] = [];
    let page = 1;
    for (;;) {
      const res = await glRaw(
        token,
        `/projects/${pid(projectPath)}/repository/tree?recursive=true&ref=${encodeURIComponent(
          branch
        )}&per_page=100&page=${page}`
      );
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new ProviderError(res.status, `GitLab ${res.status}: ${body.slice(0, 300)}`);
      }
      const batch = (await res.json()) as { path: string; type: string }[];
      for (const t of batch) if (t.type === "blob") out.push({ path: t.path });
      const next = res.headers.get("x-next-page");
      if (!next) break;
      page = Number(next);
      if (!page || page > 1000) break; // 保險：避免無限迴圈
    }
    return out;
  },

  async readFile(token, projectPath, filePath) {
    const branch = await defaultBranch(token, projectPath);
    const data = await gl<{ content: string; blob_id: string; file_path: string; encoding: string }>(
      token,
      `/projects/${pid(projectPath)}/repository/files/${encFile(filePath)}?ref=${encodeURIComponent(branch)}`
    );
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return { content, sha: data.blob_id, path: data.file_path } satisfies RepoFile;
  },

  async readFileRaw(token, projectPath, filePath) {
    const branch = await defaultBranch(token, projectPath);
    const res = await glRaw(
      token,
      `/projects/${pid(projectPath)}/repository/files/${encFile(filePath)}/raw?ref=${encodeURIComponent(branch)}`
    );
    if (!res.ok) throw new ProviderError(res.status, `GitLab ${res.status}: raw read failed for ${filePath}`);
    return Buffer.from(await res.arrayBuffer());
  },

  async writeFile(token, projectPath, filePath, content, message, _sha, branch, author, isBase64) {
    const url = `/projects/${pid(projectPath)}/repository/files/${encFile(filePath)}`;
    // 團隊模式：token 是某個人的，但 commit 的 author 要記成該成員
    // （committer 仍是 token 帳號，這是 GitLab API 的行為）。
    const encodedContent = isBase64 ? content : Buffer.from(content, "utf8").toString("base64");
    const body = JSON.stringify({
      branch,
      content: encodedContent,
      encoding: "base64",
      commit_message: message,
      ...(author?.name ? { author_name: author.name } : {}),
      ...(author?.email ? { author_email: author.email } : {}),
    });
    const headers = { "Content-Type": "application/json" };
    // 先試更新（PUT）；檔案不存在時 GitLab 回 400，改用建立（POST）。
    let res = await glRaw(token, url, { method: "PUT", body, headers });
    if (res.status === 400) {
      res = await glRaw(token, url, { method: "POST", body, headers });
    }
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new ProviderError(res.status, `GitLab ${res.status}: write failed ${t.slice(0, 200)}`);
    }
    // GitLab 寫入回應不含新 blob sha；回讀一次取 blob_id 供前端後續存檔比對。
    try {
      const f = await gl<{ blob_id: string }>(
        token,
        `/projects/${pid(projectPath)}/repository/files/${encFile(filePath)}?ref=${encodeURIComponent(branch)}`
      );
      return { sha: f.blob_id };
    } catch {
      return { sha: "" };
    }
  },
};

// readFile / readFileRaw 需要 ref；GitLab 沒有「預設分支」隱含值，先查專案。
// 小快取避免同一請求鏈重複打 /projects/:id。
const branchCache = new Map<string, { branch: string; exp: number }>();
async function defaultBranch(token: string, projectPath: string): Promise<string> {
  const key = projectPath;
  const hit = branchCache.get(key);
  if (hit && hit.exp > Date.now()) return hit.branch;
  const p = await gl<GlProject>(token, `/projects/${pid(projectPath)}`);
  const branch = p.default_branch || "main";
  branchCache.set(key, { branch, exp: Date.now() + 5 * 60_000 });
  return branch;
}
