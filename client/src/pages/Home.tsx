import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type Me, type RepoInfo } from "../lib/api";

export default function Home() {
  const [me, setMe] = useState<Me | null>(null);
  const [repos, setRepos] = useState<RepoInfo[] | null>(null);
  const [filter, setFilter] = useState("");
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
        {me?.login && (
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
        )}
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-6 py-12">
        {!me ? (
          <p className="text-zinc-500">載入中…</p>
        ) : !me.login ? (
          <div className="text-center space-y-6 pt-16">
            <h1 className="text-3xl font-bold">
              文件就住在你的 <span className="text-sky-400">GitHub repo</span>
            </h1>
            <p className="text-zinc-400 max-w-md mx-auto leading-relaxed">
              網頁編輯 Markdown、存檔即 commit——版本歷史、diff、協作全部交給 Git。
              一鍵把文件變成可分享的獨立網頁，或直接開成簡報。
            </p>
            <div className="flex items-center justify-center gap-3">
              {me.oauthReady && (
                <a
                  href="/api/auth/login"
                  className="inline-flex items-center gap-2 rounded-lg bg-white text-zinc-900 font-semibold px-5 py-2.5 hover:bg-zinc-200"
                >
                  <svg viewBox="0 0 16 16" className="h-5 w-5" fill="currentColor" aria-hidden>
                    <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8z" />
                  </svg>
                  使用 GitHub 登入
                </a>
              )}
              {me.devMode && (
                <button
                  onClick={handleDevLogin}
                  disabled={busy}
                  className="rounded-lg border border-zinc-700 px-4 py-2.5 text-sm text-zinc-300 hover:border-zinc-500"
                >
                  Dev PAT 登入
                </button>
              )}
            </div>
            {!me.oauthReady && !me.devMode && (
              <p className="text-xs text-zinc-600">
                尚未設定 GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET（見 README）
              </p>
            )}
          </div>
        ) : (
          <div className="space-y-8">
            <div>
              <h1 className="text-2xl font-bold mb-1">選擇筆記 repo</h1>
              <p className="text-sm text-zinc-500">note-bridge 會管理 repo 裡的 .md 檔，每次存檔都是一個 commit。</p>
            </div>

            <div className="flex gap-3">
              <input
                value={newRepo}
                onChange={(e) => setNewRepo(e.target.value)}
                placeholder="建立新的私有筆記 repo（例：notes）"
                className="flex-1 rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm focus:border-sky-600 outline-none"
              />
              <button
                onClick={handleCreateRepo}
                disabled={busy || !newRepo.trim()}
                className="rounded-lg bg-sky-600 px-4 py-2.5 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
              >
                建立
              </button>
            </div>

            <div>
              <input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="搜尋現有 repo…"
                className="w-full rounded-lg bg-zinc-900 border border-zinc-800 px-4 py-2.5 text-sm focus:border-sky-600 outline-none mb-3"
              />
              {error && <p className="text-sm text-red-400 mb-3">{error}</p>}
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
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
