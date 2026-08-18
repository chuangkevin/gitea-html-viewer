import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { insertAsBlock, snapToLineBoundary } from "./block-insert.js";

const snippet = "![img](x.png)";

function assertSnippetLine(text: string) {
  assert.ok(text.split("\n").includes(snippet));
}

function assertOriginalNonEmptyLinesIntact(before: string, after: string) {
  const resultLines = after.split("\n");
  for (const line of before.split("\n")) {
    if (line.length > 0) assert.ok(resultLines.includes(line), `missing original line: ${line}`);
  }
}

function assertNoTripleNewline(text: string) {
  assert.equal(text.includes("\n\n\n"), false);
}

describe("block-insert module", () => {
  describe("snapToLineBoundary", () => {
    it("returns the line start for offsets in the first half", () => {
      assert.equal(snapToLineBoundary("abcdef", 2), 0);
    });

    it("returns the line end excluding the newline for offsets in the second half", () => {
      assert.equal(snapToLineBoundary("abcde\nnext", 4), 5);
    });

    it("returns the empty line position for offsets on an empty line", () => {
      assert.equal(snapToLineBoundary("第一段\n\n第二段", 4), 4);
    });

    it("clamps offsets at document bounds", () => {
      const doc = "alpha\nbeta";
      assert.equal(snapToLineBoundary(doc, 0), 0);
      assert.equal(snapToLineBoundary(doc, doc.length), doc.length);
      assert.equal(snapToLineBoundary(doc, -20), 0);
      assert.equal(snapToLineBoundary(doc, doc.length + 20), doc.length);
    });

    it("always snaps every offset in a multiline document to a line start or line end", () => {
      const doc = "alpha\n\nbeta gamma\nthird";
      for (let offset = 0; offset <= doc.length; offset++) {
        const snapped = snapToLineBoundary(doc, offset);
        const isBoundary =
          snapped === 0 ||
          snapped === doc.length ||
          doc[snapped - 1] === "\n" ||
          doc[snapped] === "\n";
        assert.equal(isBoundary, true, `offset ${offset} snapped to ${snapped}`);
      }
    });
  });

  describe("insertAsBlock", () => {
    it("inserts into an empty document", () => {
      const result = insertAsBlock("", 0, snippet);
      assert.equal(result.text, snippet);
      assert.equal(result.caret, snippet.length);
      assertSnippetLine(result.text);
      assertNoTripleNewline(result.text);
    });

    it("inserts at the beginning without a leading blank line", () => {
      const doc = "第一段";
      const result = insertAsBlock(doc, 0, snippet);
      assert.equal(result.text, `${snippet}\n\n第一段`);
      assert.equal(result.caret, snippet.length);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("inserts at the end without a trailing blank line", () => {
      const doc = "第一段";
      const result = insertAsBlock(doc, doc.length, snippet);
      assert.equal(result.text, `第一段\n\n${snippet}`);
      assert.equal(result.caret, result.text.length);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("inserts before a line with one blank line on each side", () => {
      const doc = "第一段\n第二段";
      const result = insertAsBlock(doc, "第一段\n".length, snippet);
      assert.equal(result.text, `第一段\n\n${snippet}\n\n第二段`);
      assert.equal(result.caret, `第一段\n\n${snippet}`.length);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("inserts after a line with one blank line on each side", () => {
      const doc = "第一段\n第二段";
      const result = insertAsBlock(doc, "第一段".length, snippet);
      assert.equal(result.text, `第一段\n\n${snippet}\n\n第二段`);
      assert.equal(result.caret, `第一段\n\n${snippet}`.length);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("uses an existing blank line as separation without adding a third newline", () => {
      const doc = "第一段\n\n第二段";
      const result = insertAsBlock(doc, "第一段\n".length, snippet);
      assert.equal(result.text, `第一段\n\n${snippet}\n\n第二段`);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("keeps original non-empty lines intact when the drop is mid-line", () => {
      const doc = "alpha sentence\nbeta sentence\ngamma sentence";
      const result = insertAsBlock(doc, "alpha sentence\nbeta".length, snippet);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("places the image near the dropped paragraph without splitting the paragraph", () => {
      const doc = "第一段\n\n第二段\n\n第三段";
      const result = insertAsBlock(doc, doc.indexOf("第二段") + 1, snippet);
      const lines = result.text.split("\n");
      const imageIndex = lines.indexOf(snippet);
      assert.ok(imageIndex > lines.indexOf("第一段"));
      assert.ok(imageIndex < lines.indexOf("第三段"));
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });

    it("does not introduce triple newlines when adjacent padding already has extra blank lines", () => {
      const doc = "第一段\n\n\n第二段";
      const result = insertAsBlock(doc, doc.indexOf("第二段"), snippet);
      assert.equal(result.text, `第一段\n\n${snippet}\n\n第二段`);
      assertSnippetLine(result.text);
      assertOriginalNonEmptyLinesIntact(doc, result.text);
      assertNoTripleNewline(result.text);
    });
  });
});
