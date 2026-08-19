import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as Y from "yjs";
import { applyEditsToYText } from "./collab-edit.js";
import type { TextEdit } from "./text-diff.js";

function applyEditsToString(s: string, edits: readonly TextEdit[]): string {
  const ops = [...edits].sort((a, b) => b.from - a.from);
  let out = s;
  for (const e of ops) {
    out = out.slice(0, e.from) + e.insert + out.slice(e.to);
  }
  return out;
}

describe("collab-edit module", () => {
  describe("applyEditsToYText", () => {
    it("applies a single insert", () => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "hello");
      applyEditsToYText(text, [{ from: 5, to: 5, insert: " world" }]);
      assert.equal(text.toString(), "hello world");
    });

    it("applies a single delete", () => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "hello world");
      applyEditsToYText(text, [{ from: 5, to: 11, insert: "" }]);
      assert.equal(text.toString(), "hello");
    });

    it("applies a single replace", () => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "the cat sat");
      applyEditsToYText(text, [{ from: 4, to: 7, insert: "dog" }]);
      assert.equal(text.toString(), "the dog sat");
    });

    it("applies multiple non-overlapping edits back-to-front, matching string apply", () => {
      const start = "hello world";
      const edits: TextEdit[] = [
        { from: 0, to: 5, insert: "HELLO" },
        { from: 6, to: 11, insert: "WORLD" },
      ];
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, start);
      applyEditsToYText(text, edits);
      assert.equal(text.toString(), applyEditsToString(start, edits));
      assert.equal(text.toString(), "HELLO WORLD");
    });

    it("does not change content or emit a Y.Doc update for an empty array", () => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "hello");
      let updates = 0;
      doc.on("update", () => {
        updates++;
      });
      applyEditsToYText(text, []);
      assert.equal(text.toString(), "hello");
      assert.equal(updates, 0);
    });

    it("does not change content or emit a Y.Doc update for a no-op array", () => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "hello");
      let updates = 0;
      doc.on("update", () => {
        updates++;
      });
      applyEditsToYText(text, [
        { from: 0, to: 0, insert: "" },
        { from: 3, to: 1, insert: "nope" },
      ]);
      assert.equal(text.toString(), "hello");
      assert.equal(updates, 0);
    });

    it("applies as a single transaction", () => {
      const doc = new Y.Doc();
      const text = doc.getText("content");
      text.insert(0, "hello world");
      let updates = 0;
      doc.on("update", () => {
        updates++;
      });
      applyEditsToYText(text, [
        { from: 0, to: 5, insert: "HELLO" },
        { from: 6, to: 11, insert: "WORLD" },
      ]);
      assert.equal(text.toString(), "HELLO WORLD");
      assert.equal(updates, 1);
    });
  });
});
