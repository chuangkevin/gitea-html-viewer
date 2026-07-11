import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import Presenter from "../components/Presenter";

/** 本地展示（不經分享 token）：/present/:owner/:repo?list=<JSON paths>。
 *  勾選展示與資料夾連續模式都導到這裡；讀取權限同工作區（public 免登入）。 */
export default function PresentPage() {
  const { owner, repo } = useParams();
  const [params] = useSearchParams();
  const fullRepo = `${owner}/${repo}`;

  const items = useMemo<string[]>(() => {
    try {
      const parsed = JSON.parse(params.get("list") || "[]");
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
    } catch {
      return [];
    }
  }, [params]);

  const title = params.get("title") || fullRepo;
  const grant = params.get("grant") || "";
  const rawBase = grant ? `/rawt/${grant}` : "/raw";

  return (
    <Presenter
      title={title}
      items={items}
      loadText={(p) => api.readFile(fullRepo, p).then((f) => f.content)}
      rawUrl={(p) => `${rawBase}/${fullRepo}/${p.split("/").map(encodeURIComponent).join("/")}`}
      exitUrl={`/edit/${fullRepo}`}
    />
  );
}
