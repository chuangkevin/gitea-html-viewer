import { marked } from "marked";
import DOMPurify from "dompurify";

marked.setOptions({ gfm: true, breaks: true });

export function renderMarkdown(md: string): string {
  const raw = marked.parse(md, { async: false }) as string;
  return DOMPurify.sanitize(raw);
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
