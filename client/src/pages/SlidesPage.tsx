import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PublicDoc } from "../lib/api";
import { renderMarkdown, splitSlides } from "../lib/markdown";

export default function SlidesPage() {
  const { token } = useParams();
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [error, setError] = useState("");
  const [idx, setIdx] = useState(0);

  useEffect(() => {
    if (!token) return;
    api
      .publicDoc(token)
      .then((d) => {
        setDoc(d);
        document.title = `${d.title} — 簡報`;
      })
      .catch((e) => setError(String((e as Error).message || e)));
  }, [token]);

  const slides = useMemo(() => (doc ? splitSlides(doc.content) : []), [doc]);

  const go = useCallback(
    (d: number) => setIdx((i) => Math.max(0, Math.min(slides.length - 1, i + d))),
    [slides.length]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "ArrowRight" || e.key === " " || e.key === "PageDown") go(1);
      else if (e.key === "ArrowLeft" || e.key === "PageUp") go(-1);
      else if (e.key === "Home") setIdx(0);
      else if (e.key === "End") setIdx(slides.length - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, slides.length]);

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center text-zinc-400">
        這個分享連結不存在或已被撤銷。
      </div>
    );
  }
  if (!doc) return <div className="min-h-screen grid place-items-center text-zinc-600">載入中…</div>;

  return (
    <div className="h-screen flex flex-col select-none">
      {/* 投影片主體：左右點擊區 + 內容置中 */}
      <div className="relative flex-1 min-h-0 slide">
        <button
          aria-label="上一張"
          onClick={() => go(-1)}
          className="absolute left-0 top-0 h-full w-1/4 z-10 cursor-w-resize"
        />
        <button
          aria-label="下一張"
          onClick={() => go(1)}
          className="absolute right-0 top-0 h-full w-1/4 z-10 cursor-e-resize"
        />
        <div className="h-full overflow-y-auto grid place-items-center px-10 md:px-24 py-12">
          <article
            className="doc max-w-4xl w-full"
            dangerouslySetInnerHTML={{ __html: renderMarkdown(slides[idx] ?? "") }}
          />
        </div>
      </div>

      {/* 底部控制列 */}
      <footer className="shrink-0 border-t border-zinc-900 px-4 py-2.5 flex items-center gap-4 text-xs text-zinc-500">
        <Link to={`/s/${token}`} className="hover:text-zinc-200">
          ← 文件模式
        </Link>
        <span className="font-mono">
          {idx + 1} / {slides.length}
        </span>
        <div className="flex-1 flex items-center gap-1">
          {slides.map((_, i) => (
            <button
              key={i}
              onClick={() => setIdx(i)}
              aria-label={`第 ${i + 1} 張`}
              className={`h-1.5 rounded-full transition-all ${
                i === idx ? "w-6 bg-sky-500" : "w-1.5 bg-zinc-700 hover:bg-zinc-500"
              }`}
            />
          ))}
        </div>
        <span className="hidden md:inline text-zinc-700">← → 或點左右翻頁</span>
      </footer>
    </div>
  );
}
