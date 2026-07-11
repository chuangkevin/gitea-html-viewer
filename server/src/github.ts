/**
 * GitHub REST API 薄封裝。所有呼叫都帶使用者自己的 token —
 * note-bridge 不代管任何內容，GitHub repo 就是唯一資料庫。
 */

const API = "https://api.github.com";

export class GitHubError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function gh<T>(token: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      // token 為空字串時走匿名請求（只能讀 public，rate limit 較低）
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "note-bridge",
      ...(init?.headers || {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new GitHubError(res.status, `GitHub ${res.status}: ${body.slice(0, 300)}`);
  }
  return (await res.json()) as T;
}

export interface GhUser {
  login: string;
  avatar_url: string;
}

export function getUser(token: string): Promise<GhUser> {
  return gh<GhUser>(token, "/user");
}

export interface GhRepo {
  full_name: string;
  private: boolean;
  default_branch: string;
  pushed_at: string;
  permissions?: { push?: boolean };
}

export async function listRepos(token: string): Promise<GhRepo[]> {
  // 只列使用者有 push 權限的 repo，依最近活動排序
  const repos = await gh<GhRepo[]>(token, "/user/repos?sort=pushed&per_page=100");
  return repos.filter((r) => r.permissions?.push);
}

export function createRepo(token: string, name: string, isPrivate: boolean): Promise<GhRepo> {
  return gh<GhRepo>(token, "/user/repos", {
    method: "POST",
    body: JSON.stringify({
      name,
      private: isPrivate,
      auto_init: true,
      description: "Notes managed with note-bridge",
    }),
  });
}

export interface GhTreeItem {
  path: string;
  type: "blob" | "tree";
  sha: string;
}

/** 列出 repo 內全部檔案（遞迴 git tree，一次拿完）。巢狀樹由 client 端組。 */
export async function listAllFiles(token: string, repo: string, branch: string): Promise<GhTreeItem[]> {
  const data = await gh<{ tree: GhTreeItem[]; truncated: boolean }>(
    token,
    `/repos/${repo}/git/trees/${encodeURIComponent(branch)}?recursive=1`
  );
  return data.tree.filter((t) => t.type === "blob");
}

/** 以 raw bytes 讀檔（HTML/CSS/JS/圖片等靜態資產用；contents API 的 raw accept）。 */
export async function readFileRaw(token: string, repo: string, filePath: string): Promise<Buffer> {
  const res = await fetch(`${API}/repos/${repo}/contents/${encodePath(filePath)}`, {
    headers: {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      Accept: "application/vnd.github.raw",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "note-bridge",
    },
  });
  if (!res.ok) {
    throw new GitHubError(res.status, `GitHub ${res.status}: raw read failed for ${filePath}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

export interface GhFile {
  content: string;
  sha: string;
  path: string;
}

export async function readFile(token: string, repo: string, filePath: string): Promise<GhFile> {
  const data = await gh<{ content: string; sha: string; path: string; encoding: string }>(
    token,
    `/repos/${repo}/contents/${encodePath(filePath)}`
  );
  const content = Buffer.from(data.content, "base64").toString("utf8");
  return { content, sha: data.sha, path: data.path };
}

export async function writeFile(
  token: string,
  repo: string,
  filePath: string,
  content: string,
  message: string,
  sha?: string
): Promise<{ sha: string }> {
  const data = await gh<{ content: { sha: string } }>(token, `/repos/${repo}/contents/${encodePath(filePath)}`, {
    method: "PUT",
    body: JSON.stringify({
      message,
      content: Buffer.from(content, "utf8").toString("base64"),
      ...(sha ? { sha } : {}),
    }),
  });
  return { sha: data.content.sha };
}

export function getRepo(token: string, repo: string): Promise<GhRepo> {
  return gh<GhRepo>(token, `/repos/${repo}`);
}

/** path 各段個別編碼，保留斜線結構 */
function encodePath(p: string): string {
  return p.split("/").map(encodeURIComponent).join("/");
}

// ── OAuth ──────────────────────────────────────────────
export async function exchangeCode(clientId: string, clientSecret: string, code: string): Promise<string> {
  const res = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  });
  const data = (await res.json()) as { access_token?: string; error_description?: string };
  if (!data.access_token) {
    throw new GitHubError(401, data.error_description || "OAuth token exchange failed");
  }
  return data.access_token;
}
