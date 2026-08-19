import type * as Y from "yjs";
import type { TextEdit } from "./text-diff.js";

/**
 * 把一組局部變更套用到 Y.Text。
 * 一律包在同一個 transaction 裡（別人只會看到一次變更、undo 也是一步）。
 * 多筆變更要**由後往前**套用，否則前面的變更會讓後面的 offset 位移。
 * 空陣列或全部都是 no-op 就什麼都不做。
 */
export function applyEditsToYText(text: Y.Text, edits: readonly TextEdit[]): void {
  const ops = edits.filter((e) => e.to >= e.from && !(e.from === e.to && e.insert === ""));
  if (ops.length === 0) return;
  ops.sort((a, b) => b.from - a.from);

  const apply = () => {
    for (const { from, to, insert } of ops) {
      const len = to - from;
      if (len > 0) text.delete(from, len);
      if (insert !== "") text.insert(from, insert);
    }
  };

  const doc = text.doc;
  if (doc) doc.transact(apply);
  else apply();
}
