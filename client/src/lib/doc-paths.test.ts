import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  normalizeRepoPath,
  classifyHref,
  resolveRepoHref,
  encodeRepoPath,
  formatLinkDestination,
  escapeLinkText,
  safeDecodeHref,
  isNewFileResponse,
  buildAssetUrl,
  isImagePath,
  insertSnippetFor,
  repoPathFromAssetUrl,
  snippetFromDragData,
  createDropClaim,
  isHttpUrl,
  urlCardInfo,
} from "./doc-paths.js";

describe("doc-paths module", () => {
  describe("normalizeRepoPath", () => {
    it("handles dot and parent-directory navigation in paths", () => {
      assert.equal(normalizeRepoPath("a/./b"), "a/b");
      assert.equal(normalizeRepoPath("docs/a/../b"), "docs/b");
    });

    it("strips redundant and leading slashes", () => {
      assert.equal(normalizeRepoPath("/a/b"), "a/b");
      assert.equal(normalizeRepoPath("a//b"), "a/b");
      assert.equal(normalizeRepoPath("///a///b///"), "a/b");
    });

    it("stops at root when excessive .. are present and prevents escaping root", () => {
      assert.equal(normalizeRepoPath("a/../../../b"), "b");
      assert.equal(normalizeRepoPath("../../etc/passwd"), "etc/passwd");
      assert.equal(normalizeRepoPath("../../../"), "");
    });
  });

  describe("classifyHref", () => {
    it("classifies pure anchors as anchor", () => {
      assert.equal(classifyHref("#sec"), "anchor");
      assert.equal(classifyHref("#"), "anchor");
    });

    it("classifies mailto, tel, and data protocols as protocol", () => {
      assert.equal(classifyHref("mailto:a@b.c"), "protocol");
      assert.equal(classifyHref("tel:+123456789"), "protocol");
      assert.equal(classifyHref("data:image/png;base64,AAA"), "protocol");
    });

    it("classifies http, https, and protocol-relative URLs as external", () => {
      assert.equal(classifyHref("https://x.com"), "external");
      assert.equal(classifyHref("http://x.com/path"), "external");
      assert.equal(classifyHref("//cdn.x.com/a"), "external");
    });

    it("classifies relative and root-relative paths as repo", () => {
      assert.equal(classifyHref("img/a.png"), "repo");
      assert.equal(classifyHref("/img/a.png"), "repo");
      assert.equal(classifyHref("../other.md"), "repo");
    });
  });

  describe("resolveRepoHref", () => {
    it("resolves relative path from nested currentPath", () => {
      const res = resolveRepoHref("../img/c.png", "docs/a/b.md");
      assert.deepEqual(res, { path: "docs/img/c.png", anchor: "" });
    });

    it("resolves root-relative path starting with slash", () => {
      const res = resolveRepoHref("/top.png", "docs/a/b.md");
      assert.deepEqual(res, { path: "top.png", anchor: "" });
    });

    it("resolves relative path containing hash anchor", () => {
      const res = resolveRepoHref("c.md#sec", "docs/a/b.md");
      assert.deepEqual(res, { path: "docs/a/c.md", anchor: "#sec" });
    });

    it("resolves relative path when currentPath is at repo root", () => {
      const res = resolveRepoHref("c.png", "b.md");
      assert.deepEqual(res, { path: "c.png", anchor: "" });
    });
  });

  describe("encodeRepoPath", () => {
    it("encodes Chinese characters and spaces per segment while preserving slashes", () => {
      assert.equal(
        encodeRepoPath("資料夾/我 的圖.png"),
        `${encodeURIComponent("資料夾")}/${encodeURIComponent("我 的圖.png")}`
      );
    });

    it("encodes special characters like ? and # in filenames", () => {
      assert.equal(encodeRepoPath("a?b#c.png"), "a%3Fb%23c.png");
    });
  });

  describe("formatLinkDestination", () => {
    it("keeps simple paths unwrapped", () => {
      assert.equal(formatLinkDestination("/a/b.png"), "/a/b.png");
    });

    it("wraps paths containing spaces in CommonMark angle brackets", () => {
      assert.equal(
        formatLinkDestination("/導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png"),
        "</導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png>"
      );
    });

    it("wraps paths containing parentheses", () => {
      assert.equal(formatLinkDestination("/docs/a(1).png"), "</docs/a(1).png>");
      assert.equal(formatLinkDestination("/docs/a)1.png"), "</docs/a)1.png>");
    });

    it("percent-encodes > and wraps the destination", () => {
      assert.equal(formatLinkDestination("/docs/a>b.png"), "</docs/a%3Eb.png>");
    });
  });

  describe("escapeLinkText", () => {
    it("escapes square brackets inside link text", () => {
      assert.equal(escapeLinkText("a[b]c"), "a\\[b\\]c");
    });

    it("keeps text without square brackets unchanged", () => {
      assert.equal(escapeLinkText("abc"), "abc");
    });
  });

  describe("buildAssetUrl", () => {
    it("builds public asset URL with encoded project path", () => {
      const url = buildAssetUrl("/raw", "gitlab", "interagent-io/global-doc", "docs/img/a.png");
      assert.equal(url, "/raw/gitlab/interagent-io%2Fglobal-doc/docs/img/a.png");
    });

    it("builds private grant asset URL with rawt prefix", () => {
      const url = buildAssetUrl("/rawt/GRANT123", "github", "user/repo", "docs/img/a.png");
      assert.equal(url, "/rawt/GRANT123/github/user%2Frepo/docs/img/a.png");
    });

    it("prevents directory traversal escape in repoPath", () => {
      const url = buildAssetUrl("/raw", "gitlab", "interagent-io/global-doc", "../../etc/passwd");
      assert.equal(url, "/raw/gitlab/interagent-io%2Fglobal-doc/etc/passwd");
      assert.ok(!url.includes(".."), "asset URL must not contain ..");
    });

    it("supports empty provider and project without creating empty segments for public share URLs", () => {
      const url = buildAssetUrl("/api/public/T/raw", "", "", "img/a.png");
      assert.equal(url, "/api/public/T/raw/img/a.png");
    });
  });

  describe("isImagePath", () => {
    it("returns true for common image file extensions in any casing", () => {
      assert.equal(isImagePath("a.png"), true);
      assert.equal(isImagePath("a.JPG"), true);
      assert.equal(isImagePath("a.jpeg"), true);
      assert.equal(isImagePath("a.svg"), true);
      assert.equal(isImagePath("a.webp"), true);
      assert.equal(isImagePath("a.avif"), true);
      assert.equal(isImagePath("a.gif"), true);
      assert.equal(isImagePath("a.ico"), true);
    });

    it("returns false for non-image files or paths without extensions", () => {
      assert.equal(isImagePath("a.md"), false);
      assert.equal(isImagePath("a.pdf"), false);
      assert.equal(isImagePath("a.txt"), false);
      assert.equal(isImagePath("a"), false);
      assert.equal(isImagePath(""), false);
    });
  });

  describe("insertSnippetFor", () => {
    it("generates image snippet for image files", () => {
      assert.equal(insertSnippetFor("docs/img/圖.png"), "![圖](/docs/img/圖.png)");
      assert.equal(insertSnippetFor("/docs/img/photo.JPG"), "![photo](/docs/img/photo.JPG)");
    });

    it("generates markdown link snippet for non-image files", () => {
      assert.equal(insertSnippetFor("docs/會議記錄.md"), "[會議記錄](/docs/會議記錄.md)");
      assert.equal(insertSnippetFor("specs/api.pdf"), "[api](/specs/api.pdf)");
    });

    it("wraps real-world image paths containing spaces", () => {
      assert.equal(
        insertSnippetFor("導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png"),
        "![截圖 2026-08-13 下午2.13.51](</導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png>)"
      );
    });

    it("wraps non-image Chinese paths containing spaces", () => {
      assert.equal(insertSnippetFor("導入客戶/元信豐/會議 記錄.md"), "[會議 記錄](</導入客戶/元信豐/會議 記錄.md>)");
    });

    it("keeps simple image paths unwrapped", () => {
      const snippet = insertSnippetFor("docs/a.png");
      assert.equal(snippet, "![a](/docs/a.png)");
      assert.ok(!snippet.includes("<"));
      assert.ok(!snippet.includes(">"));
    });
  });

  describe("safeDecodeHref", () => {
    it("decodes percent-encoded Chinese text", () => {
      assert.equal(safeDecodeHref("%E5%B0%8E%E5%85%A5"), "導入");
    });

    it("decodes encoded spaces", () => {
      assert.equal(safeDecodeHref("a%20b.png"), "a b.png");
    });

    it("returns malformed percent escapes unchanged without throwing", () => {
      assert.doesNotThrow(() => safeDecodeHref("a%zzb.png"));
      assert.equal(safeDecodeHref("a%zzb.png"), "a%zzb.png");
    });

    it("keeps ordinary strings unchanged", () => {
      assert.equal(safeDecodeHref("docs/a.png"), "docs/a.png");
    });
  });

  describe("isNewFileResponse", () => {
    it("treats 404 as a new file response", () => {
      assert.equal(isNewFileResponse(404), true);
    });

    it("does not treat successful, auth, permission, or server responses as new files", () => {
      for (const status of [200, 401, 403, 500, 502]) {
        assert.equal(isNewFileResponse(status), false, String(status));
      }
    });

    it("新檔載入回 404 不算錯誤，其他狀態才算", () => {
      const statuses = [200, 401, 403, 404, 500, 502];
      assert.deepEqual(statuses.filter(isNewFileResponse), [404]);
    });
  });

  describe("asset URL encoding regressions", () => {
    const expectedUrl =
      "/raw/gitlab/interagent-io%2Fglobal-doc/%E5%B0%8E%E5%85%A5%E5%AE%A2%E6%88%B6/%E5%85%83%E4%BF%A1%E8%B1%90/%E6%88%AA%E5%9C%96%202026-08-13%20%E4%B8%8B%E5%8D%882.13.51.png";

    it("does not double-encode a marked-encoded image src", () => {
      const markedSrc =
        "/%E5%B0%8E%E5%85%A5%E5%AE%A2%E6%88%B6/%E5%85%83%E4%BF%A1%E8%B1%90/%E6%88%AA%E5%9C%96%202026-08-13%20%E4%B8%8B%E5%8D%882.13.51.png";
      const { path } = resolveRepoHref(safeDecodeHref(markedSrc), "_note-test.md");
      const url = buildAssetUrl("/raw", "gitlab", "interagent-io/global-doc", path);
      assert.equal(url, expectedUrl);
      assert.ok(!url.includes("%25"));
    });

    it("keeps insertSnippetFor output round-trip consistent with asset URLs", () => {
      const snippet = insertSnippetFor("導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png");
      const match = /^!\[.*\]\(<(.+)>\)$/.exec(snippet);
      assert.ok(match);

      const { path } = resolveRepoHref(safeDecodeHref(match[1]), "_note-test.md");
      const url = buildAssetUrl("/raw", "gitlab", "interagent-io/global-doc", path);
      assert.equal(url, expectedUrl);
      assert.ok(!url.includes("%25"));
    });
  });

  describe("isHttpUrl", () => {
    it("returns true for http and https URLs", () => {
      assert.equal(isHttpUrl("https://a.com"), true);
      assert.equal(isHttpUrl("http://a.com/sub/path?q=1"), true);
    });

    it("returns false for non-http protocols and non-url strings", () => {
      assert.equal(isHttpUrl("ftp://a"), false);
      assert.equal(isHttpUrl("mailto:a@b.c"), false);
      assert.equal(isHttpUrl("不是網址"), false);
      assert.equal(isHttpUrl("/relative/path"), false);
    });
  });

  describe("urlCardInfo", () => {
    it("returns domain and display URL for matching bare http/https links and strips www.", () => {
      const res = urlCardInfo("https://www.example.com/a/b", "https://www.example.com/a/b");
      assert.deepEqual(res, {
        domain: "example.com",
        display: "https://www.example.com/a/b",
      });

      const res2 = urlCardInfo("http://docs.dev.io", " http://docs.dev.io ");
      assert.deepEqual(res2, {
        domain: "docs.dev.io",
        display: "http://docs.dev.io",
      });
    });

    it("returns null when link text does not match href", () => {
      assert.equal(urlCardInfo("https://example.com", "點我"), null);
      assert.equal(urlCardInfo("https://example.com", "https://other.com"), null);
    });

    it("returns null for non-http/https protocols", () => {
      assert.equal(urlCardInfo("ftp://example.com/file", "ftp://example.com/file"), null);
      assert.equal(urlCardInfo("mailto:test@example.com", "mailto:test@example.com"), null);
    });

    it("returns null on malformed URLs without throwing exceptions", () => {
      assert.equal(urlCardInfo("not a url", "not a url"), null);
      assert.equal(urlCardInfo("http://", "http://"), null);
    });
  });

  describe("repoPathFromAssetUrl", () => {
    // 線上實際會遇到的路徑：含中文與空白的截圖檔
    const repoPath = "導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png";
    const encoded = repoPath.split("/").map(encodeURIComponent).join("/");
    const project = encodeURIComponent("interagent-io/global-doc");

    it("restores repo path from an absolute note.ia raw URL", () => {
      assert.equal(repoPathFromAssetUrl(`https://note.ia/raw/gitlab/${project}/${encoded}`), repoPath);
    });

    it("restores repo path from relative, grant-token and public-share asset URLs", () => {
      assert.equal(repoPathFromAssetUrl(`/raw/gitlab/${project}/${encoded}`), repoPath);
      assert.equal(repoPathFromAssetUrl(`/rawt/SOMEGRANT/gitlab/${project}/${encoded}`), repoPath);
      assert.equal(repoPathFromAssetUrl(`/api/public/TOKEN123/raw/gitlab/${project}/${encoded}`), repoPath);
    });

    it("ignores query strings and hashes such as ?download=1", () => {
      assert.equal(repoPathFromAssetUrl(`https://note.ia/raw/gitlab/${project}/${encoded}?download=1`), repoPath);
      assert.equal(repoPathFromAssetUrl(`/raw/gitlab/${project}/${encoded}#view=FitH`), repoPath);
    });

    it("returns null for external URLs and non-asset paths", () => {
      assert.equal(repoPathFromAssetUrl("https://example.com/a.png"), null);
      assert.equal(repoPathFromAssetUrl("https://example.com/raw/gitlab/p/a.png", "https://note.ia"), null);
      assert.equal(repoPathFromAssetUrl("/site/gitlab/x"), null);
      assert.equal(repoPathFromAssetUrl("/raw/gitlab/only-project"), null);
      assert.equal(repoPathFromAssetUrl(""), null);
      assert.equal(repoPathFromAssetUrl("mailto:a@b.c"), null);
    });

    it("keeps same-origin asset URLs when an origin is given", () => {
      assert.equal(repoPathFromAssetUrl(`https://note.ia/raw/gitlab/${project}/${encoded}`, "https://note.ia"), repoPath);
    });
  });

  describe("snippetFromDragData（拖放插入的契約）", () => {
    const repoPath = "導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png";
    const encoded = repoPath.split("/").map(encodeURIComponent).join("/");
    const project = encodeURIComponent("interagent-io/global-doc");
    const expected = "![截圖 2026-08-13 下午2.13.51](</導入客戶/元信豐/截圖 2026-08-13 下午2.13.51.png>)";

    /** 產出的 markdown 絕不能含主機名／rawBase／grant token（token 90 天會過期）。 */
    function assertNoAbsoluteUrl(snippet: string | null) {
      assert.ok(snippet, "應該要有 snippet");
      const s = snippet as string;
      assert.ok(!s.includes("http"), `不可含 http：${s}`);
      assert.ok(!s.includes("note.ia"), `不可含 note.ia：${s}`);
      assert.ok(!s.includes("/raw"), `不可含 /raw：${s}`);
      assert.ok(!s.includes("rawt"), `不可含 rawt：${s}`);
    }

    it("produces a relative image embed from the file-tree payload", () => {
      const snippet = snippetFromDragData({ notePath: repoPath, plain: repoPath });
      assert.equal(snippet, expected);
      assert.ok(snippet!.startsWith("!["));
      assertNoAbsoluteUrl(snippet);
    });

    it("converts a dropped absolute raw URL back into a relative image embed", () => {
      const url = `https://note.ia/raw/gitlab/${project}/${encoded}`;
      const snippet = snippetFromDragData({ uriList: url, plain: url }, "https://note.ia");
      assert.equal(snippet, expected);
      assert.ok(snippet!.startsWith("!["));
      assertNoAbsoluteUrl(snippet);
    });

    it("converts grant-token asset URLs too, so no token ever lands in markdown", () => {
      const url = `https://note.ia/rawt/GRANT90D/gitlab/${project}/${encoded}?download=1`;
      const snippet = snippetFromDragData({ uriList: url }, "https://note.ia");
      assert.equal(snippet, expected);
      assertNoAbsoluteUrl(snippet);
    });

    it("still inserts external URLs as bare URLs (url card)", () => {
      assert.equal(
        snippetFromDragData({ uriList: "https://example.com/a\n#comment" }),
        "https://example.com/a"
      );
      assert.equal(snippetFromDragData({}), null);
      assert.equal(snippetFromDragData({ uriList: "not a url" }), null);
    });

    it("uses a link (not an image) for non-image repo files", () => {
      assert.equal(snippetFromDragData({ notePath: "docs/a b.md" }), "[a b](</docs/a b.md>)");
    });
  });

  describe("createDropClaim（同一次 drop 只插一次）", () => {
    it("lets only the first handler claim one native drop event", () => {
      const claim = createDropClaim();
      const dropEvent = { type: "drop" };
      assert.equal(claim(dropEvent), true, "第一個 handler 應該接下");
      assert.equal(claim(dropEvent), false, "同一個原生事件不可再插一次");
      assert.equal(claim(dropEvent), false);
    });

    it("allows the next, different drop event", () => {
      const claim = createDropClaim();
      assert.equal(claim({ type: "drop" }), true);
      assert.equal(claim({ type: "drop" }), true, "另一次拖放是另一個事件物件");
    });
  });
});
