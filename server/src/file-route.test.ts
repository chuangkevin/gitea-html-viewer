import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ProviderError } from "./providers.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-file-route-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";

const { isGiteaWriteConflict, isOptionalAuthLoginRequired, isProviderNotFound } = await import("./index.js");
const { db } = await import("./db.js");

test.after(() => {
  db.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("isProviderNotFound", () => {
  it("recognizes GitLab file 404 as not found", () => {
    assert.equal(isProviderNotFound('GitLab 404: {"message":"404 File Not Found"}'), true);
  });

  it("recognizes GitHub file 404 as not found", () => {
    assert.equal(isProviderNotFound("GitHub 404: Not Found"), true);
  });

  it("does not treat permission or server errors as not found", () => {
    assert.equal(isProviderNotFound("GitLab 403: forbidden"), false);
    assert.equal(isProviderNotFound("GitLab 500: boom"), false);
  });

  it("does not treat an empty message as not found", () => {
    assert.equal(isProviderNotFound(""), false);
  });
});

describe("isOptionalAuthLoginRequired", () => {
  it("requires login for an unauthenticated Gitea 403", () => {
    assert.equal(isOptionalAuthLoginRequired(new ProviderError(403, "Forbidden"), "gitea", false), true);
  });

  it("requires login for an unauthenticated Gitea 401", () => {
    assert.equal(isOptionalAuthLoginRequired(new ProviderError(401, "Unauthorized"), "gitea", false), true);
  });

  it("does not require login for an authenticated Gitea 403", () => {
    assert.equal(isOptionalAuthLoginRequired(new ProviderError(403, "Forbidden"), "gitea", true), false);
  });

  it("preserves unauthenticated GitLab 404 handling", () => {
    assert.equal(isOptionalAuthLoginRequired(new ProviderError(404, "Not Found"), "gitlab", false), true);
  });

  it("does not classify an unauthenticated GitLab 403 as requiring login", () => {
    assert.equal(isOptionalAuthLoginRequired(new ProviderError(403, "Forbidden"), "gitlab", false), false);
  });

  it("does not classify non-provider errors as requiring login", () => {
    assert.equal(isOptionalAuthLoginRequired(new Error("boom"), "gitea", false), false);
  });
});

describe("isGiteaWriteConflict", () => {
  it("passes a Gitea 409 through the write route", () => {
    assert.equal(isGiteaWriteConflict(new ProviderError(409, "file exists"), "gitea"), true);
  });

  it("does not change GitLab 409 handling", () => {
    assert.equal(isGiteaWriteConflict(new ProviderError(409, "conflict"), "gitlab"), false);
  });
});
