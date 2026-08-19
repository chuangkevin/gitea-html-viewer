/** 團隊模式成員：前端永遠只拿得到 name / email，拿不到 token。 */
export interface TeamMember {
  name: string;
  email: string;
  provider: string;
}

export interface TeamInfo {
  enabled: boolean;
  members: TeamMember[];
  selected: { index: number; name: string; email: string } | null;
}

export interface Me {
  login: string | null;
  avatarUrl?: string;
  provider?: string;
  providers?: { github: boolean; gitlab: boolean };
  team?: TeamInfo;
  admin?: { enabled: boolean; is: boolean };
}

export type AccessMode = "open" | "login" | "admin";

export interface AdminEntry {
  provider: string;
  project: string;
  mode: AccessMode;
  updatedAt: number;
  updatedBy: string | null;
}

export interface AdminState {
  adminEnabled: boolean;
  isAdmin: boolean;
  openTokenReady?: { github: boolean; gitlab: boolean };
  entries?: AdminEntry[];
}

export interface ShortLink {
  id: string;
  alias: string;
  targetPath: string;
  label: string | null;
  createdBy: string;
  isEnabled: boolean;
  createdAt: number;
  updatedAt: number;
  goUrl: string;
}

/** 管理員可檢視的公開 /s 分享；不含分享者的 session 或 token。 */
export interface AdminShareInventoryItem {
  token: string;
  ownerLogin: string;
  provider: string;
  repo: string;
  path: string | null;
  paths: string[] | null;
  title: string | null;
  kind: "doc" | "set";
  createdAt: number;
  revoked: boolean;
  shareUrl: string;
  slidesUrl?: string;
}

export interface AdminSharesResult {
  shares: AdminShareInventoryItem[];
}

export interface AdminRevokeShareResult {
  ok: boolean;
  revoked: boolean;
}

export interface RepoInfo {
  provider: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  pushedAt: string;
}

export interface ShareInfo {
  token: string;
  repo: string;
  path: string;
  title: string | null;
}

export interface PublicDoc {
  kind: "doc" | "set";
  title: string;
  ownerLogin: string;
  repo: string;
  path?: string;
  content?: string;
  items?: string[];
}

export interface IdentitySuggestion {
  name: string;
  email: string;
  source: "roster" | "history";
  hasToken?: boolean;
}

export interface UserRepoPref {
  provider: string;
  project: string;
  pinned: boolean;
  lastSeenAt: number;
}

export interface UserPrefsResult {
  pinned: UserRepoPref[];
  recent: UserRepoPref[];
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    const err = new Error(body.error || `HTTP ${res.status}`);
    (err as any).status = res.status;
    (err as any).code = body.error;
    throw err;
  }
  return (await res.json()) as T;
}

