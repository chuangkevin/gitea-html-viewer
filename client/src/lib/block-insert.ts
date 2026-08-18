/** 一行在畫面上的位置與它對應的原始碼範圍。top/bottom 是 client 座標。 */
export interface LineBox {
  from: number; // 這一行在 markdown 原始碼的起始 offset
  to: number; // 結束 offset（不含換行）
  top: number;
  bottom: number;
}

/**
 * 把任意字元 offset 收斂到最近的「行邊界」。
 * offset 落在該行前半 → 回行首；後半 → 回行尾（不含換行）。空行回該位置。
 * offset 超出範圍要 clamp 到 [0, doc.length]。
 */
export function snapToLineBoundary(doc: string, offset: number): number {
  if (doc.length === 0) return 0;
  const o = Math.max(0, Math.min(doc.length, offset));
  const lineStart = doc.lastIndexOf("\n", o - 1) + 1;
  const nl = doc.indexOf("\n", o);
  const lineEnd = nl === -1 ? doc.length : nl;
  if (lineStart === lineEnd) return lineStart;
  const mid = (lineStart + lineEnd) / 2;
  return o < mid ? lineStart : lineEnd;
}

/**
 * 依放開點的 y，算出要插在原始碼的哪個 offset。回傳值一定是某一行的開頭或結尾。
 * boxes 必須依畫面順序排好。
 *  - boxes 空 → 回 docLength
 *  - y 落在某個 box 內：上半 → 回「前一個 box 的 to」（第一個 box 則回它自己的 from）；下半 → 回 box.to
 *  - y 在所有 box 之上 → 回第一個 box 的 from
 *  - y 在所有 box 之下 → 回最後一個 box 的 to
 *  - y 落在兩個 box 之間的空隙 → 回上面那個 box 的 to
 */
export function boundaryOffsetForY(boxes: LineBox[], y: number, docLength: number): number {
  if (boxes.length === 0) return docLength;
  if (y < boxes[0].top) return boxes[0].from;

  for (let i = 0; i < boxes.length; i++) {
    const box = boxes[i];
    if (y >= box.top && y <= box.bottom) {
      const mid = (box.top + box.bottom) / 2;
      if (y < mid) return i === 0 ? box.from : boxes[i - 1].to;
      return box.to;
    }
    if (i < boxes.length - 1) {
      const next = boxes[i + 1];
      if (y > box.bottom && y < next.top) return box.to;
    }
  }

  return boxes[boxes.length - 1].to;
}

/**
 * 在 doc 的 offset 插入「獨立成段」的內容。內部一定先 snapToLineBoundary，
 * 所以永遠不會把一行文字切成兩半。前後各補到「剛好隔一個空行」：
 *  - 前面若不是文件開頭且沒有空行 → 補換行補到有空行
 *  - 後面同理
 *  - 不可以產生連續三個以上換行
 * 回傳新內容與插入後游標位置（snippet 結尾）。
 */
export function insertAsBlock(
  doc: string,
  offset: number,
  snippet: string
): { text: string; caret: number } {
  const pos = snapToLineBoundary(doc, offset);
  const before = doc.slice(0, pos);
  const after = doc.slice(pos);
  const leading = padToBlankLine(before, "end");
  const trailing = padToBlankLine(after, "start");
  const text = before + leading + snippet + trailing + after;
  const caret = before.length + leading.length + snippet.length;
  return { text, caret };
}

function padToBlankLine(side: string, where: "end" | "start"): string {
  if (side.length === 0) return "";
  const hasBlank = where === "end" ? side.endsWith("\n\n") : side.startsWith("\n\n");
  if (hasBlank) return "";
  const hasOne = where === "end" ? side.endsWith("\n") : side.startsWith("\n");
  return hasOne ? "\n" : "\n\n";
}

export interface SourceSpan {
  start: number;
  end: number;
}

/**
 * 把 doc 裡 [span.start, span.end) 這段內容搬到 at 的位置，並讓它自成一塊
 * （前後各隔一個空行），語意與 insertAsBlock 一致。
 *
 * 規則：
 *  - at 落在 span 內部或邊界（span.start <= at <= span.end）→ 原樣回傳 doc（放回原地不動）
 *  - 先把該段從 doc 移除，移除後把接縫處多餘的換行收斂（不可留下三個以上連續換行、
 *    也不可讓原本分開的兩段黏在一起）
 *  - 移除後 at 要跟著位移：at >= span.end 時要減去該段長度；at <= span.start 時不變
 *  - 再用 insertAsBlock(removed, 位移後的 at, 被搬的內容) 插回去
 *  - 被搬的內容取 doc.slice(span.start, span.end) 後要 trim 掉頭尾換行（避免把原本的
 *    換行一起搬過去而產生多餘空行）
 * 回傳新的完整內容字串。
 */
export function moveSpanAsBlock(doc: string, span: SourceSpan, at: number): string {
  if (at >= span.start && at <= span.end) return doc;

  const snippet = doc.slice(span.start, span.end).replace(/^\n+/, "").replace(/\n+$/, "");
  const spanLen = span.end - span.start;
  let targetAt = at >= span.end ? at - spanLen : at;

  let before = doc.slice(0, span.start);
  let after = doc.slice(span.end);

  const beforeNls = (before.match(/\n+$/) ?? [""])[0].length;
  const afterNls = (after.match(/^\n+/) ?? [""])[0].length;
  const excess = beforeNls + afterNls - 2;
  let trimmedBefore = 0;
  let trimmedAfter = 0;
  if (excess > 0) {
    trimmedAfter = Math.min(afterNls, excess);
    trimmedBefore = excess - trimmedAfter;
    if (trimmedAfter > 0) after = after.slice(trimmedAfter);
    if (trimmedBefore > 0) before = before.slice(0, before.length - trimmedBefore);
  }

  // 接縫收斂拿掉的字元若落在 at 之前，位移後的 at 要再跟著減，否則會指到錯位。
  if (at >= span.end) targetAt -= trimmedAfter + trimmedBefore;

  const removed = before + after;
  targetAt = Math.max(0, Math.min(removed.length, targetAt));
  return insertAsBlock(removed, targetAt, snippet).text;
}
