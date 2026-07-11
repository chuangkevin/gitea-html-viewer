import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { api, type Me } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import { GitHubIcon } from "./Home";

type SaveState = "clean" | "dirty" | "saving" | "saved" | "error";

/**
 * 主工作區。設計原則：public repo 誰都能直接讀（不登入 = 唯讀模式），
 * 需要編輯或讀 private 時才走右上角 GitHub 登入。
 */
export default function Workspace() {
  const { owner, repo } = useParams();
  const navigate = useNavigate();
  const fullRepo = `${owner}/${repo}`;
  const [params, setParams] = useSearchParams();
  const activePath = params.get("f") || "";

  const [me, setMe] = useState<Me | null>(null);
  const [files, setFiles] = useState<string[] | null>(null);
  const [canWrite, setCanWrite] = useState(false);
  const [needLogin, setNeedLogin] = useState(false);
  const [content, setContent] = useState("");
  const [sha, setSha] = useState<string | undefined>();
  const [save, setSave] = useState<SaveState>("clean");
  const [view, setView] = useState<"edit" | "split" | "preview">("split");
  const [error, setError] = useState("");
  const [newFile, setNewFile] = useState("");
  const [shareUrl, setShareUrl] = useState<{ url: string; slidesUrl: string } | null>(null);

  const loginUrl = `/api/auth/login?next=${encodeURIComponent(
    location.pathname + location.search
  )}`;

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ login: null }));
  }, []);

  const loadFiles = useCallback(() => {
    setNeedLogin(false);
    api
      .files(fullRepo)
      .then((r) => {
        setFiles(r.files.map((f) => f.path));
        setCanWrite(r.canWrite);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [fullRepo]);

  useEffect(loadFiles, [loadFiles]);

  useEffect(() => {
    if (!activePath) return;
    setSave("clean");
    setShareUrl(null);
    api
      .readFile(fullRepo, activePath)
      .then((f) => {
        setContent(f.content);
        setSha(f.sha);
      })
      .catch((e) => {
        if ((e as Error).message === "login_required") setNeedLogin(true);
        else setError(String((e as Error).message || e));
      });
  }, [fullRepo, activePath]);

  async function handleSave() {
    if (!activePath || !canWrite) return;
    setSave("saving");
    try {
      const r = await api.saveFile(fullRepo, activePath, content, sha);
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
    const r = await api.share(fullRepo, activePath, title);
    setShareUrl({ url: r.url, slidesUrl: r.slidesUrl });
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

  // private repo 且未登入：整頁登入提示
  if (needLogin) {
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div className="space-y-4">
          <p className="text-3xl">🔒</p>
          <p className="text-zinc-300">
            <span className="font-mono">{fullRepo}</span> 不存在，或是私有 repo。
          </p>
          <p className="text-sm text-zinc-500">若你有這個 repo 的權限，登入後即可存取。</p>
          <a
            href={loginUrl}
            className="inline-flex items-center gap-2 rounded-lg bg-white text-zinc-900 font-semibold px-5 py-2.5 hover:bg-zinc-200"
          >
            <GitHubIcon className="h-5 w-5" />
            使用 GitHub 登入
          </a>
          <div>
            <Link to="/" className="text-xs text-zinc-500 hover:text-zinc-300">
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
        <span className="font-mono text-sm text-zinc-500 truncate">{fullRepo}</span>
        {readOnly && (
          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-400">唯讀</span>
        )}
        <div className="flex-1" />
        {activePath && !readOnly && (
          <div className="hidden md:flex rounded-lg border border-zinc-800 overflow-hidden text-xs">
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
        {activePath && (
          <button
            onClick={() => navigate(`/p/${fullRepo}/${activePath}`)}
            className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-sky-600 hover:text-sky-400"
          >
            🎞️ 簡報
          </button>
        )}
        {activePath && canWrite && (
          <>
            <button
              onClick={handleShare}
              className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-sky-600 hover:text-sky-400"
            >
              分享
            </button>
            <button
              onClick={handleSave}
              disabled={save === "saving"}
              className="rounded-lg bg-sky-600 px-4 py-1.5 text-xs font-semibold hover:bg-sky-500 disabled:opacity-50"
            >
              {save === "saving" ? "commit 中…" : save === "saved" ? "已 commit ✓" : "存檔（commit）"}
            </button>
          </>
        )}
        {/* 右上角：未登入顯示登入鈕（要編輯就從這裡進） */}
        {me && !me.login && (
          <a
            href={loginUrl}
            className="inline-flex items-center gap-1.5 rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-200 hover:border-zinc-400"
          >
            <GitHubIcon className="h-3.5 w-3.5" />
            登入以編輯
          </a>
        )}
        {me?.login && (
          <span className="flex items-center gap-1.5 text-xs text-zinc-500">
            {me.avatarUrl && <img src={me.avatarUrl} alt="" className="h-5 w-5 rounded-full" />}
            {me.login}
          </span>
        )}
      </header>

      {shareUrl && (
        <div className="border-b border-sky-900/50 bg-sky-950/40 px-4 py-2 text-xs flex flex-wrap items-center gap-x-6 gap-y-1">
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
        <div className="border-b border-red-900/50 bg-red-950/40 px-4 py-2 text-xs text-red-300 flex">
          <span className="flex-1">{error}</span>
          <button onClick={() => setError("")}>✕</button>
        </div>
      )}

      <div className="flex-1 flex min-h-0">
        {/* 檔案樹 */}
        <aside className="w-60 shrink-0 border-r border-zinc-800 overflow-y-auto p-3 hidden sm:block">
          {canWrite && (
            <div className="flex gap-1.5 mb-3">
              <input
                value={newFile}
                onChange={(e) => setNewFile(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && handleCreate()}
                placeholder="新檔名…"
                className="flex-1 min-w-0 rounded bg-zinc-900 border border-zinc-800 px-2 py-1 text-xs outline-none focus:border-sky-600"
              />
              <button
                onClick={handleCreate}
                className="rounded bg-zinc-800 px-2 text-xs text-zinc-300 hover:bg-zinc-700"
              >
                ＋
              </button>
            </div>
          )}
          {!files ? (
            <p className="text-xs text-zinc-600">載入中…</p>
          ) : files.length === 0 ? (
            <p className="text-xs text-zinc-600">
              {canWrite ? "repo 裡還沒有 .md，建立第一份吧" : "這個 repo 裡沒有 .md 檔"}
            </p>
          ) : (
            <ul className="space-y-0.5">
              {files.map((f) => (
                <li key={f}>
                  <button
                    onClick={() => setParams({ f })}
                    className={`w-full text-left rounded px-2 py-1.5 text-xs font-mono truncate ${
                      f === activePath ? "bg-sky-950 text-sky-300" : "text-zinc-400 hover:bg-zinc-900"
                    }`}
                    title={f}
                  >
                    {f}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>

        {/* 編輯／預覽 */}
        {!activePath ? (
          <div className="flex-1 grid place-items-center text-zinc-600 text-sm">
            從左側選擇檔案{canWrite ? "，或建立新檔" : ""}
          </div>
        ) : (
          <div className="flex-1 flex min-w-0">
            {effectiveView !== "preview" && (
              <textarea
                value={content}
                onChange={(e) => {
                  setContent(e.target.value);
                  setSave("dirty");
                }}
                spellCheck={false}
                className={`${effectiveView === "split" ? "w-1/2" : "w-full"} resize-none bg-zinc-950 p-5 font-mono text-sm leading-relaxed outline-none border-r border-zinc-900`}
              />
            )}
            {effectiveView !== "edit" && (
              <div
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
