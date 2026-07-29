import { useEffect, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { api, type Me, type RepoInfo } from "../lib/api";
import { parseRepoInput, refPathOf, ProviderIcon, providerLabel } from "../lib/providers";

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
    const q = new URLSearchParams(location.search);
    if (q.get("login") === "unconfigured") {
      setError(`此站尚未設定 ${providerLabel(q.get("provider") || "github")} OAuth，暫時無法登入。`);
    }
  }, []);

  useEffect(() => {
    if (me?.login) {
      api.repos().then(setRepos).catch((e) => setError(String(e.message || e)));
    }
  }, [me?.login]);

  function handleOpen() {
    const parsed = parseRepoInput(openRepo);
    if (!parsed) {
      setError("貼上 GitHub 或 GitLab repo 網址（或 owner/repo）");
      return;
    }
    navigate(`/edit/${refPathOf(parsed.provider, parsed.projectPath)}`);
  }

  async function handleCreateRepo() {
    if (!newRepo.trim()) return;
    setBusy(true);
    setError("");
    try {
      const r = await api.createRepo(newRepo.trim(), true);
      location.href = `/edit/${refPathOf(r.provider, r.fullName)}`;
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setBusy(false);
    }
  }

  const shown = (repos || []).filter((r) => r.fullName.toLowerCase().includes(filter.toLowerCase()));
  const loginProviders = (["github", "gitlab"] as const).filter((p) => me?.providers?.[p]);

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
            {me.provider && <span className="text-xs text-zinc-600">({providerLabel(me.provider)})</span>}
            <button
              className="text-zinc-500 hover:text-zinc-200"
              onClick={() => api.logout().then(() => location.reload())}
            >
              登出
            </button>
          </div>
        ) : me ? (
          <div className="flex items-center gap-2">
            {loginProviders.map((p) => (
              <a
                key={p}
                href={`/api/auth/login?provider=${p}`}
                className="inline-flex items-center gap-2 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400"
              >
                <ProviderIcon provider={p} className="h-4 w-4" />
                {providerLabel(p)}
              </a>
            ))}
          </div>
        ) : null}
      </header>

      <main className="flex-1 max-w-3xl w-full mx-auto px-6 py-12 space-y-10">
        {/* 公開瀏覽：不需登入 */}
        <section className="space-y-4">
          <div className="text-center pt-4">
            <h1 className="text-3xl font-bold">
              文件就住在你的 <span className="text-sky-400">Git repo</span> 裡
            </h1>
            <p className="text-zinc-400 max-w-lg mx-auto leading-relaxed mt-3">
              貼上 GitHub 或 GitLab 的 repo 網址即可瀏覽、放簡報，不用登入。
              要編輯或讀私有 repo 時，再用右上角登入。
            </p>
          </div>
          <div className="flex gap-3 max-w-xl mx-auto">
            <input
              value={openRepo}
              onChange={(e) => setOpenRepo(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleOpen()}
              placeholder="貼上 repo 網址（github.com/… 或 gitlab.com/…）"
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
              <h2 className="text-lg font-bold mb-1">我的 repo（{providerLabel(me.provider || "github")}）</h2>
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
                  <li key={`${r.provider}/${r.fullName}`}>
                    <Link
                      to={`/edit/${refPathOf(r.provider, r.fullName)}`}
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
