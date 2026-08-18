export type ViewMode = "edit" | "split" | "preview";

export const VIEW_MODE_STORAGE_KEY = "note.viewMode";

export function isViewMode(v: unknown): v is ViewMode {
  return v === "edit" || v === "split" || v === "preview";
}

/**
 * 預設一律停在 preview——因為 preview 現在本身就是「可編輯的渲染畫面」，
 * 開檔就看到乾淨排版、點下去直接打字。edit（純原始碼）與 split 是進階選項。
 */
export function defaultViewMode(_isDesktop: boolean): ViewMode {
  return "preview";
}

export function initialViewMode(stored: string | null, isDesktop: boolean): ViewMode {
  return isViewMode(stored) ? stored : defaultViewMode(isDesktop);
}

export function resolveViewMode(
  view: ViewMode,
  opts: { readOnly: boolean; isDesktop: boolean }
): ViewMode {
  if (opts.readOnly) return "preview";
  // 手機沒有左右分割的空間；退回 preview（它本身就能編輯）而不是原始碼模式
  if (!opts.isDesktop && view === "split") return "preview";
  return view;
}

export type PaneMode = "text" | "images";

export const PANE_MODE_STORAGE_KEY = "note.paneMode";

export function isPaneMode(v: unknown): v is PaneMode {
  return v === "text" || v === "images";
}

export function initialPaneMode(stored: string | null): PaneMode {
  return isPaneMode(stored) ? stored : "text";
}

/**
 * 實際生效的子狀態。**按鈕高亮一定要讀這個推導值，不是原始 state**，
 * 這樣「顯示的」與「實際生效的」結構上不可能不一致。
 * 規則：
 *  - view 不是 "preview" → 一律 "text"（原始碼／分割模式沒有排圖狀態）
 *  - !canWrite（唯讀訪客）→ 一律 "text"
 *  - 其餘 → 回 paneMode 本身
 */
export function resolvePaneMode(paneMode: PaneMode, opts: { view: ViewMode; canWrite: boolean }): PaneMode {
  if (opts.view !== "preview") return "text";
  if (!opts.canWrite) return "text";
  return paneMode;
}
