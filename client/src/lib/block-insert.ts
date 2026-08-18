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

/** 一行在畫面上的位置與它對應的原始碼範圍。top/bottom 是 client 座標（螢幕）。 */
export interface LineBlock {
  from: number;   // 這一行在 markdown 原始碼的起始 offset
  to: number;     // 這一行的結束 offset（不含換行字元）
  top: number;    // 這一行在畫面上的上緣 y
  bottom: number; // 下緣 y
}

/**
 * 依放開點的 y 座標，算出「要插在原始碼的哪個 offset」。
 * 回傳值一定是某一行的開頭或結尾（＝行邊界），所以永遠不會把一行文字切開。
 *
 * 規則（blocks 必須依畫面順序排好）：
 *  - blocks 是空的 → 回 docLength
 *  - y 落在某一行內（top <= y <= bottom）：在該行「上半」→ 回 block.from（插在這行前面）；
 *    「下半」→ 回 block.to（插在這行後面）
 *  - y 在所有行之上 → 回第一行的 from
 *  - y 在所有行之下 → 回最後一行的 to
 *  - y 落在兩行之間的空隙 → 回上面那一行的 to
 */
export function boundaryOffsetForY(blocks: LineBlock[], y: number, docLength: number): number {
  if (blocks.length === 0) return docLength;

  const beforeBlockBoundary = (index: number) => (index === 0 ? blocks[0].from : blocks[index - 1].to);

  if (y < blocks[0].top) return blocks[0].from;

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (y >= block.top && y <= block.bottom) {
      const midpoint = (block.top + block.bottom) / 2;
      return y < midpoint ? beforeBlockBoundary(i) : block.to;
    }

    const next = blocks[i + 1];
    if (next && y > block.bottom && y < next.top) return block.to;
  }

  return blocks[blocks.length - 1].to;
}
