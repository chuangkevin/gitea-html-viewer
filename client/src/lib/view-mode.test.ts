import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultViewMode, initialViewMode, resolveViewMode } from "./view-mode.js";

describe("view-mode module", () => {
  describe("defaultViewMode", () => {
    it("defaults desktop to preview (the editable rendered view)", () => {
      assert.equal(defaultViewMode(true), "preview");
    });

    it("defaults mobile to preview too", () => {
      assert.equal(defaultViewMode(false), "preview");
    });
  });

  describe("initialViewMode", () => {
    it("uses a valid stored value first", () => {
      assert.equal(initialViewMode("preview", true), "preview");
      assert.equal(initialViewMode("edit", true), "edit");
      assert.equal(initialViewMode("split", false), "split");
    });

    it("falls back to the device default for invalid stored values", () => {
      assert.equal(initialViewMode("invalid", true), "preview");
      assert.equal(initialViewMode(null, false), "preview");
    });
  });

  describe("resolveViewMode", () => {
    it("always resolves read-only files to preview", () => {
      assert.equal(resolveViewMode("edit", { readOnly: true, isDesktop: true }), "preview");
      assert.equal(resolveViewMode("split", { readOnly: true, isDesktop: false }), "preview");
    });

    it("resolves mobile split to preview (which is itself editable)", () => {
      assert.equal(resolveViewMode("split", { readOnly: false, isDesktop: false }), "preview");
    });
  });
});
