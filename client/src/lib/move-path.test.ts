import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { checkMove, FILE_MOVE_MIME } from "./move-path.js";

describe("move-path module", () => {
  it("把檔案移到另一個資料夾", () => {
    assert.deepEqual(checkMove("a/b/x.md", "c"), { ok: true, target: "c/x.md" });
  });

  it("移到根目錄（targetDir 為空字串）", () => {
    assert.deepEqual(checkMove("a/b/x.md", ""), { ok: true, target: "x.md" });
  });

  it("從根目錄移進資料夾", () => {
    assert.deepEqual(checkMove("x.md", "a/b"), { ok: true, target: "a/b/x.md" });
  });

  it("已經在該資料夾 → same-dir", () => {
    assert.equal(checkMove("a/b/x.md", "a/b").ok, false);
    assert.equal(checkMove("a/b/x.md", "a/b").reason, "same-dir");
    assert.equal(checkMove("x.md", "").reason, "same-dir");
  });

  it("目標就是檔案自己或在它底下 → into-self", () => {
    assert.equal(checkMove("a/b/x.md", "a/b/x.md").reason, "into-self");
    assert.equal(checkMove("a/b/x.md", "a/b/x.md/inner").reason, "into-self");
  });

  it("空路徑 → invalid", () => {
    assert.equal(checkMove("", "a").reason, "invalid");
    assert.equal(checkMove("   ".trim(), "a").reason, "invalid");
  });

  it("路徑正規化：前後斜線與雙斜線都要收乾淨", () => {
    assert.deepEqual(checkMove("/a//b/x.md/", "/c//d/"), { ok: true, target: "c/d/x.md" });
  });

  it("契約：ok 時 target 不含 //、不以 / 開頭或結尾，且 basename 與原檔相同", () => {
    const cases: Array<[string, string]> = [
      ["a/b/x.md", "c"],
      ["a/b/x.md", ""],
      ["x.md", "a/b"],
      ["/a//b/x.md/", "/c//d/"],
      ["導入客戶/元信豐/圖 1.png", "客戶POC"],
    ];
    for (const [file, dir] of cases) {
      const r = checkMove(file, dir);
      assert.equal(r.ok, true, `${file} → ${dir} 應該可以移動`);
      const t = r.target as string;
      assert.ok(!t.includes("//"), `target 不可含 //：${t}`);
      assert.ok(!t.startsWith("/") && !t.endsWith("/"), `target 不可有頭尾斜線：${t}`);
      const srcBase = file.replace(/\/+$/, "").split("/").pop();
      assert.equal(t.split("/").pop(), srcBase, `basename 必須不變：${t}`);
    }
  });

  it("MIME 常數與插入連結用的那個不同（兩種用途必須分流）", () => {
    assert.equal(FILE_MOVE_MIME, "application/x-note-file-move");
    assert.notEqual(FILE_MOVE_MIME, "application/x-note-path");
  });
});
