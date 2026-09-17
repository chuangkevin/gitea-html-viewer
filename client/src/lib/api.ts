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
  providers?: { github: boolean; gitlab: boolean; gitea: boolean };
  giteaUrl?: string | null;
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
  openTokenReady?: { github: boolean; gitlab: boolean; gitea: boolean };
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
  branch: string | null;
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
  branch: string | null;
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
export const withGiteaBranch = (url: string, branch?: string) =>
  branch && /\/gitea\//.test(url) ? `${url}${url.includes("?") ? "&" : "?"}ref=${encodeURIComponent(branch)}` : url;

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
  files: (ref: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/files/${ref}`, branch)).then((r) =>
      j<{
        branch: string;
        private: boolean;
        canWrite: boolean;
        access: AccessMode;
        guestName: string | null;
        files: { path: string }[];
      }>(r)
    ),
  access: (ref: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/access/${ref}`, branch)).then((r) =>
      j<{
        branch: string;
        private: boolean;
        canWrite: boolean;
        access: AccessMode;
        guestName: string | null;
      }>(r)
    ),
  readFile: (ref: string, path: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/file/${ref}/${encFilePath(path)}`, branch)).then((r) => j<{ content: string; sha: string; path: string }>(r)),
  saveFile: (ref: string, path: string, content?: string, sha?: string, message?: string, contentBase64?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/file/${ref}/${encFilePath(path)}`, branch), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(contentBase64 ? { contentBase64, sha, message } : { content, sha, message }),
    }).then((r) => j<{ sha: string }>(r)),
  uploadFile: (ref: string, path: string, contentBase64: string, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/file/${ref}/${encFilePath(path)}`, branch), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ contentBase64, message }),
    }).then((r) => j<{ sha: string }>(r)),
  moveFile: (ref: string, from: string, to: string, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/move/${ref}`, branch), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, message }),
    }).then((r) => j<{ ok: boolean; from: string; to: string }>(r)),
  deleteFile: (ref: string, path: string, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/file/${ref}/${encFilePath(path)}`, branch), {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }),
    }).then((r) => j<{ ok: boolean; path: string }>(r)),
  copyFile: (ref: string, from: string, to: string, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/copy/${ref}`, branch), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, message }),
    }).then((r) => j<{ ok: boolean; from: string; to: string }>(r)),
  pathRefs: (ref: string, path: string, kind: "file" | "folder", branch?: string) =>
    fetch(withGiteaBranch(`/api/path-refs/${ref}?path=${encodeURIComponent(path)}&kind=${kind}`, branch)).then((r) =>
      j<{ shares: number; shortLinks: { alias: string; label: string | null }[] }>(r)
    ),
  moveFolder: (ref: string, from: string, to: string, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/move-folder/${ref}`, branch), { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ from, to, message }) }).then((r) => j<{ ok: boolean; from: string; to: string; count: number }>(r)),
  deleteFolder: (ref: string, path: string, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/folder/${ref}/${encFilePath(path)}`, branch), { method: "DELETE", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message }) }).then((r) => j<{ ok: boolean; path: string; count: number }>(r)),
  batchUpload: (ref: string, files: Array<{ path: string; contentBase64: string }>, message?: string, branch?: string) =>
    fetch(withGiteaBranch(`/api/upload/${ref}`, branch), {
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
  share: (provider: string, repo: string, path: string, title?: string, branch?: string) =>
    fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, repo, path, title, branch }),
    }).then((r) => j<{ token: string; url: string; slidesUrl: string }>(r)),
  rawGrant: (provider: string, repo: string) =>
    fetch("/api/raw-grant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, repo }),
    }).then((r) => j<{ grant: string }>(r)),
  setLastRepo: (provider: string, project: string, file?: string, branch?: string) =>
    fetch("/api/prefs/last-repo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, project, file, branch }),
    }).then((r) => j<{ ok: boolean }>(r)),
  shareSet: (provider: string, repo: string, paths: string[], title?: string, branch?: string) =>
    fetch("/api/share", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, repo, paths, title, branch }),
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
  collabFlush: (doc: string) =>
    fetch("/api/collab/flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ doc }),
    }).then((r) => j<{ ok: boolean; lastSavedAt: number | null }>(r)),
  /** 互動 HTML 頁的寫入：先排入佇列立刻回來，由 server 背景合併後 commit。 */
  enqueueFile: (
    ref: string,
    files: Array<{ path: string; content?: string; contentBase64?: string; sha?: string }>,
    sourceGroup?: string,
    message?: string,
    branch?: string
  ) =>
    fetch(withGiteaBranch(`/api/enqueue-file/${ref}`, branch), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ files, sourceGroup, message }),
    }).then((r) => j<{ ok: boolean; jobId: string; status: string; merged: boolean; quietMs: number }>(r)),
  enqueueStatus: (jobId: string, provider: string, project: string, sourceGroup?: string, branch?: string) => {
    const q = new URLSearchParams({ provider, project });
    q.set("jobId", jobId);
    if (sourceGroup) q.set("sourceGroup", sourceGroup);
    if (branch) q.set("ref", branch);
    return fetch(`/api/enqueue-status?${q.toString()}`).then((r) =>
      j<{
        jobId: string;
        status: "pending" | "running" | "done" | "conflict" | "error";
        pending: boolean;
        attempts: number;
        error?: string;
        conflicts?: { path: string; currentSha: string }[];
        files?: Array<{ path: string; content?: string; contentBase64?: string; sha?: string }>;
      }>(r)
    );
  },
  enqueueFlush: (provider: string, project: string, sourceGroup?: string, branch?: string, jobId?: string) =>
    fetch("/api/enqueue-flush", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ provider, project, sourceGroup, ref: branch, jobId }),
      keepalive: true,
    }).then((r) => j<{ ok: boolean; flushed: number; pending: boolean }>(r)),
  getUserPrefs: () => fetch("/api/user-prefs").then((r) => j<UserPrefsResult>(r)),
  updateUserPrefs: (body: {
    action: "upsert" | "delete" | "merge" | "touch";
    provider?: string;
    project?: string;
    branch?: string | null;
    pinned?: boolean;
    lastSeenAt?: number;
    items?: { provider: string; project: string; branch?: string | null; pinned: boolean; lastSeenAt: number }[];
  }) =>
    fetch("/api/user-prefs", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then((r) => j<UserPrefsResult>(r)),
  resolveGiteaUrl: (url: string) =>
    fetch("/api/gitea/resolve-url", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    }).then((r) => j<{ provider: "gitea"; project: string; branch: string; path: string }>(r)),
};
