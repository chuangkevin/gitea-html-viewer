import { useMemo } from "react";
import { useParams, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { refPathOf } from "../lib/providers";
import Presenter from "../components/Presenter";

/** 本地展示（不經分享 token）：/present/:provider/:project?list=<JSON paths>。
 *  勾選展示與資料夾連續模式都導到這裡；讀取權限同工作區（public 免登入）。 */
export default function PresentPage() {
  const { provider = "github", project = "" } = useParams();
  const [params] = useSearchParams();
  const refPath = refPathOf(provider, project);

  const items = useMemo<string[]>(() => {
    try {
      const parsed = JSON.parse(params.get("list") || "[]");
      return Array.isArray(parsed) ? parsed.filter((p) => typeof p === "string") : [];
    } catch {
      return [];
    }
  }, [params]);

  const title = params.get("title") || project;
  const grant = params.get("grant") || "";
  const rawBase = grant ? `/rawt/${grant}` : "/raw";

  return (
    <Presenter
      title={title}
      items={items}
      loadText={(p) => api.readFile(refPath, p).then((f) => f.content)}
      rawUrl={(p) => `${rawBase}/${refPath}/${p.split("/").map(encodeURIComponent).join("/")}`}
      exitUrl={`/edit/${refPath}`}
      linkCtx={{
        provider,
        project,
        currentPath: "",
        files: [],
        rawBase,
      }}
    />
  );
}
