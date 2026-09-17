/**
 * GitHub REST API 薄封裝，實作 Provider 介面。所有呼叫都帶使用者自己的
 * token — note-bridge 不代管任何內容，GitHub repo 就是唯一資料庫。
 */
import type { Provider, ProviderUser, RepoMeta, RepoFile } from "./providers.js";
import { ProviderError, UPSTREAM_TIMEOUT_MS, withUpstreamSignal, mapUpstreamTimeout } from "./providers.js";

const API = "https://api.github.com";

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "note-bridge",
        ...(init?.headers || {}),
      },
      signal: withUpstreamSignal(init), // AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) + AbortSignal.any if caller passed signal
    });
  } catch (err) {
    mapUpstreamTimeout(err, "GitHub");
  }
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
    mirror: false,
    defaultBranch: r.default_branch,
    pushedAt: r.pushed_at,
    canPush: Boolean(r.permissions?.push),
  };
}

/** path 各段個別編碼，保留斜線結構 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

/** 用 Git Data API 在單一 commit 內套用一組 tree 變更（新增/搬移/刪除）。
 *  entries 直接就是 create-tree 的 tree 陣列元素；刪除用 sha: null。
 *  不用 contents API：那是逐檔 PUT/DELETE，一次一檔＝N 個 commit，中途失敗還會留下半套。 */
async function commitTreeChanges(
  token: string,
  projectPath: string,
  entries: { path: string; mode: string; type: "blob"; sha: string | null }[],
  message: string,
  branch: string,
  author?: { name: string; email: string }
): Promise<void> {
  const ref = await gh<{ object: { sha: string } }>(token, `/repos/${projectPath}/git/ref/heads/${encodeURIComponent(branch)}`);
  const headSha = ref.object.sha;
  const head = await gh<{ tree: { sha: string } }>(token, `/repos/${projectPath}/git/commits/${headSha}`);
  const baseTree = head.tree.sha;
  const newTree = await gh<{ sha: string }>(token, `/repos/${projectPath}/git/trees`, {
    method: "POST",
    body: JSON.stringify({ base_tree: baseTree, tree: entries }),
  });
  const commit = await gh<{ sha: string }>(token, `/repos/${projectPath}/git/commits`, {
    method: "POST",
    body: JSON.stringify({
      message,
      tree: newTree.sha,
      parents: [headSha],
      ...(author?.name && author?.email ? { author: { name: author.name, email: author.email } } : {}),
    }),
  });
  await gh(token, `/repos/${projectPath}/git/refs/heads/${encodeURIComponent(branch)}`, {
    method: "PATCH",
    body: JSON.stringify({ sha: commit.sha }),
  });
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
    let res: Response;
    try {
      res = await fetch("https://github.com/login/oauth/access_token", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code, redirect_uri: redirectUri }),
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      mapUpstreamTimeout(err, "GitHub");
    }
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
    let res: Response;
    try {
      res = await fetch(`${API}/repos/${projectPath}/contents/${encodePath(filePath)}`, {
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          Accept: "application/vnd.github.raw",
          "X-GitHub-Api-Version": "2022-11-28",
          "User-Agent": "note-bridge",
        },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      });
    } catch (err) {
      mapUpstreamTimeout(err, "GitHub");
    }
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

  async deleteFile(token, projectPath, filePath, message, branch, author) {
    const src = await gh<{ sha: string; type?: string }>(
      token,
      `/repos/${projectPath}/contents/${encodePath(filePath)}${branch ? `?ref=${encodeURIComponent(branch)}` : ""}`
    );
    if (!src?.sha || Array.isArray(src) || src.type === "dir") {
      throw new ProviderError(400, `無法讀取來源檔案：${filePath}`);
    }

    const authorBody =
      author?.name && author?.email ? { author: { name: author.name, email: author.email } } : {};

    await gh(token, `/repos/${projectPath}/contents/${encodePath(filePath)}`, {
      method: "DELETE",
      body: JSON.stringify({
        message,
        sha: src.sha,
        ...(branch ? { branch } : {}),
        ...authorBody,
      }),
    });
  },

  /** 單一 commit 搬移整批檔案。不用 contents API（逐檔＝N 個 commit）。 */
  async batchMoveFiles(token, projectPath, moves, message, branch, author) {
    const data = await gh<{ tree: { path: string; mode: string; type: string; sha: string }[] }>(
      token,
      `/repos/${projectPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    const byPath = new Map<string, { mode: string; sha: string }>();
    for (const t of data.tree) {
      if (t.type === "blob") byPath.set(t.path, { mode: t.mode, sha: t.sha });
    }
    const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const m of moves) {
      const src = byPath.get(m.from);
      if (!src) throw new ProviderError(400, `找不到來源檔案：${m.from}`);
      entries.push({ path: m.to, mode: src.mode, type: "blob", sha: src.sha });
      entries.push({ path: m.from, mode: src.mode, type: "blob", sha: null });
    }
    await commitTreeChanges(token, projectPath, entries, message, branch, author);
  },

  /** 單一 commit 刪除整批檔案。不用 contents API（逐檔＝N 個 commit）。 */
  async batchDeleteFiles(token, projectPath, paths, message, branch, author) {
    const data = await gh<{ tree: { path: string; mode: string; type: string; sha: string }[] }>(
      token,
      `/repos/${projectPath}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    );
    const byPath = new Map<string, { mode: string; sha: string }>();
    for (const t of data.tree) {
      if (t.type === "blob") byPath.set(t.path, { mode: t.mode, sha: t.sha });
    }
    const entries: { path: string; mode: string; type: "blob"; sha: string | null }[] = [];
    for (const p of paths) {
      const src = byPath.get(p);
      if (!src) throw new ProviderError(400, `找不到來源檔案：${p}`);
      entries.push({ path: p, mode: src.mode, type: "blob", sha: null });
    }
    await commitTreeChanges(token, projectPath, entries, message, branch, author);
  },
};
