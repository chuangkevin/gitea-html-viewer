import test, { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AdminShareInventoryItem, Session } from "./db.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-admin-shares-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.BASE_URL = "https://note.ia";
process.env.ADMIN_KEY = "test-admin-key";

const { app } = await import("./index.js");
const { createSession, createShare, createShareSet, db, revokeShare } = await import("./db.js");

const server = http.createServer(app);
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
if (!address || typeof address === "string") throw new Error("test server did not start");
const baseUrl = `http://127.0.0.1:${address.port}`;

test.after(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare("DELETE FROM shares").run();
  db.prepare("DELETE FROM sessions").run();
});

function request(route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${route}`, { redirect: "manual", ...init });
}

function sessionFor(login: string): string {
  return createSession(login, null, { accessToken: `${login}-access-token` }, "gitlab");
}

function ownerFor(login: string): Session {
  return {
    sid: sessionFor(login),
    login,
    avatar_url: null,
    token: "",
    provider: "gitlab",
    refreshToken: null,
    expiresAt: null,
  };
}

async function adminCookie(): Promise<string> {
  const res = await request("/api/admin/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ key: "test-admin-key" }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get("set-cookie");
  assert.ok(cookie);
  return cookie.split(";")[0];
}

type AdminShareResponse = AdminShareInventoryItem & { shareUrl: string; slidesUrl?: string };

function asItems(value: unknown): AdminShareResponse[] {
  return (value as { shares: AdminShareResponse[] }).shares;
}

describe("admin public share inventory", () => {
  it("requires admin and returns globally scoped, safe inventory data", async () => {
    const alice = ownerFor("alice");
    const bob = ownerFor("bob");
    const aliceToken = createShare(alice, "team/Alpha", "docs/README.md", "Alpha 文件");
    const bobToken = createShareSet(bob, "team/Beta", ["slides/one.md", "slides/two.md"], "Beta 展示");
    const revokedToken = createShare(bob, "team/Beta", "docs/old.md", "已撤銷文件");
    assert.equal(revokeShare("bob", revokedToken), true);

    const denied = await request("/api/admin/shares");
    assert.equal(denied.status, 403);
    const deniedDelete = await request("/api/admin/shares/no-access", { method: "DELETE" });
    assert.equal(deniedDelete.status, 403);

    const cookie = await adminCookie();
    const res = await request("/api/admin/shares", { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const shares = asItems(await res.json());
    assert.equal(shares.length, 3);
    assert.equal(JSON.stringify(shares).includes("owner_sid"), false);
    assert.equal(JSON.stringify(shares).includes("ownerSid"), false);

    const aliceShare = shares.find((share) => share.token === aliceToken);
    assert.ok(aliceShare);
    assert.equal(aliceShare.ownerLogin, "alice");
    assert.equal(aliceShare.shareUrl, `https://note.ia/s/${aliceToken}`);
    assert.equal(aliceShare.slidesUrl, `https://note.ia/s/${aliceToken}/slides`);

    const bobShare = shares.find((share) => share.token === bobToken);
    assert.ok(bobShare);
    assert.equal(bobShare.ownerLogin, "bob");
    assert.equal(bobShare.kind, "set");
    assert.deepEqual(bobShare.paths, ["slides/one.md", "slides/two.md"]);
    assert.equal(bobShare.slidesUrl, `https://note.ia/s/${bobToken}`);

    const revokedShare = shares.find((share) => share.token === revokedToken);
    assert.ok(revokedShare);
    assert.equal(revokedShare.revoked, true);
  });

  it("searches case-insensitively and leaves the ordinary owner list owner-scoped and active-only", async () => {
    const alice = ownerFor("alice");
    const bob = ownerFor("bob");
    const aliceToken = createShare(alice, "team/Alpha", "docs/README.md", "Alpha 文件");
    const bobActiveToken = createShareSet(bob, "team/Beta", ["slides/one.md", "slides/two.md"], "Beta 文件");
    const bobRevokedToken = createShare(bob, "team/Beta", "docs/old.md", "舊文件");
    assert.equal(revokeShare("bob", bobRevokedToken), true);

    const cookie = await adminCookie();
    const search = await request("/api/admin/shares?q=aLpHa", { headers: { Cookie: cookie } });
    assert.equal(search.status, 200);
    const found = asItems(await search.json());
    assert.deepEqual(found.map((share) => share.token), [aliceToken]);

    const setPathSearch = await request("/api/admin/shares?q=TWO.MD", { headers: { Cookie: cookie } });
    assert.equal(setPathSearch.status, 200);
    assert.deepEqual(asItems(await setPathSearch.json()).map((share) => share.token), [bobActiveToken]);

    const ownerList = await request("/api/shares", { headers: { Cookie: `nb_sid=${bob.sid}` } });
    assert.equal(ownerList.status, 200);
    const ownerShares = (await ownerList.json()) as Array<{ token: string }>;
    assert.deepEqual(ownerShares.map((share) => share.token), [bobActiveToken]);
  });

  it("lets an admin revoke any active share and reports missing or already revoked tokens", async () => {
    const owner = ownerFor("owner");
    const token = createShare(owner, "team/Repo", "docs/guide.md", "Guide");
    const cookie = await adminCookie();

    const revoke = await request(`/api/admin/shares/${encodeURIComponent(token)}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(revoke.status, 200);
    assert.deepEqual(await revoke.json(), { ok: true, revoked: true });

    const ownerList = await request("/api/shares", { headers: { Cookie: `nb_sid=${owner.sid}` } });
    assert.equal(ownerList.status, 200);
    assert.deepEqual(await ownerList.json(), []);

    const again = await request(`/api/admin/shares/${encodeURIComponent(token)}`, {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(again.status, 404);

    const missing = await request("/api/admin/shares/no-such-token", {
      method: "DELETE",
      headers: { Cookie: cookie },
    });
    assert.equal(missing.status, 404);
  });
});
