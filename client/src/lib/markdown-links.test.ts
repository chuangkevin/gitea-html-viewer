import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { linkContextAtPath, type LinkContext } from "./markdown";

describe("continuous folder link context", () => {
  it("retains the exact Gitea branch while changing the current document path", () => {
    const context: LinkContext = {
      provider: "gitea",
      project: "org/repo",
      currentPath: "docs/index.md",
      files: ["docs/index.md", "docs/child.md"],
      rawBase: "/rawb/feature%2Fexact",
      branch: "feature/exact",
    };

    assert.deepEqual(linkContextAtPath(context, "docs/child.md"), {
      ...context,
      currentPath: "docs/child.md",
    });
  });
});
