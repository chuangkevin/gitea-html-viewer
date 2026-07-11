import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Me, type RepoInfo } from "../lib/api";

export default function Home() {
  const navigate = useNavigate();
  const [me, setMe] = useState<Me | null>(null);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [filter, setFilter] = useState("");
  const [openRepo, setOpenRepo] = useState("");
  const [newRepo, setNewRepo] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ login: null }));
  }, []);

  useEffect(() => {
    if (me?.login) {
      api.repos().then(setRepos).catch((e) => setError(String(e.message || e)));
    }
  }, [me?.login]);

  function handleOpen() {
    const r = openRepo.trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "").replace(/\/$/, "");
    if (/^[^/\s]+\/[^/\s]+$/.test(r)) navigate(`/edit/${r}`);
    else setError("格式：owner/repo 或 GitHub 網址");
  }

  async function handleDevLogin() {
    setBusy(true);
    try {
      await api.devLogin();
      setMe(await api.me());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateRepo() {
    if (!newRepo.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.createRepo(newRepo.trim(), true);
      location.href = `/edit/${r.fullName}`;
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  const shown = (repos || []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="min-h-screen flex flex-col">
      <header className="border-b border-zinc-800 px-6 py-4 flex items-center justify-between">
        <div className="font-mono font-bold text-lg">
          note<span className="text-sky-400">-bridge</span>
        </div>
        {/* 右上角：登入／使用者 */}
        {me?.login ? (
          <div className="flex items-center gap-3 text-sm text-zinc-400">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-6 w-6 rounded-full" />}
            <span>{me.login}</span>
            <button
              className="text-zinc-500 hover:text-zinc-200"
              onClick={() => api.logout().then(() => location.reload())}
            >
              登出
            </button>
          </div>
        ) : me ? (
          <div className="flex items-center gap-2">
            {me.oauthReady && (
              <a
                href="/api/auth/login"
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400"
              >
                <GitHubIcon className="h-4 w-4" />
                登入
              </a>
            )}
            {me.devMode && (
              <button
                onClick={handleDevLogin}
                disabled={busy}
                className="rounded-lg border border-zinc-800 px-3 py-1.5 text-xs text-zinc-500 hover:border-zinc-600"
              >
                Dev
              </button>
            )}
          </div>
        ) : null}
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-6 py-12 space-y-10">
        {/* 公開瀏覽：不需登入 */}
        <section className="space-y-4">
          <div className="text-center pt-4">
            <h1 className="text-3xl font-bold">
              文件就住在 <span className="text-sky-400">GitHub repo</span> 裡
            </h1>
            <p className="text-zinc-400 max-w-lg mx-auto leading-relaxed mt-3">
              公開 repo 直接讀、直接放簡報，不用登入。
              要編輯或讀私有 repo 時，再用右上角以 GitHub 登入。
            </p>
          </div>
          <div className="flex gap-3 max-w-xl mx-auto">
            <input
              value={openRepo}
              onChange={(e) => setOpenRepo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleOpen()}
              placeholder="owner/repo（例：chuangkevin/gitea-html-viewer）"
              className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm focus:border-sky-600 outline-none font-mono"
            />
            <button
              onClick={handleOpen}
              className="rounded-lg bg-sky-600 px-5 py-2.5 text-sm font-semibold hover:bg-sky-500"
            >
              開啟
            </button>
          </div>
          {error && <p className="text-sm text-red-400 text-center">{error}</p>}
        </section>

        {/* 已登入：我的 repo */}
        {me?.login && (
          <section className="space-y-4 border-t border-zinc-900 pt-8">
            <div>
              <h2 className="text-lg font-bold mb-1">我的 repo</h2>
              <p className="text-xs text-zinc-500">每次存檔都是一個 commit。</p>
            </div>
            <div className="flex gap-3">
              <input
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                placeholder="建立新的私有筆記 repo（例：notes）"
                className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-sm focus:border-sky-600 outline-none"
              />
              <button
                onClick={handleCreateRepo}
                disabled={busy || !newRepo.trim()}
                className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-sky-600 hover:text-sky-400 disabled:opacity-40"
              >
                建立
              </button>
            </div>
            <input
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              placeholder="搜尋…"
              className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2 text-sm focus:border-sky-600 outline-none"
            />
            {!repos ? (
              <p className="text-zinc-500 text-sm">載入 repo 清單…</p>
            ) : (
              <ul className="divide-y divide-zinc-900 border border-zinc-800 rounded-lg overflow-hidden">
                {shown.slice(0, 30).map((r) => (
                  <li key={r.fullName}>
                    <Link
                      to={`/edit/${r.fullName}`}
                      className="flex items-center justify-between px-4 py-3 hover:bg-zinc-900 transition-colors"
                    >
                      <span className="font-mono text-sm">{r.fullName}</span>
                      <span className="text-xs text-zinc-600">
                        {r.private ? "private" : "public"} · {r.defaultBranch}
                      </span>
                    </Link>
                  </li>
                ))}
                {shown.length === 0 && (
                  <li className="px-4 py-6 text-center text-sm text-zinc-600">沒有符合的 repo</li>
                )}
              </ul>
            )}
          </section>
        )}
      </main>
    </div>
  );
}

export function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 16 16" className={className} fill="currentColor" aria-hidden>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
    </svg>
  );
}
