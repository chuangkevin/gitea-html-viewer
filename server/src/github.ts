/**
 * GitHub REST API 薄封裝，實作 Provider 介面。所有呼叫都帶使用者自己的
 * token — note-bridge 不代管任何內容，GitHub repo 就是唯一資料庫。
 */
import type { Provider, ProviderUser, RepoMeta, RepoFile } from "./providers.js";
import { ProviderError } from "./providers.js";

const API = "https://api.github.com";

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "note-bridge",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ProviderError(res.status, `GitHub ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string;
  permissions?: { push?: boolean };
}

function toMeta(r: GhRepo): RepoMeta {
  return {
    projectPath: r.full_name,
    private: r.private,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    canPush: Boolean(r.permissions?.push),
  };
}

/** path 各段個別編碼，保留斜線結構 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

export const github: Provider = {
  name: "github",

  authorizeUrl(clientId, redirectUri, state) {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", redirectUri);
    url.searchParams.set("scope", "repo");
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const res = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
    });
    const data = (await res.json()) as { access_token?: string; error_description?: string };
    if (!data.access_token) throw new ProviderError(401, data.error_description || "OAuth token exchange failed");
    return { accessToken: data.access_token };
  },

  async getUser(token) {
    const u = await gh<{ login: string; avatar_url: string }>(token, "/user");
    return { login: u.login, avatarUrl: u.avatar_url } satisfies ProviderUser;
  },

  async listRepos(token) {
    const repos = await gh<GhRepo[]>(token, "/user/repos?sort=pushed&per_page=100");
    return repos.filter((r) => r.permissions?.push).map(toMeta);
  },

  async createRepo(token, name, isPrivate) {
    const r = await gh<GhRepo>(token, "/user/repos", {
      method: "POST",
      body: JSON.stringify({ name, private: isPrivate, auto_init: true, description: "Notes managed with note-bridge" }),
    });
    return toMeta(r);
  },

  async getRepo(token, projectPath) {
    return toMeta(await gh<GhRepo>(token, `/repos/${projectPath}`));
  },

  async listAllFiles(token, projectPath, branch) {
    const data = await gh<{ tree: { path: string; type: string }[]; truncated: boolean }>(
      token,
      `/repos/${projectPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    return data.tree.filter((t) => t.type === "blob").map((t) => ({ path: t.path }));
  },

  async readFile(token, projectPath, filePath) {
    const data = await gh<{ content: string; sha: string; path: string }>(
      token,
      `/repos/${projectPath}/contents/${encodePath(filePath)}`
    );
    const content = Buffer.from(data.content, "base64").toString("utf8");
    return { content, sha: data.sha, path: data.path } satisfies RepoFile;
  },

  async readFileRaw(token, projectPath, filePath) {
    const res = await fetch(`${API}/repos/${projectPath}/contents/${encodePath(filePath)}`, {
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github.raw",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "note-bridge",
      },
    });
    if (!res.ok) throw new ProviderError(res.status, `GitHub ${res.status}: raw read failed for ${filePath}`);
    return Buffer.from(await res.arrayBuffer());
  },

  async writeFile(token, projectPath, filePath, content, message, sha, _branch, _author, isBase64) {
    // GitHub contents API 本來就吃 base64，isBase64 為 true 時直接把傳進來的字串當 content、不要再 encode 一次
    const encodedContent = isBase64 ? content : Buffer.from(content, "utf8").toString("base64");
    const data = await gh<{ content: { sha: string } }>(token, `/repos/${projectPath}/contents/${encodePath(filePath)}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content: encodedContent,
        ...(sha ? { sha } : {}),
      }),
    });
    return { sha: data.content.sha };
  },

  async moveFile(token, projectPath, fromPath, toPath, message, branch, author) {
    const src = await gh<{ content?: string | null; sha: string; encoding?: string; type?: string }>(
      token,
      `/repos/${projectPath}/contents/${encodePath(fromPath)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`
    );
    if (!src?.sha || Array.isArray(src) || src.type === "dir") {
      throw new ProviderError(400, `無法讀取來源檔案：${fromPath}`);
    }
    let content = (src.content || "").replace(/\s/g, "");
    if (!content) {
      const blob = await gh<{ content?: string }>(token, `/repos/${projectPath}/git/blobs/${src.sha}`);
      content = (blob.content || "").replace(/\s/g, "");
    }
    if (!content) {
      throw new ProviderError(400, `來源檔案沒有內容，無法移動：${fromPath}`);
    }

    const authorBody =
      author?.name && author?.email ? { author: { name: author.name, email: author.email } } : {};

    await gh(token, `/repos/${projectPath}/contents/${encodePath(toPath)}`, {
      method: "PUT",
      body: JSON.stringify({
        message,
        content,
        ...(branch ? { branch } : {}),
        ...authorBody,
      }),
    });

    try {
      await gh(token, `/repos/${projectPath}/contents/${encodePath(fromPath)}`, {
        method: "DELETE",
        body: JSON.stringify({
          message,
          sha: src.sha,
          ...(branch ? { branch } : {}),
          ...authorBody,
        }),
      });
    } catch (e: unknown) {
      const detail = e instanceof Error ? e.message : String(e);
      const status = e instanceof ProviderError ? e.status : 500;
      throw new ProviderError(
        status,
        `移動未完成：新檔已建立於「${toPath}」，但舊檔「${fromPath}」刪除失敗。請手動刪除舊檔。${detail}`
      );
    }
  },
};
