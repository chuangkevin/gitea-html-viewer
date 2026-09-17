import { useEffect, useState } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api, type Me } from "../lib/api";
import { providerLabel, refPathOf, type ProviderName } from "../lib/providers";
import SlideDeck from "../components/SlideDeck";

/** public repo 檔案直接開簡報（/p/:provider/:project/*path），不需分享 token。 */
export default function DirectSlidesPage() {
  const params = useParams();
  const provider = params.provider || "github";
  const projectPath = params.project || "";
  const refPath = refPathOf(provider, projectPath);
  const filePath = params["*"] || "";
  const [searchParams] = useSearchParams();
  const branch = provider === "gitea" ? searchParams.get("ref") || undefined : undefined;
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [me, setMe] = useState<Me | null>(null);

  useEffect(() => {
    api.me().then(setMe).catch(() => setMe({ login: null }));
  }, []);

  useEffect(() => {
    let current = true;
    setContent(null);
    setError("");
    api
      .readFile(refPath, filePath, branch)
      .then((f) => {
        if (!current) return;
        setContent(f.content);
        document.title = `${filePath.split("/").pop()} — 簡報`;
      })
      .catch((e) => {
        if (current) setError(String((e as Error).message || e));
      });
    return () => { current = false; };
  }, [refPath, filePath, branch]);

  if (error) {
    const canLogin = me?.providers?.[provider as ProviderName];
    return (
      <div className="min-h-screen grid place-items-center text-center px-6">
        <div>
          <p className="text-zinc-400 mb-4">{error === "login_required" ? "這是私有 repo，需要登入。" : error}</p>
          {canLogin ? (
            <a
              href={`/api/auth/login?provider=${provider}&next=${encodeURIComponent(location.pathname + location.search)}`}
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
    rawBase: branch ? `/rawb/${encodeURIComponent(branch)}` : "/raw",
    branch,
  };

  const query = new URLSearchParams();
  if (branch) query.set("ref", branch);
  query.set("f", filePath);
  return <SlideDeck content={content} docUrl={`/edit/${refPath}?${query.toString()}`} linkCtx={linkCtx} />;
}
