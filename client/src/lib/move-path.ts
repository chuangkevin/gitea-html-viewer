/**
 * 「從檔案樹拖一個檔案到資料夾上＝移動檔案」用的 dataTransfer type。
 *
 * 刻意跟 `application/x-note-path`（拖到編輯區插入 markdown 連結）分開：
 * 同一次 dragstart 會同時帶兩種 type，由放開的目標決定要做哪件事——
 * 放在編輯區就插入連結，放在資料夾上就移動檔案。
 */
export const FILE_MOVE_MIME = "application/x-note-file-move";

export interface MoveCheck {
  ok: boolean;
  /** ok=false 時的原因代碼 */
  reason?: "same-dir" | "into-self" | "invalid";
  /** ok=true 時的目標完整路徑 */
  target?: string;
}

function normalize(p: string): string {
  return p.replace(/\/+/g, "/").replace(/^\/+|\/+$/g, "");
}

/**
 * 檢查「把 filePath 移到 targetDir 這個資料夾」是否有效，並算出目標路徑。
 * targetDir 用 "" 代表 repo 根目錄。
 */
export function checkMove(filePath: string, targetDir: string): MoveCheck {
  const file = normalize(filePath ?? "");
  const dir = normalize(targetDir ?? "");
  if (!file) return { ok: false, reason: "invalid" };

  // 目標資料夾就是這個檔案本身、或在它底下 → 不合法
  if (dir === file || dir.startsWith(file + "/")) return { ok: false, reason: "into-self" };

  const lastSlash = file.lastIndexOf("/");
  const currentDir = lastSlash >= 0 ? file.slice(0, lastSlash) : "";
  if (currentDir === dir) return { ok: false, reason: "same-dir" };

  const basename = lastSlash >= 0 ? file.slice(lastSlash + 1) : file;
  return { ok: true, target: dir ? `${dir}/${basename}` : basename };
}
