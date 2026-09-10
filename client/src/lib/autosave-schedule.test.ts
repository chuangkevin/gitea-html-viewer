import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { nextAutosaveDelay } from "./autosave-schedule.js";

const idleMs = 120_000;
const maxWaitMs = 300_000;

describe("nextAutosaveDelay", () => {
  it("剛編輯完回 idleMs", () => {
    assert.equal(
      nextAutosaveDelay({
        dirtySince: 1_000,
        lastEditAt: 1_000,
        now: 1_000,
        idleMs,
        maxWaitMs,
      }),
      idleMs
    );
  });

  it("閒置已超過 idleMs 回 0", () => {
    assert.equal(
      nextAutosaveDelay({
        dirtySince: 1_000,
        lastEditAt: 1_000,
        now: 1_000 + idleMs + 1,
        idleMs,
        maxWaitMs,
      }),
      0
    );
  });

  it("一直打字到封頂回 0", () => {
    // lastEditAt 一直往後推，閒置計時永遠重置；但從 dirtySince 起算已滿 maxWaitMs
    const dirtySince = 0;
    const now = dirtySince + maxWaitMs;
    assert.equal(
      nextAutosaveDelay({
        dirtySince,
        lastEditAt: now,
        now,
        idleMs,
        maxWaitMs,
      }),
      0
    );
  });

  it("一直打字但還沒到封頂，回距離封頂還有多久而不是 idleMs", () => {
    const dirtySince = 0;
    const now = 200_000;
    const remainingToCap = dirtySince + maxWaitMs - now;
    assert.equal(remainingToCap, 100_000);
    assert.notEqual(remainingToCap, idleMs);
    assert.equal(
      nextAutosaveDelay({
        dirtySince,
        lastEditAt: now,
        now,
        idleMs,
        maxWaitMs,
      }),
      remainingToCap
    );
  });

  it("dirtySince 是 null 回 null", () => {
    assert.equal(
      nextAutosaveDelay({
        dirtySince: null,
        lastEditAt: 1_000,
        now: 1_000,
        idleMs,
        maxWaitMs,
      }),
      null
    );
  });

  it("now 正好等於封頂時間回 0", () => {
    const dirtySince = 0;
    const now = dirtySince + maxWaitMs;
    assert.equal(
      nextAutosaveDelay({
        dirtySince,
        lastEditAt: now - 50_000,
        now,
        idleMs,
        maxWaitMs,
      }),
      0
    );
  });
});
