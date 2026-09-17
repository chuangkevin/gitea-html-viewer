import { after, before, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-gitea-ref-route-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.GITEA_URL = "https://gitea.example";
process.env.GITEA_OPEN_TOKEN = "gitea-open-token";
process.env.ADMIN_LOGINS = "github-admin,gitea-admin";

const originalFetch = globalThis.fetch;
const giteaAuthorizationHeaders: Array<string | null> = [];
globalThis.fetch = async (input, init) => {
  const url = String(input);
  giteaAuthorizationHeaders.push(new Headers(init?.headers).get("Authorization"));
  if (url.endsWith("/repos/org/repo")) {
    return Response.json({
      full_name: "org/repo",
      private: false,
      default_branch: "main",
      updated_at: "2026-01-01T00:00:00Z",
      permissions: { push: false },
    });
  }
  if (url.endsWith("/repos/mirror/repo")) {
    return Response.json({
      full_name: "mirror/repo",
      private: false,
      default_branch: "main",
      updated_at: "2026-09-18T00:00:00Z",
      permissions: { push: true },
      mirror: true,
    });
  }
  if (url.endsWith("/repos/writable/repo")) {
    return Response.json({
      full_name: "writable/repo",
      private: false,
      default_branch: "main",
      updated_at: "2026-09-18T00:00:00Z",
      permissions: { push: true },
      mirror: false,
    });
  }
  if (url.includes("/repos/mirror/repo/git/trees/main") || url.includes("/repos/writable/repo/git/trees/main")) {
    return Response.json({ tree: [{ path: "README.md", type: "blob" }], truncated: false });
  }
  if (url.endsWith("/repos/private/repo")) {
    return Response.json({ message: "not found" }, { status: 404 });
  }
  if (url.includes("/branches/missing%2Fref")) {
    return Response.json({ message: "branch not found" }, { status: 404 });
  }
  if (url.includes("/contents/docs/branch.md?ref=feature%2Fok")) {
    return Response.json({
      content: Buffer.from("feature branch content").toString("base64"),
      sha: "branch-sha",
      path: "docs/branch.md",
      type: "file",
    });
  }
  return Response.json({ name: "feature/ok" });
};

const { app } = await import("./index.js");
const { createSession, db, deleteSession, getShare } = await import("./db.js");
const { setMode } = await import("./access.js");
const server = http.createServer(app);
let baseUrl = "";

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server did not bind");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  globalThis.fetch = originalFetch;
  delete process.env.DATA_DIR;
  delete process.env.GITEA_URL;
  delete process.env.GITEA_OPEN_TOKEN;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

async function status(pathname: string): Promise<number> {
  return await new Promise<number>((resolve, reject) => {
    http.get(`${baseUrl}${pathname}`, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode ?? 0));
    }).on("error", reject);
  });
}

async function postJson(pathname: string, body: unknown, cookie: string): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(`${baseUrl}${pathname}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
        Cookie: cookie,
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

async function putJson(pathname: string, body: unknown): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const request = http.request(`${baseUrl}${pathname}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(payload),
      },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    });
    request.on("error", reject);
    request.end(payload);
  });
}

async function getJson(pathname: string): Promise<{ status: number; body: any }> {
  return await new Promise((resolve, reject) => {
    http.get(`${baseUrl}${pathname}`, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        resolve({ status: response.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
      });
    }).on("error", reject);
  });
}

