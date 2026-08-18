import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  boundaryOffsetForY,
  insertAsBlock,
  moveSpanAsBlock,
  snapToLineBoundary,
  type LineBox,
} from "./block-insert.js";

const doc = "test\ndfwef\nwefwfip";
const boxes: LineBox[] = [
  { from: 0, to: 4, top: 100, bottom: 120 }, // test
  { from: 5, to: 10, top: 120, bottom: 140 }, // dfwef
  { from: 11, to: 18, top: 140, bottom: 160 }, // wefwfip
];
const allowed = [0, 4, 10, 18];
const snippet = "[README](/README.md)";

describe("block-insert module", () => {
  describe("snapToLineBoundary", () => {
    it("snaps first half of a line to the start and second half to the end", () => {
      assert.equal(snapToLineBoundary(doc, 0), 0);
      assert.equal(snapToLineBoundary(doc, 1), 0);
      assert.equal(snapToLineBoundary(doc, 2), 4);
      assert.equal(snapToLineBoundary(doc, 3), 4);
      assert.equal(snapToLineBoundary(doc, 6), 5);
      assert.equal(snapToLineBoundary(doc, 9), 10);
    });

    it("returns the empty-line position unchanged", () => {
      assert.equal(snapToLineBoundary("a\n\nb", 2), 2);
    });

    it("clamps offsets outside the document", () => {
      assert.equal(snapToLineBoundary(doc, -5), 0);
      assert.equal(snapToLineBoundary(doc, 999), doc.length);
      assert.equal(snapToLineBoundary("", 8), 0);
    });

    it("returns a line start or end for every character offset in a multi-line doc", () => {
      const boundaries = new Set<number>();
      let i = 0;
      while (i <= doc.length) {
        const nl = doc.indexOf("\n", i);
        const lineEnd = nl === -1 ? doc.length : nl;
        boundaries.add(i);
        boundaries.add(lineEnd);
        if (nl === -1) break;
        i = nl + 1;
      }
      for (let o = 0; o <= doc.length; o++) {
        assert.ok(
          boundaries.has(snapToLineBoundary(doc, o)),
          `offset ${o} snapped to a non-boundary`
        );
      }
    });
  });

  describe("boundaryOffsetForY (boss acceptance)", () => {
    it("places y=115 (test lower half) between test and dfwef", () => {
      assert.equal(boundaryOffsetForY(boxes, 115, doc.length), 4);
    });

    it("places y=125 (dfwef upper half) on the same middle boundary", () => {
      assert.equal(boundaryOffsetForY(boxes, 125, doc.length), 4);
    });

    it("places y=135 (dfwef lower half) between dfwef and wefwfip", () => {
      assert.equal(boundaryOffsetForY(boxes, 135, doc.length), 10);
    });

    it("places y=145 (wefwfip upper half) between dfwef and wefwfip", () => {
      assert.equal(boundaryOffsetForY(boxes, 145, doc.length), 10);
    });

    it("places y=155 (wefwfip lower half) at the end of the last line", () => {
      assert.equal(boundaryOffsetForY(boxes, 155, doc.length), 18);
    });

    it("places y=105 (test upper half) at the start", () => {
      assert.equal(boundaryOffsetForY(boxes, 105, doc.length), 0);
    });

    it("returns first from / last to / docLength for above, below, and empty boxes", () => {
      assert.equal(boundaryOffsetForY(boxes, 0, doc.length), 0);
      assert.equal(boundaryOffsetForY(boxes, 999, doc.length), 18);
      assert.equal(boundaryOffsetForY([], 120, doc.length), doc.length);
    });

    it("returns the upper box to when y lands in a gap", () => {
      const gapped: LineBox[] = [
        { from: 0, to: 4, top: 100, bottom: 120 },
        { from: 5, to: 10, top: 140, bottom: 160 },
      ];
      assert.equal(boundaryOffsetForY(gapped, 130, doc.length), 4);
    });

    it("契約 1：y 從 90 掃到 170 每 1px，回傳值一定是 [0,4,10,18] 之一", () => {
      for (let y = 90; y <= 170; y++) {
        const at = boundaryOffsetForY(boxes, y, doc.length);
        assert.ok(allowed.includes(at), `y=${y} returned ${at}`);
      }
    });
  });

  describe("insertAsBlock", () => {
    it("契約 2：把 [0,4,10,18] 每個都餵給 insertAsBlock，三行都完整存在", () => {
      for (const at of allowed) {
        const { text } = insertAsBlock(doc, at, snippet);
        const lines = text.split("\n");
        assert.ok(lines.includes("test"), `missing test at ${at}: ${JSON.stringify(text)}`);
        assert.ok(lines.includes("dfwef"), `missing dfwef at ${at}: ${JSON.stringify(text)}`);
        assert.ok(lines.includes("wefwfip"), `missing wefwfip at ${at}: ${JSON.stringify(text)}`);
      }
    });

    it("契約 3：snippet 獨佔一整行，且不得出現連續三個以上換行", () => {
      for (const at of allowed) {
        const { text } = insertAsBlock(doc, at, snippet);
        assert.ok(text.split("\n").includes(snippet), `snippet not its own line at ${at}`);
        assert.equal(/\n{3,}/.test(text), false, `triple newline at ${at}: ${JSON.stringify(text)}`);
      }
    });

    it("inserts with a blank line so adjacent paragraphs stay separate (defect A)", () => {
      const spaced = "test\n\ndfwef\n\nwefwfip\n";
      const { text } = insertAsBlock(spaced, 4, snippet);
      assert.equal(text.includes("test\n\n[README](/README.md)\n\ndfwef"), true);
      assert.equal(/\n{3,}/.test(text), false);
    });
  });
});

