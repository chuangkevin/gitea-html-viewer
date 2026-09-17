import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { readonlyLabel } from "./readonly-label.js";

const workspaceSource = fs.readFileSync(new URL("../pages/Workspace.tsx", import.meta.url), "utf8");

describe("readonlyLabel", () => {
  it("gives mirror text priority over identity guidance", () => {
    assert.equal(readonlyLabel({ mirror: true, needsIdentity: true }), "此為鏡像repo，無法編輯");
  });

  it("preserves existing non-mirror labels", () => {
    assert.equal(readonlyLabel({ mirror: false, needsIdentity: true }), "唯讀 · 先選身分");
    assert.equal(readonlyLabel({ mirror: false, needsIdentity: false }), "唯讀");
  });

  it("renders an always-visible wrapping mirror banner below lg", () => {
    assert.match(
      workspaceSource,
      /\{mirror && \(\s*<div\s+className="lg:hidden w-full min-w-0[^\"]*max-w-full[^\"]*break-words[^\"]*"[^>]*>\s*\{readOnlyLabel\}\s*<\/div>\s*\)\}/,
    );
  });

  it("clears stale write permission whenever repo access state resets", () => {
    assert.match(
      workspaceSource,
      /useEffect\(\(\) => \{\s*setAccessReady\(false\);\s*setFiles\(null\);\s*setCanWrite\(false\);\s*setMirror\(false\);/,
    );
  });
});
