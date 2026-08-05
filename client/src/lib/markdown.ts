import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export interface LinkContext {
  provider: string;
  project: string; // 原始 projectPath，例如 interagent-io/global-doc
  currentPath: string; // 目前開啟的檔案路徑，例如 docs/a/b.md
  files: string[]; // 這個 repo 的所有檔案路徑
}

function normalizePathParts(pathStr: string): string {
  const parts = pathStr.split("/");
  const stack: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") {
      stack.pop();
    } else {
      stack.push(p);
    }
  }
  return stack.join("/");
}

export function renderMarkdown(md: string, ctx?: LinkContext): string {
  const raw = marked.parse(md, { async: false }) as string;

  if (typeof window !== "undefined") {
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, "text/html");
    const anchors = doc.querySelectorAll("a");

    anchors.forEach((a) => {
      const href = a.getAttribute("href");
      if (!href) return;

      // 1. # 開頭（純錨點）→ 完全不動
      if (href.startsWith("#")) return;

      // 2. mailto: / tel: → 不動
      if (href.startsWith("mailto:") || href.startsWith("tel:")) return;

      // 3. http:// 或 https:// 或 // 開頭 → 加上 target="_blank" 與 rel="noopener noreferrer"
      if (href.startsWith("http://") || href.startsWith("https://") || href.startsWith("//")) {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        return;
      }

      // 4. 其他（相對路徑）：需有 ctx 才能解析
      if (ctx) {
        const hashIdx = href.indexOf("#");
        const cleanPath = hashIdx >= 0 ? href.slice(0, hashIdx) : href;
        const anchor = hashIdx >= 0 ? href.slice(hashIdx) : "";

        let targetPath: string;
        if (cleanPath.startsWith("/")) {
          targetPath = cleanPath.slice(1);
        } else {
          const parts = ctx.currentPath.split("/");
          const currentDir = parts.length > 1 ? parts.slice(0, -1).join("/") : "";
          targetPath = currentDir ? `${currentDir}/${cleanPath}` : cleanPath;
        }

        const resolvedPath = normalizePathParts(targetPath);
        const encodedProject = encodeURIComponent(ctx.project);

        if (ctx.files.includes(resolvedPath)) {
          // 完全等於某個檔案路徑
          const newHref = `/edit/${ctx.provider}/${encodedProject}?f=${encodeURIComponent(resolvedPath)}${anchor}`;
          a.setAttribute("href", newHref);
        } else if (ctx.files.some((f) => f.startsWith(resolvedPath + "/"))) {
          // 目錄前綴
          const newHref = `/edit/${ctx.provider}/${encodedProject}?dir=${encodeURIComponent(resolvedPath)}${anchor}`;
          a.setAttribute("href", newHref);
        } else {
          // 都對不上
          a.setAttribute("data-nb-unresolved", "1");
        }
      }
    });

    return DOMPurify.sanitize(doc.body.innerHTML, {
      ADD_ATTR: ["target", "rel", "data-nb-unresolved"],
    });
  }

  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["target", "rel", "data-nb-unresolved"],
  });
}

/**
 * 簡報切頁：以獨立一行的 `---` 為分隔。
 * 若檔案開頭是 YAML frontmatter（--- ... ---），先剝掉再切。
 */
export function splitSlides(md: string): string[] {
  let body = md;
  const fm = /^---\n[\s\S]*?\n---\n/;
  if (fm.test(body)) body = body.replace(fm, "");
  return body
    .split(/\n---\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
