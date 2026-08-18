import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { imageSrc, type LivePreviewContext } from "./cm-live-preview.js";
import { insertSnippetFor } from "./doc-paths.js";

const ctx: LivePreviewContext = {
  provider: "gitlab",
  project: "interagent-io/global-doc",
  currentPath: "docs/a/b.md",
  rawBase: "/raw",
};

describe("cm-live-preview imageSrc", () => {
  it("把 repo 絕對路徑轉成資產 URL", () => {
    const url = imageSrc("/assets/logo.png", ctx);
    assert.ok(url);
    assert.ok(url.startsWith("/raw/"), `應該是 /raw 開頭，實際：${url}`);
    assert.ok(url.includes("logo.png"));
  });

  it("相對路徑以目前檔案所在目錄為基準解析", () => {
    const url = imageSrc("./pic.png", ctx);
    assert.ok(url);
    assert.ok(url.includes("docs/a/pic.png") || url.includes("docs%2Fa%2Fpic.png"), url);
  });

  it("角括號形式會先剝掉再解析（含空白的檔名）", () => {
    const withAngle = imageSrc("</assets/my pic.png>", ctx);
    const without = imageSrc("/assets/my pic.png", ctx);
    assert.equal(withAngle, without);
    assert.ok(withAngle && !withAngle.includes("<"), "不可以把角括號帶進 URL");
  });

  it("外部連結原樣使用，不會被改寫成 /raw", () => {
    const url = "https://example.com/a.png";
    assert.equal(imageSrc(url, ctx), url);
  });

  it("純錨點與空字串不當圖片", () => {
    assert.equal(imageSrc("#top", ctx), null);
    assert.equal(imageSrc("   ", ctx), null);
  });

  it("沒有 context 時不猜路徑（回 null，不會生出錯的 URL）", () => {
    assert.equal(imageSrc("/assets/logo.png", null), null);
  });

  it("契約：貼圖產生的 markdown 路徑，編輯器解析得出資產 URL", () => {
    // insertSnippetFor 是貼上／拖曳共用的產生器，產出形如 ![name](/path)
    const snippet = insertSnippetFor("docs/a/pasted-20260818-121740.png");
    const dest = snippet.slice(snippet.indexOf("](") + 2, snippet.lastIndexOf(")"));
    const url = imageSrc(dest, ctx);
    assert.ok(url, `解析不出來：${snippet}`);
    assert.ok(!url.startsWith("http://") && !url.startsWith("https://"), "不可以是絕對外部網址");
    assert.ok(url.includes("pasted-20260818-121740.png"), url);
  });

  it("契約：檔名含空白時 insertSnippetFor 會用角括號，編輯器也要解析得出來", () => {
    const snippet = insertSnippetFor("docs/a/my pic.png");
    assert.ok(snippet.includes("(<"), `應該用角括號包起來：${snippet}`);
    const dest = snippet.slice(snippet.indexOf("](") + 2, snippet.lastIndexOf(")"));
    const url = imageSrc(dest, ctx);
    assert.ok(url, `解析不出來：${snippet}`);
    assert.ok(!url.includes("<") && !url.includes(">"), "角括號不可以留在 URL 裡");
  });
});
