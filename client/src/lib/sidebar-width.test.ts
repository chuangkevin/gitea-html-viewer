import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  SIDEBAR_MIN,
  SIDEBAR_DEFAULT,
  MAIN_MIN,
  clampSidebarWidth,
  sidebarStorageKey,
  readSidebarWidth,
  writeSidebarWidth,
  type WidthStore,
} from "./sidebar-width.js";

/** 用 Map 包成假的 WidthStore，測試不需要 jsdom。 */
function memoryStore(initial?: Iterable<[string, string]>): WidthStore & { map: Map<string, string> } {
  const map = new Map<string, string>(initial);
  return {
    map,
    getItem(key) {
      return map.has(key) ? map.get(key)! : null;
    },
    setItem(key, value) {
      map.set(key, value);
    },
  };
}

const WIDE = 1280;
const NARROW = 800;

describe("clampSidebarWidth", () => {
  it("低於 MIN 被拉回", () => {
    assert.equal(clampSidebarWidth(50, WIDE), SIDEBAR_MIN);
    assert.equal(clampSidebarWidth(SIDEBAR_MIN, WIDE), SIDEBAR_MIN);
  });

  it("超過視窗 60% 被壓回", () => {
    // 1280 * 0.6 = 768；1280 - 360 = 920 → 上限 768
    assert.equal(clampSidebarWidth(1000, WIDE), 768);
    assert.equal(clampSidebarWidth(768, WIDE), 768);
  });

  it("視窗很窄時 MAIN_MIN 這條上限會生效", () => {
    // 800 * 0.6 = 480；800 - 360 = 440 → 上限 440（MAIN_MIN 比較緊）
    assert.equal(NARROW - MAIN_MIN, 440);
    assert.ok(NARROW * 0.6 > NARROW - MAIN_MIN);
    assert.equal(clampSidebarWidth(500, NARROW), 440);
    assert.equal(clampSidebarWidth(440, NARROW), 440);
  });

  it("NaN / Infinity 一律當 DEFAULT 再夾一次", () => {
    const expected = clampSidebarWidth(SIDEBAR_DEFAULT, WIDE);
    assert.equal(clampSidebarWidth(Number.NaN, WIDE), expected);
    assert.equal(clampSidebarWidth(Number.POSITIVE_INFINITY, WIDE), expected);
    assert.equal(clampSidebarWidth(Number.NEGATIVE_INFINITY, WIDE), expected);
    assert.equal(expected, SIDEBAR_DEFAULT);
  });

  it("回傳是整數", () => {
    const a = clampSidebarWidth(250.4, WIDE);
    const b = clampSidebarWidth(250.6, WIDE);
    assert.equal(a, 250);
    assert.equal(b, 251);
    assert.equal(Number.isInteger(a), true);
    assert.equal(Number.isInteger(b), true);
    assert.equal(Number.isInteger(clampSidebarWidth(288.2, WIDE)), true);
  });
});

describe("sidebarStorageKey", () => {
  it("有 login 時帶登入者", () => {
    assert.equal(sidebarStorageKey("kevin"), "nb.sidebarWidth:kevin");
  });

  it("login 為 null 時用匿名 key", () => {
    assert.equal(sidebarStorageKey(null), "nb.sidebarWidth");
  });

  it("login 為 undefined 時用匿名 key", () => {
    assert.equal(sidebarStorageKey(undefined), "nb.sidebarWidth");
  });
});

describe("readSidebarWidth", () => {
  it("沒存過回 DEFAULT", () => {
    const store = memoryStore();
    assert.equal(readSidebarWidth(store, "kevin", WIDE), SIDEBAR_DEFAULT);
    assert.equal(readSidebarWidth(store, null, WIDE), SIDEBAR_DEFAULT);
  });

  it("存了合法值就照讀", () => {
    const store = memoryStore([["nb.sidebarWidth:kevin", "320"]]);
    assert.equal(readSidebarWidth(store, "kevin", WIDE), 320);
  });

  it('存了 "abc" 回 DEFAULT', () => {
    const store = memoryStore([["nb.sidebarWidth", "abc"]]);
    assert.equal(readSidebarWidth(store, null, WIDE), SIDEBAR_DEFAULT);
  });

  it("存了超出範圍的值會被夾回來", () => {
    const tooSmall = memoryStore([["nb.sidebarWidth:kevin", "50"]]);
    assert.equal(readSidebarWidth(tooSmall, "kevin", WIDE), SIDEBAR_MIN);
    const tooBig = memoryStore([["nb.sidebarWidth:kevin", "9999"]]);
    assert.equal(readSidebarWidth(tooBig, "kevin", WIDE), 768);
  });

  it("getItem 丟例外時回 DEFAULT 而不是炸掉", () => {
    const store: WidthStore = {
      getItem() {
        throw new Error("QuotaExceededError");
      },
      setItem() {},
    };
    assert.equal(readSidebarWidth(store, "kevin", WIDE), SIDEBAR_DEFAULT);
  });
});

describe("writeSidebarWidth", () => {
  it("寫進去的值是 clamp 過的", () => {
    const store = memoryStore();
    writeSidebarWidth(store, "kevin", 50, WIDE);
    assert.equal(store.getItem("nb.sidebarWidth:kevin"), String(SIDEBAR_MIN));
    writeSidebarWidth(store, "kevin", 9999, WIDE);
    assert.equal(store.getItem("nb.sidebarWidth:kevin"), "768");
    writeSidebarWidth(store, null, 320, WIDE);
    assert.equal(store.getItem("nb.sidebarWidth"), "320");
  });

  it("setItem 丟例外不會冒出去", () => {
    const store: WidthStore = {
      getItem() {
        return null;
      },
      setItem() {
        throw new Error("QuotaExceededError");
      },
    };
    assert.doesNotThrow(() => writeSidebarWidth(store, "kevin", 320, WIDE));
  });
});