// filePath 各段編碼，保留斜線結構（給 catch-all route）
const encFilePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export const api = {
  me: () => fetch("/api/me").then((r) => j<Me>(r)),
  logout: () => fetch("/api/auth/logout", { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  /** 團隊模式選身分；index 傳 null = 清除選擇（回唯讀）。 */
  selectIdentity: (index: number | null) =>
    fetch("/api/identity", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ index }),
    }).then((r) => j<{ ok: boolean; selected: { index: number; name: string; email: string } | null }>(r)),
  suggestIdentities: (q: string = "") =>
    fetch(`/api/identities/suggest?q=${encodeURIComponent(q)}`).then((r) => j<IdentitySuggestion[]>(r)),
  repos: () => fetch("/api/repos").then((r) => j<RepoInfo[]>(r)),
  createRepo: (name: string, isPrivate: boolean) =>
    fetch("/api/repos", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, isPrivate }),
    }).then((r) => j<RepoInfo>(r)),
  // ref = `<provider>/<encodeURIComponent(projectPath)>`
  files: (ref: string) =>
    fetch(`/api/files/${ref}`).then((r) =>
      j<{
        branch: string;
        private: boolean;
        canWrite: boolean;
        access: AccessMode;
        guestName: string | null;
        files: { path: string }[];
      }>(r)
    ),
  readFile: (ref: string, path: string) =>
    fetch(`/api/file/${ref}/${encFilePath(path)}`).then((r) => j<{ content: string; sha: string; path: string }>(r)),
  saveFile: (ref: string, path: string, content?: string, sha?: string, message?: string, contentBase64?: string) =>
    fetch(`/api/file/${ref}/${encFilePath(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contentBase64 ? { contentBase64, sha, message } : { content, sha, message }),
    }).then((r) => j<{ sha: string }>(r)),
  uploadFile: (ref: string, path: string, contentBase64: string, message?: string) =>
    fetch(`/api/file/${ref}/${encFilePath(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentBase64, message }),
    }).then((r) => j<{ sha: string }>(r)),
  batchUpload: (ref: string, files: Array<{ path: string; contentBase64: string }>, message?: string) =>
    fetch(`/api/upload/${ref}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, message }),
    }).then((r) =>
      j<{ ok: boolean; count: number; batched: boolean; failed: Array<{ path: string; error: string }> }>(r)
    ),
  setGuestName: (name: string) =>
    fetch("/api/guest-name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    }).then((r) => j<{ ok: boolean; name: string | null }>(r)),
  adminState: () => fetch("/api/admin/state").then((r) => j<AdminState>(r)),
  adminLogin: (key: string) =>
    fetch("/api/admin/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key }),
    }).then((r) => j<{ ok: boolean }>(r)),
  adminLogout: () => fetch("/api/admin/logout", { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
  setRepoAccess: (provider: string, project: string, mode: AccessMode) =>
    fetch("/api/admin/repos", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, project, mode }),
    }).then((r) => j<{ ok: boolean; entries: AdminEntry[] }>(r)),
  deleteRepoAccess: (provider: string, project: string) =>
    fetch("/api/admin/repos", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, project }),
    }).then((r) => j<{ ok: boolean; entries: AdminEntry[] }>(r)),
  listShortLinks: (q: string = "") =>
    fetch(`/api/admin/short-links${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => j<{ links: ShortLink[] }>(r)),
  createShortLink: (body: { alias?: string; targetPath: string; label?: string }) =>
    fetch("/api/admin/short-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<{ link: ShortLink }>(r)),
  updateShortLink: (id: string, body: { targetPath?: string; label?: string | null; isEnabled?: boolean }) =>
    fetch(`/api/admin/short-links/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<{ link: ShortLink }>(r)),
  listAdminShares: (q: string = "") =>
    fetch(`/api/admin/shares${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => j<AdminSharesResult>(r)),
  revokeAdminShare: (token: string) =>
    fetch(`/api/admin/shares/${encodeURIComponent(token)}`, { method: "DELETE" }).then((r) => j<AdminRevokeShareResult>(r)),
  // repo = projectPath（server 依 session 決定 provider）
  share: (repo: string, path: string, title?: string) =>
    fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, path, title }),
    }).then((r) => j<{ token: string; url: string; slidesUrl: string }>(r)),
  rawGrant: (provider: string, repo: string) =>
    fetch("/api/raw-grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, repo }),
    }).then((r) => j<{ grant: string }>(r)),
  setLastRepo: (provider: string, project: string, file?: string) =>
    fetch("/api/prefs/last-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, project, file }),
    }).then((r) => j<{ ok: boolean }>(r)),
  shareSet: (repo: string, paths: string[], title?: string) =>
    fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ repo, paths, title }),
    }).then((r) => j<{ token: string; url: string; slidesUrl: string }>(r)),
  publicDoc: (token: string) => fetch(`/api/public/${token}`).then((r) => j<PublicDoc>(r)),
  publicSetFile: (token: string, path: string) =>
    fetch(`/api/public/${token}/file/${path.split("/").map(encodeURIComponent).join("/")}`).then((r) =>
      j<{ path: string; content: string }>(r)
    ),
  collabConfig: (doc: string) =>
    fetch(`/api/collab/config?doc=${encodeURIComponent(doc)}`).then((r) =>
      j<{ enabled: boolean; user: { name: string; color: string } | null }>(r)
    ),
  getUserPrefs: () => fetch("/api/user-prefs").then((r) => j<UserPrefsResult>(r)),
  updateUserPrefs: (body: {
    action: "upsert" | "delete" | "merge";
    provider?: string;
    project?: string;
    pinned?: boolean;
    lastSeenAt?: number;
    items?: { provider: string; project: string; pinned: boolean; lastSeenAt: number }[];
  }) =>
    fetch("/api/user-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<UserPrefsResult>(r)),
};
