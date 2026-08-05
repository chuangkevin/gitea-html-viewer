/**
 * Provider 抽象層：把「文件儲存後端」統一成一個介面，GitHub / GitLab
 * 各自實作。note-bridge 不代管內容，repo 就是唯一資料庫；這層只負責
 * 用使用者自己的 token 去讀寫。
 *
 * 名詞：
 *   projectPath  跨 provider 的專案識別字串
 *                - GitHub： "owner/repo"（固定兩段）
 *                - GitLab： "group/subgroup/project"（可巢狀，段數不定）
 */

export type ProviderName = "github" | "gitlab";

export class ProviderError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export interface ProviderUser {
  login: string;
  avatarUrl: string;
}

export interface RepoMeta {
  projectPath: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
  canPush: boolean;
}

export interface RepoFile {
  content: string;
  sha: string;
  path: string;
}

/**
 * commit 的作者。團隊模式下 token 是「某個人的 token」，但 commit 要記在
 * 該成員名下：committer 是 token 帳號、author 是這裡指定的人。
 */
export interface CommitAuthor {
  name: string;
  email: string;
}

export interface OAuthTokens {
  accessToken: string;
  refreshToken?: string;
  /** epoch ms；沒有就是不會過期 */
  expiresAt?: number;
}

export interface Provider {
  name: ProviderName;

  // ── OAuth ──
  /** 使用者授權頁網址（把使用者導去 provider 登入）。 */
  authorizeUrl(clientId: string, redirectUri: string, state: string): string;
  /** 用授權碼換 access token。 */
  exchangeCode(clientId: string, clientSecret: string, code: string, redirectUri: string): Promise<OAuthTokens>;
  /** 用 refresh token 換新 token。 */
  refreshTokens?(clientId: string, clientSecret: string, refreshToken: string, redirectUri?: string): Promise<OAuthTokens>;

  // ── 內容 ──
  getUser(token: string): Promise<ProviderUser>;
  listRepos(token: string): Promise<RepoMeta[]>;
  createRepo(token: string, name: string, isPrivate: boolean): Promise<RepoMeta>;
  getRepo(token: string, projectPath: string): Promise<RepoMeta>;
  listAllFiles(token: string, projectPath: string, branch: string): Promise<{ path: string }[]>;
  readFile(token: string, projectPath: string, filePath: string): Promise<RepoFile>;
  readFileRaw(token: string, projectPath: string, filePath: string): Promise<Buffer>;
  /** author 省略時就用 token 帳號當作者（個人 OAuth 登入的情況）。 */
  writeFile(
    token: string,
    projectPath: string,
    filePath: string,
    content: string,
    message: string,
    sha: string | undefined,
    branch: string,
    author?: CommitAuthor
  ): Promise<{ sha: string }>;
}

// registry 由 index.ts 用 registerProvider 填入，避免循環相依
const REGISTRY = new Map<ProviderName, Provider>();
export function registerProvider(p: Provider): void {
  REGISTRY.set(p.name, p);
}
export function getProvider(name: string | undefined): Provider {
  const p = name ? REGISTRY.get(name as ProviderName) : undefined;
  if (!p) throw new ProviderError(400, `unknown provider: ${name}`);
  return p;
}
export function isProviderName(x: string): x is ProviderName {
  return x === "github" || x === "gitlab";
}

/**
 * 從「貼上的網址」或「provider/path」判斷來源與專案路徑。
 * 支援：
 *   https://github.com/owner/repo(.git)(/…)
 *   https://gitlab.com/group/sub/project(/-/tree/…)(.git)
 *   owner/repo            → 視為 GitHub（向後相容）
 * 回傳 null 表示無法解析。
 */
export function parseRepoInput(input: string): { provider: ProviderName; projectPath: string } | null {
  const raw = input.trim();
  if (!raw) return null;

  // 完整網址
  const m = raw.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (m) {
    const host = m[1].toLowerCase();
    let rest = m[2];
    if (host === "github.com") {
      const path = cleanGitHubPath(rest);
      return path ? { provider: "github", projectPath: path } : null;
    }
    if (host === "gitlab.com" || host.startsWith("gitlab.")) {
      const path = cleanGitLabPath(rest);
      return path ? { provider: "gitlab", projectPath: path } : null;
    }
    return null;
  }

  // 裸 owner/repo → GitHub
  const bare = raw.replace(/\.git$/, "").replace(/\/+$/, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(bare)) {
    return { provider: "github", projectPath: bare };
  }
  return null;
}

function cleanGitHubPath(rest: string): string | null {
  // owner/repo，砍掉 repo 之後的東西（/tree/... /blob/... 等）與 .git
  const parts = rest.replace(/\.git($|\/)/, "$1").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

function cleanGitLabPath(rest: string): string | null {
  // GitLab 專案路徑可巢狀；`/-/` 之後是 UI 路徑（tree/blob/…），要切掉
  let p = rest;
  const dash = p.indexOf("/-/");
  if (dash >= 0) p = p.slice(0, dash);
  p = p.replace(/\.git($|\/)/, "$1").replace(/\/+$/, "");
  const parts = p.split("/").filter(Boolean);
  if (parts.length < 2) return null; // 至少 group/project
  return parts.join("/");
}

/**
 * 把使用者貼進來的任何形式正規化成 projectPath。
 * 接受：https://gitlab.com/interagent-io/global-doc.git、gitlab.com/interagent-io/global-doc、
 *       interagent-io/global-doc、結尾多餘的 / 或 .git、/-/tree/main/... 之類的尾巴
 * 認不出 host 時用 fallbackProvider。
 */
export function normalizeProjectInput(
  raw: string,
  fallbackProvider: ProviderName
): { provider: ProviderName; projectPath: string } | null {
  let s = raw.trim();
  if (!s) return null;

  s = s.replace(/^https?:\/\//i, "");

  let provider: ProviderName;
  let path = s;

  const gitlabMatch = path.match(/^(gitlab\.com|gitlab\.[^/]+)\/(.*)$/i);
  const githubMatch = path.match(/^(github\.com)\/(.*)$/i);

  if (gitlabMatch) {
    provider = "gitlab";
    path = gitlabMatch[2];
  } else if (githubMatch) {
    provider = "github";
    path = githubMatch[2];
  } else {
    provider = fallbackProvider;
  }

  // 砍掉 `/-/tree/…`、`/-/blob/…`、`/-/…`、`/tree/…`、`/blob/…` 之後的所有東西
  const dashIndex = path.indexOf("/-/");
  if (dashIndex !== -1) {
    path = path.slice(0, dashIndex);
  } else {
    const treeMatch = path.match(/\/(tree|blob)($|\/)/i);
    if (treeMatch && treeMatch.index !== undefined) {
      path = path.slice(0, treeMatch.index);
    }
  }

  // 砍掉結尾的 / 與 .git
  while (path.endsWith("/") || path.endsWith(".git")) {
    if (path.endsWith("/")) {
      path = path.slice(0, -1);
    } else if (path.endsWith(".git")) {
      path = path.slice(0, -4);
    }
  }

  const parts = path.split("/").filter(Boolean);
  if (parts.length < 2) return null;

  const projectPath = parts.join("/");
  return { provider, projectPath };
}

