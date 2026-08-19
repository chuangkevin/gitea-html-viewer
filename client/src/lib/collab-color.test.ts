import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { COLLAB_PALETTE, collabColorIndex, pickCollabColor } from "./collab-color.js";

describe("collab-color", () => {
  describe("collabColorIndex", () => {
    it("returns the same index for the same name", () => {
      assert.equal(collabColorIndex("Kevin"), collabColorIndex("Kevin"));
      assert.equal(collabColorIndex("InterAgent朋友"), collabColorIndex("InterAgent朋友"));
    });

    it("stays within the palette range", () => {
      for (const name of ["Kevin", "InterAgent朋友", "愷文", "訪客", ""]) {
        const index = collabColorIndex(name);
        assert.ok(index >= 0);
        assert.ok(index < COLLAB_PALETTE.length);
        assert.equal(index, Math.floor(index));
      }
    });

    it("gives Kevin and InterAgent朋友 different colors", () => {
      const kevin = COLLAB_PALETTE[collabColorIndex("Kevin")];
      const friend = COLLAB_PALETTE[collabColorIndex("InterAgent朋友")];
      assert.notEqual(kevin, friend);
    });
  });

  describe("pickCollabColor", () => {
    it("returns the preferred color when taken is empty", () => {
      const preferred = 5;
      assert.equal(pickCollabColor(preferred, []), COLLAB_PALETTE[preferred]);
    });

    it("skips the preferred color when it is already taken", () => {
      const preferred = collabColorIndex("Kevin");
      const taken = [COLLAB_PALETTE[preferred]];
      const picked = pickCollabColor(preferred, taken);
      assert.notEqual(picked, COLLAB_PALETTE[preferred]);
      assert.equal(picked, COLLAB_PALETTE[(preferred + 1) % COLLAB_PALETTE.length]);
      assert.equal(taken.includes(picked), false);
    });

    it("returns the preferred color when the whole palette is taken", () => {
      const preferred = 3;
      const picked = pickCollabColor(preferred, [...COLLAB_PALETTE]);
      assert.equal(picked, COLLAB_PALETTE[preferred]);
      assert.notEqual(picked, undefined);
    });
  });
});
