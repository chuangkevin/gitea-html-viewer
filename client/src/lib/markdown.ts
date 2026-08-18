import { marked } from "marked";
import DOMPurify from "dompurify";
import {
  classifyHref,
  resolveRepoHref,
  buildAssetUrl,
  safeDecodeHref,
  urlCardInfo,
} from "./doc-paths.js";
import { blockSourceRanges } from "./drop-position.js";

marked.setOptions({ gfm: true, breaks: true });

export interface LinkContext {
  provider: string;
  project: string; // 原始 projectPath，例如 interagent-io/global-doc
  currentPath: string; // 目前開啟的檔案路徑，例如 docs/a/b.md
  files: string[]; // 這個 repo 的所有檔案路徑
  /** 把 repo 路徑解析成可讀取的資產 URL（圖片用）。不給就不改寫 <img src>。 */
  rawBase?: string;
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

      const kind = classifyHref(href);

      // 1. 純錨點與通訊協定連結（mailto:, tel:, data:）→ 不動
      if (kind === "anchor" || kind === "protocol") return;

      // 2. 外部連結（http://, https://, //）→ 加上 target="_blank" 與 rel="noopener noreferrer"
      if (kind === "external") {
        a.setAttribute("target", "_blank");
        a.setAttribute("rel", "noopener noreferrer");
        return;
      }

      // 3. repo 內路徑：需有 ctx 才能解析
      if (kind === "repo" && ctx) {
        const decodedHref = safeDecodeHref(href);
        const { path: resolvedPath, anchor } = resolveRepoHref(decodedHref, ctx.currentPath);
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

    // 處理 <img> 標籤
    const images = doc.querySelectorAll("img");
    images.forEach((img) => {
      const src = img.getAttribute("src");
      if (src) {
        const kind = classifyHref(src);
        if (kind === "repo") {
          if (ctx?.rawBase) {
            const decodedSrc = safeDecodeHref(src);
            const { path: resolvedPath } = resolveRepoHref(decodedSrc, ctx.currentPath);
            img.setAttribute("src", buildAssetUrl(ctx.rawBase, ctx.provider, ctx.project, resolvedPath));
          } else {
            img.setAttribute("data-nb-unresolved", "1");
          }
        }
      }
      img.setAttribute("loading", "lazy");
      img.classList.add("nb-img");
    });

    // 裸網址卡片處理
    const paragraphs = doc.querySelectorAll("p");
    paragraphs.forEach((p) => {
      const meaningfulChildren = Array.from(p.childNodes).filter((n) => {
        return n.nodeType !== Node.TEXT_NODE || (n.textContent ?? "").trim().length > 0;
      });
      if (meaningfulChildren.length === 1 && meaningfulChildren[0].nodeType === Node.ELEMENT_NODE) {
        const el = meaningfulChildren[0] as HTMLElement;
        if (el.tagName.toLowerCase() === "a") {
          const href = el.getAttribute("href") || "";
          const linkText = el.textContent || "";
          const card = urlCardInfo(href, linkText);
          if (card) {
            el.classList.add("nb-url-card");
            el.textContent = "";
            const domainSpan = doc.createElement("span");
            domainSpan.className = "nb-url-card-domain";
            domainSpan.textContent = card.domain;
            const urlSpan = doc.createElement("span");
            urlSpan.className = "nb-url-card-url";
            urlSpan.textContent = card.display;
            el.appendChild(domainSpan);
            el.appendChild(urlSpan);
          }
        }
      }
    });

    const ranges = blockSourceRanges(md);
    const children = Array.from(doc.body.children);
    if (children.length === ranges.length) {
      children.forEach((el, idx) => {
        el.setAttribute("data-src-start", String(ranges[idx].start));
        el.setAttribute("data-src-end", String(ranges[idx].end));
      });
    }

    return DOMPurify.sanitize(doc.body.innerHTML, {
      ADD_ATTR: ["target", "rel", "data-nb-unresolved", "loading", "data-src-start", "data-src-end"],
    });
  }

  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ["target", "rel", "data-nb-unresolved", "loading", "data-src-start", "data-src-end"],
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
