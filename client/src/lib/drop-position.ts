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
