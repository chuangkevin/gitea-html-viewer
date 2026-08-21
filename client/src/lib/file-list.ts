/** 單檔改名／搬移：把 from 換成 to。files 裡沒有 from 時仍要把 to 加進去（容錯）。 */
export function applyMove(files: readonly string[], from: string, to: string): string[] {
  let found = false;
  const next = files.map((p) => {
    if (p === from) {
      found = true;
      return to;
    }
    return p;
  });
  if (!found && !next.includes(to)) next.push(to);
  return next;
}

/** 新增一個檔案路徑。已存在就原樣回傳（不重複）。 */
export function applyAdd(files: readonly string[], path: string): string[] {
  if (files.some((p) => p === path)) return [...files];
  return [...files, path];
}

/** 刪除一個檔案路徑。 */
export function applyRemove(files: readonly string[], path: string): string[] {
  return files.filter((p) => p !== path);
}

/** 資料夾改名：所有 from/ 開頭的路徑換成 to/ 開頭，其餘不動。 */
export function applyFolderMove(files: readonly string[], from: string, to: string): string[] {
  const prefix = from + "/";
  return files.map((p) => (p.startsWith(prefix) ? to + p.slice(from.length) : p));
}

/** 刪除資料夾：移除所有 folder/ 開頭的路徑。 */
export function applyFolderRemove(files: readonly string[], folder: string): string[] {
  const prefix = folder + "/";
  return files.filter((p) => !p.startsWith(prefix));
}
