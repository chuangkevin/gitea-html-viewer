import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type Me } from "../lib/api";
import SlideDeck from "../components/SlideDeck";

/** public repo 檔案直接開簡報（/p/:owner/:repo/*path），不需分享 token。 */
export default function DirectSlidesPage() {
  const params = useParams();
  const owner = params.owner!;
  const repo = params.repo!;
  const filePath = params["*"] || "";
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ login: null }));
  }, []);

  useEffect(() => {
    api
      .readFile(`${owner}/${repo}`, filePath)
      .then((f) => {
        setContent(f.content);
        document.title = `${filePath.split("/").pop()} — 簡報`;
      })
      .catch((e) => setError(String((e as Error).message || e)));
  }, [owner, repo, filePath]);

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div>
          <p className="text-zinc-400 mb-4">{error === "login_required" ? "這是私有 repo，需要登入。" : error}</p>
          {me?.oauthReady ? (
            <a
              href={`/api/auth/login?next=${encodeURIComponent(location.pathname)}`}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-400"
            >
              使用 GitHub 登入
            </a>
          ) : me?.devMode ? (
            <button
              onClick={() => api.devLogin().then(() => location.reload())}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-400"
            >
              Dev PAT 登入
            </button>
          ) : (
            <p className="text-xs text-zinc-600">此站尚未設定 GitHub OAuth。</p>
          )}
        </div>
      </div>
    );
  }
  if (content === null)
    return <div className="min-h-screen grid place-items-center text-zinc-600">載入中…</div>;

  return <SlideDeck content={content} docUrl={`/edit/${owner}/${repo}?f=${encodeURIComponent(filePath)}`} />;
}
