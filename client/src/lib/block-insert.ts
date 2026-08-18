function clampOffset(doc: string, offset: number): number {
  if (!Number.isFinite(offset)) return 0;
  return Math.max(0, Math.min(doc.length, Math.trunc(offset)));
}

function hasNonNewline(text: string): boolean {
  for (let i = 0; i < text.length; i++) {
    if (text[i] !== "\n") return true;
  }
  return false;
}

function countLeadingNewlines(text: string): number {
  let count = 0;
  while (count < text.length && text[count] === "\n") count++;
  return count;
}

function countTrailingNewlines(text: string): number {
  let count = 0;
  while (count < text.length && text[text.length - 1 - count] === "\n") count++;
  return count;
}

function keepAtMostLeadingNewlines(text: string, max: number): string {
  const count = countLeadingNewlines(text);
  if (count <= max) return text;
  return text.slice(0, max) + text.slice(count);
}

function keepAtMostTrailingNewlines(text: string, max: number): string {
  const count = countTrailingNewlines(text);
  if (count <= max) return text;
  return text.slice(0, text.length - count + max);
}

/**
 * 把任意字元 offset 收斂到最近的「行邊界」。
 */
export function snapToLineBoundary(doc: string, offset: number): number {
  const clamped = clampOffset(doc, offset);
  const prevNewline = clamped === 0 ? -1 : doc.lastIndexOf("\n", clamped - 1);
  const nextNewline = doc.indexOf("\n", clamped);
  const lineStart = prevNewline + 1;
  const lineEnd = nextNewline === -1 ? doc.length : nextNewline;

  if (lineStart === lineEnd) return lineStart;
  return clamped - lineStart <= (lineEnd - lineStart) / 2 ? lineStart : lineEnd;
}

/**
 * 在 doc 的 offset 位置插入一段「獨立成段」的內容。
 */
export function insertAsBlock(doc: string, offset: number, snippet: string): { text: string; caret: number } {
  const pos = snapToLineBoundary(doc, offset);
  const rawBefore = doc.slice(0, pos);
  const rawAfter = doc.slice(pos);
  const hasBefore = hasNonNewline(rawBefore);
  const hasAfter = hasNonNewline(rawAfter);
  const before = hasBefore ? keepAtMostTrailingNewlines(rawBefore, 2) : "";
  const after = hasAfter ? keepAtMostLeadingNewlines(rawAfter, 2) : "";
  const beforeNewlines = countTrailingNewlines(before);
  const afterNewlines = countLeadingNewlines(after);
  const prefix = hasBefore ? "\n".repeat(Math.max(0, 2 - beforeNewlines)) : "";
  const suffix = hasAfter ? "\n".repeat(Math.max(0, 2 - afterNewlines)) : "";
  const insertStart = before.length + prefix.length;

  return {
    text: before + prefix + snippet + suffix + after,
    caret: insertStart + snippet.length,
  };
}
