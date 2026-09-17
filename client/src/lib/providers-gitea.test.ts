import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { giteaRepoRedirectFromFileParam, parseRepoInput } from "./providers.js";

describe("giteaRepoRedirectFromFileParam", () => {
  it("redirects a Gitea Unicode branch URL to the encoded repo editor path with its branch suffix", () => {
    const branch = "kevin/sara-5605-補報工上傳優化討論";
    assert.equal(
      giteaRepoRedirectFromFileParam(
        `https://gitea.ia/SARA_BACKEND/sara-v2/src/branch/${branch}`,
        "gitea.ia"
      ),
      `/edit/gitea/SARA_BACKEND%2Fsara-v2?ref=${encodeURIComponent(branch)}`
    );
  });

  it("does not intercept a GitLab URL", () => {
    assert.equal(
      giteaRepoRedirectFromFileParam("https://gitlab.com/SARA_BACKEND/sara-v2/-/blob/main/README.md", "gitea.ia"),
      null
    );
  });

  it("does not intercept a normal repo-relative filename", () => {
    assert.equal(giteaRepoRedirectFromFileParam("docs/README.md", "gitea.ia"), null);
  });
});

describe("parseRepoInput gitea", () => {
  it("parses gitea url when giteaHost matches", () => {
    assert.deepEqual(parseRepoInput("https://gitea.ia/kevin/secret", "gitea.ia"), {
      provider: "gitea",
      projectPath: "kevin/secret",
    });
  });

  it("preserves the suffix of a gitea branch url", () => {
    assert.deepEqual(
      parseRepoInput(
        "https://gitea.ia/SARA_BACKEND/sara-v2/src/branch/kevin/sara-5605-補報工上傳優化討論",
        "gitea.ia"
      ),
      {
        provider: "gitea",
        projectPath: "SARA_BACKEND/sara-v2",
        giteaBranchSuffix: "kevin/sara-5605-補報工上傳優化討論",
      }
    );
  });

  it("matches a configured non-default port as part of the Gitea authority", () => {
    assert.deepEqual(
      parseRepoInput(
        "https://gitea.example:3443/acme/docs/src/branch/feature/port-fix",
        "gitea.example:3443"
      ),
      {
        provider: "gitea",
        projectPath: "acme/docs",
        giteaBranchSuffix: "feature/port-fix",
      }
    );
    assert.equal(
      parseRepoInput("https://gitea.example/acme/docs/src/branch/feature/port-fix", "gitea.example:3443"),
      null
    );
  });

  it("keeps a plain gitea url without a branch suffix", () => {
    assert.deepEqual(parseRepoInput("https://gitea.ia/kevin/secret", "gitea.ia"), {
      provider: "gitea",
      projectPath: "kevin/secret",
    });
  });

  it("does not parse gitea url without giteaHost", () => {
    assert.equal(parseRepoInput("https://gitea.ia/kevin/secret"), null);
  });

  it("leaves github urls untouched even when giteaHost is given", () => {
    assert.deepEqual(parseRepoInput("https://github.com/a/b", "gitea.ia"), {
      provider: "github",
      projectPath: "a/b",
    });
  });
});
