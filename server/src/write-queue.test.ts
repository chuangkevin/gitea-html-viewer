import test, { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderError, type Provider } from "./providers.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-write-queue-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.BASE_URL = "https://note.ia";
process.env.GITHUB_OPEN_TOKEN = "test-open-token";
process.env.GITEA_OPEN_TOKEN = "test-gitea-open-token";
process.env.GITEA_URL = "https://gitea.example";

const { db } = await import("./db.js");
const { registerProvider } = await import("./providers.js");
const { gitea } = await import("./gitea.js");
const { enqueueWrite, ensureWriteJobsTable, processOnce, rawJob, recoverRunningJobs, jobStatus, hasUnlanded, flushGroup, flushJob } = await import(
  "./write-queue.js"
);

/** 假的 provider：把上游狀態放在記憶體，讓我們能斷言「幾次 commit、內容是什麼」。 */
interface FakeFile {
  content: string;
  sha: string;
}
let remote: Map<string, FakeFile>;
let writes: { path: string; content: string; message: string }[];
let batches: { files: { path: string; contentBase64: string }[]; message: string }[];
let canPush: boolean;
let failNext: number;

function resetUpstream(): void {
  remote = new Map();
  writes = [];
  batches = [];
  canPush = true;
  failNext = 0;
}

function shaOf(content: string): string {
  return `sha-${content.length}-${content.slice(0, 8)}`;
}

const fake: Provider = {
  name: "github",
  authorizeUrl: () => "",
  exchangeCode: async () => ({ accessToken: "t" }),
  getUser: async () => ({ login: "u", avatarUrl: "" }),
  listRepos: async () => [],
  createRepo: async () => {
    throw new Error("not implemented");
  },
  getRepo: async (_token, projectPath) => ({
    projectPath,
    private: false,
    defaultBranch: "main",
    pushedAt: "",
    canPush,
  }),
  listAllFiles: async () => [],
  readFile: async (_token, _project, filePath) => {
    const f = remote.get(filePath);
    if (!f) throw new ProviderError(404, "not found");
    return { content: f.content, sha: f.sha, path: filePath };
  },
  readFileRaw: async () => Buffer.from(""),
  writeFile: async (_token, _project, filePath, content, message) => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("upstream boom");
    }
    writes.push({ path: filePath, content, message });
    const f = { content, sha: shaOf(content) };
    remote.set(filePath, f);
    return { sha: f.sha };
  },
  batchWriteFiles: async (_token, _project, files, message) => {
    if (failNext > 0) {
      failNext -= 1;
      throw new Error("upstream boom");
    }
    batches.push({ files, message });
    for (const f of files) {
      const content = Buffer.from(f.contentBase64, "base64").toString("utf8");
      remote.set(f.path, { content, sha: shaOf(content) });
    }
    return { count: files.length, failed: [] };
  },
};

registerProvider(fake);
registerProvider(gitea);
ensureWriteJobsTable();

function countJobs(): { status: string; n: number }[] {
  return db.prepare("SELECT status, COUNT(*) AS n FROM write_jobs GROUP BY status").all() as { status: string; n: number }[];
}

function truncate(): void {
  db.prepare("DELETE FROM write_jobs").run();
}

function enqueue(content: string, extra?: { sha?: string; group?: string; path?: string }) {
  return enqueueWrite({
    provider: "github",
    project: "acme/doc",
    sourceGroup: extra?.group,
    files: [{ path: extra?.path ?? "board.md", content, sha: extra?.sha }],
    actor: { kind: "open" },
    author: { name: "Kevin", email: "k@example.com" },
  });
}

