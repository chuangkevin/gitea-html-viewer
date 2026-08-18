import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockSourceRanges, insertOffsetForPoint } from "./drop-position.js";

describe("drop-position module", () => {
  describe("blockSourceRanges", () => {
    it("calculates source ranges for multi-block markdown correctly", () => {
      const md = "# 標題\n\n第一段\n\n![a](</a.png>)\n\n第二段\n";
      const ranges = blockSourceRanges(md);

      // 包含標題、第一段、圖片段落、第二段，共 4 個會渲染的 top-level 區塊
      assert.equal(ranges.length, 4);

      assert.ok(md.slice(ranges[0].start, ranges[0].end).includes("# 標題"));
      assert.ok(md.slice(ranges[1].start, ranges[1].end).includes("第一段"));
      assert.ok(md.slice(ranges[2].start, ranges[2].end).includes("![a](</a.png>)"));
      assert.ok(md.slice(ranges[3].start, ranges[3].end).includes("第二段"));
    });

    it("ensures start offsets are monotonically increasing, non-overlapping, and end <= md.length", () => {
      const md = "# 標題\n\n段落一\n\n- 項目 1\n- 項目 2\n\n> 引用文字\n\n```ts\nconsole.log(1);\n```\n";
      const ranges = blockSourceRanges(md);

      assert.ok(ranges.length > 0);
      for (let i = 0; i < ranges.length; i++) {
        assert.ok(ranges[i].start < ranges[i].end);
        if (i > 0) {
          assert.ok(ranges[i].start >= ranges[i - 1].end);
        }
      }
      assert.ok(ranges[ranges.length - 1].end <= md.length);
    });

    it("skips HTML-comment-only blocks so real notes keep their block mapping", () => {
      // 實際文件（writeback／d0-decisions 等）會夾大量純 HTML 註解，
      // 那些渲染後是 comment node 不是元素，不可以佔一個區塊。
      const md = "# 標題\n\n<!-- item:abc kind:writeback -->\n\n第一段\n\n<!-- /item -->\n\n第二段\n";
      const ranges = blockSourceRanges(md);

      assert.equal(ranges.length, 3, "只有標題與兩個段落會渲染成元素");
      assert.ok(md.slice(ranges[0].start, ranges[0].end).includes("# 標題"));
      assert.ok(md.slice(ranges[1].start, ranges[1].end).includes("第一段"));
      assert.ok(md.slice(ranges[2].start, ranges[2].end).includes("第二段"));
    });

    it("keeps real HTML blocks that do render elements", () => {
      const md = "第一段\n\n<div>真的 HTML</div>\n\n第二段\n";
      const ranges = blockSourceRanges(md);
      assert.equal(ranges.length, 3);
      assert.ok(md.slice(ranges[1].start, ranges[1].end).includes("<div>"));
    });

    it("returns empty array for empty string", () => {
      assert.deepEqual(blockSourceRanges(""), []);
    });
  });

  describe("insertOffsetForPoint", () => {
    const blocks = [
      { top: 100, bottom: 200, start: 0, end: 50 },
      { top: 250, bottom: 350, start: 52, end: 120 },
      { top: 400, bottom: 500, start: 122, end: 200 },
    ];
    const contentLength = 200;

    it("returns block.start when landing in upper half and block.end when landing in lower half", () => {
      // 第一個 block: 100~200, mid = 150
      assert.equal(insertOffsetForPoint(blocks, 120, contentLength), 0); // 上半
      assert.equal(insertOffsetForPoint(blocks, 100, contentLength), 0); // 上邊界
      assert.equal(insertOffsetForPoint(blocks, 170, contentLength), 50); // 下半
      assert.equal(insertOffsetForPoint(blocks, 200, contentLength), 50); // 下邊界

      // 第二個 block: 250~350, mid = 300
      assert.equal(insertOffsetForPoint(blocks, 270, contentLength), 52); // 上半
      assert.equal(insertOffsetForPoint(blocks, 320, contentLength), 120); // 下半
    });

    it("returns first block start when landing above all blocks", () => {
      assert.equal(insertOffsetForPoint(blocks, 50, contentLength), 0);
      assert.equal(insertOffsetForPoint(blocks, 99, contentLength), 0);
    });

    it("returns contentLength when landing below all blocks", () => {
      assert.equal(insertOffsetForPoint(blocks, 550, contentLength), 200);
      assert.equal(insertOffsetForPoint(blocks, 600, contentLength), 200);
    });

    it("returns upper block end when landing in gap between blocks", () => {
      // 區塊 1 與 2 之間空隙: 200 < y < 250
      assert.equal(insertOffsetForPoint(blocks, 220, contentLength), 50);
      // 區塊 2 與 3 之間空隙: 350 < y < 400
      assert.equal(insertOffsetForPoint(blocks, 380, contentLength), 120);
    });

    it("returns contentLength when blocks array is empty", () => {
      assert.equal(insertOffsetForPoint([], 150, 100), 100);
    });
  });

  describe("契約測試", () => {
    it("拖到中間段落就插在中間", () => {
      const md = "# 標題\n\n這是第一段文字。\n\n這是第二段中間文字。\n\n這是第三段結尾文字。";
      const ranges = blockSourceRanges(md);
      assert.equal(ranges.length, 4, "應該解析出 4 個區塊");

      // 假裝每個區塊在畫面上各佔 100px 高（第 i 個 top=i*100, bottom=i*100+100）
      const blocks = ranges.map((r, i) => ({
        top: i * 100,
        bottom: i * 100 + 100,
        start: r.start,
        end: r.end,
      }));

      // 中間區塊是第二段文字（index 2, top=200, bottom=300, mid=250）
      // 丟一個落在中間區塊下半的 y（例如 280）
      const y = 280;
      const at = insertOffsetForPoint(blocks, y, md.length);

      // 模擬插入 snippet
      const snippet = "\n![x](</x.png>)\n";
      const inserted = md.slice(0, at) + snippet + md.slice(at);

      // 斷言結果不是插在開頭也不是插在末尾
      assert.notEqual(at, 0, "不可插在開頭");
      assert.notEqual(at, md.length, "不可插在末尾");

      // 具體斷言：插入後的字串中，![x] 出現的位置要在中間那段文字之後、最後一段文字之前
      const midText = "這是第二段中間文字。";
      const lastText = "這是第三段結尾文字。";
      const imgText = "![x](</x.png>)";

      const midIdx = inserted.indexOf(midText);
      const imgIdx = inserted.indexOf(imgText);
      const lastIdx = inserted.indexOf(lastText);

      assert.ok(midIdx !== -1, "必須包含中間段落文字");
      assert.ok(imgIdx !== -1, "必須包含插入的圖片");
      assert.ok(lastIdx !== -1, "必須包含最後段落文字");

      assert.ok(
        midIdx < imgIdx && imgIdx < lastIdx,
        `圖片插入位置必須在第二段之後、第三段之前 (midIdx=${midIdx}, imgIdx=${imgIdx}, lastIdx=${lastIdx})`
      );
    });
  });
});
