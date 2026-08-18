import test, { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-file-route-"));
process.env.DATA_DIR = dataDir;
process.env.NODE_ENV = "test";

const { isProviderNotFound } = await import("./index.js");
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
