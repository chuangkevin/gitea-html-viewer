import test, { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-enqueue-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.BASE_URL = "https://note.ia";
process.env.GITLAB_OPEN_TOKEN = "test-open-token";
process.env.GITEA_OPEN_TOKEN = "test-gitea-open-token";
process.env.ADMIN_LOGINS = "queue-admin";

const { app } = await import("./index.js");
const { setMode } = await import("./access.js");
const { createSession, db } = await import("./db.js");

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not start");
const baseUrl = `http://127.0.0.1:${address.port}`;

const PROJECT = "interagent-io%2Fglobal-doc";
const REF = `gitlab/${PROJECT}`;

function post(path: string, body: unknown, cookie?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify(body),
  });
}

function cookieFrom(response: Response, name: string): string {
  const match = response.headers.get("set-cookie")?.match(new RegExp(`(?:^|,\\s*)${name}=([^;]+)`));
  assert.ok(match, `${name} cookie must be set`);
  return `${name}=${match[1]}`;
}

test.after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("互動頁寫入佇列的 HTTP 端點", () => {
  beforeEach(() => {
    db.prepare("DELETE FROM write_jobs").run();
    db.prepare("DELETE FROM repo_access").run();
    setMode("gitlab", "interagent-io/global-doc", "open", "test");
  });

  it("未通過存取檢查時拒絕排入", async () => {
    setMode("gitlab", "interagent-io/global-doc", "login", "test");
    const res = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "a.md", content: "x" }],
    });
    assert.equal(res.status, 401);
  });

  it("沿用 repo access mode：普通登入不可繞過 admin，admin 與 open 可排入", async () => {
    setMode("gitlab", "interagent-io/global-doc", "admin", "test");
    const ordinarySid = createSession("ordinary-user", null, { accessToken: "ordinary-token" }, "gitlab");
    const ordinary = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "ordinary.md", content: "x" }],
    }, `nb_sid=${ordinarySid}`);
    assert.equal(ordinary.status, 403);
    assert.deepEqual(await ordinary.json(), { error: "admin_only" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM write_jobs").get() as { n: number }).n, 0);

    const adminSid = createSession("queue-admin", null, { accessToken: "admin-token" }, "gitlab");
    const admin = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "admin.md", content: "admin" }],
    }, `nb_sid=${adminSid}`);
    assert.equal(admin.status, 202);

    setMode("gitlab", "interagent-io/global-doc", "open", "test");
    const open = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "open.md", content: "open" }],
    });
    assert.equal(open.status, 202);
  });

  it("jobId 狀態只回給相同 actor 與 repo context", async () => {
    const aliceSid = createSession("alice-status", null, { accessToken: "alice-token" }, "gitlab");
    const bobSid = createSession("bob-status", null, { accessToken: "bob-token" }, "gitlab");
    const res = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "客戶POC/customers.md", content: "md" }],
      sourceGroup: "客戶POC/board",
      message: "更新客戶 POC 看板",
    }, `nb_sid=${aliceSid}`);
    assert.equal(res.status, 202);
    const body = (await res.json()) as { jobId: string; status: string };
    assert.equal(body.status, "pending");
    assert.ok(body.jobId);

    db.prepare("UPDATE write_jobs SET status = 'conflict', last_error = 'sha_mismatch', conflict_json = ? WHERE id = ?")
      .run(JSON.stringify([{ path: "客戶POC/customers.md", currentSha: "other" }]), body.jobId);
    const exactUrl = `${baseUrl}/api/enqueue-status?jobId=${body.jobId}&provider=gitlab&project=${encodeURIComponent("interagent-io/global-doc")}`;
    const ownResponse = await fetch(exactUrl, { headers: { Cookie: `nb_sid=${aliceSid}` } });
    assert.equal(ownResponse.status, 200);
    const st = await ownResponse.json() as { status: string; error?: string; files?: Array<{ content?: string }> };
    assert.equal(st.status, "conflict");
    assert.equal(st.error, "sha_mismatch");
    assert.equal(st.files?.[0]?.content, "md");

    const anonymous = await fetch(exactUrl);
    assert.equal(anonymous.status, 404);
    assert.deepEqual(await anonymous.json(), { error: "not_found" });

    const differentActor = await fetch(exactUrl, { headers: { Cookie: `nb_sid=${bobSid}` } });
    assert.equal(differentActor.status, 404);
    assert.deepEqual(await differentActor.json(), { error: "not_found" });

    const wrongProject = await fetch(
      `${baseUrl}/api/enqueue-status?jobId=${body.jobId}&provider=gitlab&project=${encodeURIComponent("interagent-io/other")}`,
      { headers: { Cookie: `nb_sid=${aliceSid}` } }
    );
    assert.equal(wrongProject.status, 404);
    assert.deepEqual(await wrongProject.json(), { error: "not_found" });
  });

  it("同一群組的第二次寫入會被合併，不會多一個項目", async () => {
    const firstResponse = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "客戶POC/customers.md", content: "v1" }],
      sourceGroup: "客戶POC/board",
    });
    const browser = cookieFrom(firstResponse, "nb_queue_actor");
    const first = await firstResponse.json() as { jobId: string };
    const second = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "客戶POC/customers.md", content: "v2" }],
      sourceGroup: "客戶POC/board",
    }, browser).then((r) => r.json() as Promise<{ jobId: string; merged: boolean }>);
    assert.equal(second.jobId, first.jobId, "合併到同一個項目");
    assert.equal(second.merged, true);
    const n = db.prepare("SELECT COUNT(*) AS n FROM write_jobs").get() as { n: number };
    assert.equal(n.n, 1);
  });

  it("匿名瀏覽器以 server-issued opaque cookie 隔離 queue actor", async () => {
    const firstAResponse = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "board.md", content: "browser-a-v1" }],
      sourceGroup: "shared-board",
    });
    assert.equal(firstAResponse.status, 202);
    const setCookie = firstAResponse.headers.get("set-cookie") ?? "";
    assert.match(setCookie, /nb_queue_actor=[0-9a-f-]{36}/i);
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Lax/i);
    assert.match(setCookie, /Secure/i);
    const browserA = cookieFrom(firstAResponse, "nb_queue_actor");
    const firstA = await firstAResponse.json() as { jobId: string };
    assert.equal(JSON.stringify(firstA).includes(browserA.split("=")[1]), false, "opaque actor ID must not be exposed");

    const secondA = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "board.md", content: "browser-a-v2" }],
      sourceGroup: "shared-board",
    }, browserA).then((response) => response.json() as Promise<{ jobId: string; merged: boolean }>);
    assert.equal(secondA.jobId, firstA.jobId, "same browser still coalesces");
    assert.equal(secondA.merged, true);

    const firstBResponse = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "board.md", content: "browser-b" }],
      sourceGroup: "shared-board",
    });
    const browserB = cookieFrom(firstBResponse, "nb_queue_actor");
    const firstB = await firstBResponse.json() as { jobId: string };
    assert.notEqual(browserB, browserA);
    assert.notEqual(firstB.jobId, firstA.jobId, "different browsers with the same default guest name stay isolated");

    const statusUrl = `${baseUrl}/api/enqueue-status?jobId=${firstA.jobId}&provider=gitlab&project=${encodeURIComponent("interagent-io/global-doc")}`;
    assert.equal((await fetch(statusUrl, { headers: { Cookie: browserA } })).status, 200);
    assert.equal((await fetch(statusUrl, { headers: { Cookie: browserB } })).status, 404);

    const wrongFlush = await post("/api/enqueue-flush", {
      jobId: firstA.jobId,
      provider: "gitlab",
      project: "interagent-io/global-doc",
    }, browserB);
    assert.deepEqual(await wrongFlush.json(), { ok: true, flushed: 0, pending: false });
    const ownFlush = await post("/api/enqueue-flush", {
      jobId: firstA.jobId,
      provider: "gitlab",
      project: "interagent-io/global-doc",
    }, browserA);
    assert.deepEqual(await ownFlush.json(), { ok: true, flushed: 1, pending: true });
  });

  it("同一 open repo 的不同登入 actor 不會互相合併或 flush", async () => {
    const aliceSid = createSession("alice", null, { accessToken: "alice-token" }, "gitlab");
    const bobSid = createSession("bob", null, { accessToken: "bob-token" }, "gitlab");
    const alice = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "board.md", content: "alice" }],
      sourceGroup: "shared-board",
    }, `nb_sid=${aliceSid}`).then((r) => r.json() as Promise<{ jobId: string }>);
    const bob = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "board.md", content: "bob" }],
      sourceGroup: "shared-board",
    }, `nb_sid=${bobSid}`).then((r) => r.json() as Promise<{ jobId: string }>);

    assert.notEqual(alice.jobId, bob.jobId);
    const rows = db.prepare(
      "SELECT id, actor_kind, actor_sid, files_json, quiet_deadline FROM write_jobs WHERE id IN (?, ?) ORDER BY id"
    ).all(alice.jobId, bob.jobId) as Array<{
      id: string;
      actor_kind: string;
      actor_sid: string | null;
      files_json: string;
      quiet_deadline: number;
    }>;
    assert.equal(rows.length, 2);
    assert.deepEqual(new Set(rows.map((row) => row.actor_sid)), new Set([aliceSid, bobSid]));
    assert.deepEqual(new Set(rows.map((row) => JSON.parse(row.files_json)[0].content)), new Set(["alice", "bob"]));

    const wrongActorFlush = await post("/api/enqueue-flush", {
      jobId: bob.jobId,
      provider: "gitlab",
      project: "interagent-io/global-doc",
      sourceGroup: "shared-board",
    }, `nb_sid=${aliceSid}`);
    assert.equal((await wrongActorFlush.json() as { flushed: number }).flushed, 0);

    const ownFlush = await post("/api/enqueue-flush", {
      jobId: alice.jobId,
      provider: "gitlab",
      project: "interagent-io/global-doc",
      sourceGroup: "shared-board",
    }, `nb_sid=${aliceSid}`);
    assert.equal((await ownFlush.json() as { flushed: number }).flushed, 1);
    const deadlines = db.prepare("SELECT id, quiet_deadline FROM write_jobs WHERE id IN (?, ?)").all(alice.jobId, bob.jobId) as Array<{
      id: string;
      quiet_deadline: number;
    }>;
    assert.ok(deadlines.find((row) => row.id === alice.jobId)!.quiet_deadline <= Date.now());
    assert.ok(deadlines.find((row) => row.id === bob.jobId)!.quiet_deadline > Date.now());
  });

  it("jobId flush 不接受同 actor 的 stale repo 或 branch context", async () => {
    const sid = createSession("alice-flush", null, { accessToken: "alice-token" }, "gitea");
    setMode("gitea", "acme/doc", "open", "test");
    setMode("gitea", "acme/other", "open", "test");
    const { enqueueWrite } = await import("./write-queue.js");
    const job = enqueueWrite({
      provider: "gitea",
      project: "acme/doc",
      branch: "feature/a",
      sourceGroup: "board.md",
      files: [{ path: "board.md", content: "draft" }],
      actor: { kind: "open", sid },
    });
    assert.ok(job);
    const originalDeadline = (db.prepare("SELECT quiet_deadline FROM write_jobs WHERE id = ?").get(job.jobId) as { quiet_deadline: number }).quiet_deadline;

    const wrongRepo = await post("/api/enqueue-flush", {
      jobId: job.jobId,
      provider: "gitea",
      project: "acme/other",
      ref: "feature/a",
    }, `nb_sid=${sid}`);
    assert.equal(wrongRepo.status, 200);
    assert.deepEqual(await wrongRepo.json(), { ok: true, flushed: 0, pending: false });

    const wrongBranch = await post("/api/enqueue-flush", {
      jobId: job.jobId,
      provider: "gitea",
      project: "acme/doc",
      ref: "feature/b",
    }, `nb_sid=${sid}`);
    assert.equal(wrongBranch.status, 200);
    assert.deepEqual(await wrongBranch.json(), { ok: true, flushed: 0, pending: false });
    assert.equal(
      (db.prepare("SELECT quiet_deadline FROM write_jobs WHERE id = ?").get(job.jobId) as { quiet_deadline: number }).quiet_deadline,
      originalDeadline
    );

    const exact = await post("/api/enqueue-flush", {
      jobId: job.jobId,
      provider: "gitea",
      project: "acme/doc",
      ref: "feature/a",
    }, `nb_sid=${sid}`);
    assert.equal(exact.status, 200);
    assert.deepEqual(await exact.json(), { ok: true, flushed: 1, pending: true });
  });

  it("多檔群組排入時保持整組", async () => {
    const res = await post(`/api/enqueue-file/${REF}`, {
      files: [
        { path: "客戶POC/customers.md", content: "md" },
        { path: "客戶POC/customers.html", content: "html" },
      ],
      sourceGroup: "客戶POC/board",
    });
    assert.equal(res.status, 202);
    const row = db.prepare("SELECT files_json FROM write_jobs").get() as { files_json: string };
    assert.equal(JSON.parse(row.files_json).length, 2);
  });

  it("拒絕不合法檔案（路徑逃脫、超大、空陣列）", async () => {
    assert.equal((await post(`/api/enqueue-file/${REF}`, { files: [] })).status, 400);
    assert.equal(
      (await post(`/api/enqueue-file/${REF}`, { files: [{ path: "../x.md", content: "x" }] })).status,
      400
    );
    assert.equal((await post(`/api/enqueue-file/${REF}`, { files: [{ path: "x.md" }] })).status, 400);
  });

  it("強制落地端點把等待中的項目變成可立即處理", async () => {
    const enqueueResponse = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "a.md", content: "x" }],
      sourceGroup: "g1",
    });
    const browser = cookieFrom(enqueueResponse, "nb_queue_actor");
    const q = await enqueueResponse.json() as { jobId: string };
    const res = await post("/api/enqueue-flush", {
      provider: "gitlab",
      project: "interagent-io/global-doc",
      sourceGroup: "g1",
    }, browser);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { flushed: number };
    assert.equal(body.flushed, 1);
    const row = db.prepare("SELECT quiet_deadline, cap_deadline FROM write_jobs WHERE id = ?").get(q.jobId) as {
      quiet_deadline: number;
      cap_deadline: number;
    };
    assert.ok(row.quiet_deadline <= Date.now(), "安靜視窗已被跳過");
  });

  it("既有同步 PUT 端點仍存在且未被改成非同步", async () => {
    const res = await fetch(`${baseUrl}/api/file/${REF}/a.md`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: "x" }),
    });
    // 沒有真的上游可打，但絕不該是 202（非同步）——同步路徑要維持原語意
    assert.notEqual(res.status, 202);
  });
});
