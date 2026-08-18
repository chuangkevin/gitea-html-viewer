import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { defaultViewMode, initialViewMode, resolveViewMode } from "./view-mode.js";

describe("view-mode module", () => {
  describe("defaultViewMode", () => {
    it("defaults desktop to split", () => {
      assert.equal(defaultViewMode(true), "split");
    });

    it("defaults mobile to edit", () => {
      assert.equal(defaultViewMode(false), "edit");
    });
  });

  describe("initialViewMode", () => {
    it("uses a valid stored value first", () => {
      assert.equal(initialViewMode("preview", true), "preview");
      assert.equal(initialViewMode("edit", true), "edit");
      assert.equal(initialViewMode("split", false), "split");
    });

    it("falls back to the device default for invalid stored values", () => {
      assert.equal(initialViewMode("invalid", true), "split");
      assert.equal(initialViewMode(null, false), "edit");
    });
  });

  describe("resolveViewMode", () => {
    it("always resolves read-only files to preview", () => {
      assert.equal(resolveViewMode("edit", { readOnly: true, isDesktop: true }), "preview");
      assert.equal(resolveViewMode("split", { readOnly: true, isDesktop: false }), "preview");
    });

    it("resolves mobile split to edit, not preview", () => {
      assert.equal(resolveViewMode("split", { readOnly: false, isDesktop: false }), "edit");
    });
  });
});
