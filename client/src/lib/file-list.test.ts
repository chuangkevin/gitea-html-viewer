import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyAdd,
  applyFolderMove,
  applyFolderRemove,
  applyMove,
  applyRemove,
} from "./file-list.js";

function assertUnchanged(original: readonly string[], snapshot: readonly string[]) {
  assert.deepEqual(original, snapshot);
}

describe("applyMove", () => {
  it("把 from 換成 to", () => {
    const files = ["a.md", "b/c.md"];
    assert.deepEqual(applyMove(files, "a.md", "d.md"), ["d.md", "b/c.md"]);
  });

  it("from 不存在時仍把 to 加進去", () => {
    assert.deepEqual(applyMove(["a.md"], "missing.md", "y.md"), ["a.md", "y.md"]);
    assert.deepEqual(applyMove([], "missing.md", "y.md"), ["y.md"]);
  });

  it("from 不存在且 to 已在清單中時不產生重複", () => {
    const next = applyMove(["a.md", "b.md"], "missing.md", "b.md");
    assert.equal(next.length, 2);
    assert.deepEqual(next, ["a.md", "b.md"]);
  });

  it("前綴相似但不該被誤傷（docs vs docs2）", () => {
    const files = ["docs/a.md", "docs2/a.md"];
    assert.deepEqual(applyMove(files, "docs/a.md", "notes/a.md"), ["notes/a.md", "docs2/a.md"]);
  });

  it("巢狀路徑只改完全相符的那一筆", () => {
    const files = ["docs/sub/a.md", "docs/sub/b.md"];
    assert.deepEqual(applyMove(files, "docs/sub/a.md", "docs/sub/renamed.md"), [
      "docs/sub/renamed.md",
      "docs/sub/b.md",
    ]);
  });

  it("輸入陣列沒有被就地改動", () => {
    const files = ["a.md", "b.md"];
    const snapshot = [...files];
    applyMove(files, "a.md", "c.md");
    assertUnchanged(files, snapshot);
  });
});

describe("applyAdd", () => {
  it("新增一個尚未存在的路徑", () => {
    assert.deepEqual(applyAdd(["a.md"], "b.md"), ["a.md", "b.md"]);
    assert.deepEqual(applyAdd([], "a.md"), ["a.md"]);
  });

  it("已存在就原樣回傳（不重複）", () => {
    const files = ["a.md", "b.md"];
    assert.deepEqual(applyAdd(files, "a.md"), ["a.md", "b.md"]);
  });

  it("前綴相似但不該被當成同一檔（docs vs docs2）", () => {
    const files = ["docs/a.md"];
    assert.deepEqual(applyAdd(files, "docs2/a.md"), ["docs/a.md", "docs2/a.md"]);
  });

  it("巢狀路徑可新增", () => {
    assert.deepEqual(applyAdd(["docs/sub/a.md"], "docs/sub/b.md"), ["docs/sub/a.md", "docs/sub/b.md"]);
  });

  it("輸入陣列沒有被就地改動", () => {
    const files = ["a.md"];
    const snapshot = [...files];
    applyAdd(files, "b.md");
    applyAdd(files, "a.md");
    assertUnchanged(files, snapshot);
  });
});

describe("applyRemove", () => {
  it("刪除指定路徑", () => {
    assert.deepEqual(applyRemove(["a.md", "b.md"], "a.md"), ["b.md"]);
  });

  it("目標不存在時其餘不動", () => {
    assert.deepEqual(applyRemove(["a.md"], "missing.md"), ["a.md"]);
    assert.deepEqual(applyRemove([], "a.md"), []);
  });

  it("前綴相似但不該被誤傷（docs vs docs2）", () => {
    const files = ["docs/a.md", "docs2/a.md"];
    assert.deepEqual(applyRemove(files, "docs/a.md"), ["docs2/a.md"]);
  });

  it("巢狀路徑只刪完全相符的那一筆", () => {
    const files = ["docs/sub/a.md", "docs/sub/b.md"];
    assert.deepEqual(applyRemove(files, "docs/sub/a.md"), ["docs/sub/b.md"]);
  });

  it("輸入陣列沒有被就地改動", () => {
    const files = ["a.md", "b.md"];
    const snapshot = [...files];
    applyRemove(files, "a.md");
    assertUnchanged(files, snapshot);
  });
});

describe("applyFolderMove", () => {
  it("from/ 開頭換成 to/ 開頭", () => {
    const files = ["docs/a.md", "docs/sub/b.md", "other.md"];
    assert.deepEqual(applyFolderMove(files, "docs", "notes"), [
      "notes/a.md",
      "notes/sub/b.md",
      "other.md",
    ]);
  });

  it("from 底下沒有檔時其餘不動", () => {
    assert.deepEqual(applyFolderMove(["a.md"], "missing", "notes"), ["a.md"]);
    assert.deepEqual(applyFolderMove([], "docs", "notes"), []);
  });

  it("前綴相似但不該被誤傷（docs vs docs2）", () => {
    const files = ["docs/a.md", "docs2/a.md", "docs.md"];
    assert.deepEqual(applyFolderMove(files, "docs", "notes"), ["notes/a.md", "docs2/a.md", "docs.md"]);
  });

  it("巢狀資料夾只改該層 prefix", () => {
    const files = ["docs/sub/a.md", "docs/sub/inner/b.md", "docs/other.md"];
    assert.deepEqual(applyFolderMove(files, "docs/sub", "docs/moved"), [
      "docs/moved/a.md",
      "docs/moved/inner/b.md",
      "docs/other.md",
    ]);
  });

  it("輸入陣列沒有被就地改動", () => {
    const files = ["docs/a.md", "other.md"];
    const snapshot = [...files];
    applyFolderMove(files, "docs", "notes");
    assertUnchanged(files, snapshot);
  });
});

describe("applyFolderRemove", () => {
  it("移除所有 folder/ 開頭的路徑", () => {
    const files = ["docs/a.md", "docs/sub/b.md", "other.md"];
    assert.deepEqual(applyFolderRemove(files, "docs"), ["other.md"]);
  });

  it("目標資料夾不存在時其餘不動", () => {
    assert.deepEqual(applyFolderRemove(["a.md"], "missing"), ["a.md"]);
    assert.deepEqual(applyFolderRemove([], "docs"), []);
  });

  it("前綴相似但不該被誤傷（docs vs docs2）", () => {
    const files = ["docs/a.md", "docs2/a.md", "docs.md"];
    assert.deepEqual(applyFolderRemove(files, "docs"), ["docs2/a.md", "docs.md"]);
  });

  it("巢狀資料夾只刪該層底下", () => {
    const files = ["docs/sub/a.md", "docs/sub/inner/b.md", "docs/other.md"];
    assert.deepEqual(applyFolderRemove(files, "docs/sub"), ["docs/other.md"]);
  });

  it("輸入陣列沒有被就地改動", () => {
    const files = ["docs/a.md", "other.md"];
    const snapshot = [...files];
    applyFolderRemove(files, "docs");
    assertUnchanged(files, snapshot);
  });
});
