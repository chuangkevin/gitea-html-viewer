/** 側欄寬度的界線。DEFAULT 對應原本的 w-72。 */
export const SIDEBAR_MIN = 200;
export const SIDEBAR_DEFAULT = 288;
/** 主編輯區至少要留這麼寬，否則側欄不准再拉。 */
export const MAIN_MIN = 360;

/** 只讀 / 只寫 localStorage 的最小介面，方便測試塞假物件。 */
export interface WidthStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function maxSidebarWidth(viewportWidth: number): number {
  return Math.max(SIDEBAR_MIN, Math.min(viewportWidth * 0.6, viewportWidth - MAIN_MIN));
}

/** 把寬度夾在合法範圍內。
 *  上限 = max(SIDEBAR_MIN, min(viewportWidth * 0.6, viewportWidth - MAIN_MIN))
 *  非有限數（NaN / Infinity）一律回 SIDEBAR_DEFAULT 夾過的結果。
 *  回傳值取整數。 */
export function clampSidebarWidth(px: number, viewportWidth: number): number {
  const source = Number.isFinite(px) ? px : SIDEBAR_DEFAULT;
  const maxW = maxSidebarWidth(viewportWidth);
  return Math.round(Math.min(maxW, Math.max(SIDEBAR_MIN, source)));
}

/** localStorage 的 key。登入者用 `nb.sidebarWidth:<login>`，沒登入用 `nb.sidebarWidth`。 */
export function sidebarStorageKey(login: string | null | undefined): string {
  if (login) return `nb.sidebarWidth:${login}`;
  return "nb.sidebarWidth";
}

/** 讀出已存的寬度；沒存過、存的不是數字、或超出範圍，都回夾過的合理值。
 *  store 讀取丟例外時（例如 Safari 無痕模式）不可以讓例外冒出去，回 SIDEBAR_DEFAULT。 */
export function readSidebarWidth(
  store: WidthStore,
  login: string | null | undefined,
  viewportWidth: number
): number {
  try {
    const raw = store.getItem(sidebarStorageKey(login));
    if (raw == null) return clampSidebarWidth(SIDEBAR_DEFAULT, viewportWidth);
    const n = Number(raw);
    if (!Number.isFinite(n)) return clampSidebarWidth(SIDEBAR_DEFAULT, viewportWidth);
    return clampSidebarWidth(n, viewportWidth);
  } catch {
    return SIDEBAR_DEFAULT;
  }
}

/** 寫入寬度（寫入前先 clamp）。store 丟例外時安靜吞掉，不可以讓例外冒出去。 */
export function writeSidebarWidth(
  store: WidthStore,
  login: string | null | undefined,
  px: number,
  viewportWidth: number
): void {
  try {
    const w = clampSidebarWidth(px, viewportWidth);
    store.setItem(sidebarStorageKey(login), String(w));
  } catch {
    // Safari 無痕等環境可能丟例外；版面偏好寫失敗就略過。
  }
}
