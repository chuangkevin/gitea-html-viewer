/** 把檔名拆成 base 與副檔名。副檔名含前導點；沒有副檔名時 ext = ""。
 *  規則：只認「最後一個點」，且該點的 index 必須 > 0（`.gitignore` 視為沒有副檔名）。 */
export function splitName(name: string): { base: string; ext: string } {
  const i = name.lastIndexOf(".");
  if (i > 0) return { base: name.slice(0, i), ext: name.slice(i) };
  return { base: name, ext: "" };
}

/** 算出重複檔案的目標路徑。
 *  - filePath: 來源完整路徑，例如 "docs/ABC.txt"
 *  - existing: repo 內已存在的所有檔案路徑（用來避開碰撞）
 *  規則：
 *    ABC.txt        → ABC-複製.txt
 *    已存在 ABC-複製.txt → ABC-複製2.txt，再撞 → ABC-複製3.txt … （上限 999，超過就丟 Error）
 *    ABC（無副檔名） → ABC-複製
 *    .gitignore     → .gitignore-複製
 *    ABC-複製.txt   → ABC-複製-複製.txt（不要試圖「解析」既有的-複製，單純再接一層）
 *  回傳與來源同資料夾的完整路徑。
 *  比對 existing 時大小寫敏感（跟 Git 一致），existing 用 Set 或 Array 皆可。 */
export function duplicatePathFor(filePath: string, existing: readonly string[]): string {
  const slash = filePath.lastIndexOf("/");
  const dir = slash >= 0 ? filePath.slice(0, slash + 1) : "";
  const name = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  const { base, ext } = splitName(name);
  const taken = new Set(existing);

  const candidate = (n: number): string =>
    n === 1 ? `${dir}${base}-複製${ext}` : `${dir}${base}-複製${n}${ext}`;

  for (let n = 1; n <= 999; n++) {
    const path = candidate(n);
    if (!taken.has(path)) return path;
  }
  throw new Error("無法產生不重複的複製檔名（已超過 999）");
}
