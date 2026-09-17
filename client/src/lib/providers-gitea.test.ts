import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { giteaRepoRedirectFromFileParam, parseRepoInput } from "./providers.js";

describe("giteaRepoRedirectFromFileParam", () => {
  it("redirects a Gitea Unicode branch URL to the encoded repo editor path", () => {
    assert.equal(
      giteaRepoRedirectFromFileParam(
        "https://gitea.ia/SARA_BACKEND/sara-v2/src/branch/kevin/sara-5605-補報工上傳優化討論",
        "gitea.ia"
      ),
      "/edit/gitea/SARA_BACKEND%2Fsara-v2"
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

  it("trims subpaths of a gitea blob url", () => {
    assert.deepEqual(parseRepoInput("https://gitea.ia/kevin/secret/src/branch/main/x.md", "gitea.ia"), {
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