describe("Gitea ref HTTP validation", () => {
  it("returns mirror metadata and disables writes for access and files", async () => {
    setMode("gitea", "mirror/repo", "open", "test");

    const access = await getJson("/api/access/gitea/mirror%2Frepo");
    assert.equal(access.status, 200);
    assert.equal(access.body.mirror, true);
    assert.equal(access.body.canWrite, false);

    const files = await getJson("/api/files/gitea/mirror%2Frepo");
    assert.equal(files.status, 200);
    assert.equal(files.body.mirror, true);
    assert.equal(files.body.canWrite, false);
  });

  it("rejects a direct write to a mirror before calling the Gitea write API", async () => {
    setMode("gitea", "mirror/repo", "open", "test");

    const response = await putJson("/api/file/gitea/mirror%2Frepo/README.md", {
      content: "changed",
    });

    assert.equal(response.status, 403);
    assert.deepEqual(response.body, { error: "no_write_permission" });
  });

  it("keeps a normal Gitea repo writable", async () => {
    setMode("gitea", "writable/repo", "open", "test");

    const access = await getJson("/api/access/gitea/writable%2Frepo");
    assert.equal(access.status, 200);
    assert.equal(access.body.mirror, false);
    assert.equal(access.body.canWrite, true);
  });

  it("returns 400 for explicitly empty and duplicate refs", async () => {
    assert.equal(await status("/api/access/gitea/org%2Frepo?ref="), 400);
    assert.equal(await status("/api/access/gitea/org%2Frepo?ref=one&ref=two"), 400);
  });

  it("returns 404 for an explicit nonexistent exact branch", async () => {
    assert.equal(await status("/api/access/gitea/org%2Frepo?ref=missing%2Fref"), 404);
  });

  it("returns login-required for an anonymous private branch whose repo lookup is hidden as 404", async () => {
    const response = await getJson("/api/access/gitea/private%2Frepo?ref=feature%2Fok");
    assert.equal(response.status, 401);
    assert.deepEqual(response.body, { error: "login_required", reason: "not_found_or_private" });
  });

  it("creates and reads an exact-branch Gitea share while logged in through GitHub", async () => {
    giteaAuthorizationHeaders.length = 0;
    setMode("gitea", "org/repo", "open", "test");
    const sid = createSession("github-user", null, { accessToken: "github-user-token" }, "github");
    const created = await postJson("/api/share", {
      provider: "gitea",
      repo: "org/repo",
      path: "docs/branch.md",
      branch: "feature/ok",
    }, `nb_sid=${sid}`);

    assert.equal(created.status, 200);
    const share = getShare(created.body.token);
    assert.equal(share?.provider, "gitea");
    assert.equal(share?.branch, "feature/ok");
    deleteSession(sid);

    const publicDoc = await getJson(`/api/public/${created.body.token}`);
    assert.equal(publicDoc.status, 200);
    assert.equal(publicDoc.body.content, "feature branch content");
    assert.ok(giteaAuthorizationHeaders.length >= 3);
    assert.ok(giteaAuthorizationHeaders.every((value) => value === "Bearer gitea-open-token"));
  });

  it("rejects an admin cross-provider share before persistence", async () => {
    setMode("gitea", "org/repo", "admin", "test");
    const sid = createSession("github-admin", null, { accessToken: "github-admin-token" }, "github");
    const before = (db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n;
    const created = await postJson("/api/share", {
      provider: "gitea",
      repo: "org/repo",
      path: "docs/admin.md",
    }, `nb_sid=${sid}`);

    assert.equal(created.status, 400);
    assert.deepEqual(created.body, { error: "share_actor_unavailable" });
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shares").get() as { n: number }).n, before);
  });

  it("preserves same-provider private shares", async () => {
    setMode("gitea", "org/repo", "login", "test");
    const sid = createSession("gitea-user", null, { accessToken: "gitea-user-token" }, "gitea");
    const created = await postJson("/api/share", {
      provider: "gitea",
      repo: "org/repo",
      path: "docs/branch.md",
      branch: "feature/ok",
    }, `nb_sid=${sid}`);

    assert.equal(created.status, 200);
    const publicDoc = await getJson(`/api/public/${created.body.token}`);
    assert.equal(publicDoc.status, 200);
    assert.equal(publicDoc.body.content, "feature branch content");
    assert.equal(giteaAuthorizationHeaders.at(-1), "Bearer gitea-user-token");
  });

  it("preserves same-provider admin shares", async () => {
    setMode("gitea", "org/repo", "admin", "test");
    const sid = createSession("gitea-admin", null, { accessToken: "gitea-admin-token" }, "gitea");
    const created = await postJson("/api/share", {
      provider: "gitea",
      repo: "org/repo",
      path: "docs/branch.md",
      branch: "feature/ok",
    }, `nb_sid=${sid}`);

    assert.equal(created.status, 200);
    const publicDoc = await getJson(`/api/public/${created.body.token}`);
    assert.equal(publicDoc.status, 200);
    assert.equal(publicDoc.body.content, "feature branch content");
    assert.equal(giteaAuthorizationHeaders.at(-1), "Bearer gitea-admin-token");
  });
});
