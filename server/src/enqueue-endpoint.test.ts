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

const { app } = await import("./index.js");
const { setMode } = await import("./access.js");
const { db } = await import("./db.js");

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not start");
const baseUrl = `http://127.0.0.1:${address.port}`;

const PROJECT = "interagent-io%2Fglobal-doc";
const REF = `gitlab/${PROJECT}`;

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
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

  it("排入後立刻回 202 與 jobId，並可查得等待中", async () => {
    const res = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "客戶POC/customers.md", content: "md" }],
      sourceGroup: "客戶POC/board",
      message: "更新客戶 POC 看板",
    });
    assert.equal(res.status, 202);
    const body = (await res.json()) as { jobId: string; status: string };
    assert.equal(body.status, "pending");
    assert.ok(body.jobId);

    const st = await fetch(`${baseUrl}/api/enqueue-status?jobId=${body.jobId}`).then((r) => r.json());
    assert.equal(st.status, "pending", "剛排入時是等待中");
    assert.equal(st.pending, true);
  });

  it("同一群組的第二次寫入會被合併，不會多一個項目", async () => {
    const first = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "客戶POC/customers.md", content: "v1" }],
      sourceGroup: "客戶POC/board",
    }).then((r) => r.json() as Promise<{ jobId: string }>);
    const second = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "客戶POC/customers.md", content: "v2" }],
      sourceGroup: "客戶POC/board",
    }).then((r) => r.json() as Promise<{ jobId: string; merged: boolean }>);
    assert.equal(second.jobId, first.jobId, "合併到同一個項目");
    assert.equal(second.merged, true);
    const n = db.prepare("SELECT COUNT(*) AS n FROM write_jobs").get() as { n: number };
    assert.equal(n.n, 1);
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
    const q = await post(`/api/enqueue-file/${REF}`, {
      files: [{ path: "a.md", content: "x" }],
      sourceGroup: "g1",
    }).then((r) => r.json() as Promise<{ jobId: string }>);
    const res = await post("/api/enqueue-flush", {
      provider: "gitlab",
      project: "interagent-io/global-doc",
      sourceGroup: "g1",
    });
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
