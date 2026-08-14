import test, { beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ShortLinkResponse } from "./short-links.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-short-links-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";
process.env.BASE_URL = "https://note.ia";
process.env.ADMIN_KEY = "test-admin-key";

const { app } = await import("./index.js");
const { db } = await import("./db.js");
const shortLinks = await import("./short-links.js");

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
  db.prepare("DELETE FROM short_links").run();
});

function request(route: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${baseUrl}${route}`, { redirect: "manual", ...init });
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

describe("short link validation", () => {
  it("normalizes aliases to lowercase and rejects invalid aliases", () => {
    assert.equal(shortLinks.validateShortLinkAlias("ERP-2026"), "erp-2026");

    for (const alias of ["a", "has space", "bad_slug", "中文", "x".repeat(49), ""]) {
      assert.throws(() => shortLinks.validateShortLinkAlias(alias), { code: "invalid_alias" });
    }
  });

  it("accepts only same-site user-renderable UI targets", () => {
    assert.equal(
      shortLinks.validateShortLinkTarget("/edit/gitlab/group%2Frepo?f=docs%2Freadme.md#intro"),
      "/edit/gitlab/group%2Frepo?f=docs%2Freadme.md#intro"
    );
    assert.equal(shortLinks.validateShortLinkTarget("/site/gitlab/group%2Frepo?dir=docs"), "/site/gitlab/group%2Frepo?dir=docs");
    assert.equal(shortLinks.validateShortLinkTarget("/p/gitlab/group%2Frepo/docs/readme.md"), "/p/gitlab/group%2Frepo/docs/readme.md");
    assert.equal(shortLinks.validateShortLinkTarget("/present/gitlab/group%2Frepo?list=%5B%5D"), "/present/gitlab/group%2Frepo?list=%5B%5D");

    for (const target of [
      "https://note.ia/edit/gitlab/group%2Frepo",
      "//note.ia/edit/gitlab/group%2Frepo",
      "edit/gitlab/group%2Frepo",
      "/edit/gitlab/group%2Frepo\\file",
      "/edit/gitlab/group%2Frepo%5Cfile",
      "/edit/gitlab/group%2Frepo?next=%5c",
      "/edit/gitlab/group%2Frepo?x=%0a",
      "/api/me",
      "/raw/gitlab/group%2Frepo/file.md",
      "/s/share-token",
      "/go/erp",
      "/admin",
      "/%61pi/me",
      "/slides",
      "/edit",
      "/site/gitlab",
      "/present/gitlab/group%2Frepo/extra",
      "/edit/gitlab/group%2Frepo/../admin",
    ]) {
      assert.throws(() => shortLinks.validateShortLinkTarget(target), { code: "invalid_target" }, target);
    }
  });
});

describe("short link persistence", () => {
  it("rejects duplicate custom aliases", () => {
    const first = shortLinks.createShortLink({
      alias: "erp",
      targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
      createdBy: "admin",
    });
    assert.equal(first.alias, "erp");
    assert.throws(
      () =>
        shortLinks.createShortLink({
          alias: "ERP",
          targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
          createdBy: "admin",
        }),
      { code: "alias_exists" }
    );
  });

  it("rejects a non-string custom alias instead of silently generating one", () => {
    const before = shortLinks.listShortLinks().length;
    assert.throws(
      () =>
        shortLinks.createShortLink({
          alias: 123 as unknown as string,
          targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
          createdBy: "admin",
        }),
      { code: "invalid_alias" }
    );
    assert.equal(shortLinks.listShortLinks().length, before);
  });

  it("rejects a non-string label rather than silently discarding it", () => {
    assert.throws(
      () =>
        shortLinks.createShortLink({
          alias: "label-test",
          targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
          label: { unexpected: true } as unknown as string,
          createdBy: "admin",
        }),
      { code: "invalid_label" }
    );
  });

  it("retries generated aliases on collision", () => {
    shortLinks.createShortLink({
      alias: "taken1",
      targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
      createdBy: "admin",
    });
    const generated = ["taken1", "free02"];
    const link = shortLinks.createShortLink(
      { targetPath: "/site/gitlab/group%2Frepo?f=README.md", createdBy: "admin" },
      () => generated.shift() || "free03"
    );
    assert.equal(link.alias, "free02");
  });

  it("lists every issued alias instead of silently truncating the manager", () => {
    for (let index = 0; index < 201; index++) {
      shortLinks.createShortLink({
        alias: `n${String(index).padStart(3, "0")}`,
        targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
        createdBy: "admin",
      });
    }
    assert.equal(shortLinks.listShortLinks().length, 201);
  });
});

describe("short link routes", () => {
  it("redirects active aliases with exact saved Location and ignores incoming query", async () => {
    shortLinks.createShortLink({
      alias: "erp",
      targetPath: "/site/gitlab/group%2Frepo?f=docs%2Freadme.md#intro",
      createdBy: "admin",
    });

    const res = await request("/go/erp?utm=external");
    assert.equal(res.status, 302);
    assert.equal(res.headers.get("location"), "/site/gitlab/group%2Frepo?f=docs%2Freadme.md#intro");
    assert.equal(res.headers.get("cache-control"), "no-store");
  });

  it("returns 404 for unknown and disabled aliases", async () => {
    const link = shortLinks.createShortLink({
      alias: "off",
      targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
      createdBy: "admin",
    });
    shortLinks.updateShortLink(link.id, { isEnabled: false });

    assert.equal((await request("/go/missing")).status, 404);
    assert.equal((await request("/go/off")).status, 404);
  });

  it("requires admin for management APIs and supports create/update when authenticated", async () => {
    const blocked = await request("/api/admin/short-links", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ alias: "erp", targetPath: "/edit/gitlab/group%2Frepo?f=README.md" }),
    });
    assert.equal(blocked.status, 403);

    const cookie = await adminCookie();
    const created = await request("/api/admin/short-links", {
      method: "POST",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ alias: "erp", targetPath: "/edit/gitlab/group%2Frepo?f=README.md", label: "ERP 首頁" }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { link: ShortLinkResponse };
    assert.equal(createdBody.link.alias, "erp");
    assert.equal(createdBody.link.goUrl, "https://note.ia/go/erp");

    const updated = await request(`/api/admin/short-links/${createdBody.link.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", Cookie: cookie },
      body: JSON.stringify({ targetPath: "/site/gitlab/group%2Frepo?f=README.md#top", isEnabled: false }),
    });
    assert.equal(updated.status, 200);
    const updatedBody = (await updated.json()) as { link: ShortLinkResponse };
    assert.equal(updatedBody.link.targetPath, "/site/gitlab/group%2Frepo?f=README.md#top");
    assert.equal(updatedBody.link.isEnabled, false);
  });

  it("does not hijack existing /s public-share routes", async () => {
    shortLinks.createShortLink({
      alias: "sharetest",
      targetPath: "/edit/gitlab/group%2Frepo?f=README.md",
      createdBy: "admin",
    });

    const res = await request("/s/sharetest?utm=external");
    assert.notEqual(res.status, 302);
    assert.notEqual(res.headers.get("location"), "/edit/gitlab/group%2Frepo?f=README.md");
  });
});
