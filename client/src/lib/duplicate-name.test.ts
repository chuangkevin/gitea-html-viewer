import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { splitName, duplicatePathFor } from "./duplicate-name.js";

describe("splitName", () => {
  it("只認最後一個點，且點的 index 必須 > 0", () => {
    assert.deepEqual(splitName("ABC.txt"), { base: "ABC", ext: ".txt" });
    assert.deepEqual(splitName("foo.bar.baz"), { base: "foo.bar", ext: ".baz" });
  });

  it("沒有副檔名時 ext 為空字串", () => {
    assert.deepEqual(splitName("ABC"), { base: "ABC", ext: "" });
  });

  it(".gitignore 視為沒有副檔名", () => {
    assert.deepEqual(splitName(".gitignore"), { base: ".gitignore", ext: "" });
  });
});

describe("duplicatePathFor", () => {
  it("ABC.txt → ABC-複製.txt", () => {
    assert.equal(duplicatePathFor("ABC.txt", []), "ABC-複製.txt");
  });

  it("已存在 ABC-複製.txt → ABC-複製2.txt，再撞 → ABC-複製3.txt", () => {
    assert.equal(duplicatePathFor("ABC.txt", ["ABC.txt", "ABC-複製.txt"]), "ABC-複製2.txt");
    assert.equal(
      duplicatePathFor("ABC.txt", ["ABC.txt", "ABC-複製.txt", "ABC-複製2.txt"]),
      "ABC-複製3.txt"
    );
  });

  it("無副檔名 → ABC-複製", () => {
    assert.equal(duplicatePathFor("ABC", []), "ABC-複製");
  });

  it(".gitignore → .gitignore-複製", () => {
    assert.equal(duplicatePathFor(".gitignore", []), ".gitignore-複製");
  });

  it("不要解析既有的-複製，單純再接一層", () => {
    assert.equal(duplicatePathFor("ABC-複製.txt", []), "ABC-複製-複製.txt");
  });

  it("巢狀資料夾路徑維持同資料夾", () => {
    assert.equal(duplicatePathFor("docs/ABC.txt", []), "docs/ABC-複製.txt");
    assert.equal(
      duplicatePathFor("docs/nested/ABC.txt", ["docs/nested/ABC.txt", "docs/nested/ABC-複製.txt"]),
      "docs/nested/ABC-複製2.txt"
    );
  });

  it("比對大小寫敏感", () => {
    assert.equal(duplicatePathFor("ABC.txt", ["ABC-複製.TXT"]), "ABC-複製.txt");
  });

  it("上限 999，超過就丟 Error", () => {
    const existing = ["ABC-複製.txt"];
    for (let n = 2; n <= 999; n++) existing.push(`ABC-複製${n}.txt`);
    assert.throws(() => duplicatePathFor("ABC.txt", existing), /999/);
  });
});
