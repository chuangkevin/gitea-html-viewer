import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import type { Session } from "./db.js";
import { parseCollabDocKey, parseShortLinkTarget, targetAffectedBy } from "./path-refs.js";
import { buildPreviewBaseUrl } from "./site-preview.js";

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "note-gitea-branch-test-"));
const dbPath = path.join(dataDir, "note-bridge.db");
const legacy = new Database(dbPath);
legacy.exec(`
  CREATE TABLE shares (
    token TEXT PRIMARY KEY, owner_sid TEXT NOT NULL, owner_login TEXT NOT NULL,
    repo TEXT NOT NULL, path TEXT NOT NULL, title TEXT, created_at INTEGER NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0, kind TEXT NOT NULL DEFAULT 'doc', paths TEXT,
    provider TEXT NOT NULL DEFAULT 'github'
  );
  INSERT INTO shares VALUES ('legacy-share', 'sid', 'owner', 'org/repo', 'README.md', NULL, 1, 0, 'doc', NULL, 'gitea');
  CREATE TABLE user_prefs (
    owner TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL,
    file TEXT, updated_at INTEGER NOT NULL
  );
  INSERT INTO user_prefs VALUES ('owner', 'gitea', 'org/repo', 'README.md', 1);
  CREATE TABLE user_repo_prefs (
    owner TEXT NOT NULL, provider TEXT NOT NULL, project TEXT NOT NULL,
    pinned INTEGER NOT NULL DEFAULT 0, last_seen_at INTEGER NOT NULL,
    PRIMARY KEY (owner, provider, project)
  );
  INSERT INTO user_repo_prefs VALUES ('owner', 'gitea', 'org/repo', 1, 1);
  CREATE TABLE write_jobs (
    id TEXT PRIMARY KEY, provider TEXT NOT NULL, project TEXT NOT NULL,
    source_group TEXT NOT NULL, files_json TEXT NOT NULL, author_name TEXT,
    author_email TEXT, actor_kind TEXT NOT NULL, actor_sid TEXT, actor_identity TEXT,
    message TEXT NOT NULL, status TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
    last_error TEXT, conflict_json TEXT, created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL, quiet_deadline INTEGER NOT NULL, cap_deadline INTEGER NOT NULL
  );
  INSERT INTO write_jobs VALUES ('legacy-job', 'gitea', 'org/repo', 'README.md', '[]', NULL, NULL, 'open', NULL, NULL, 'legacy', 'done', 0, NULL, NULL, 1, 1, 1, 1);
`);
legacy.close();
process.env.DATA_DIR = dataDir;

const dbModule = await import("./db.js");
const queueModule = await import("./write-queue.js");
const { db, createShare, getShare, getUserRepoPrefs, touchUserRepoPref, upsertUserRepoPref } = dbModule;
const { enqueueWrite, jobStatus } = queueModule;
const project = `branch-test/${process.pid}`;
const owner = `branch-test-${process.pid}`;

after(() => {
  db.close();
  delete process.env.DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
});

describe("Gitea branch persistence and identity", () => {
  it("migrates legacy schemas in an isolated DATA_DIR and retains old rows", () => {
    for (const table of ["shares", "user_prefs", "user_repo_prefs", "write_jobs"]) {
      const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
      assert.ok(columns.some((column) => column.name === "branch"), `${table}.branch`);
    }
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM shares WHERE token = 'legacy-share'").get() as { n: number }).n, 1);
    assert.equal((db.prepare("SELECT COUNT(*) AS n FROM write_jobs WHERE id = 'legacy-job'").get() as { n: number }).n, 1);
    assert.deepEqual(getUserRepoPrefs("owner").pinned[0], {
      provider: "gitea", project: "org/repo", branch: null, pinned: true, lastSeenAt: 1,
    });
  });

  it("keeps recent repositories separate by exact Gitea branch", () => {
    upsertUserRepoPref(owner, "gitea", project, "feature/one", true, 1);
    upsertUserRepoPref(owner, "gitea", project, "feature/two", false, 2);
    touchUserRepoPref(owner, "gitea", project, "feature/one", 3);
    const prefs = getUserRepoPrefs(owner);
    assert.equal(prefs.pinned[0].branch, "feature/one");
    assert.equal(prefs.pinned[0].lastSeenAt, 3);
    assert.equal(prefs.recent[0].branch, "feature/two");
  });

  it("does not merge queue jobs from different branches", () => {
    const common = {
      provider: "gitea" as const, project, sourceGroup: "board.md",
      files: [{ path: "board.md", content: "x" }], actor: { kind: "open" as const },
    };
    const one = enqueueWrite({ ...common, branch: "feature/one" });
    const two = enqueueWrite({ ...common, branch: "feature/two" });
    assert.ok(one && two);
    assert.notEqual(one.jobId, two.jobId);
    assert.equal(jobStatus({ provider: "gitea", project, branch: "feature/one", sourceGroup: "board.md" })?.jobId, one.jobId);
    assert.equal(jobStatus({ provider: "gitea", project, branch: "feature/two", sourceGroup: "board.md" })?.jobId, two.jobId);
  });

  it("deduplicates shares within a branch but not across branches", () => {
    const session: Session = {
      sid: "branch-test-sid", login: owner, avatar_url: null, token: "token",
      provider: "gitea", refreshToken: null, expiresAt: null,
    };
    const one = createShare(session, project, "docs/a.md", null, "feature/one");
    assert.equal(createShare(session, project, "docs/a.md", null, "feature/one"), one);
    const two = createShare(session, project, "docs/a.md", null, "feature/two");
    assert.notEqual(two, one);
    assert.equal(getShare(one)?.branch, "feature/one");
    assert.equal(getShare(two)?.branch, "feature/two");

    const github = createShare({ ...session, provider: "github" }, project, "docs/a.md", null, "ignored-branch");
    assert.equal(getShare(github)?.branch, null, "non-Gitea shares do not persist a branch");
  });

  it("keeps branch identity in short links, previews, and versioned collab rooms", () => {
    const branch = "kevin/補報工";
    const target = parseShortLinkTarget(`/edit/gitea/org%2Frepo?ref=${encodeURIComponent(branch)}&f=docs%2Fa.md`);
    assert.deepEqual(target, { provider: "gitea", project: "org/repo", path: "docs/a.md", kind: "file", branch });
    assert.equal(targetAffectedBy(target!, "gitea", "org/repo", "docs/a.md", "file", "other"), false);
    assert.equal(
      buildPreviewBaseUrl({ provider: "gitea", project: "org/repo", folderPath: "docs/", branch }),
      `/site-assetsb/${encodeURIComponent(branch)}/gitea/org%2Frepo/docs/`
    );
    assert.deepEqual(
      parseCollabDocKey(`gitea-ref/org%2Frepo/${encodeURIComponent(branch)}/docs/a.md`),
      { provider: "gitea", project: "org/repo", branch, filePath: "docs/a.md" }
    );
    assert.deepEqual(parseCollabDocKey("gitea/org%2Frepo/~ref/legal.md"), {
      provider: "gitea", project: "org/repo", filePath: "~ref/legal.md",
    });
  });
});
