import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { insertSnippetFor } from "./doc-paths.js";
import {
  extensionForImageMime,
  pastedImageFilename,
  pastedImagePath,
  uniqueRepoPath,
} from "./paste-image.js";

describe("paste-image module", () => {
  describe("extensionForImageMime", () => {
    it("maps known image mime types and falls back to png", () => {
      assert.equal(extensionForImageMime("image/png"), "png");
      assert.equal(extensionForImageMime("image/jpeg"), "jpg");
      assert.equal(extensionForImageMime("image/gif"), "gif");
      assert.equal(extensionForImageMime("image/webp"), "webp");
      assert.equal(extensionForImageMime("image/svg+xml"), "svg");
      assert.equal(extensionForImageMime("image/bmp"), "bmp");
      assert.equal(extensionForImageMime("image/unknown"), "png");
    });
  });

  describe("pastedImageFilename", () => {
    it("formats local time and appends the one-based duplicate suffix", () => {
      const at = new Date(2026, 7, 18, 12, 17, 40);
      assert.equal(pastedImageFilename("image/png", at, 0), "pasted-20260818-121740.png");
      assert.equal(pastedImageFilename("image/png", at, 1), "pasted-20260818-121740-2.png");
    });
  });

  describe("pastedImagePath", () => {
    it("returns just the filename without a target directory", () => {
      assert.equal(pastedImagePath("", "pasted.png"), "pasted.png");
    });

    it("trims target directory slashes before joining", () => {
      assert.equal(pastedImagePath("/docs/images/", "pasted.png"), "docs/images/pasted.png");
    });
  });

  describe("uniqueRepoPath", () => {
    it("increments collisions before the extension", () => {
      assert.equal(uniqueRepoPath("docs/pasted.png", ["docs/pasted.png"]), "docs/pasted-2.png");
      assert.equal(
        uniqueRepoPath("docs/pasted.png", ["docs/pasted.png", "docs/pasted-2.png"]),
        "docs/pasted-3.png"
      );
    });
  });

  describe("insertSnippetFor contract", () => {
    it("embeds pasted images as repo-relative markdown without absolute URLs", () => {
      const simple = insertSnippetFor(pastedImagePath("docs", "pasted-20260818-121740.png"));
      assert.match(simple, /^!\[[^\]]+\]\(\/docs\/pasted-20260818-121740\.png\)$/);
      assert.equal(simple.includes("http://"), false);
      assert.equal(simple.includes("https://"), false);

      const spaced = insertSnippetFor(pastedImagePath("docs with space", "pasted-20260818-121740.png"));
      assert.ok(spaced.includes("](</docs with space/"));
      assert.equal(spaced.includes("http://"), false);
      assert.equal(spaced.includes("https://"), false);
    });
  });
});
