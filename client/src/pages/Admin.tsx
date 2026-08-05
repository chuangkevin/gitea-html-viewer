import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AccessMode, type AdminState } from "../lib/api";

const MODE_OPTIONS: { value: AccessMode; label: string }[] = [
  { value: "open", label: "免登入公開可編" },
  { value: "login", label: "要登入才能編" },
  { value: "admin", label: "只有 admin 能編" },
];

export default function Admin() {
  const [state, setState] = useState<AdminState | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [actionError, setActionError] = useState("");

  // 新增 entry 表單
  const [newProvider, setNewProvider] = useState<"github" | "gitlab">("gitlab");
  const [newProject, setNewProject] = useState("");
  const [newMode, setNewMode] = useState<AccessMode>("open");

  const loadState = useCallback(() => {
    setActionError("");
    api
      .adminState()
      .then(setState)
      .catch((e) => setActionError(String((e as Error).message || e)));
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  async function handleLogin(e: React.FormEvent) {
    e.preventDefault();
    setLoginError("");
    try {
      await api.adminLogin(keyInput);
      setKeyInput("");
      loadState();
    } catch (e) {
      setLoginError(String((e as Error).message || e));
    }
  }

  async function handleLogout() {
    try {
      await api.adminLogout();
      loadState();
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  async function handleSetMode(provider: string, project: string, mode: AccessMode) {
    try {
      const r = await api.setRepoAccess(provider, project, mode);
      setState((prev) => (prev ? { ...prev, entries: r.entries } : prev));
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  async function handleDelete(provider: string, project: string) {
    try {
      const r = await api.deleteRepoAccess(provider, project);
      setState((prev) => (prev ? { ...prev, entries: r.entries } : prev));
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  async function handleAddEntry(e: React.FormEvent) {
    e.preventDefault();
    const p = newProject.trim();
    if (!p) return;
    try {
      const r = await api.setRepoAccess(newProvider, p, newMode);
      setState((prev) => (prev ? { ...prev, entries: r.entries } : prev));
      setNewProject("");
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  if (!state) {
    return (
      <div className="min-h-screen bg-slate-900 text-slate-100 flex items-center justify-center p-4">
        <div className="text-slate-400">載入中...</div>
      </div>
    );
  }

  // 檢查是否有「設為 open 模式，但 openTokenReady 為 false」的 provider
  const missingTokens: string[] = [];
  if (state.isAdmin && state.openTokenReady && state.entries) {
    const openProviders = new Set(state.entries.filter((e) => e.mode === "open").map((e) => e.provider));
    if (openProviders.has("github") && !state.openTokenReady.github) missingTokens.push("GITHUB_OPEN_TOKEN");
    if (openProviders.has("gitlab") && !state.openTokenReady.gitlab) missingTokens.push("GITLAB_OPEN_TOKEN");
  }

  return (
    <div className="min-h-screen bg-slate-900 text-slate-100 p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Top bar */}
        <div className="flex items-center justify-between border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <Link to="/" className="text-sm text-slate-400 hover:text-white transition">
              ← 返回首頁
            </Link>
            <h1 className="text-xl font-bold text-white">Note Bridge 管理員控制台</h1>
          </div>
          {state.isAdmin && (
            <button
              onClick={handleLogout}
              className="px-3 py-1.5 text-xs bg-slate-800 hover:bg-slate-700 text-slate-300 rounded transition"
            >
              登出管理
            </button>
          )}
        </div>

        {/* Action Error Banner */}
        {actionError && (
          <div className="p-3 text-sm bg-red-900/50 border border-red-700 text-red-200 rounded">
            {actionError}
          </div>
        )}

        {!state.isAdmin ? (
          /* 未登入 admin 狀態 */
          <div className="max-w-md mx-auto mt-12 bg-slate-800/60 border border-slate-700 rounded-lg p-6 space-y-4">
            <h2 className="text-lg font-medium text-white">管理員身分驗證</h2>
            {!state.adminEnabled ? (
              <div className="p-3 text-sm bg-amber-900/40 border border-amber-700/60 text-amber-200 rounded">
                本站尚未設定 ADMIN_KEY，請在 .env 設定後重啟容器
              </div>
            ) : (
              <form onSubmit={handleLogin} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-300 mb-1">管理密碼 (ADMIN_KEY)</label>
                  <input
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    placeholder="請輸入 ADMIN_KEY"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                {loginError && <div className="text-xs text-red-400">{loginError}</div>}
                <button
                  type="submit"
                  className="w-full bg-indigo-600 hover:bg-indigo-500 text-white font-medium py-2 rounded text-sm transition"
                >
                  進入管理
                </button>
              </form>
            )}
          </div>
        ) : (
          /* 已登入 admin 狀態 */
          <div className="space-y-6">
            {/* Warning banner for missing open tokens */}
            {missingTokens.length > 0 && (
              <div className="p-4 bg-amber-950/80 border border-amber-600/80 text-amber-200 rounded-lg space-y-1">
                <div className="font-semibold text-amber-100 flex items-center space-x-2">
                  <span>⚠️ 注意：缺少共用 Token 設定</span>
                </div>
                <div className="text-sm">
                  尚未設定{" "}
                  {missingTokens.map((t, i) => (
                    <span key={t}>
                      {i > 0 && " 與 "}
                      <code className="font-mono text-amber-100">{t}</code>
                    </span>
                  ))}
                  ，這些 repo 現在仍然不能免登入編輯。
                </div>
              </div>
            )}

            {/* 新增 Entry 表單 */}
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-5 space-y-4">
              <h2 className="text-base font-semibold text-white">新增／修改 Repo 存取模式</h2>
              <form onSubmit={handleAddEntry} className="flex flex-wrap items-end gap-3">
                <div>
                  <label className="block text-xs text-slate-400 mb-1">Provider</label>
                  <select
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value as "github" | "gitlab")}
                    className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="gitlab">GitLab</option>
                    <option value="github">GitHub</option>
                  </select>
                </div>
                <div className="flex-1 min-w-[240px]">
                  <label className="block text-xs text-slate-400 mb-1">
                    Project Path <span className="text-slate-500">（填原始路徑，不要 URL-encode）</span>
                  </label>
                  <input
                    type="text"
                    value={newProject}
                    onChange={(e) => setNewProject(e.target.value)}
                    placeholder="interagent-io/interagent-bible"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div>
                  <label className="block text-xs text-slate-400 mb-1">存取模式</label>
                  <select
                    value={newMode}
                    onChange={(e) => setNewMode(e.target.value as AccessMode)}
                    className="bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    {MODE_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="submit"
                  className="bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded font-medium transition"
                >
                  儲存模式
                </button>
              </form>
            </div>

            {/* Existing Entries Table */}
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg overflow-hidden">
              <div className="p-4 border-b border-slate-700 flex justify-between items-center">
                <h2 className="text-base font-semibold text-white">已設定的 Repo 白名單 ({state.entries?.length || 0})</h2>
                <div className="text-xs text-slate-400">未在清單中的 Repo 預設為「要登入才能編」</div>
              </div>
              {!state.entries || state.entries.length === 0 ? (
                <div className="p-8 text-center text-slate-500 text-sm">目前尚無設定任何 repo 存取規則。</div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-sm text-slate-300">
                    <thead className="bg-slate-900/80 text-xs text-slate-400 uppercase tracking-wider border-b border-slate-700">
                      <tr>
                        <th className="px-4 py-3">Provider</th>
                        <th className="px-4 py-3">Project</th>
                        <th className="px-4 py-3">Mode</th>
                        <th className="px-4 py-3">最後更新</th>
                        <th className="px-4 py-3 text-right">操作</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-700/60">
                      {state.entries.map((entry) => (
                        <tr key={`${entry.provider}:${entry.project}`} className="hover:bg-slate-800/40">
                          <td className="px-4 py-3 font-mono text-xs uppercase text-slate-400">{entry.provider}</td>
                          <td className="px-4 py-3 font-medium text-white">{entry.project}</td>
                          <td className="px-4 py-3">
                            <select
                              value={entry.mode}
                              onChange={(e) => handleSetMode(entry.provider, entry.project, e.target.value as AccessMode)}
                              className="bg-slate-900 border border-slate-700 rounded px-2.5 py-1 text-xs text-slate-200 focus:outline-none focus:border-indigo-500"
                            >
                              {MODE_OPTIONS.map((opt) => (
                                <option key={opt.value} value={opt.value}>
                                  {opt.label}
                                </option>
                              ))}
                            </select>
                          </td>
                          <td className="px-4 py-3 text-xs text-slate-400">
                            <div>{new Date(entry.updatedAt).toLocaleString()}</div>
                            {entry.updatedBy && <div className="text-slate-500">by {entry.updatedBy}</div>}
                          </td>
                          <td className="px-4 py-3 text-right">
                            <button
                              onClick={() => handleDelete(entry.provider, entry.project)}
                              className="text-xs text-red-400 hover:text-red-300 bg-red-950/40 hover:bg-red-900/60 border border-red-800/50 px-2.5 py-1 rounded transition"
                            >
                              刪除
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
