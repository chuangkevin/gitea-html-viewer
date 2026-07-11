import { useCallback, useEffect, useMemo, useState } from "react";
import { renderMarkdown } from "../lib/markdown";
import { fileIcon } from "./FileTree";

/** 多檔連續展示器。播放清單依資料夾排序；.md 直接渲染、.html 走
 *  sandbox iframe（獨立分享網站）、圖片直接顯示、其他以原始碼呈現。
 *  loadText 拿 md/原始碼內容，rawUrl 給 iframe / 圖片 src。 */

export type ItemKind = "md" | "html" | "image" | "text";

export function kindOf(path: string): ItemKind {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "md") return "md";
  if (ext === "html" || ext === "htm") return "html";
  if (["png", "jpg", "jpeg", "gif", "svg", "webp", "ico"].includes(ext)) return "image";
  return "text";
}

interface Props {
  title: string;
  items: string[];
  loadText: (path: string) => Promise<string>;
  rawUrl: (path: string) => string;
  exitUrl?: string;
}

export default function Presenter({ title, items, loadText, rawUrl, exitUrl }: Props) {
  const [idx, setIdx] = useState(0);
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [error, setError] = useState("");
  const path = items[idx] ?? "";
  const kind = useMemo(() => kindOf(path), [path]);

  const go = useCallback(
    (d: number) => setIdx((i) => Math.max(0, Math.min(items.length - 1, i + d))),
    [items.length]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(items.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, items.length]);

  useEffect(() => {
    document.title = `${title} — 展示`;
  }, [title]);

  useEffect(() => {
    if (!path || kind === "html" || kind === "image" || texts[path] !== undefined) return;
    loadText(path)
      .then((c) => setTexts((t) => ({ ...t, [path]: c })))
      .catch((e) => setError(String((e as Error).message || e)));
  }, [path, kind, texts, loadText]);

  if (items.length === 0) {
    return <div className="min-h-screen grid place-items-center text-zinc-500">展示清單是空的</div>;
  }

  const text = texts[path];

  return (
    <div className="h-screen flex flex-col">
      <div className="flex-1 min-h-0 relative">
        {error && (
          <div className="absolute inset-x-0 top-0 z-20 bg-red-950/80 text-red-300 text-xs px-4 py-2">
            {error} <button onClick={() => setError("")}>✕</button>
          </div>
        )}
        {kind === "html" ? (
          // 獨立分享網站：sandbox 只給 allow-scripts（無 same-origin），
          // 頁內 script 拿不到本站 cookie/API；相對路徑資產自然落回 raw 前綴
          <iframe
            key={path}
            src={rawUrl(path)}
            sandbox="allow-scripts"
            className="w-full h-full bg-white"
            title={path}
          />
        ) : kind === "image" ? (
          <div className="h-full grid place-items-center p-6 overflow-auto">
            <img src={rawUrl(path)} alt={path} className="max-w-full max-h-full" />
          </div>
        ) : text === undefined ? (
          <div className="h-full grid place-items-center text-zinc-600">載入中…</div>
        ) : kind === "md" ? (
          <div className="h-full overflow-y-auto">
            <article
              className="doc max-w-4xl mx-auto px-8 py-10"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(text) }}
            />
          </div>
        ) : (
          <pre className="h-full overflow-auto p-6 text-xs font-mono text-zinc-300 whitespace-pre-wrap">
            {text}
          </pre>
        )}
      </div>

      <footer className="shrink-0 border-t border-zinc-900 bg-zinc-950 px-4 py-2.5 flex items-center gap-3 text-xs text-zinc-500">
        {exitUrl && (
          <a href={exitUrl} className="hover:text-zinc-200">
            ← 離開
          </a>
        )}
        <button onClick={() => go(-1)} disabled={idx === 0} className="disabled:opacity-30 hover:text-zinc-200">
          ◀
        </button>
        <span className="font-mono">
          {idx + 1} / {items.length}
        </span>
        <button
          onClick={() => go(1)}
          disabled={idx === items.length - 1}
          className="disabled:opacity-30 hover:text-zinc-200"
        >
          ▶
        </button>
        <span className="font-mono text-zinc-400 truncate flex-1">
          {fileIcon(path)} {path}
        </span>
        <div className="hidden md:flex items-center gap-1 max-w-[40%] overflow-hidden">
          {items.map((p, i) => (
            <button
              key={p}
              onClick={() => setIdx(i)}
              title={p}
              className={`h-1.5 rounded-full shrink-0 transition-all ${
                i === idx ? "w-6 bg-sky-500" : "w-1.5 bg-zinc-700 hover:bg-zinc-500"
              }`}
            />
          ))}
        </div>
        <span className="hidden lg:inline text-zinc-700">← → 翻頁</span>
      </footer>
    </div>
  );
}
