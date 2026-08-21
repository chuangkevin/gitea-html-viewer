/** 依使用者輸入的檔名決定最終路徑與初始內容。 */
export function newFileFrom(path: string): { path: string; initial: string } {
  const basename = path.split("/").pop() || path;
  const hasExt = basename.lastIndexOf(".") > 0 && /\.[A-Za-z0-9]{1,10}$/.test(basename);
  const isDotfile = basename.startsWith(".") && basename.lastIndexOf(".") === 0;
  const finalPath = hasExt || isDotfile ? path : `${path}.md`;
  const finalBase = finalPath.split("/").pop() || finalPath;
  const initial = /\.md$/i.test(finalBase) ? `# ${finalBase.replace(/\.md$/i, "")}\n\n` : "";
  return { path: finalPath, initial };
}

/** 把使用者輸入的檔名換成指定副檔名（給「副檔名快選」按鈕用）。
 *  - ext 一律含前導點，例如 ".md"
 *  - name 為空或只有空白 → 回 "" （呼叫端自己處理）
 *  - basename 已有副檔名（lastIndexOf(".") > 0 且結尾符合 /\.[A-Za-z0-9]{1,10}$/）→ 換掉它
 *  - basename 沒有副檔名 → 直接接上
 *  - dotfile（以點開頭、後面沒有第二個點，例如 ".gitignore"）→ 視為沒有副檔名，直接接上
 *  - 路徑前綴（"docs/a/b"）要保留 */
export function applyExtension(name: string, ext: string): string {
  if (!name.trim()) return "";
  const slash = name.lastIndexOf("/");
  const dir = slash >= 0 ? name.slice(0, slash + 1) : "";
  const basename = slash >= 0 ? name.slice(slash + 1) : name;
  const hasExt = basename.lastIndexOf(".") > 0 && /\.[A-Za-z0-9]{1,10}$/.test(basename);
  if (hasExt) {
    return dir + basename.replace(/\.[A-Za-z0-9]{1,10}$/, ext);
  }
  return dir + basename + ext;
}
