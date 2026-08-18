import { marked } from "marked";

export interface BlockRange {
  /** 這個區塊在 markdown 原始碼的起始 offset（含） */
  start: number;
  /** 結束 offset（不含） */
  end: number;
}

/**
 * 這個 token 渲染後會不會「一個元素都不產生」。
 * space／def 本來就不產生東西；純 HTML 註解（例如 writeback 用的 `<!-- item:... -->`）
 * 會變成 comment node 而不是元素，也要算進來——不然區塊數對不上，
 * 整份文件就會退回「插在末尾」。
 */
function rendersNoElement(token: { type: string; raw: string }): boolean {
  if (token.type === "space" || token.type === "def") return true;
  if (token.type === "html") {
    return token.raw.replace(/<!--[\s\S]*?-->/g, "").trim().length === 0;
  }
  return false;
}

/**
 * 算出 markdown 每個「會渲染出東西的 top-level 區塊」在原始碼的 offset 範圍。
 * 用 marked 的 lexer：token.raw 串起來等於原始碼，所以累加 raw.length 就是 offset。
 * 渲染後不產生元素的 token 要跳過（但 offset 仍要累加）。
 */
export function blockSourceRanges(md: string): BlockRange[] {
  const tokens = marked.lexer(md);
  const ranges: BlockRange[] = [];
  let offset = 0;

  for (const token of tokens) {
    const len = token.raw.length;
    const start = offset;
    const end = offset + len;
    offset = end;

    if (rendersNoElement(token)) {
      continue;
    }

    ranges.push({ start, end });
  }

  return ranges;
}

/**
 * 依放開點的 Y 座標決定要插在原始碼的哪個 offset。
 * blocks 是「畫面上每個區塊的位置 + 它對應的原始碼範圍」，依畫面順序排好。
 * 規則：
 *  - 命中某個區塊（top <= y <= bottom）：落在該區塊上半 → 回 start（插在它前面）；下半 → 回 end（插在它後面）
 *  - 落在所有區塊之上 → 回第一個區塊的 start
 *  - 落在所有區塊之下 → 回 contentLength（插在最後）
 *  - 落在兩個區塊之間的空隙 → 回上面那個區塊的 end
 *  - blocks 是空的 → 回 contentLength
 */
export function insertOffsetForPoint(
  blocks: Array<{ top: number; bottom: number; start: number; end: number }>,
  y: number,
  contentLength: number
): number {
  if (blocks.length === 0) {
    return contentLength;
  }

  if (y < blocks[0].top) {
    return blocks[0].start;
  }

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    if (y >= block.top && y <= block.bottom) {
      const mid = (block.top + block.bottom) / 2;
      return y < mid ? block.start : block.end;
    }

    if (i < blocks.length - 1) {
      const nextBlock = blocks[i + 1];
      if (y > block.bottom && y < nextBlock.top) {
        return block.end;
      }
    }
  }

  return contentLength;
}

export interface SourceSpan {
  start: number;
  end: number;
}

/**
 * 掃出 md.slice(from, to) 範圍內所有 markdown 圖片語法 `![alt](destination)` 的位置，
 * 回傳的是「相對於整份 md 的絕對 offset」，依出現順序排列。
 * destination 支援兩種寫法：`<...>` 角括號（我們插入含空白路徑時會用）與一般寫法（可含成對的小括號）。
 */
export function imageSpansIn(md: string, from: number, to: number): SourceSpan[] {
  const spans: SourceSpan[] = [];
  const clampedFrom = Math.max(0, from);
  const clampedTo = Math.min(md.length, to);
  let i = clampedFrom;

  while (i < clampedTo) {
    const startIdx = md.indexOf("![", i);
    if (startIdx === -1 || startIdx >= clampedTo) break;

    // 掃過 alt：遇到 ] 結束、\] 要跳過
    let altIdx = startIdx + 2;
    let altClosed = false;
    while (altIdx < clampedTo) {
      if (md[altIdx] === "\\") {
        altIdx += 2;
        continue;
      }
      if (md[altIdx] === "]") {
        altClosed = true;
        break;
      }
      altIdx++;
    }

    if (!altClosed || altIdx + 1 >= clampedTo || md[altIdx + 1] !== "(") {
      i = startIdx + 2;
      continue;
    }

    const destStart = altIdx + 2;
    let endIdx = -1;

    if (destStart < clampedTo && md[destStart] === "<") {
      // 角括號寫法：<...>
      let angleIdx = destStart + 1;
      let closeAngle = -1;
      while (angleIdx < clampedTo) {
        if (md[angleIdx] === "\\") {
          angleIdx += 2;
          continue;
        }
        if (md[angleIdx] === ">") {
          closeAngle = angleIdx;
          break;
        }
        angleIdx++;
      }
      if (closeAngle !== -1) {
        let afterAngle = closeAngle + 1;
        while (afterAngle < clampedTo && md[afterAngle] === " ") afterAngle++;
        if (afterAngle < clampedTo && md[afterAngle] === ")") {
          endIdx = afterAngle + 1;
        }
      }
    } else {
      // 一般寫法：括號深度計數
      let depth = 1;
      let pIdx = destStart;
      while (pIdx < clampedTo) {
        if (md[pIdx] === "\\") {
          pIdx += 2;
          continue;
        }
        if (md[pIdx] === "(") {
          depth++;
        } else if (md[pIdx] === ")") {
          depth--;
          if (depth === 0) {
            endIdx = pIdx + 1;
            break;
          }
        }
        pIdx++;
      }
    }

    if (endIdx !== -1) {
      spans.push({ start: startIdx, end: endIdx });
      i = endIdx;
    } else {
      i = startIdx + 2;
    }
  }

  return spans;
}

