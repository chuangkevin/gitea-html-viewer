import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { blockSourceRanges, imageSpansIn, insertOffsetForPoint, moveSpanInSource } from "./drop-position.js";

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

  describe("moveSpanInSource 不可破壞程式碼區塊", () => {
    it("keeps blank lines inside fenced code blocks untouched when moving an image", () => {
      // code fence 裡刻意留三個以上連續換行；移動圖片不可以把它壓掉
      const md = "# 標題\n\n![a](</a.png>)\n\n```js\nconst x = 1;\n\n\n\nconst y = 2;\n```\n\n最後一段。\n";
      const span = imageSpansIn(md, 0, md.length)[0];
      const moved = moveSpanInSource(md, span, md.length);

      assert.ok(moved.includes("const x = 1;\n\n\n\nconst y = 2;"), "code fence 內的空行必須原封不動");
      assert.equal((moved.match(/!\[a\]/g) || []).length, 1, "圖片總數不變");
      assert.ok(moved.indexOf("![a]") > moved.indexOf("最後一段。"), "圖片要在最後");
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

  describe("imageSpansIn", () => {
    it("returns spans for multiple images matching the complete ![...](...) syntax", () => {
      const md = "第一段\n\n![圖一](/img1.png)\n\n文字\n\n![圖二](/img2.png)\n\n第二段";
      const spans = imageSpansIn(md, 0, md.length);
      assert.equal(spans.length, 2);
      assert.equal(md.slice(spans[0].start, spans[0].end), "![圖一](/img1.png)");
      assert.equal(md.slice(spans[1].start, spans[1].end), "![圖二](/img2.png)");
    });

    it("correctly captures angle bracket destination ![a](</有 空白/圖.png>)", () => {
      const md = "前綴 ![a](</有 空白/圖.png>) 後綴";
      const spans = imageSpansIn(md, 0, md.length);
      assert.equal(spans.length, 1);
      assert.equal(md.slice(spans[0].start, spans[0].end), "![a](</有 空白/圖.png>)");
    });

    it("correctly captures normal destination with paired parentheses ![a](/x(1).png)", () => {
      const md = "前綴 ![a](/x(1).png) 後綴";
      const spans = imageSpansIn(md, 0, md.length);
      assert.equal(spans.length, 1);
      assert.equal(md.slice(spans[0].start, spans[0].end), "![a](/x(1).png)");
    });

    it("skips unclosed/incomplete syntax without throwing exceptions", () => {
      const md = "殘缺語法 ![a](/x.png 還有一般文字 ![正常](/ok.png)";
      let spans: ReturnType<typeof imageSpansIn> = [];
      assert.doesNotThrow(() => {
        spans = imageSpansIn(md, 0, md.length);
      });
      assert.equal(spans.length, 1);
      assert.equal(md.slice(spans[0].start, spans[0].end), "![正常](/ok.png)");
    });

    it("does not capture images outside from/to range", () => {
      const md = "![圖0](/0.png)\n\n段落一\n\n![圖1](/1.png)\n\n段落二\n\n![圖2](/2.png)";
      const span1Start = md.indexOf("![圖1]");
      const span1End = md.indexOf("段落二");
      const spans = imageSpansIn(md, span1Start, span1End);
      assert.equal(spans.length, 1);
      assert.equal(md.slice(spans[0].start, spans[0].end), "![圖1](/1.png)");
    });
  });

  describe("moveSpanInSource", () => {
    it("契約測試：移動圖片後在全文中總數不變（不是複製）且各段文字維持原樣", () => {
      const p1 = "# 第一段標題\n這是第一段的內容。";
      const p2 = "這是第二段的內容。";
      const img = "![範例圖片](</assets/image 1.png>)";
      const p3 = "這是第三段的中間說明文字。";
      const p4 = "這是第四段的結尾文字。";
      const md = `${p1}\n\n${p2}\n\n${img}\n\n${p3}\n\n${p4}\n`;

      const spans = imageSpansIn(md, 0, md.length);
      assert.equal(spans.length, 1);
      const span = spans[0];

      // 搬到最後一段之後的 offset（md.length）
      const result = moveSpanInSource(md, span, md.length);

      // ① 該圖片語法在結果中只出現一次（總數不變、不是複製）
      const count = (result.match(/!\[範例圖片\]\(<\/assets\/image 1\.png>\)/g) || []).length;
      assert.equal(count, 1, "搬移後圖片在全文中必須只出現一次");

      // ② 原本的位置（p2 與 p3 之間）已經沒有它
      const p2Idx = result.indexOf(p2);
      const p3Idx = result.indexOf(p3);
      const p4Idx = result.indexOf(p4);
      const imgIdx = result.indexOf(img);

      assert.ok(p2Idx !== -1 && p3Idx !== -1 && p4Idx !== -1 && imgIdx !== -1);
      assert.ok(
        p2Idx < p3Idx && p3Idx < p4Idx && p4Idx < imgIdx,
        `圖片應被移到第四段之後 (p2Idx=${p2Idx}, p3Idx=${p3Idx}, p4Idx=${p4Idx}, imgIdx=${imgIdx})`
      );

      // ③ 新位置有它（已由 imgIdx > p4Idx 驗證）

      // ④ 其他段落文字一字未動
      assert.ok(result.includes(p1), "第一段文字必須完整保留");
      assert.ok(result.includes(p2), "第二段文字必須完整保留");
      assert.ok(result.includes(p3), "第三段文字必須完整保留");
      assert.ok(result.includes(p4), "第四段文字必須完整保留");
    });

    it("搬到文件最前面（at = 0）時圖片在最前且總數為 1", () => {
      const md = "# 標題\n\n段落一\n\n![圖](/img.png)\n\n段落二";
      const spans = imageSpansIn(md, 0, md.length);
      assert.equal(spans.length, 1);
      const result = moveSpanInSource(md, spans[0], 0);

      assert.ok(result.startsWith("![圖](/img.png)"));
      const count = (result.match(/!\[圖\]\(\/img\.png\)/g) || []).length;
      assert.equal(count, 1);
      assert.ok(result.includes("# 標題"));
      assert.ok(result.includes("段落一"));
      assert.ok(result.includes("段落二"));
    });

    it("搬到同一段內／原地（at 落在 span 內部）回傳與輸入完全相同的字串", () => {
      const md = "# 標題\n\n段落一\n\n![圖](/img.png)\n\n段落二";
      const spans = imageSpansIn(md, 0, md.length);
      const span = spans[0];
      const midAt = Math.floor((span.start + span.end) / 2);

      const result = moveSpanInSource(md, span, midAt);
      assert.equal(result, md);
    });

    it("搬完後不會在刪除點或插入點生出連續三個以上的換行", () => {
      const md = "# 標題\n\n段落一\n\n![圖](/img.png)\n\n段落二\n";
      const spans = imageSpansIn(md, 0, md.length);
      const result = moveSpanInSource(md, spans[0], md.length);

      assert.equal(/\n{3,}/.test(result), false, "不可出現連續三個以上的換行");
    });

    it("不會動到跟這次移動無關的既有空行", () => {
      // 使用者原本就留的空行是他的排版，移動圖片不可以順手把整份文件重排
      const md = "# 標題\n\n\n段落一\n\n![圖](/img.png)\n\n段落二\n";
      const spans = imageSpansIn(md, 0, md.length);
      const result = moveSpanInSource(md, spans[0], md.length);

      assert.ok(result.includes("# 標題\n\n\n段落一"), "原本就有的空行要留著");
      assert.equal((result.match(/!\[圖\]/g) || []).length, 1, "圖片總數不變");
    });
  });
});

