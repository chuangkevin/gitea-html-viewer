export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(code: number): boolean {
  return code >= HIGH_SURROGATE_START && code <= HIGH_SURROGATE_END;
}

function isLowSurrogate(code: number): boolean {
  return code >= LOW_SURROGATE_START && code <= LOW_SURROGATE_END;
}

/**
 * 算出「把 prev 變成 next」的最小單一區間替換。
 * 兩者相同回 null。
 *
 * 規則：
 *  - prev === next → 回 null
 *  - 共同前綴長度 p，上限 Math.min(prev.length, next.length)
 *  - 共同後綴長度 s，必須 clamp 成 s <= minLen - p（避免前後綴重疊算出 to < from）
 *  - 回 { from: p, to: prev.length - s, insert: next.slice(p, next.length - s) }
 *  - JS 字串是 UTF-16。若 p 正好把代理對切成兩半（prev.charCodeAt(p-1) 是高位代理），
 *    p 往前退 1。後綴切點若落在代理對中間，s 減 1。退位後仍維持 s <= minLen - p。
 */
export function minimalEdit(prev: string, next: string): TextEdit | null {
  if (prev === next) return null;

  const minLen = Math.min(prev.length, next.length);

  let p = 0;
  while (p < minLen && prev.charCodeAt(p) === next.charCodeAt(p)) {
    p++;
  }

  let s = 0;
  const maxSuffix = minLen - p;
  while (
    s < maxSuffix &&
    prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)
  ) {
    s++;
  }

  // 前綴切點落在高位代理之後 → 把高位代理劃進替換區，避免切開 emoji。
  if (p > 0 && isHighSurrogate(prev.charCodeAt(p - 1))) {
    p -= 1;
  }

  // 後綴切點落在低位代理上 → 把低位代理劃進替換區。
  if (s > 0 && isLowSurrogate(prev.charCodeAt(prev.length - s))) {
    s -= 1;
  }

  // 退位後重新 clamp，維持 s <= min(prev.length, next.length) - p。
  const maxS = Math.min(prev.length, next.length) - p;
  if (s > maxS) s = maxS;

  return {
    from: p,
    to: prev.length - s,
    insert: next.slice(p, next.length - s),
  };
}
