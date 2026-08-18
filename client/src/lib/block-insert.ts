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
