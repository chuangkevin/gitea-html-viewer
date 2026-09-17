import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import { gitea } from "./gitea.js";
import { ProviderError, parseRepoInput } from "./providers.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.GITEA_URL;
});

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response> | Response,
  calls: FetchCall[]
): void {
  globalThis.fetch = async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = String(url);
    calls.push({
      url: u,
      method: String(init?.method ?? "GET"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    return handler(u, init);
  };
}

describe("gitea provider", () => {
  it("listRepos 翻頁直到回傳筆數 < 50，只留 push=true，pushedAt 來自 updated_at", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    const calls: FetchCall[] = [];
    stubFetch((u) => {
      if (u.includes("page=1")) {
        return jsonResponse(
          Array.from({ length: 50 }, (_, i) => ({
            full_name: `kevin/repo-${i}`,
            private: false,
            default_branch: "main",
            updated_at: "2026-01-01T00:00:00Z",
            permissions: { push: i % 2 === 0 },
          }))
        );
      }
      return jsonResponse([
        {
          full_name: "kevin/small",
          private: true,
          default_branch: "main",
          updated_at: "2026-02-02T00:00:00Z",
          permissions: { push: true },
        },
      ]);
    }, calls);
    const repos = await gitea.listRepos("tok");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /\/user\/repos\?page=1&limit=50/);
    assert.match(calls[1].url, /\/user\/repos\?page=2&limit=50/);
    assert.equal(repos.length, 26); // page1 50 筆中偶數 push（25 筆）+ page2 1 筆
    const small = repos.find((r) => r.projectPath === "kevin/small");
    assert.equal(small?.pushedAt, "2026-02-02T00:00:00Z");
    assert.equal(small?.private, true);
  });

  it("writeFile：沒 sha → POST；有 sha → PUT 且 body 含 sha", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    const calls: FetchCall[] = [];
    stubFetch(() => jsonResponse({ content: { sha: "newsha" } }), calls);
    await gitea.writeFile("tok", "kevin/repo", "a.md", "hello", "msg", undefined, "main");
    assert.equal(calls[0].method, "POST");
    assert.equal((calls[0].body as Record<string, unknown>).content, Buffer.from("hello").toString("base64"));
    assert.equal((calls[0].body as Record<string, unknown>).branch, "main");

    await gitea.writeFile("tok", "kevin/repo", "a.md", "hello", "msg", "oldsha", "main");
    assert.equal(calls[1].method, "PUT");
    assert.equal((calls[1].body as Record<string, unknown>).sha, "oldsha");
    assert.equal((calls[1].body as Record<string, unknown>).branch, "main");
  });

  it("writeFile：沒 sha 且檔案已存在時將 Gitea 422 映射為 409，且不自動覆寫", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    const calls: FetchCall[] = [];
    stubFetch(
      () => jsonResponse({ message: "repository file already exists" }, 422),
      calls
    );

    await assert.rejects(
      () => gitea.writeFile("tok", "kevin/repo", "a.md", "hello", "msg", undefined, "main"),
      (err: unknown) => err instanceof ProviderError && err.status === 409
    );
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
  });

  it("moveFile：只打一次 POST /contents，files[0] 是 rename", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    const calls: FetchCall[] = [];
    stubFetch(() => jsonResponse({}), calls);
    await gitea.moveFile!("tok", "kevin/repo", "old.md", "new.md", "move", "main", {
      name: "K",
      email: "k@e.io",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].method, "POST");
    assert.ok(/\/repos\/kevin\/repo\/contents$/.test(calls[0].url));
    const files = (calls[0].body as { files: Record<string, string>[] }).files;
    assert.deepEqual(files[0], { operation: "rename", from_path: "old.md", path: "new.md" });
  });

  it("listAllFiles：truncated=true 再抓一頁，只回 blob", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    const calls: FetchCall[] = [];
    stubFetch((u) => {
      if (/[?&]page=1&/.test(u)) {
        return jsonResponse({
          tree: [
            { path: "a.md", type: "blob" },
            { path: "docs", type: "tree" },
          ],
          truncated: true,
          total_count: 3,
          page: 1,
        });
      }
      return jsonResponse({
        tree: [{ path: "b.md", type: "blob" }],
        truncated: false,
        total_count: 3,
        page: 2,
      });
    }, calls);
    const files = await gitea.listAllFiles("tok", "kevin/repo", "main");
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /git\/trees\/main\?recursive=true&page=1&per_page=1000/);
    assert.match(calls[1].url, /git\/trees\/main\?recursive=true&page=2&per_page=1000/);
    assert.deepEqual(files, [{ path: "a.md" }, { path: "b.md" }]);
  });

  it("batchDeleteFiles：找不到路徑丟 ProviderError 400", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    globalThis.fetch = async () =>
      jsonResponse({ tree: [{ path: "a.md", type: "blob", sha: "s1" }], truncated: false });
    await assert.rejects(
      () => gitea.batchDeleteFiles!("tok", "kevin/repo", ["missing.md"], "msg", "main"),
      (err: unknown) => err instanceof ProviderError && err.status === 400 && err.message.includes("missing.md")
    );
  });

  it("batchDeleteFiles：一次 POST /contents，files 為 delete + sha", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    const calls: FetchCall[] = [];
    stubFetch((u) => {
      if (u.includes("/contents")) return jsonResponse({});
      return jsonResponse({ tree: [{ path: "a.md", type: "blob", sha: "s1" }], truncated: false });
    }, calls);
    await gitea.batchDeleteFiles!("tok", "kevin/repo", ["a.md"], "msg", "main");
    const post = calls.find((c) => c.method === "POST");
    assert.ok(post);
    assert.deepEqual((post.body as { files: unknown }).files, [{ operation: "delete", path: "a.md", sha: "s1" }]);
  });

  it("exchangeCode：回傳 refreshToken 且 expiresAt > Date.now()", async () => {
    process.env.GITEA_URL = "https://gitea.example";
    globalThis.fetch = async () => jsonResponse({ access_token: "at", refresh_token: "rt", expires_in: 3600 });
    const t = await gitea.exchangeCode("id", "secret", "code", "https://example/cb");
    assert.equal(t.accessToken, "at");
    assert.equal(t.refreshToken, "rt");
    assert.ok(t.expiresAt && t.expiresAt > Date.now());
  });

  it("GITEA_URL 未設定時各方法丟 ProviderError 500", async () => {
    delete process.env.GITEA_URL;
    globalThis.fetch = async () => jsonResponse({});
    await assert.rejects(
      () => gitea.getUser("tok"),
      (err: unknown) => err instanceof ProviderError && err.status === 500 && err.message.includes("GITEA_URL")
    );
  });

  it("GITEA_URL 未設定時 parseRepoInput 對 Gitea host 輸入回 null", () => {
    delete process.env.GITEA_URL;
    assert.equal(parseRepoInput("https://gitea.example/kevin/secret"), null);
  });

  it("parseRepoInput：Gitea host 完整網址 → provider gitea、取前兩段", () => {
    process.env.GITEA_URL = "https://gitea.example";
    assert.deepEqual(parseRepoInput("https://gitea.example/kevin/secret"), {
      provider: "gitea",
      projectPath: "kevin/secret",
    });
    assert.deepEqual(parseRepoInput("https://gitea.example/kevin/secret.git/tree/main"), {
      provider: "gitea",
      projectPath: "kevin/secret",
    });
  });
});
