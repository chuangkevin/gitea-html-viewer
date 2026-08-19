import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { minimalEdit, type TextEdit } from "./text-diff.js";

function applyEdit(prev: string, edit: TextEdit): string {
  return prev.slice(0, edit.from) + edit.insert + prev.slice(edit.to);
}

function hasIsolatedSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      if (i + 1 >= s.length) return true;
      const n = s.charCodeAt(i + 1);
      if (n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function assertMinimal(prev: string, next: string): TextEdit | null {
  const edit = minimalEdit(prev, next);
  if (prev === next) {
    assert.equal(edit, null);
    return null;
  }
  assert.ok(edit, "expected an edit when strings differ");
  assert.ok(edit.from >= 0, "from >= 0");
  assert.ok(edit.from <= edit.to, "from <= to");
  assert.ok(edit.to <= prev.length, "to <= prev.length");
  assert.equal(applyEdit(prev, edit), next);
  return edit;
}

describe("text-diff module", () => {
  describe("minimalEdit", () => {
    it("returns null when both strings are identical", () => {
      assert.equal(minimalEdit("", ""), null);
      assert.equal(minimalEdit("hello", "hello"), null);
      assertMinimal("same", "same");
    });

    it("inserts at the start", () => {
      assertMinimal("world", "hello world");
    });

    it("inserts in the middle", () => {
      assertMinimal("helo", "hello");
    });

    it("inserts at the end", () => {
      assertMinimal("hello", "hello!");
    });

    it("deletes at the start", () => {
      assertMinimal("hello world", "world");
    });

    it("deletes in the middle", () => {
      assertMinimal("hello", "helo");
    });

    it("deletes at the end", () => {
      assertMinimal("hello!", "hello");
    });

    it("replaces a middle span while keeping shared prefix and suffix", () => {
      const edit = assertMinimal("the cat sat", "the dog sat");
      assert.ok(edit);
      assert.equal(edit.from, 4);
      assert.equal(edit.to, 7);
      assert.equal(edit.insert, "dog");
    });

    it("inserts the whole next string when prev is empty", () => {
      const edit = assertMinimal("", "hello");
      assert.ok(edit);
      assert.equal(edit.from, 0);
      assert.equal(edit.to, 0);
      assert.equal(edit.insert, "hello");
    });

    it("deletes the whole prev string when next is empty", () => {
      const edit = assertMinimal("hello", "");
      assert.ok(edit);
      assert.equal(edit.from, 0);
      assert.equal(edit.to, 5);
      assert.equal(edit.insert, "");
    });

    it("clamps overlapping prefix/suffix so from <= to (aaa → aaaa)", () => {
      const edit = assertMinimal("aaa", "aaaa");
      assert.ok(edit);
      assert.ok(edit.from <= edit.to);
    });

    it("clamps overlapping prefix/suffix so from <= to (aaaa → aaa)", () => {
      const edit = assertMinimal("aaaa", "aaa");
      assert.ok(edit);
      assert.ok(edit.from <= edit.to);
    });

    it("handles Chinese content", () => {
      assertMinimal("第一行\n第二行", "第一行\n第二行\n第三行");
    });

    it("does not split surrogate pairs when replacing after an emoji", () => {
      const edit = assertMinimal("a👍b", "a👍c");
      assert.ok(edit);
      assert.equal(hasIsolatedSurrogate(edit.insert), false);
    });

    it("does not split surrogate pairs when replacing one emoji with another", () => {
      const edit = assertMinimal("👍", "👎");
      assert.ok(edit);
      assert.equal(hasIsolatedSurrogate(edit.insert), false);
    });
  });
});
