import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultViewMode,
  initialPaneMode,
  initialViewMode,
  isPaneMode,
  resolvePaneMode,
  resolveViewMode,
  type PaneMode,
  type ViewMode,
} from "./view-mode.js";

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

  describe("isPaneMode", () => {
    it("accepts only text and images", () => {
      assert.equal(isPaneMode("text"), true);
      assert.equal(isPaneMode("images"), true);
    });

    it("rejects invalid values including null", () => {
      assert.equal(isPaneMode(null), false);
      assert.equal(isPaneMode(undefined), false);
      assert.equal(isPaneMode(""), false);
      assert.equal(isPaneMode("preview"), false);
      assert.equal(isPaneMode("edit"), false);
      assert.equal(isPaneMode("split"), false);
    });
  });

  describe("initialPaneMode", () => {
    it("uses a valid stored value", () => {
      assert.equal(initialPaneMode("text"), "text");
      assert.equal(initialPaneMode("images"), "images");
    });

    it("falls back to text for invalid stored values and null", () => {
      assert.equal(initialPaneMode(null), "text");
      assert.equal(initialPaneMode(""), "text");
      assert.equal(initialPaneMode("preview"), "text");
      assert.equal(initialPaneMode("invalid"), "text");
    });
  });

  describe("resolvePaneMode", () => {
    const views: ViewMode[] = ["preview", "split", "edit"];
    const paneModes: PaneMode[] = ["text", "images"];
    const expected: Record<string, PaneMode> = {
      "preview|true|text": "text",
      "preview|true|images": "images",
      "preview|false|text": "text",
      "preview|false|images": "text",
      "split|true|text": "text",
      "split|true|images": "text",
      "split|false|text": "text",
      "split|false|images": "text",
      "edit|true|text": "text",
      "edit|true|images": "text",
      "edit|false|text": "text",
      "edit|false|images": "text",
    };

    for (const view of views) {
      for (const canWrite of [true, false]) {
        for (const paneMode of paneModes) {
          const key = `${view}|${canWrite}|${paneMode}`;
          it(`view=${view} canWrite=${canWrite} paneMode=${paneMode} → ${expected[key]}`, () => {
            assert.equal(resolvePaneMode(paneMode, { view, canWrite }), expected[key]);
          });
        }
      }
    }

    it("returns images only when view is preview and canWrite is true", () => {
      let imageCases = 0;
      for (const view of views) {
        for (const canWrite of [true, false]) {
          for (const paneMode of paneModes) {
            const resolved = resolvePaneMode(paneMode, { view, canWrite });
            if (view === "preview" && canWrite) {
              assert.equal(resolved, paneMode);
              if (resolved === "images") imageCases += 1;
            } else {
              assert.equal(resolved, "text");
            }
          }
        }
      }
      assert.equal(imageCases, 1);
    });
  });
});
