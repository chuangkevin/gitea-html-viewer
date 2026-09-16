/**
 * 自架 Gitea REST API 薄封裝，實作 Provider 介面。
 * base URL 不寫死，由環境變數 GITEA_URL 決定（例：https://gitea.ia，
 * 去尾斜線後 API base 為 ${GITEA_URL}/api/v1）。
 *
 * 與 GitHub 的主要差異（實作重點）：
 *   - OAuth token 會過期（約 3600s），必須實作 refreshTokens
 *   - repo 清單要翻頁（limit=50，最多 20 頁）、沒有 pushed_at（用 updated_at）
 *   - 列檔 tree 翻頁看回應的 truncated 欄位（per_page=1000，最多 50 頁）
 *   - 寫檔：新增＝POST、更新＝PUT（有帶 sha 即更新）
 *   - 搬檔／批次搬刪：一次 POST /repos/{p}/contents 用 files 操作，單一 commit
 */
import type { Provider, ProviderUser, RepoMeta, RepoFile, OAuthTokens, CommitAuthor } from "./providers.js";
import { ProviderError, UPSTREAM_TIMEOUT_MS, withUpstreamSignal, mapUpstreamTimeout } from "./providers.js";

/** 呼叫時讀 GITEA_URL（不要在模組載入時 cache），去尾斜線；未設定就丟錯 */
function baseUrl(): string {
  const url = (process.env.GITEA_URL || "").trim().replace(/\/+$/, "");
  if (!url) throw new ProviderError(500, "GITEA_URL 未設定");
  return url;
}

const API = "/api/v1";

