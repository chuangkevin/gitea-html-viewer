/** 前端共用：provider 名稱、圖示，以及「貼上網址 → 判斷來源」的解析。 */

export type ProviderName = "github" | "gitlab";

export function providerLabel(p: string): string {
  return p === "gitlab" ? "GitLab" : "GitHub";
}

/** app 路由 / API 路徑用的 repo 參考： `<provider>/<encodeURIComponent(projectPath)>` */
export function refPathOf(provider: string, projectPath: string): string {
  return `${provider}/${encodeURIComponent(projectPath)}`;
}

/**
 * 從貼上的網址或「owner/repo」判斷來源與專案路徑。
 *   https://github.com/owner/repo(.git)(/…)
 *   https://gitlab.com/group/sub/project(/-/…)
 *   owner/repo  → GitHub（向後相容）
 */
export function parseRepoInput(input: string): { provider: ProviderName; projectPath: string } | null {
  const raw = input.trim();
  if (!raw) return null;

  const m = raw.match(/^https?:\/\/([^/]+)\/(.+)$/i);
  if (m) {
    const host = m[1].toLowerCase();
    const rest = m[2];
    if (host === "github.com") {
      const p = cleanGitHub(rest);
      return p ? { provider: "github", projectPath: p } : null;
    }
    if (host === "gitlab.com" || host.startsWith("gitlab.")) {
      const p = cleanGitLab(rest);
      return p ? { provider: "gitlab", projectPath: p } : null;
    }
    return null;
  }

  const bare = raw.replace(/\.git$/, "").replace(/\/+$/, "");
  if (/^[^/\s]+\/[^/\s]+$/.test(bare)) return { provider: "github", projectPath: bare };
  return null;
}

function cleanGitHub(rest: string): string | null {
  const parts = rest.replace(/\.git($|\/)/, "$1").split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return `${parts[0]}/${parts[1]}`;
}

function cleanGitLab(rest: string): string | null {
  let p = rest;
  const dash = p.indexOf("/-/");
  if (dash >= 0) p = p.slice(0, dash);
  p = p.replace(/\.git($|\/)/, "$1").replace(/\/+$/, "");
  const parts = p.split("/").filter(Boolean);
  if (parts.length < 2) return null;
  return parts.join("/");
}

export function ProviderIcon({ provider, className }: { provider: string; className?: string }) {
  return provider === "gitlab" ? <GitLabIcon className={className} /> : <GitHubIcon className={className} />;
}

export function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}

export function GitLabIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M15.73 6.53 15 4.28l-1.45-4.46a.25.25 0 0 0-.48 0l-1.45 4.46H4.38L2.93-.18a.25.25 0 0 0-.48 0L1 4.28.27 6.53a.5.5 0 0 0 .18.56L8 12.63l7.55-5.54a.5.5 0 0 0 .18-.56z" />
    </svg>
  );
}
