export interface AutosaveTiming {
  /** 這一輪 dirty 開始的時間戳（毫秒）。乾淨狀態是 null。 */
  dirtySince: number | null;
  /** 最後一次編輯的時間戳（毫秒）。 */
  lastEditAt: number;
  /** 現在時間（毫秒）。 */
  now: number;
  idleMs: number;
  maxWaitMs: number;
}

/**
 * 回傳「距離下次自動存檔還要等幾毫秒」。
 * - 閒置 idleMs 就存
 * - 但從 dirtySince 起算超過 maxWaitMs 就一定要存（封頂）
 * - 已經該存了回 0；dirtySince 是 null（沒有未存內容）回 null
 */
export function nextAutosaveDelay(t: AutosaveTiming): number | null {
  if (t.dirtySince === null) return null;
  const idleAt = t.lastEditAt + t.idleMs;
  const capAt = t.dirtySince + t.maxWaitMs;
  const delay = Math.min(idleAt, capAt) - t.now;
  return delay < 0 ? 0 : delay;
}