async function gt<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${API}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        "User-Agent": "note-bridge",
        ...(init?.headers || {}),
      },
      signal: withUpstreamSignal(init),
    });
  } catch (err) {
    mapUpstreamTimeout(err, "Gitea");
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(res.status, `Gitea ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface GtRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  updated_at: string;
  permissions?: { push?: boolean };
}

function toMeta(r: GtRepo): RepoMeta {
  return {
    projectPath: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    pushedAt: r.updated_at,
    canPush: Boolean(r.permissions?.push),
  };
}

/** path 各段個別編碼，保留斜線結構 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

function authorBody(author?: CommitAuthor): Record<string, unknown> {
  return author?.name && author?.email ? { author: { name: author.name, email: author.email } } : {};
}

export const gitea: Provider = {
  name: "gitea",

  authorizeUrl(clientId, redirectUri, state) {
    const url = new URL(`${baseUrl()}/login/oauth/authorize`);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", "read:user write:repository");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl()}/login/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          code,
          grant_type: "authorization_code",
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      mapUpstreamTimeout(err, "Gitea");
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!data.access_token) throw new ProviderError(401, data.error_description || "OAuth token exchange failed");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  },

  async refreshTokens(clientId, clientSecret, refreshToken, redirectUri) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl()}/login/oauth/access_token`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          client_secret: clientSecret,
          refresh_token: refreshToken,
          grant_type: "refresh_token",
          redirect_uri: redirectUri,
        }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      mapUpstreamTimeout(err, "Gitea");
    }
    const data = (await res.json()) as { access_token?: string; refresh_token?: string; expires_in?: number; error_description?: string };
    if (!data.access_token) throw new ProviderError(401, data.error_description || "OAuth token refresh failed");
    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      expiresAt: Date.now() + (data.expires_in ?? 3600) * 1000,
    };
  },

  async getUser(token) {
    const u = await gt<{ login: string; avatar_url: string }>(token, "/user");
    return { login: u.login, avatarUrl: u.avatar_url } satisfies ProviderUser;
  },

  async listRepos(token) {
    const out: GtRepo[] = [];
    let page = 1;
    for (;;) {
      const batch = await gt<GtRepo[]>(token, `/user/repos?page=${page}&limit=50`);
      out.push(...batch);
      if (batch.length < 50) break;
      page++;
      if (page > 20) break; // 保險：避免無限迴圈
    }
    return out.filter((r) => r.permissions?.push).map(toMeta);
  },

  async createRepo(token, name, isPrivate) {
    const r = await gt<GtRepo>(token, "/user/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name,
        private: isPrivate,
        auto_init: true,
        default_branch: "main",
        description: "Notes managed with note-bridge",
      }),
    });
    return toMeta(r);
  },

  async getRepo(token, projectPath) {
    return toMeta(await gt<GtRepo>(token, `/repos/${projectPath}`));
  },

  async listAllFiles(token, projectPath, branch) {
    const out: { path: string }[] = [];
    let page = 1;
    for (;;) {
      const data = await gt<{
        tree: { path: string; type: string }[];
        truncated: boolean;
        total_count: number;
        page: number;
      }>(
        token,
        `/repos/${projectPath}/git/trees/${encodeURIComponent(branch)}?recursive=true&page=${page}&per_page=1000`
      );
      for (const t of data.tree ?? []) if (t.type === "blob") out.push({ path: t.path });
      if (!data.truncated) break;
      page++;
      if (page > 50) break; // 保險：避免無限迴圈
    }
    return out;
  },

  async readFile(token, projectPath, filePath) {
    const data = await gt<{ content: string; sha: string; path: string; type: string; encoding?: string }>(
      token,
      `/repos/${projectPath}/contents/${encodePath(filePath)}`
    );
    if (data.type !== "file") {
      throw new ProviderError(400, `Gitea 400: 不是檔案（type=${data.type}）：${filePath}`);
    }
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return { content, sha: data.sha, path: data.path } satisfies RepoFile;
  },

  async readFileRaw(token, projectPath, filePath) {
    let res: Response;
    try {
      res = await fetch(`${baseUrl()}${API}/repos/${projectPath}/media/${encodePath(filePath)}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          "User-Agent": "note-bridge",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      mapUpstreamTimeout(err, "Gitea");
    }
    if (!res.ok) throw new ProviderError(res.status, `Gitea ${res.status}: raw read failed for ${filePath}`);
    return Buffer.from(await res.arrayBuffer());
  },

  async writeFile(token, projectPath, filePath, content, message, sha, _branch, author, isBase64) {
    const encodedContent = isBase64 ? content : Buffer.from(content, "utf8").toString("base64");
    // Gitea：沒有 sha＝新增（POST）、有 sha＝更新（PUT）
    const fileBody = JSON.stringify({
      message,
      content: encodedContent,
      ...authorBody(author),
    });
    const init: RequestInit = sha
      ? { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...JSON.parse(fileBody), sha }) }
      : { method: "POST", headers: { "Content-Type": "application/json" }, body: fileBody };
    const data = await gt<{ content: { sha: string } }>(token, `/repos/${projectPath}/contents/${encodePath(filePath)}`, init);
    return { sha: data.content.sha };
  },

  async moveFile(token, projectPath, fromPath, toPath, message, branch, author) {
    await gt(token, `/repos/${projectPath}/contents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        ...(branch ? { branch } : {}),
        ...authorBody(author),
        files: [{ operation: "rename", from_path: fromPath, path: toPath }],
      }),
    });
  },

  async deleteFile(token, projectPath, filePath, message, branch, author) {
    const src = await gt<{ sha: string; type?: string }>(
      token,
      `/repos/${projectPath}/contents/${encodePath(filePath)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`
    );
    if (!src?.sha || Array.isArray(src) || src.type === "dir") {
      throw new ProviderError(400, `無法讀取來源檔案：${filePath}`);
    }

    await gt(token, `/repos/${projectPath}/contents/${encodePath(filePath)}`, {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        sha: src.sha,
        ...(branch ? { branch } : {}),
        ...authorBody(author),
      }),
    });
  },

  async batchMoveFiles(token, projectPath, moves, message, branch, author) {
    await gt(token, `/repos/${projectPath}/contents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        ...(branch ? { branch } : {}),
        ...authorBody(author),
        files: moves.map((m) => ({ operation: "rename", from_path: m.from, path: m.to })),
      }),
    });
  },

  async batchDeleteFiles(token, projectPath, paths, message, branch, author) {
    const byPath = new Map<string, string>();
    let page = 1;
    for (;;) {
      const data = await gt<{
        tree: { path: string; type: string; sha: string }[];
        truncated: boolean;
      }>(
        token,
        `/repos/${projectPath}/git/trees/${encodeURIComponent(branch)}?recursive=true&page=${page}&per_page=1000`
      );
      for (const t of data.tree ?? []) {
        if (t.type === "blob") byPath.set(t.path, t.sha);
      }
      if (!data.truncated) break;
      page++;
      if (page > 50) break;
    }
    const files: { operation: "delete"; path: string; sha: string }[] = [];
    for (const p of paths) {
      const sha = byPath.get(p);
      if (!sha) throw new ProviderError(400, `找不到來源檔案：${p}`);
      files.push({ operation: "delete", path: p, sha });
    }
    await gt(token, `/repos/${projectPath}/contents`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        ...(branch ? { branch } : {}),
        ...authorBody(author),
        files,
      }),
    });
  },
};
