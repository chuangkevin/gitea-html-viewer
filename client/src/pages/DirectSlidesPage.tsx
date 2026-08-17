import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type Me } from "../lib/api";
import { providerLabel, refPathOf } from "../lib/providers";
import SlideDeck from "../components/SlideDeck";

/** public repo 檔案直接開簡報（/p/:provider/:project/*path），不需分享 token。 */
export default function DirectSlidesPage() {
  const params = useParams();
  const provider = params.provider || "github";
  const projectPath = params.project || "";
  const refPath = refPathOf(provider, projectPath);
  const filePath = params["*"] || "";
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ login: null }));
  }, []);

  useEffect(() => {
    api
      .readFile(refPath, filePath)
      .then((f) => {
        setContent(f.content);
        document.title = `${filePath.split("/").pop()} — 簡報`;
      })
      .catch((e) => setError(String((e as Error).message || e)));
  }, [refPath, filePath]);

  if (error) {
    const canLogin = me?.providers?.[provider as "github" | "gitlab"];
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div>
          <p className="text-zinc-400 mb-4">{error === "login_required" ? "這是私有 repo，需要登入。" : error}</p>
          {canLogin ? (
            <a
              href={`/api/auth/login?provider=${provider}&next=${encodeURIComponent(location.pathname)}`}
              className="rounded-lg border border-zinc-700 px-4 py-2 text-sm hover:border-zinc-400"
            >
              使用 {providerLabel(provider)} 登入
            </a>
          ) : (
            <p className="text-xs text-zinc-600">此站尚未設定 {providerLabel(provider)} OAuth。</p>
          )}
        </div>
      </div>
    );
  }
  if (content === null)
    return <div className="min-h-screen grid place-items-center text-zinc-600">載入中…</div>;

  const linkCtx = {
    provider,
    project: projectPath,
    currentPath: filePath,
    files: [],
    rawBase: "/raw",
  };

  return <SlideDeck content={content} docUrl={`/edit/${refPath}?f=${encodeURIComponent(filePath)}`} linkCtx={linkCtx} />;
}
