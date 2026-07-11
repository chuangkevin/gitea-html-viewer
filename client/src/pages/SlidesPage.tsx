import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api, type PublicDoc } from "../lib/api";
import SlideDeck from "../components/SlideDeck";

/** 分享 token 的簡報模式（/s/:token/slides） */
export default function SlidesPage() {
  const { token } = useParams();
  const [doc, setDoc] = useState<PublicDoc | null>(null);
  const [error, setError] = useState("");

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

  if (error) {
    return (
      <div className="min-h-screen grid place-items-center text-zinc-400">
        這個分享連結不存在或已被撤銷。
      </div>
    );
  }
  if (!doc) return <div className="min-h-screen grid place-items-center text-zinc-600">載入中…</div>;

  return <SlideDeck content={doc.content ?? ""} docUrl={`/s/${token}`} />;
}
