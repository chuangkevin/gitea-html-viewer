import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withGiteaBranch } from "./api.js";
import {
  collabDocumentKey,
  directSlidesUrl,
  giteaRepoRedirectPlan,
  presentationCacheKey,
  workspaceDocumentKey,
  workspaceSearchParams,
} from "./providers.js";

describe("Gitea branch query helpers", () => {
  it("preserves an exact slash and Unicode branch while changing files", () => {
    const branch = "kevin/sara-5605-補報工上傳優化討論";
    assert.equal(
      workspaceSearchParams(branch, { f: "docs/guide.md" }).toString(),
      `ref=${encodeURIComponent(branch)}&f=docs%2Fguide.md`
    );
  });

  it("adds ref only to Gitea API routes", () => {
    assert.equal(
      withGiteaBranch("/api/file/gitea/SARA_BACKEND%2Fsara-v2/docs/a.md", "feature/foo"),
      "/api/file/gitea/SARA_BACKEND%2Fsara-v2/docs/a.md?ref=feature%2Ffoo"
    );
    assert.equal(
      withGiteaBranch("/api/file/gitlab/interagent-io%2Fglobal-doc/README.md", "feature/foo"),
      "/api/file/gitlab/interagent-io%2Fglobal-doc/README.md"
    );
  });

  it("preserves an explicitly empty dir for root navigation", () => {
    assert.equal(workspaceSearchParams("feature/foo", { dir: "" }).toString(), "ref=feature%2Ffoo&dir=");
    assert.equal(workspaceSearchParams(undefined, { dir: "" }).toString(), "dir=");
    assert.equal(workspaceSearchParams(undefined, { f: "" }).toString(), "");
  });

  it("uses complete unambiguous document and presentation identities", () => {
    assert.equal(
      collabDocumentKey("gitea", "org/repo", "feature/補報工", "~ref/a.md"),
      "gitea-ref/org%2Frepo/feature%2F%E8%A3%9C%E5%A0%B1%E5%B7%A5/~ref/a.md"
    );
    assert.notEqual(
      workspaceDocumentKey("gitea", "org/repo", "feature/one", "README.md", "ident:one"),
      workspaceDocumentKey("gitea", "org/repo", "feature/two", "README.md", "ident:one")
    );
    assert.notEqual(
      workspaceDocumentKey("gitea", "org/repo", "feature/one", "README.md", "ident:one"),
      workspaceDocumentKey("gitea", "org/repo", "feature/one", "README.md", "ident:two")
    );
    assert.notEqual(presentationCacheKey("feature/one", "README.md"), presentationCacheKey("feature/two", "README.md"));
  });

  it("keeps every slide path segment in the pathname and the Gitea ref in the query", () => {
    assert.equal(
      directSlidesUrl(
        "gitea/org%2Frepo",
        "規格/space name/a#b?c.md",
        "feature/補報工"
      ),
      "/p/gitea/org%2Frepo/%E8%A6%8F%E6%A0%BC/space%20name/a%23b%3Fc.md?ref=feature%2F%E8%A3%9C%E5%A0%B1%E5%B7%A5"
    );
  });

  it("redirects plain Gitea repository URLs without branch resolution", () => {
    assert.deepEqual(giteaRepoRedirectPlan("https://gitea.ia/org/repo", "gitea.ia"), {
      redirect: "/edit/gitea/org%2Frepo",
      resolveBranch: false,
    });
    assert.equal(
      giteaRepoRedirectPlan("https://gitea.ia/org/repo/src/branch/feature/foo/docs/a.md", "gitea.ia")?.resolveBranch,
      true
    );
  });
});
