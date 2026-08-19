import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { joinTargetPath, targetDirFor, targetDirLabelFor } from "./target-dir.js";

function assertPathContract(value: string) {
  assert.equal(value.startsWith("/"), false, `must not start with /: ${value}`);
  assert.equal(value.endsWith("/"), false, `must not end with /: ${value}`);
  assert.equal(value.includes("//"), false, `must not contain //: ${value}`);
}

describe("target-dir module", () => {
  describe("targetDirFor", () => {
    it("prefers dirParam even when activeFolder and activePath are set", () => {
      assert.equal(
        targetDirFor({
          dirParam: "docs/api",
          activeFolder: "導入客戶/元信豐",
          activePath: "導入客戶/元信豐/README.md",
        }),
        "docs/api"
      );
    });

    it("uses activeFolder when dirParam is null", () => {
      assert.equal(
        targetDirFor({
          dirParam: null,
          activeFolder: "docs/guides",
          activePath: "other/file.md",
        }),
        "docs/guides"
      );
    });

    it("uses the parent directory of activePath when only that is set", () => {
      assert.equal(
        targetDirFor({
          dirParam: null,
          activeFolder: null,
          activePath: "導入客戶/元信豐/README.md",
        }),
        "導入客戶/元信豐"
      );
    });

    it("returns empty string when activePath is a root-level file", () => {
      assert.equal(
        targetDirFor({
          dirParam: null,
          activeFolder: null,
          activePath: "test.md",
        }),
        ""
      );
    });

    it("returns empty string when all inputs are null", () => {
      assert.equal(
        targetDirFor({
          dirParam: null,
          activeFolder: null,
          activePath: null,
        }),
        ""
      );
    });

    it("Kevin 驗收：focus 在 導入客戶/元信豐 時回該資料夾", () => {
      assert.equal(
        targetDirFor({
          dirParam: null,
          activeFolder: "導入客戶/元信豐",
          activePath: null,
        }),
        "導入客戶/元信豐"
      );
    });
  });

  describe("joinTargetPath", () => {
    it("returns the normalized name when baseDir is empty", () => {
      assert.equal(joinTargetPath("", "會議記錄.md"), "會議記錄.md");
      assert.equal(joinTargetPath("", "/a//b.md"), "a/b.md");
    });

    it("joins a filename under the focused folder", () => {
      assert.equal(
        joinTargetPath("導入客戶/元信豐", "會議記錄.md"),
        "導入客戶/元信豐/會議記錄.md"
      );
    });

    it("does not duplicate an existing baseDir prefix", () => {
      assert.equal(joinTargetPath("docs", "docs/a.md"), "docs/a.md");
    });

    it("returns name as-is when it equals baseDir", () => {
      assert.equal(joinTargetPath("docs", "docs"), "docs");
    });

    it("normalizes extra and surrounding slashes in name", () => {
      assert.equal(joinTargetPath("docs", "/b//c.md"), "docs/b/c.md");
    });

    it("returns empty string when name normalizes to empty", () => {
      assert.equal(joinTargetPath("docs", ""), "");
      assert.equal(joinTargetPath("docs", "///"), "");
      assert.equal(joinTargetPath("", "  ".trim()), "");
    });

    it("never returns a path that starts/ends with / or contains //", () => {
      const cases: Array<[string, string]> = [
        ["", "會議記錄.md"],
        ["導入客戶/元信豐", "會議記錄.md"],
        ["docs", "docs/a.md"],
        ["docs", "docs"],
        ["docs", "/b//c.md"],
        ["docs", ""],
        ["docs", "///"],
        ["", "/a//b.md"],
      ];
      for (const [baseDir, name] of cases) {
        assertPathContract(joinTargetPath(baseDir, name));
      }
    });
  });

  describe("targetDirLabelFor", () => {
    it("labels the repo root", () => {
      assert.equal(targetDirLabelFor(""), "根目錄");
    });

    it("returns nested paths as-is", () => {
      assert.equal(targetDirLabelFor("docs/a"), "docs/a");
    });
  });
});
