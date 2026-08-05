import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type AccessMode, type Me } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { ProviderIcon, providerLabel } from "../lib/providers";
import FileTree, { buildTree, flattenFiles } from "../components/FileTree";
import IdentityPicker from "../components/IdentityPicker";
import { kindOf } from "../components/Presenter";

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

/**
 * 主工作區。設計原則：public repo 誰都能直接讀（不登入 = 唯讀模式），
 * 需要編輯或讀 private 時才走右上角登入。
 *
 * 團隊模式（server 有成員清單）時另有一條路：不必個人 OAuth，
 * 在 header 選「你是誰」即可用該成員的 token 讀寫，commit 記在該成員名下。
 */
export default function Workspace() {
  const { provider = "github", project = "" } = useParams();
  const navigate = useNavigate();
  const projectPath = project; // react-router 已解碼；GitLab 可含巢狀群組
  const refPath = `${provider}/${encodeURIComponent(projectPath)}`; // 路由/API 用
  const repoLeaf = projectPath.split("/").pop() || projectPath;
  const [params, setParams] = useSearchParams();
  const activePath = params.get("f") || "";

  const [me, setMe] = useState<Me | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [accessMode, setAccessMode] = useState<AccessMode>("login");
  const [guestName, setGuestName] = useState("");
  const [needLogin, setNeedLogin] = useState(false);
  const [content, setContent] = useState("");
  const [sha, setSha] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>("clean");
  const [view, setView] = useState<"edit" | "split" | "preview">("split");
  const [error, setError] = useState("");
  const [newFile, setNewFile] = useState("");
  const [shareUrl, setShareUrl] = useState<{ url: string; slidesUrl: string } | null>(null);
  const [presentMode, setPresentMode] = useState(false);
  const [isPrivate, setIsPrivate] = useState(false);
  const [rawGrant, setRawGrant] = useState("");
  const [checked, setChecked] = useState<Set<string>>(() => new Set());
  const [activeFolder, setActiveFolder] = useState("");
  const [reloadKey, setReloadKey] = useState(0); // 換身分後強制重讀檔案樹與檔案內容

  const loginUrl = `/api/auth/login?provider=${provider}&next=${encodeURIComponent(
    location.pathname + location.search
  )}`;

  const refreshMe = useCallback(() => api.me().then(setMe).catch(() => setMe({ login: null })), []);

  useEffect(() => {
    void refreshMe();
  }, [refreshMe]);

  // 團隊模式：選了成員（或改選別人）→ 重抓身分、檔案樹與目前檔案
  const handleIdentityChange = useCallback(() => {
    void refreshMe();
    setReloadKey((k) => k + 1);
  }, [refreshMe]);

  const loadFiles = useCallback(() => {
    setNeedLogin(false);
    api
      .files(refPath)
      .then((r) => {
        setFiles(r.files.map((f) => f.path));
        setCanWrite(r.canWrite);
        setIsPrivate(r.private);
        if (r.access) setAccessMode(r.access);
        if (r.guestName !== undefined && r.guestName !== null) setGuestName(r.guestName);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [refPath, reloadKey]);

  useEffect(loadFiles, [loadFiles]);

  const activeKind = activePath ? kindOf(activePath) : null;

  // 個人登入或團隊模式選了身分，才有資格拿 private repo 的 raw grant
  const hasIdentity = Boolean(me?.login || me?.team?.selected);

  useEffect(() => {
    if (!isPrivate || !hasIdentity || rawGrant) return;
    api.rawGrant(provider, projectPath).then((r) => setRawGrant(r.grant)).catch(() => {});
  }, [isPrivate, hasIdentity, rawGrant, provider, projectPath]);

  const rawBase = isPrivate && rawGrant ? `/rawt/${rawGrant}` : "/raw";

  useEffect(() => {
    if (!activePath) return;
    setSave("clean");
    setShareUrl(null);
    if (kindOf(activePath) === "html" || kindOf(activePath) === "image") return;
    api
      .readFile(refPath, activePath)
      .then((f) => {
        setContent(f.content);
        setSha(f.sha);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [refPath, activePath, reloadKey]);

  async function handleSave() {
    if (!activePath || !canWrite) return;
    setSave("saving");
    try {
      const r = await api.saveFile(refPath, activePath, content, sha);
      setSha(r.sha);
      setSave("saved");
      setTimeout(() => setSave((s) => (s === "saved" ? "clean" : s)), 2000);
    } catch (e) {
      setSave("error");
      setError(String((e as Error).message || e));
    }
  }

  async function handleCreate() {
    let p = newFile.trim();
    if (!p) return;
    if (!p.toLowerCase().endsWith(".md")) p += ".md";
    setNewFile("");
    setFiles((f) => (f ? [...f, p] : [p]));
    setParams({ f: p });
    setContent(`# ${p.replace(/\.md$/i, "").split("/").pop()}\n\n`);
    setSha(undefined);
    setSave("dirty");
  }

  async function handleShare() {
    if (!activePath) return;
    const title = content.match(/^#\s+(.+)$/m)?.[1];
    const r = await api.share(projectPath, activePath, title);
    setShareUrl({ url: r.url, slidesUrl: r.slidesUrl });
  }

  // 展示順序一律取檔案樹的資料夾排序
  const sortedFiles = useMemo(() => (files ? flattenFiles(buildTree(files)) : []), [files]);
  const checkedInOrder = useMemo(() => sortedFiles.filter((f) => checked.has(f)), [sortedFiles, checked]);
  const folderFiles = useMemo(
    () => (activeFolder ? sortedFiles.filter((f) => f.startsWith(activeFolder + "/")) : []),
    [sortedFiles, activeFolder]
  );

  function startPresent(items: string[], title: string) {
    if (items.length === 0) return;
    const g = isPrivate && rawGrant ? `&grant=${rawGrant}` : "";
    navigate(
      `/present/${refPath}?list=${encodeURIComponent(JSON.stringify(items))}&title=${encodeURIComponent(title)}${g}`
    );
  }

  async function handleShareSet() {
    if (checkedInOrder.length === 0) return;
    try {
      const r = await api.shareSet(projectPath, checkedInOrder, `${repoLeaf} 展示`);
      setShareUrl({ url: r.url, slidesUrl: r.url });
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }

  // Cmd/Ctrl+S 存檔
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "s") {
        e.preventDefault();
        void handleSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const readOnly = !canWrite;
  const effectiveView = readOnly ? "preview" : view;
  const html = useMemo(() => renderMarkdown(content), [content]);

  // ── 分割檢視：編輯區與預覽區依捲動比例雙向同步 ──
  const editorRef = useRef<HTMLTextAreaElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  // 同步旗標：記住「現在是哪一邊在帶動」加一段冷卻時間。被帶動的那一邊會因為
  // scrollTop 被改而回彈一個 scroll 事件，冷卻期內直接忽略，避免兩邊互相觸發。
  // 用時間戳而非 callback 清旗標——不依賴 rAF/timer，卡不住。
  const syncSource = useRef<HTMLElement | null>(null);
  const syncUntil = useRef(0);

  const syncScroll = useCallback(
    (from: HTMLElement | null, to: HTMLElement | null) => {
      if (effectiveView !== "split" || !from || !to) return;
      const now = performance.now();
      if (syncSource.current !== from && now < syncUntil.current) return; // 回彈事件
      const fromMax = from.scrollHeight - from.clientHeight;
      const toMax = to.scrollHeight - to.clientHeight;
      if (fromMax <= 0 || toMax <= 0) return;
      syncSource.current = from;
      syncUntil.current = now + 120;
      to.scrollTop = (from.scrollTop / fromMax) * toMax;
    },
    [effectiveView]
  );

  // private repo 且未登入：整頁登入提示
  if (needLogin) {
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div className="space-y-4">
          <p className="text-3xl">🔒</p>
          <p className="text-zinc-300">
            <span className="font-mono">{projectPath}</span> 不存在，或是私有 repo。
          </p>
          <p className="text-base text-zinc-500">若你有這個 repo 的權限，登入後即可存取。</p>
          {me?.team?.enabled && !me.login && (
            <div className="space-y-2">
              <p className="text-sm text-zinc-400">或者，選一下你是誰（團隊模式）：</p>
              <IdentityPicker team={me.team} onChange={handleIdentityChange} size="lg" />
            </div>
          )}
          {me?.providers?.[provider as "github" | "gitlab"] ? (
            <a
              href={loginUrl}
              className="inline-flex items-center gap-2 rounded-lg bg-white text-zinc-900 font-semibold px-5 py-2.5 hover:bg-zinc-200"
            >
              <ProviderIcon provider={provider} className="h-5 w-5" />
              使用 {providerLabel(provider)} 登入
            </a>
          ) : (
            <p className="text-sm text-zinc-600">此站尚未設定 {providerLabel(provider)} OAuth，暫時無法登入。</p>
          )}
          <div>
            <Link to="/" className="text-sm text-zinc-500 hover:text-zinc-300">
              ← 回首頁
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col">
      <header className="border-b border-zinc-800 px-4 py-2.5 flex items-center gap-3 shrink-0">
        <Link to="/" className="font-mono font-bold">
          note<span className="text-sky-400">-bridge</span>
        </Link>
        <span className="font-mono text-base text-zinc-500 truncate">{projectPath}</span>
        {readOnly && (
          <span
            className="rounded bg-zinc-800 px-2 py-0.5 text-xs text-zinc-400"
            title={
              me?.team?.enabled && !me.team.selected
                ? "先在右上角選「你是誰」才能編輯"
                : "沒有這個 repo 的寫入權限"
            }
          >
            {me?.team?.enabled && !me.team.selected && !me.login ? "唯讀 · 先選身分" : "唯讀"}
          </span>
        )}
        <div className="flex-1" />
        {activePath && activeKind === "md" && !readOnly && (
          <div className="hidden md:flex rounded-lg border border-zinc-800 overflow-hidden text-sm">
            {(["edit", "split", "preview"] as const).map((v) => (
              <button
                key={v}
                onClick={() => setView(v)}
                className={`px-3 py-1.5 ${view === v ? "bg-zinc-800 text-white" : "text-zinc-500 hover:text-zinc-200"}`}
              >
                {v === "edit" ? "編輯" : v === "split" ? "分割" : "預覽"}
              </button>
            ))}
          </div>
        )}
        {activePath && activeKind === "md" && (
          <button
            onClick={() => navigate(`/p/${refPath}/${activePath}`)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400"
          >
            🎞️ 簡報
          </button>
        )}
        {activePath && activeKind === "md" && canWrite && (
          <>
            {/* 分享連結的內容是用「分享者的 session」持續拉取，團隊身分沒有 session，
                所以分享功能仍只開給個人 OAuth 登入者 */}
            {me?.login && (
              <button
                onClick={handleShare}
                className="rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400"
              >
                分享
              </button>
            )}
            <button
              onClick={handleSave}
              disabled={save === "saving"}
              className="rounded-lg bg-sky-600 px-4 py-1.5 text-sm font-semibold hover:bg-sky-500 disabled:opacity-50"
            >
              {save === "saving" ? "commit 中…" : save === "saved" ? "已 commit ✓" : "存檔（commit）"}
            </button>
          </>
        )}
        {/* 免登入 open 模式：顯示署名輸入框（訪客 commit author 名字） */}
        {accessMode === "open" && me && !me.login && !me.team?.selected && (
          <input
            type="text"
            defaultValue={guestName}
            placeholder="你是誰？（選填，會寫進 commit）"
            onBlur={(e) => void api.setGuestName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.currentTarget.blur();
              }
            }}
            className="bg-zinc-900 border border-zinc-700 rounded px-2.5 py-1 text-xs text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-sky-500 max-w-[200px]"
          />
        )}
        {/* 團隊模式：不必個人 OAuth，選「你是誰」就用該成員的 token 讀寫 */}
        {me && !me.login && me.team?.enabled && (
          <IdentityPicker team={me.team} onChange={handleIdentityChange} />
        )}
        {/* 右上角：未登入顯示登入鈕（要編輯就從這裡進，依目前 repo 來源） */}
        {me && !me.login && me.providers?.[provider as "github" | "gitlab"] && (
          <a
            href={loginUrl}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-sm text-zinc-200 hover:border-zinc-400"
          >
            <ProviderIcon provider={provider} className="h-4 w-4" />
            登入以編輯
          </a>
        )}
        {me?.login && (
          <span className="flex items-center gap-1.5 text-sm text-zinc-500">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
            {me.login}
          </span>
        )}
        {/* Admin 連結 */}
        {me?.admin?.is && (
          <Link
            to="/admin"
            className="inline-flex items-center gap-1 text-xs border border-zinc-700 text-zinc-400 hover:text-white px-2 py-1 rounded transition"
            title="管理控制台"
          >
            ⚙️ 管理
          </Link>
        )}
      </header>

      {shareUrl && (
        <div className="border-b border-sky-900/50 bg-sky-950/40 px-4 py-2 text-sm flex flex-wrap items-center gap-x-6 gap-y-1">
          <span className="text-sky-300">已建立公開分享：</span>
          <a href={shareUrl.url} target="_blank" rel="noreferrer" className="text-sky-400 underline">
            📄 文件頁 {shareUrl.url}
          </a>
          <a href={shareUrl.slidesUrl} target="_blank" rel="noreferrer" className="text-sky-400 underline">
            🎞️ 簡報模式 {shareUrl.slidesUrl}
          </a>
          <button className="ml-auto text-zinc-500 hover:text-zinc-300" onClick={() => setShareUrl(null)}>
            ✕
          </button>
        </div>
      )}
      {error && (
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-sm text-red-300 flex">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}>✕</button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* 檔案樹 */}
        <aside className="w-72 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 hidden sm:block">
          {canWrite && (
            <div className="flex gap-1.5 mb-3">
              <input
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="新檔名…"
                className="flex-1 min-w-0 rounded bg-zinc-900 border border-zinc-800 px-2 py-1.5 text-sm outline-none focus:border-sky-600"
              />
              <button
                onClick={handleCreate}
                className="rounded bg-zinc-800 px-2 text-sm text-zinc-300 hover:bg-zinc-700"
              >
                ＋
              </button>
            </div>
          )}
          <div className="flex items-center justify-between mb-2">
            <span className="text-xs uppercase tracking-wider text-zinc-600">檔案</span>
            <button
              onClick={() => {
                setPresentMode((v) => !v);
                if (presentMode) setChecked(new Set());
              }}
              className={`rounded px-2 py-0.5 text-xs border ${
                presentMode
                  ? "border-sky-600 bg-sky-950 text-sky-300"
                  : "border-zinc-800 text-zinc-500 hover:text-zinc-300 hover:border-zinc-600"
              }`}
              title="勾選檔案組成展示清單"
            >
              🎬 展示模式
            </button>
          </div>
          {!files ? (
            <p className="text-sm text-zinc-600">載入中…</p>
          ) : files.length === 0 ? (
            <p className="text-sm text-zinc-600">
              {canWrite ? "repo 是空的，建立第一份 .md 吧" : "這個 repo 是空的"}
            </p>
          ) : (
            <FileTree
              paths={files}
              activePath={activePath}
              activeFolder={activeFolder}
              onSelectFile={(f) => {
                setActiveFolder("");
                setParams({ f });
              }}
              onSelectFolder={setActiveFolder}
              presentMode={presentMode}
              checked={checked}
              onCheckedChange={setChecked}
            />
          )}
          {presentMode && (
            <div className="sticky bottom-0 mt-3 -mx-3 border-t border-zinc-800 bg-zinc-950/95 px-3 py-2 space-y-1.5">
              <p className="text-xs text-zinc-500">已勾選 {checkedInOrder.length} 個檔案（依資料夾排序播放）</p>
              <button
                onClick={() => startPresent(checkedInOrder, `${repoLeaf} 展示`)}
                disabled={checkedInOrder.length === 0}
                className="w-full rounded bg-sky-600 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
              >
                ▶ 開始展示
              </button>
              {canWrite && me?.login && (
                <button
                  onClick={handleShareSet}
                  disabled={checkedInOrder.length === 0}
                  className="w-full rounded border border-zinc-700 py-2 text-sm text-zinc-300 hover:border-sky-600 hover:text-sky-400 disabled:opacity-40"
                >
                  🔗 分享展示集
                </button>
              )}
            </div>
          )}
        </aside>

        {/* 編輯／預覽 */}
        {activeFolder ? (
          <div className="flex-1 grid place-items-center text-center px-6">
            <div className="space-y-3">
              <p className="text-3xl">📂</p>
              <p className="font-mono text-base text-zinc-300">{activeFolder}/</p>
              <p className="text-sm text-zinc-500">{folderFiles.length} 個檔案</p>
              <button
                onClick={() => startPresent(folderFiles, activeFolder)}
                disabled={folderFiles.length === 0}
                className="rounded-lg bg-sky-600 px-5 py-2 text-sm font-semibold hover:bg-sky-500 disabled:opacity-40"
              >
                ▶ 連續模式展示（依資料夾排序）
              </button>
            </div>
          </div>
        ) : !activePath ? (
          <div className="flex-1 grid place-items-center text-zinc-600 text-base">
            從左側選擇檔案{canWrite ? "，或建立新檔" : ""}
          </div>
        ) : activeKind === "html" ? (
          // 獨立分享網站預覽:sandbox iframe,相對 css/js 由 /raw 供應
          <iframe
            key={activePath}
            src={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}`}
            sandbox="allow-scripts"
            className="flex-1 bg-white"
            title={activePath}
          />
        ) : activeKind === "image" ? (
          <div className="flex-1 grid place-items-center p-6 overflow-auto">
            <img
              src={`${rawBase}/${refPath}/${activePath.split("/").map(encodeURIComponent).join("/")}`}
              alt={activePath}
              className="max-w-full max-h-full"
            />
          </div>
        ) : activeKind === "text" ? (
          <pre className="flex-1 overflow-auto p-6 text-sm font-mono text-zinc-300 whitespace-pre-wrap">
            {content}
          </pre>
        ) : (
          <div className="flex-1 flex min-w-0">
            {effectiveView !== "preview" && (
              <textarea
                ref={editorRef}
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setSave("dirty");
                }}
                onScroll={() => syncScroll(editorRef.current, previewRef.current)}
                spellCheck={false}
                className={`${effectiveView === "split" ? "w-1/2" : "w-full"} resize-none bg-zinc-950 p-5 font-mono text-base leading-7 outline-none border-r border-zinc-900`}
              />
            )}
            {effectiveView !== "edit" && (
              <div
                ref={previewRef}
                onScroll={() => syncScroll(previewRef.current, editorRef.current)}
                className={`${effectiveView === "split" ? "w-1/2" : "w-full"} overflow-y-auto p-6 doc ${readOnly ? "max-w-3xl mx-auto" : ""}`}
                dangerouslySetInnerHTML={{ __html: html }}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
