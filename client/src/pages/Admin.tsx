import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { api, type AccessMode, type AdminShareInventoryItem, type AdminState, type ShortLink } from "../lib/api";

const MODE_OPTIONS: { value: AccessMode; label: string }[] = [
  { value: "open", label: "免登入公開可編" },
  { value: "login", label: "要登入才能編" },
  { value: "admin", label: "只有 admin 能編" },
];

type ShortLinkDraft = { targetPath: string; label: string; isEnabled: boolean };

export function normalizeProjectInput(
  raw: string,
  fallbackProvider: string
): { provider: string; project: string } {
  let str = raw.trim();
  if (!str) {
    return { provider: fallbackProvider, project: "" };
  }

  // 砍掉開頭的 https:// 或 http://
  str = str.replace(/^https?:\/\//i, "");

  // 判斷 provider
  let provider = fallbackProvider;
  if (/^gitlab\.com\//i.test(str)) {
    provider = "gitlab";
    str = str.replace(/^gitlab\.com\//i, "");
  } else if (/^github\.com\//i.test(str)) {
    provider = "github";
    str = str.replace(/^github\.com\//i, "");
  }

  // 砍掉 /-/tree/...、/-/blob/...、/tree/...、/blob/... 及其後面的東西
  str = str.replace(/\/(?:-\/)?(?:tree|blob)(?:[\/\?#].*)?$/i, "");

  // 砍掉結尾的 .git 與 /
  str = str.replace(/(\.git)?\/+$/i, "").replace(/\.git$/i, "");

  return { provider, project: str };
}

export default function Admin() {
  const [state, setState] = useState<AdminState | null>(null);
  const [keyInput, setKeyInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [actionError, setActionError] = useState("");

  // 新增 entry 表單
  const [newProvider, setNewProvider] = useState<"github" | "gitlab">("gitlab");
  const [newProject, setNewProject] = useState("");
  const [newMode, setNewMode] = useState<AccessMode>("open");

  const [shortLinks, setShortLinks] = useState<ShortLink[]>([]);
  const [shortDrafts, setShortDrafts] = useState<Record<string, ShortLinkDraft>>({});
  const [shortSearch, setShortSearch] = useState("");
  const [newShortAlias, setNewShortAlias] = useState("");
  const [newShortTarget, setNewShortTarget] = useState("");
  const [newShortLabel, setNewShortLabel] = useState("");
  const [shortLinkNotice, setShortLinkNotice] = useState("");
  const [copiedShortLink, setCopiedShortLink] = useState<string | null>(null);

  const [adminShares, setAdminShares] = useState<AdminShareInventoryItem[]>([]);
  const [shareSearch, setShareSearch] = useState("");
  const [sharesLoading, setSharesLoading] = useState(false);
  const [shareError, setShareError] = useState("");
  const [shareNotice, setShareNotice] = useState("");
  const [copiedShareUrl, setCopiedShareUrl] = useState<string | null>(null);
  const [revokingShareToken, setRevokingShareToken] = useState<string | null>(null);

  function handleBlurProject() {
    if (!newProject.trim()) return;
    const normalized = normalizeProjectInput(newProject, newProvider);
    setNewProject(normalized.project);
    if (normalized.provider === "github" || normalized.provider === "gitlab") {
      if (normalized.provider !== newProvider) {
        setNewProvider(normalized.provider as "github" | "gitlab");
      }
    }
  }

  function applyShortLinks(links: ShortLink[]) {
    setShortLinks(links);
    const drafts: Record<string, ShortLinkDraft> = {};
    for (const link of links) {
      drafts[link.id] = { targetPath: link.targetPath, label: link.label || "", isEnabled: link.isEnabled };
    }
    setShortDrafts(drafts);
  }

  const loadShortLinks = useCallback((query?: string) => {
    setActionError("");
    api
      .listShortLinks(query ?? shortSearch)
      .then((r) => applyShortLinks(r.links))
      .catch((e) => setActionError(String((e as Error).message || e)));
  }, [shortSearch]);

  const loadAdminShares = useCallback((query = "") => {
    setShareError("");
    setSharesLoading(true);
    api
      .listAdminShares(query)
      .then((r) => setAdminShares(r.shares))
      .catch((e) => setShareError(String((e as Error).message || e)))
      .finally(() => setSharesLoading(false));
  }, []);

  const loadState = useCallback(() => {
    setActionError("");
    api
      .adminState()
      .then((next) => {
        setState(next);
      })
      .catch((e) => setActionError(String((e as Error).message || e)));
  }, []);

  useEffect(() => {
    loadState();
  }, [loadState]);

  useEffect(() => {
    if (state?.isAdmin) loadShortLinks();
  }, [state?.isAdmin, loadShortLinks]);

  useEffect(() => {
    if (state?.isAdmin) loadAdminShares();
  }, [state?.isAdmin, loadAdminShares]);

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
    const normalized = normalizeProjectInput(newProject, newProvider);
    const p = normalized.project;
    const providerToSend =
      normalized.provider === "github" || normalized.provider === "gitlab"
        ? normalized.provider
        : newProvider;
    if (!p) return;
    try {
      const r = await api.setRepoAccess(providerToSend, p, newMode);
      setState((prev) => (prev ? { ...prev, entries: r.entries } : prev));
      setNewProject("");
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  function updateShortDraft(id: string, patch: Partial<ShortLinkDraft>) {
    setShortDrafts((prev) => ({ ...prev, [id]: { ...prev[id], ...patch } }));
  }

  async function copyTextToClipboard(text: string) {
    if (navigator.clipboard?.writeText) {
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        prompt("請複製以下短網址：", text);
      }
    } else {
      prompt("請複製以下短網址：", text);
    }
  }

  async function handleCopyShortLink(link: ShortLink) {
    await copyTextToClipboard(link.goUrl);
    setCopiedShortLink(link.id);
    setTimeout(() => setCopiedShortLink((id) => (id === link.id ? null : id)), 1600);
  }

  async function handleCopyAdminShare(share: AdminShareInventoryItem) {
    await copyTextToClipboard(share.shareUrl);
    setCopiedShareUrl(share.token);
    setTimeout(() => setCopiedShareUrl((token) => (token === share.token ? null : token)), 1600);
  }

  async function handleRevokeAdminShare(share: AdminShareInventoryItem) {
    if (!window.confirm(`確定撤銷 ${share.shareUrl}？撤銷後連結將立即失效。`)) return;
    setShareError("");
    setShareNotice("");
    setRevokingShareToken(share.token);
    try {
      await api.revokeAdminShare(share.token);
      setShareNotice(`已撤銷 ${share.shareUrl}`);
      loadAdminShares(shareSearch);
    } catch (e) {
      setShareError(String((e as Error).message || e));
    } finally {
      setRevokingShareToken(null);
    }
  }

  async function handleAddShortLink(e: React.FormEvent) {
    e.preventDefault();
    setActionError("");
    setShortLinkNotice("");
    try {
      const r = await api.createShortLink({
        alias: newShortAlias.trim() || undefined,
        targetPath: newShortTarget.trim(),
        label: newShortLabel.trim() || undefined,
      });
      setNewShortAlias("");
      setNewShortTarget("");
      setNewShortLabel("");
      setShortLinkNotice(`已建立 ${r.link.goUrl}`);
      loadShortLinks();
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  async function handleSaveShortLink(link: ShortLink) {
    const draft = shortDrafts[link.id];
    if (!draft) return;
    setActionError("");
    setShortLinkNotice("");
    try {
      await api.updateShortLink(link.id, {
        targetPath: draft.targetPath,
        label: draft.label || null,
        isEnabled: draft.isEnabled,
      });
      setShortLinkNotice(`已更新 /go/${link.alias}`);
      loadShortLinks();
    } catch (e) {
      setActionError(String((e as Error).message || e));
    }
  }

  async function handleToggleShortLink(link: ShortLink) {
    setActionError("");
    setShortLinkNotice("");
    try {
      await api.updateShortLink(link.id, { isEnabled: !link.isEnabled });
      setShortLinkNotice(`${link.isEnabled ? "已停用" : "已啟用"} /go/${link.alias}`);
      loadShortLinks();
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
    <div className="min-h-screen bg-slate-900 text-slate-100 p-3 sm:p-6">
      <div className="max-w-5xl mx-auto space-y-6">
        {/* Top bar */}
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-800 pb-4">
          <div className="flex items-center space-x-3">
            <Link to="/" className="text-sm text-slate-400 hover:text-white transition">
              ← 返回首頁
            </Link>
            <h1 className="text-base sm:text-xl font-bold text-white">Note Bridge 管理員控制台</h1>
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

            {/* Short links */}
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-5 space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <h2 className="text-base font-semibold text-white">內部短網址</h2>
                  <p className="text-xs text-slate-400 leading-5">
                    建立 <code className="font-mono text-slate-200">/go/alias</code> redirect。只導向既有 Note 頁面，不會賦予任何額外存取權。
                  </p>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    loadShortLinks(shortSearch);
                  }}
                  className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto"
                >
                  <input
                    type="search"
                    value={shortSearch}
                    onChange={(e) => setShortSearch(e.target.value)}
                    placeholder="搜尋 alias、label、target"
                    className="w-full lg:w-72 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    className="w-full sm:w-auto bg-slate-700 hover:bg-slate-600 text-white text-sm px-4 py-2 rounded font-medium transition whitespace-nowrap"
                  >
                    搜尋
                  </button>
                </form>
              </div>

              <form onSubmit={handleAddShortLink} className="grid gap-3 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,2fr)_minmax(0,1fr)_auto] lg:items-end">
                <div className="min-w-0">
                  <label className="block text-xs text-slate-400 mb-1">Alias（可留空自動產生）</label>
                  <input
                    type="text"
                    value={newShortAlias}
                    onChange={(e) => setNewShortAlias(e.target.value.toLowerCase())}
                    placeholder="erp"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="min-w-0">
                  <label className="block text-xs text-slate-400 mb-1">Target path</label>
                  <input
                    type="text"
                    value={newShortTarget}
                    onChange={(e) => setNewShortTarget(e.target.value)}
                    placeholder="/edit/gitlab/interagent-io%2Fglobal-doc?f=README.md"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
                  />
                </div>
                <div className="min-w-0">
                  <label className="block text-xs text-slate-400 mb-1">Label</label>
                  <input
                    type="text"
                    value={newShortLabel}
                    onChange={(e) => setNewShortLabel(e.target.value)}
                    placeholder="ERP 首頁"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <button
                  type="submit"
                  className="w-full lg:w-auto bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded font-medium transition whitespace-nowrap"
                >
                  建立短網址
                </button>
              </form>

              {shortLinkNotice && (
                <div className="rounded border border-emerald-800/70 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200 break-all">
                  {shortLinkNotice}
                </div>
              )}

              {shortLinks.length === 0 ? (
                <div className="rounded border border-slate-700/70 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
                  目前沒有符合條件的短網址。
                </div>
              ) : (
                <div className="grid gap-3">
                  {shortLinks.map((link) => {
                    const draft = shortDrafts[link.id] || { targetPath: link.targetPath, label: link.label || "", isEnabled: link.isEnabled };
                    return (
                      <div key={link.id} className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3 min-w-0">
                        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs border ${
                                  link.isEnabled
                                    ? "border-emerald-700 bg-emerald-950/60 text-emerald-300"
                                    : "border-slate-600 bg-slate-800 text-slate-400"
                                }`}
                              >
                                {link.isEnabled ? "啟用" : "停用"}
                              </span>
                              <a href={link.goUrl} target="_blank" rel="noreferrer" className="font-mono text-sm text-sky-300 hover:underline break-all">
                                {link.goUrl}
                              </a>
                            </div>
                            <div className="text-xs text-slate-500 font-mono break-all">alias: {link.alias}</div>
                          </div>
                          <div className="flex flex-wrap gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleCopyShortLink(link)}
                              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-sky-600 hover:text-sky-300 transition whitespace-nowrap"
                            >
                              {copiedShortLink === link.id ? "已複製" : "Copy"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleToggleShortLink(link)}
                              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-amber-600 hover:text-amber-300 transition whitespace-nowrap"
                            >
                              {link.isEnabled ? "停用" : "啟用"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleSaveShortLink(link)}
                              className="rounded bg-indigo-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-indigo-500 transition whitespace-nowrap"
                            >
                              儲存變更
                            </button>
                          </div>
                        </div>

                        <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,2fr)_auto] lg:items-end">
                          <div className="min-w-0">
                            <label className="block text-xs text-slate-400 mb-1">Label</label>
                            <input
                              type="text"
                              value={draft.label}
                              onChange={(e) => updateShortDraft(link.id, { label: e.target.value })}
                              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                            />
                          </div>
                          <div className="min-w-0">
                            <label className="block text-xs text-slate-400 mb-1">Target</label>
                            <input
                              type="text"
                              value={draft.targetPath}
                              onChange={(e) => updateShortDraft(link.id, { targetPath: e.target.value })}
                              className="w-full bg-slate-950 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500 font-mono"
                            />
                          </div>
                          <label className="inline-flex items-center gap-2 text-sm text-slate-300 whitespace-nowrap">
                            <input
                              type="checkbox"
                              checked={draft.isEnabled}
                              onChange={(e) => updateShortDraft(link.id, { isEnabled: e.target.checked })}
                              className="h-4 w-4 accent-indigo-500"
                            />
                            啟用
                          </label>
                        </div>

                        <div className="grid gap-1 text-xs text-slate-500 sm:grid-cols-2">
                          <div className="break-all">建立：{new Date(link.createdAt).toLocaleString()} by {link.createdBy}</div>
                          <div className="break-all sm:text-right">更新：{new Date(link.updatedAt).toLocaleString()}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Public share inventory */}
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-5 space-y-4">
              <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                <div className="space-y-1 min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-white">公開分享網址</h2>
                    <span className="rounded-full border border-sky-800 bg-sky-950/50 px-2 py-0.5 text-xs text-sky-200">
                      未撤銷 {adminShares.filter((share) => !share.revoked).length}／本次結果 {adminShares.length}
                    </span>
                  </div>
                  <p className="text-xs text-slate-400 leading-5">
                    這裡列出 Note 建立的 <code className="font-mono text-slate-200">/s/</code> 公開分享；只複製的 <code className="font-mono text-slate-200">/edit</code>、<code className="font-mono text-slate-200">/site</code> 等長網址不會被記錄，舊資料無法回推。
                  </p>
                </div>
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    loadAdminShares(shareSearch);
                  }}
                  className="flex flex-col sm:flex-row gap-2 w-full lg:w-auto"
                >
                  <input
                    type="search"
                    value={shareSearch}
                    onChange={(e) => setShareSearch(e.target.value)}
                    placeholder="搜尋 token、建立者、repo、檔案"
                    className="w-full lg:w-80 bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                  <button
                    type="submit"
                    className="w-full sm:w-auto bg-slate-700 hover:bg-slate-600 text-white text-sm px-4 py-2 rounded font-medium transition whitespace-nowrap"
                  >
                    搜尋
                  </button>
                </form>
              </div>

              {shareNotice && (
                <div aria-live="polite" className="rounded border border-emerald-800/70 bg-emerald-950/50 px-3 py-2 text-sm text-emerald-200 break-all">
                  {shareNotice}
                </div>
              )}
              {shareError && (
                <div role="alert" className="rounded border border-red-800/70 bg-red-950/50 px-3 py-2 text-sm text-red-200 break-all">
                  無法讀取或更新公開分享：{shareError}
                </div>
              )}

              {sharesLoading ? (
                <div className="rounded border border-slate-700/70 bg-slate-900/40 p-6 text-center text-sm text-slate-400">正在讀取公開分享…</div>
              ) : adminShares.length === 0 ? (
                <div className="rounded border border-slate-700/70 bg-slate-900/40 p-6 text-center text-sm text-slate-500">
                  目前沒有符合條件的公開分享網址。
                </div>
              ) : (
                <div className="grid gap-3">
                  {adminShares.map((share) => {
                    const targetSummary = share.kind === "set"
                      ? `${share.paths?.length ?? 0} 個檔案${share.paths?.[0] ? ` · ${share.paths[0]}` : ""}`
                      : share.path || "未記錄檔案路徑";
                    return (
                      <div key={share.token} className="rounded-lg border border-slate-700 bg-slate-900/50 p-4 space-y-3 min-w-0">
                        <div className="flex flex-col lg:flex-row lg:items-start justify-between gap-3">
                          <div className="min-w-0 space-y-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-full px-2 py-0.5 text-xs border ${
                                  share.revoked
                                    ? "border-slate-600 bg-slate-800 text-slate-400"
                                    : "border-emerald-700 bg-emerald-950/60 text-emerald-300"
                                }`}
                              >
                                {share.revoked ? "已撤銷" : "未撤銷"}
                              </span>
                              <span className="rounded-full border border-slate-600 bg-slate-800 px-2 py-0.5 text-xs text-slate-300">
                                {share.kind === "set" ? "展示集" : "文件分享"}
                              </span>
                              <a href={share.shareUrl} target="_blank" rel="noreferrer" className="font-mono text-sm text-sky-300 hover:underline break-all">
                                {share.shareUrl}
                              </a>
                            </div>
                            {share.title && <div className="text-sm font-medium text-white break-words">{share.title}</div>}
                          </div>
                          <div className="flex flex-wrap gap-2 shrink-0">
                            <button
                              type="button"
                              onClick={() => handleCopyAdminShare(share)}
                              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-sky-600 hover:text-sky-300 transition whitespace-nowrap"
                            >
                              {copiedShareUrl === share.token ? "已複製" : "Copy"}
                            </button>
                            <a
                              href={share.shareUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-sky-600 hover:text-sky-300 transition whitespace-nowrap"
                            >
                              {share.kind === "set" ? "開啟展示" : "開啟"}
                            </a>
                            {share.kind === "doc" && share.slidesUrl && (
                              <a
                                href={share.slidesUrl}
                                target="_blank"
                                rel="noreferrer"
                                className="rounded border border-slate-600 px-3 py-1.5 text-xs text-slate-200 hover:border-violet-600 hover:text-violet-300 transition whitespace-nowrap"
                              >
                                投影片
                              </a>
                            )}
                            {!share.revoked && (
                              <button
                                type="button"
                                disabled={revokingShareToken === share.token}
                                onClick={() => handleRevokeAdminShare(share)}
                                className="rounded border border-red-800/70 bg-red-950/40 px-3 py-1.5 text-xs text-red-300 hover:bg-red-900/60 disabled:cursor-not-allowed disabled:opacity-60 transition whitespace-nowrap"
                              >
                                {revokingShareToken === share.token ? "撤銷中…" : "撤銷分享"}
                              </button>
                            )}
                          </div>
                        </div>

                        <div className="grid gap-2 text-xs text-slate-400 sm:grid-cols-2 xl:grid-cols-3">
                          <div className="min-w-0 break-all">來源：{share.provider.toUpperCase()}／{share.repo}</div>
                          <div className="min-w-0 break-all">目標：{targetSummary}</div>
                          <div className="min-w-0 break-all sm:col-span-2 xl:col-span-1 xl:text-right">建立：{new Date(share.createdAt).toLocaleString()} by {share.ownerLogin}</div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 新增 Entry 表單 */}
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg p-5 space-y-4">
              <h2 className="text-base font-semibold text-white">新增／修改 Repo 存取模式</h2>
              <form onSubmit={handleAddEntry} className="flex flex-col sm:flex-row sm:items-end gap-3">
                <div className="w-full sm:w-auto">
                  <label className="block text-xs text-slate-400 mb-1">Provider</label>
                  <select
                    value={newProvider}
                    onChange={(e) => setNewProvider(e.target.value as "github" | "gitlab")}
                    className="w-full sm:w-auto bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
                  >
                    <option value="gitlab">GitLab</option>
                    <option value="github">GitHub</option>
                  </select>
                </div>
                <div className="flex-1 min-w-0 w-full sm:w-auto sm:min-w-[240px]">
                  <label className="block text-xs text-slate-400 mb-1">
                    Project Path <span className="block sm:inline text-slate-500">（填原始路徑，不要 URL-encode）</span>
                  </label>
                  <input
                    type="text"
                    value={newProject}
                    onChange={(e) => setNewProject(e.target.value)}
                    onBlur={handleBlurProject}
                    placeholder="interagent-io/interagent-bible"
                    className="w-full bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:border-indigo-500"
                  />
                </div>
                <div className="w-full sm:w-auto">
                  <label className="block text-xs text-slate-400 mb-1">存取模式</label>
                  <select
                    value={newMode}
                    onChange={(e) => setNewMode(e.target.value as AccessMode)}
                    className="w-full sm:w-auto bg-slate-900 border border-slate-700 rounded px-3 py-2 text-sm text-white focus:outline-none focus:border-indigo-500"
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
                  className="w-full sm:w-auto bg-indigo-600 hover:bg-indigo-500 text-white text-sm px-4 py-2 rounded font-medium transition"
                >
                  儲存模式
                </button>
              </form>
            </div>

            {/* Existing Entries Table */}
            <div className="bg-slate-800/60 border border-slate-700 rounded-lg overflow-hidden">
              <div className="p-4 border-b border-slate-700 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
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