describe("write queue", () => {
  beforeEach(() => {
    resetUpstream();
    truncate();
  });

  it("合併同一群組的連續寫入成單一 commit，內容取最後一次", async () => {
    for (let i = 1; i <= 5; i++) enqueue(`v${i}`);
    const rows = countJobs();
    assert.deepEqual(rows, [{ status: "pending", n: 1 }], "五次寫入只留一個待落地項目");

    await processOnce(Date.now() + 10_000);
    assert.equal(writes.length, 1, "上游只被寫一次");
    assert.equal(writes[0].content, "v5", "落地內容是最後一次送出的版本");
  });

  it("同一群組只合併同一 actor，切換 actor 時保留各自的內容與身分", () => {
    const common = {
      provider: "github" as const,
      project: "acme/doc",
      sourceGroup: "board.md",
    };
    const alice = enqueueWrite({
      ...common,
      files: [{ path: "board.md", content: "alice-v1" }],
      actor: { kind: "identity" as const, identityName: "Alice" },
    });
    const aliceAgain = enqueueWrite({
      ...common,
      files: [{ path: "board.md", content: "alice-v2" }],
      actor: { kind: "identity" as const, identityName: "Alice" },
    });
    const bob = enqueueWrite({
      ...common,
      files: [{ path: "board.md", content: "bob-v1" }],
      actor: { kind: "identity" as const, identityName: "Bob" },
    });

    assert.ok(alice && aliceAgain && bob);
    assert.equal(aliceAgain.jobId, alice.jobId, "同一 actor 仍合併到原 job");
    assert.notEqual(bob.jobId, alice.jobId, "不同 actor 必須建立新 job");
    assert.deepEqual(JSON.parse(rawJob(alice.jobId)!.files_json), [{ path: "board.md", content: "alice-v2" }]);
    assert.equal(rawJob(alice.jobId)?.actor_identity, "Alice");
    assert.deepEqual(JSON.parse(rawJob(bob.jobId)!.files_json), [{ path: "board.md", content: "bob-v1" }]);
    assert.equal(rawJob(bob.jobId)?.actor_identity, "Bob");
  });

  it("多檔群組以單一 commit 原子落地", async () => {
    enqueueWrite({
      provider: "github",
      project: "acme/doc",
      sourceGroup: "poc-board",
      files: [
        { path: "customers.md", content: "MD" },
        { path: "customers.html", content: "HTML" },
      ],
      actor: { kind: "open" },
      author: { name: "Kevin", email: "k@example.com" },
    });
    await processOnce(Date.now() + 10_000);
    assert.equal(batches.length, 1, "兩個檔案一次批次寫入");
    assert.equal(batches[0].files.length, 2);
    assert.equal(writes.length, 0, "不得逐檔各寫一次");
  });

  it("基準 sha 對不上時整組標記衝突、內容保留、不覆蓋上游", async () => {
    remote.set("board.md", { content: "別人的版本", sha: "sha-other" });
    const r = enqueue("我的版本", { sha: "sha-mine" });
    assert.ok(r);
    await processOnce(Date.now() + 10_000);

    assert.equal(writes.length, 0, "衝突時不得寫入");
    assert.equal(remote.get("board.md")?.content, "別人的版本", "上游保持別人的版本");
    const view = jobStatus({ jobId: r!.jobId, provider: "github", project: "acme/doc", actor: { kind: "open" } });
    assert.equal(view?.status, "conflict");
    assert.equal(view?.files?.[0]?.content, "我的版本", "我的內容被保留在佇列裡");
    assert.ok((view?.conflicts ?? []).some((c) => c.path === "board.md"));
  });

  it("多檔群組只要有一檔衝突，整組都不落地", async () => {
    remote.set("customers.md", { content: "別人改過", sha: "sha-other" });
    enqueueWrite({
      provider: "github",
      project: "acme/doc",
      sourceGroup: "poc-board",
      files: [
        { path: "customers.md", content: "我的 MD", sha: "sha-mine" },
        { path: "customers.html", content: "我的 HTML" },
      ],
      actor: { kind: "open" },
    });
    await processOnce(Date.now() + 10_000);
    assert.equal(batches.length, 0, "整組不得落地");
    assert.equal(remote.has("customers.html"), false, "另一檔也不得被寫入");
    assert.equal(remote.get("customers.md")?.content, "別人改過");
  });

  it("遠端內容已與佇列相同時視為已落地，不重複 commit", async () => {
    remote.set("board.md", { content: "v1", sha: shaOf("v1") });
    const r = enqueue("v1");
    assert.ok(r);
    await processOnce(Date.now() + 10_000);
    assert.equal(writes.length, 0, "重啟後不重複 commit");
    assert.equal(jobStatus({ jobId: r!.jobId, provider: "github", project: "acme/doc", actor: { kind: "open" } })?.status, "done");
  });

  it("Gitea exact branch：既有檔帶目前 SHA 用 PUT，新檔不帶 SHA 用 POST", async () => {
    const originalFetch = globalThis.fetch;
    const writes: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    globalThis.fetch = async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      if (url.endsWith("/repos/acme/doc")) {
        return Response.json({
          full_name: "acme/doc",
          private: false,
          default_branch: "main",
          updated_at: "2026-01-01T00:00:00Z",
          permissions: { push: true },
        });
      }
      if (url.includes("/contents/existing.md?ref=feature%2Fexact")) {
        return Response.json({
          content: Buffer.from("old").toString("base64"),
          sha: "current-sha",
          path: "existing.md",
          type: "file",
        });
      }
      if (url.includes("/contents/new.md?ref=feature%2Fexact")) {
        return Response.json({ message: "not found" }, { status: 404 });
      }
      if (url.includes("/contents/") && (method === "PUT" || method === "POST")) {
        writes.push({
          path: new URL(url).pathname.split("/contents/")[1],
          method,
          body: JSON.parse(String(init?.body)) as Record<string, unknown>,
        });
        return Response.json({ content: { sha: "written-sha" } });
      }
      throw new Error(`unexpected request: ${method} ${url}`);
    };

    try {
      const job = enqueueWrite({
        provider: "gitea",
        project: "acme/doc",
        branch: "feature/exact",
        files: [
          { path: "existing.md", content: "updated" },
          { path: "new.md", content: "created" },
        ],
        actor: { kind: "open" },
      });
      assert.ok(job);
      await processOnce(Date.now() + 10_000);

      assert.deepEqual(writes.map(({ path, method }) => ({ path, method })), [
        { path: "existing.md", method: "PUT" },
        { path: "new.md", method: "POST" },
      ]);
      assert.equal(writes[0].body.sha, "current-sha");
      assert.equal("sha" in writes[1].body, false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it("非 404 的 provider 讀取失敗會傳播，不能當成新檔寫入", async () => {
    const originalReadFile = fake.readFile;
    fake.readFile = async () => {
      throw new ProviderError(401, "token expired");
    };
    try {
      const job = enqueue("must-not-write");
      assert.ok(job);
      await processOnce(Date.now() + 10_000);
      assert.equal(writes.length, 0);
      assert.match(rawJob(job.jobId)?.last_error ?? "", /401: token expired/);
    } finally {
      fake.readFile = originalReadFile;
    }
  });

  it("重啟把 running 收回 pending 並能續落地", async () => {
    const r = enqueue("v9");
    assert.ok(r);
    db.prepare("UPDATE write_jobs SET status = 'running' WHERE id = ?").run(r!.jobId);
    assert.equal(recoverRunningJobs(), 1, "殘留的 running 被收回");
    assert.equal(rawJob(r!.jobId)?.status, "pending");
    await processOnce(Date.now() + 10_000);
    assert.equal(writes.length, 1, "重啟後仍會落地");
  });

  it("落地失敗時遞增退避重試，超過上限標記失敗", async () => {
    failNext = 50;
    const r = enqueue("v0");
    assert.ok(r);
    for (let i = 0; i < 8; i++) {
      await processOnce(Date.now() + 10_000_000);
    }
    assert.equal(jobStatus({ jobId: r!.jobId, provider: "github", project: "acme/doc", actor: { kind: "open" } })?.status, "error", "超過重試上限後停止");
    const row = rawJob(r!.jobId);
    assert.ok((row?.attempts ?? 0) >= 5);
    assert.ok(row?.last_error);
  });

  it("未落地狀態查詢與強制落地", async () => {
    const r = enqueue("v1");
    assert.ok(r);
    assert.equal(hasUnlanded("github", "acme/doc"), true);
    assert.equal(flushGroup({ provider: "github", project: "acme/doc" }), 1);
    await processOnce(Date.now() + 1);
    assert.equal(hasUnlanded("github", "acme/doc"), false);
  });

  it("actor-scoped status and flush do not affect another actor in the same group", () => {
    const common = {
      provider: "github" as const,
      project: "acme/doc",
      sourceGroup: "shared-group",
    };
    const aliceActor = { kind: "identity" as const, identityName: "Alice" };
    const bobActor = { kind: "identity" as const, identityName: "Bob" };
    const alice = enqueueWrite({ ...common, files: [{ path: "alice.md", content: "alice" }], actor: aliceActor });
    const bob = enqueueWrite({ ...common, files: [{ path: "bob.md", content: "bob" }], actor: bobActor });
    assert.ok(alice && bob);

    assert.equal(jobStatus({ jobId: bob.jobId, provider: "github", project: "acme/doc", actor: aliceActor }), null);
    assert.equal(flushJob({ jobId: bob.jobId, provider: "github", project: "acme/doc", actor: aliceActor }), 0);
    assert.equal(flushGroup({ ...common, actor: aliceActor }), 1);
    assert.ok(rawJob(alice.jobId)!.quiet_deadline <= Date.now());
    assert.ok(rawJob(bob.jobId)!.quiet_deadline > Date.now());
  });

  it("jobId status requires the exact actor and repository context", () => {
    const aliceActor = { kind: "identity" as const, identityName: "Alice" };
    const job = enqueueWrite({
      provider: "github",
      project: "acme/doc",
      branch: "feature/a",
      sourceGroup: "board.md",
      files: [{ path: "board.md", content: "private draft" }],
      actor: aliceActor,
    });
    assert.ok(job);
    db.prepare("UPDATE write_jobs SET status = 'conflict', last_error = 'sha_mismatch', conflict_json = ? WHERE id = ?")
      .run(JSON.stringify([{ path: "board.md", currentSha: "other" }]), job.jobId);

    const exact = jobStatus({
      jobId: job.jobId,
      provider: "github",
      project: "ACME/DOC",
      branch: "feature/a",
      actor: aliceActor,
    });
    assert.equal(exact?.status, "conflict");
    assert.equal(exact?.error, "sha_mismatch");
    assert.equal(exact?.files?.[0]?.content, "private draft");

    assert.equal(jobStatus({
      jobId: job.jobId,
      provider: "github",
      project: "acme/doc",
      branch: "feature/a",
    } as unknown as Parameters<typeof jobStatus>[0]), null);
    assert.equal(jobStatus({
      jobId: job.jobId,
      provider: "github",
      project: "acme/doc",
      branch: "feature/a",
      actor: { kind: "identity", identityName: "Bob" },
    }), null);
    assert.equal(jobStatus({ ...exactContext(job.jobId, aliceActor), provider: "gitlab" }), null);
    assert.equal(jobStatus({ ...exactContext(job.jobId, aliceActor), project: "acme/other" }), null);
    assert.equal(jobStatus({ ...exactContext(job.jobId, aliceActor), branch: "feature/b" }), null);
  });

  it("flushJob requires the exact job, actor, provider, project, and branch", () => {
    const actor = { kind: "identity" as const, identityName: "Alice" };
    const job = enqueueWrite({
      provider: "github",
      project: "acme/doc",
      branch: "feature/a",
      sourceGroup: "board.md",
      files: [{ path: "board.md", content: "draft" }],
      actor,
    });
    assert.ok(job);
    const originalDeadline = rawJob(job.jobId)!.quiet_deadline;

    assert.equal(flushJob({ ...exactContext(job.jobId, actor), project: "acme/other" }), 0);
    assert.equal(flushJob({ ...exactContext(job.jobId, actor), branch: "feature/b" }), 0);
    assert.equal(rawJob(job.jobId)!.quiet_deadline, originalDeadline, "mismatched requests must not change the target job");

    assert.equal(flushJob(exactContext(job.jobId, actor)), 1);
    assert.ok(rawJob(job.jobId)!.quiet_deadline <= Date.now());
  });

  it("creates and uses the pending coalescing index after the branch migration", () => {
    const columns = db.prepare("PRAGMA table_info(write_jobs)").all() as Array<{ name: string }>;
    assert.ok(columns.some((column) => column.name === "branch"));

    const indexes = db.prepare("PRAGMA index_list(write_jobs)").all() as Array<{ name: string }>;
    assert.ok(indexes.some((index) => index.name === "idx_write_jobs_pending_coalesce"));

    const plan = db.prepare(
      `EXPLAIN QUERY PLAN SELECT * FROM write_jobs
        WHERE provider = ? AND LOWER(project) = LOWER(?) AND branch IS ? AND source_group = ?
          AND actor_kind = ? AND actor_sid IS ? AND actor_identity IS ? AND status = 'pending'
        ORDER BY created_at DESC LIMIT 1`
    ).all("github", "acme/doc", null, "board.md", "open", null, null) as Array<{ detail: string }>;
    assert.ok(
      plan.some((step) => step.detail.includes("USING INDEX idx_write_jobs_pending_coalesce")),
      plan.map((step) => step.detail).join("\n")
    );
  });

  it("拒絕不合法輸入與沒有權限的情境", () => {
    assert.equal(enqueueWrite({ provider: "github", project: "acme/doc", files: [], actor: { kind: "open" } }), null);
    assert.equal(
      enqueueWrite({
        provider: "github",
        project: "acme/doc",
        files: [{ path: "../escape.md", content: "x" }],
        actor: { kind: "open" },
      }),
      null
    );
  });

  it("沒有寫入權限時不落地", async () => {
    canPush = false;
    const r = enqueue("v1");
    assert.ok(r);
    for (let i = 0; i < 8; i++) await processOnce(Date.now() + 10_000_000);
    assert.equal(writes.length, 0);
    assert.equal(jobStatus({ jobId: r!.jobId, provider: "github", project: "acme/doc", actor: { kind: "open" } })?.status, "error");
  });
});

function exactContext(jobId: string, actor: { kind: "identity"; identityName: string }) {
  return { jobId, provider: "github", project: "acme/doc", branch: "feature/a", actor };
}

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});
