import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { identityQueryAfterSwitch, RequestGeneration, runIdentitySwitch, shouldApplyDocumentRead } from "./request-guards.js";

describe("async request guards", () => {
  it("rejects a read when an edit appeared or changed after the read began", () => {
    const key = "identity/doc";
    const originalPending = { content: "before" };
    assert.equal(shouldApplyDocumentRead(key, key, undefined, undefined), true);
    assert.equal(shouldApplyDocumentRead(key, key, undefined, { content: "typed" }), false);
    assert.equal(shouldApplyDocumentRead(key, key, originalPending, originalPending), true);
    assert.equal(shouldApplyDocumentRead(key, key, originalPending, { content: "changed" }), false);
    assert.equal(shouldApplyDocumentRead(key, "other-identity/doc", undefined, undefined), false);
  });

  it("invalidates preference responses from an older identity generation", () => {
    const requests = new RequestGeneration();
    const oldIdentity = requests.next();
    assert.equal(requests.isCurrent(oldIdentity), true);
    const newIdentity = requests.next();
    assert.equal(requests.isCurrent(oldIdentity), false);
    assert.equal(requests.isCurrent(newIdentity), true);
    requests.invalidate();
    assert.equal(requests.isCurrent(newIdentity), false);
  });

  it("flushes before switching identity and does not switch when the flush fails", async () => {
    const order: string[] = [];
    const switched = await runIdentitySwitch(
      async () => { order.push("flush-old"); return true; },
      async () => { order.push("switch-cookie"); },
      async () => { order.push("reload-new"); }
    );
    assert.equal(switched, true);
    assert.deepEqual(order, ["flush-old", "switch-cookie", "reload-new"]);

    const blocked: string[] = [];
    assert.equal(await runIdentitySwitch(
      async () => false,
      async () => { blocked.push("switch-cookie"); },
      async () => { blocked.push("reload-new"); }
    ), false);
    assert.deepEqual(blocked, []);
  });

  it("restores the selected identity query when a guarded switch is rejected", () => {
    assert.equal(identityQueryAfterSwitch(false, "Bob", "Alice"), "Alice");
    assert.equal(identityQueryAfterSwitch(false, "Bob", null), "");
    assert.equal(identityQueryAfterSwitch(true, "Bob", "Alice"), "Bob");
  });
});
