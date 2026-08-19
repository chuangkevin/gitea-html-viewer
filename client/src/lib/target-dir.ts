export interface TargetDirInputs {
  /** ?dir= 參數的值（已清理過的目錄路徑）。沒有這個參數就傳 null。 */
  dirParam: string | null;
  /** 目前 focus 的資料夾（沒有就 null） */
  activeFolder: string | null;
  /** 目前開著的檔案路徑（沒有就 null） */
  activePath: string | null;
}

/**
 * 算出「新項目要建在哪個目錄」。優先序：
 *  1. dirParam 不是 null → 用它（資料夾檢視模式）
 *  2. activeFolder 有值 → 用它（focus 在資料夾上）
 *  3. activePath 含 "/" → 用它的上層目錄（focus 在檔案上）
 *  4. 其餘 → 回 ""（repo 根目錄）
 * 回傳值不含開頭與結尾的斜線。
 */
export function targetDirFor(inputs: TargetDirInputs): string {
  if (inputs.dirParam !== null) return stripEnds(inputs.dirParam);
  if (inputs.activeFolder) return stripEnds(inputs.activeFolder);
  if (inputs.activePath && inputs.activePath.includes("/")) {
    return stripEnds(inputs.activePath.split("/").slice(0, -1).join("/"));
  }
  return "";
}

/**
 * 把使用者輸入的名稱／相對路徑接到 baseDir 底下。
 *  - 先把 name 正規化：多個斜線收成一個、去掉開頭與結尾斜線
 *  - baseDir 為空 → 直接回正規化後的 name
 *  - name 已經以 `baseDir + "/"` 開頭，或 name === baseDir → 不重複加前綴，原樣回
 *  - 其餘 → 回 `${baseDir}/${name}`
 * name 正規化後是空字串時回 ""（呼叫端自己擋）。
 */
export function joinTargetPath(baseDir: string, name: string): string {
  const normalized = name.replace(/\/+/g, "/").replace(/^\/|\/$/g, "");
  if (!normalized) return "";
  if (!baseDir) return normalized;
  if (normalized === baseDir || normalized.startsWith(baseDir + "/")) return normalized;
  return `${baseDir}/${normalized}`;
}

/** 顯示用標籤：空字串 → "根目錄"，否則原樣回。 */
export function targetDirLabelFor(dir: string): string {
  return dir === "" ? "根目錄" : dir;
}

function stripEnds(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}