describe("moveSpanAsBlock", () => {
  const IMG = "![img](/a.png)";
  const doc = `test\ndfwef\nwefwfip\n\n${IMG}\n`;
  const imgStart = doc.indexOf(IMG);
  const span = { start: imgStart, end: imgStart + IMG.length };

  function assertMovedBlock(result: string) {
    assert.equal(result.split(IMG).length - 1, 1, `IMG not exactly once: ${JSON.stringify(result)}`);
    const lines = result.split("\n");
    assert.ok(lines.includes(IMG), `IMG not its own line: ${JSON.stringify(result)}`);
    assert.ok(lines.includes("test"), `missing test: ${JSON.stringify(result)}`);
    assert.ok(lines.includes("dfwef"), `missing dfwef: ${JSON.stringify(result)}`);
    assert.ok(lines.includes("wefwfip"), `missing wefwfip: ${JSON.stringify(result)}`);
  }

  it("移到中間邊界：test 與 dfwef 之間 (offset 4)", () => {
    const result = moveSpanAsBlock(doc, span, 4);
    assertMovedBlock(result);
    const lines = result.split("\n");
    const idx = lines.indexOf(IMG);
    assert.equal(lines[idx - 1], "", `prev not blank: ${JSON.stringify(result)}`);
    assert.equal(lines[idx + 1], "", `next not blank: ${JSON.stringify(result)}`);
    assert.equal(/\n{3,}/.test(result), false, `triple newline: ${JSON.stringify(result)}`);
  });

  it("移到中間邊界：dfwef 與 wefwfip 之間 (offset 10)", () => {
    const result = moveSpanAsBlock(doc, span, 10);
    assertMovedBlock(result);
    const lines = result.split("\n");
    const idx = lines.indexOf(IMG);
    assert.equal(lines[idx - 1], "", `prev not blank: ${JSON.stringify(result)}`);
    assert.equal(lines[idx + 1], "", `next not blank: ${JSON.stringify(result)}`);
    assert.equal(/\n{3,}/.test(result), false, `triple newline: ${JSON.stringify(result)}`);
  });

  it("移到最前面 (offset 0)", () => {
    const result = moveSpanAsBlock(doc, span, 0);
    const lines = result.split("\n");
    assert.equal(lines[0], IMG);
    assert.equal(lines[1], "", `no blank after IMG: ${JSON.stringify(result)}`);
    assertMovedBlock(result);
  });

  it("移到最後面", () => {
    const result = moveSpanAsBlock(doc, span, doc.length);
    const lines = result.split("\n");
    const lastNonEmpty = [...lines].reverse().find((line) => line !== "");
    assert.equal(lastNonEmpty, IMG);
    const idx = lines.indexOf(IMG);
    assert.equal(lines[idx - 1], "", `no blank before IMG: ${JSON.stringify(result)}`);
    assertMovedBlock(result);
  });

  it("放回原地：at 落在 span 內部或邊界 → 回傳值 === doc", () => {
    assert.equal(moveSpanAsBlock(doc, span, span.start), doc);
    assert.equal(moveSpanAsBlock(doc, span, span.end), doc);
    assert.equal(moveSpanAsBlock(doc, span, span.start + 1), doc);
  });

  it("契約（掃描式）：[0, 4, 10, 18] 每次都是移動且獨佔一行、無三連換行", () => {
    for (const at of [0, 4, 10, 18]) {
      const result = moveSpanAsBlock(doc, span, at);
      assertMovedBlock(result);
      assert.equal(/\n{3,}/.test(result), false, `triple newline at ${at}: ${JSON.stringify(result)}`);
    }
  });

  it("與 boundaryOffsetForY 串起來的契約：y 從 90 掃到 170", () => {
    for (let y = 90; y <= 170; y++) {
      const at = boundaryOffsetForY(boxes, y, 18);
      const result = moveSpanAsBlock(doc, span, at);
      assertMovedBlock(result);
    }
  });
});
