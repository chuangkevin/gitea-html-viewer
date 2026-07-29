export interface Me {
  login: string | null;
  avatarUrl?: string;
  provider?: string;
  providers?: { github: boolean; gitlab: boolean };
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

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `HTTP ${res.status}`);
  }
  return (await res.json()) as T;
}

// filePath 各段編碼，保留斜線結構（給 catch-all route）
const encFilePath = (p: string) => p.split("/").map(encodeURIComponent).join("/");

export const api = {
  me: () => fetch("/api/me").then((r) => j<Me>(r)),
  logout: () => fetch("/api/auth/logout", { method: "POST" }).then((r) => j<{ ok: boolean }>(r)),
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
      j<{ branch: string; private: boolean; canWrite: boolean; files: { path: string }[] }>(r)
    ),
  readFile: (ref: string, path: string) =>
    fetch(`/api/file/${ref}/${encFilePath(path)}`).then((r) => j<{ content: string; sha: string; path: string }>(r)),
  saveFile: (ref: string, path: string, content: string, sha?: string) =>
    fetch(`/api/file/${ref}/${encFilePath(path)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, sha }),
    }).then((r) => j<{ sha: string }>(r)),
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
};