/**
 * 把 md 裡 span 這一段（一段 `![](...)` 語法）搬到 at 這個 offset。
 * 規則：
 *  - 先算出要搬的文字 text = md.slice(span.start, span.end)
 *  - 刪掉 span 之後，插入點要校正：at >= span.end 時 at -= (span.end - span.start)；
 *    at 落在 span 內部（span.start < at < span.end）視為「放回原地」→ 直接回傳原本的 md（不動）
 *  - 刪掉後如果那一行變成空行（span 前後只剩換行），要把多出來的那個換行一起收掉，
 *    不可以留下連續三個以上的換行，也不可以吃掉圖片以外的文字
 *  - 插入時比照現有 insertIntoEditor 的做法：前面不是換行就補一個 \n，後面不是換行就補一個 \n
 *  - 搬完之後 md 裡該圖片語法的出現次數必須「跟搬之前一樣」（移動不是複製）
 * 回傳新的 markdown 全文。
 */
export function moveSpanInSource(md: string, span: SourceSpan, at: number): string {
  // 放回原地：at 落在 span 內部（或邊界）
  if (at >= span.start && at <= span.end) {
    return md;
  }

  const text = md.slice(span.start, span.end);
  const spanLen = span.end - span.start;

  let targetAt = at >= span.end ? at - spanLen : at;

  let before = md.slice(0, span.start);
  let after = md.slice(span.end);

  // 處理刪除點前後的換行收尾
  if (before.length === 0) {
    // span 在文件最開頭，移除後續多餘的開頭換行
    const match = after.match(/^\n+/);
    if (match) {
      const trimCount = match[0].length;
      after = after.slice(trimCount);
      if (at >= span.end) {
        targetAt -= trimCount;
      }
    }
  } else if (after.length === 0) {
    // span 在文件最末尾，移除前置多餘的末尾換行
    const match = before.match(/\n+$/);
    if (match && match[0].length > 1) {
      const trimCount = match[0].length - 1;
      before = before.slice(0, before.length - trimCount);
    }
  } else {
    // span 在中間：檢查交界處連續換行數量
    const beforeNlMatch = before.match(/\n+$/);
    const afterNlMatch = after.match(/^\n+/);
    const beforeNls = beforeNlMatch ? beforeNlMatch[0].length : 0;
    const afterNls = afterNlMatch ? afterNlMatch[0].length : 0;
    const totalNls = beforeNls + afterNls;

    if (totalNls > 2) {
      const excess = totalNls - 2;
      // 優先從 after 開頭修剪
      const trimAfter = Math.min(afterNls, excess);
      if (trimAfter > 0) {
        after = after.slice(trimAfter);
        if (at >= span.end) {
          targetAt -= trimAfter;
        }
      }
      const remainingExcess = excess - trimAfter;
      if (remainingExcess > 0) {
        before = before.slice(0, before.length - remainingExcess);
      }
    }
  }

  const removed = before + after;
  targetAt = Math.max(0, Math.min(removed.length, targetAt));

  // 插入到 targetAt，比照 insertIntoEditor 規則
  const insBefore = removed.slice(0, targetAt);
  const insAfter = removed.slice(targetAt);
  const needLeadingNl = insBefore.length > 0 && !insBefore.endsWith("\n");
  const needTrailingNl = insAfter.length > 0 && !insAfter.startsWith("\n");
  const block = `${needLeadingNl ? "\n" : ""}${text}${needTrailingNl ? "\n" : ""}`;

  // 不可以在這裡做全域的換行正規化：那會連 code fence 內部的空行一起壓掉。
  // 刪除點的換行已經在上面就地收好，插入點最多各補一個 \n，不會生出連續三個換行。
  return insBefore + block + insAfter;
}
