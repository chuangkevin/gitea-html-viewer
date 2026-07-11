import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { api, type PublicDoc } from "../lib/api";
import { renderMarkdown } from "../lib/markdown";
import Presenter from "../components/Presenter";

export default function SharePage() {
  const { token } = useParams();
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!token) return;
    document.title = "note-bridge";
    api
      .publicDoc(token)
      .then((d) => {
        setDoc(d);
        document.title = `${d.title} — note-bridge`;
      })
      .catch((e) => setError(String((e as Error).message || e)));
  }, [token]);

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div>
          <p className="text-3xl mb-3">🔗</p>
          <p className="text-zinc-400">這個分享連結不存在或已被撤銷。</p>
        </div>
      </div>
    );
  }
  if (!doc) return <div className="min-h-screen grid place-items-center text-zinc-600">載入中…</div>;

  // 多檔展示集：直接進展示器（md 渲染、html 走 sandbox iframe）
  if (doc.kind === "set") {
    return (
      <Presenter
        title={doc.title}
        items={doc.items ?? []}
        loadText={(p) => api.publicSetFile(token!, p).then((f) => f.content)}
        rawUrl={(p) => `/api/public/${token}/raw/${p.split("/").map(encodeURIComponent).join("/")}`}
      />
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-zinc-800 px-6 py-3 flex items-center gap-3 text-sm sticky top-0 bg-zinc-950/90 backdrop-blur">
        <span className="font-mono font-bold">
          note<span className="text-sky-400">-bridge</span>
        </span>
        <span className="text-zinc-600 truncate">
          {doc.ownerLogin} / {doc.path}
        </span>
        <div className="flex-1" />
        <Link
          to={`/s/${token}/slides`}
          className="rounded-lg border border-zinc-700 px-3 py-1.5 text-xs text-zinc-300 hover:border-sky-600 hover:text-sky-400"
        >
          🎞️ 以簡報開啟
        </Link>
      </header>
      <main className="max-w-3xl mx-auto px-6 py-10">
        <article className="doc" dangerouslySetInnerHTML={{ __html: renderMarkdown(doc.content ?? "") }} />
        <footer className="mt-16 pt-6 border-t border-zinc-900 text-xs text-zinc-600">
          以 <span className="font-mono">note-bridge</span> 分享 — 文件原文存放於 GitHub（{doc.repo}）
        </footer>
      </main>
    </div>
  );
}
