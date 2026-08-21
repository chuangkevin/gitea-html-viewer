import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyExtension, newFileFrom } from "./new-file-name.js";

describe("newFileFrom", () => {
  it("abc → abc.md 且 initial 有標題", () => {
    assert.deepEqual(newFileFrom("abc"), { path: "abc.md", initial: "# abc\n\n" });
  });

  it("abc.txt → 不變且 initial 為空字串", () => {
    assert.deepEqual(newFileFrom("abc.txt"), { path: "abc.txt", initial: "" });
  });

  it("abc.MD → 不變且有標題", () => {
    assert.deepEqual(newFileFrom("abc.MD"), { path: "abc.MD", initial: "# abc\n\n" });
  });

  it(".gitignore → 不變且 initial 為空字串", () => {
    assert.deepEqual(newFileFrom(".gitignore"), { path: ".gitignore", initial: "" });
  });

  it("docs/a/b → docs/a/b.md", () => {
    assert.deepEqual(newFileFrom("docs/a/b"), { path: "docs/a/b.md", initial: "# b\n\n" });
  });
});

describe("applyExtension", () => {
  it('("abc", ".txt") → "abc.txt"', () => {
    assert.equal(applyExtension("abc", ".txt"), "abc.txt");
  });

  it('("abc.md", ".txt") → "abc.txt"', () => {
    assert.equal(applyExtension("abc.md", ".txt"), "abc.txt");
  });

  it('("docs/a/b.md", ".css") → "docs/a/b.css"', () => {
    assert.equal(applyExtension("docs/a/b.md", ".css"), "docs/a/b.css");
  });

  it('(".gitignore", ".md") → ".gitignore.md"', () => {
    assert.equal(applyExtension(".gitignore", ".md"), ".gitignore.md");
  });

  it('("", ".md") → ""', () => {
    assert.equal(applyExtension("", ".md"), "");
  });

  it('("  ", ".md") → ""', () => {
    assert.equal(applyExtension("  ", ".md"), "");
  });
});
