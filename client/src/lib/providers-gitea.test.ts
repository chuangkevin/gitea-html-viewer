import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseRepoInput } from "./providers.js";

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
