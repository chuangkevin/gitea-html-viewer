import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseShortLinkTarget, sharePathAffected, targetAffectedBy } from "./path-refs.js";

describe("parseShortLinkTarget", () => {
  it("parses /edit ?f= as a file", () => {
    assert.deepEqual(parseShortLinkTarget("/edit/gitlab/interagent-io%2Fnote?f=docs%2Fa.md"), {
      provider: "gitlab",
      project: "interagent-io/note",
      path: "docs/a.md",
      kind: "file",
    });
  });

  it("parses /edit ?dir= as a folder", () => {
    assert.deepEqual(parseShortLinkTarget("/edit/github/acme%2Fdocs?dir=guides%2Fapi"), {
      provider: "github",
      project: "acme/docs",
      path: "guides/api",
      kind: "folder",
    });
  });

  it("parses /p/ with per-segment encoded path as a file", () => {
    assert.deepEqual(parseShortLinkTarget("/p/gitlab/group%2Frepo/docs/readme.md"), {
      provider: "gitlab",
      project: "group/repo",
      path: "docs/readme.md",
      kind: "file",
    });
  });

  it("strips a fragment before parsing", () => {
    assert.deepEqual(parseShortLinkTarget("/edit/gitlab/group%2Frepo?f=docs%2Freadme.md#intro"), {
      provider: "gitlab",
      project: "group/repo",
      path: "docs/readme.md",
      kind: "file",
    });
    assert.deepEqual(parseShortLinkTarget("/p/gitlab/group%2Frepo/docs/a.md#slide-1"), {
      provider: "gitlab",
      project: "group/repo",
      path: "docs/a.md",
      kind: "file",
    });
  });

  it("returns null on illegal encoding instead of throwing", () => {
    assert.equal(parseShortLinkTarget("/edit/gitlab/group%2Frepo?f=%E0%A4%A"), null);
    assert.equal(parseShortLinkTarget("/edit/gitlab/group%ZZ?f=a.md"), null);
    assert.equal(parseShortLinkTarget("/p/gitlab/group%2Frepo/%E0%A4%A"), null);
    assert.doesNotThrow(() => parseShortLinkTarget("/edit/gitlab/group%2Frepo?f=%E0%A4%A"));
  });

  it("returns null for unsupported forms", () => {
    assert.equal(parseShortLinkTarget("/site/gitlab/group%2Frepo?dir=docs"), null);
    assert.equal(parseShortLinkTarget("/present/gitlab/group%2Frepo?f=docs%2Fa.md"), null);
    assert.equal(parseShortLinkTarget("/edit/gitlab/group%2Frepo"), null);
    assert.equal(parseShortLinkTarget("/edit/gitlab/group%2Frepo?utm=1"), null);
    assert.equal(parseShortLinkTarget("/go/erp"), null);
    assert.equal(parseShortLinkTarget("/s/share-token"), null);
    assert.equal(parseShortLinkTarget("/p/gitlab/group%2Frepo"), null);
  });
});

describe("targetAffectedBy", () => {
  const fileTarget = {
    provider: "gitlab",
    project: "group/repo",
    path: "docs/a.md",
    kind: "file" as const,
  };

  it("returns false when provider or project differs", () => {
    assert.equal(targetAffectedBy(fileTarget, "github", "group/repo", "docs/a.md", "file"), false);
    assert.equal(targetAffectedBy(fileTarget, "gitlab", "other/repo", "docs/a.md", "file"), false);
  });

  it("does not treat docs2 as docs", () => {
    assert.equal(targetAffectedBy(fileTarget, "gitlab", "group/repo", "docs2", "folder"), false);
    assert.equal(
      targetAffectedBy(
        { ...fileTarget, path: "docs2/a.md" },
        "gitlab",
        "group/repo",
        "docs",
        "folder"
      ),
      false
    );
  });

  it("matches a folder prefix including the folder itself", () => {
    assert.equal(targetAffectedBy(fileTarget, "gitlab", "group/repo", "docs", "folder"), true);
    assert.equal(targetAffectedBy(fileTarget, "gitlab", "group/repo", "docs/a.md", "file"), true);
    assert.equal(
      targetAffectedBy(
        { ...fileTarget, path: "docs", kind: "folder" },
        "gitlab",
        "group/repo",
        "docs",
        "folder"
      ),
      true
    );
    assert.equal(targetAffectedBy(fileTarget, "gitlab", "group/repo", "docs/sub", "folder"), false);
  });
});

describe("sharePathAffected", () => {
  it("matches a file only on exact path", () => {
    assert.equal(sharePathAffected("docs/a.md", "docs/a.md", "file"), true);
    assert.equal(sharePathAffected("docs/a.md", "docs", "file"), false);
    assert.equal(sharePathAffected("docs/a.md", "docs/b.md", "file"), false);
  });

  it("matches a folder on exact path or children, without hitting docs2", () => {
    assert.equal(sharePathAffected("docs", "docs", "folder"), true);
    assert.equal(sharePathAffected("docs/a.md", "docs", "folder"), true);
    assert.equal(sharePathAffected("docs/sub/a.md", "docs", "folder"), true);
    assert.equal(sharePathAffected("docs2/a.md", "docs", "folder"), false);
    assert.equal(sharePathAffected("docs.md", "docs", "folder"), false);
  });
});
