import { assert, describe, it } from "@effect/vitest";

import { AcpWakeReceipts } from "./AcpWakeReceipts.ts";

describe("AcpWakeReceipts", () => {
  it("drops a re-sent notice until its wake prompt fails", () => {
    const receipts = new AcpWakeReceipts();
    assert.isTrue(receipts.admit("child done", ["r1"]));
    assert.isFalse(receipts.admit("child done", ["r1"]));
    const ids = receipts.take("child done");
    assert.deepEqual(ids, ["r1"]);
    // Still a re-send while the wake prompts and after it finishes.
    assert.isFalse(receipts.admit("child done", ["r1"]));
    receipts.forget(ids);
    assert.isTrue(receipts.admit("child done", ["r1"]));
  });

  it("admits a notice that adds an id, and every notice without ids", () => {
    const receipts = new AcpWakeReceipts();
    assert.isTrue(receipts.admit("a", ["r1"]));
    assert.isTrue(receipts.admit("a and b", ["r1", "r2"]));
    assert.isTrue(receipts.admit("process exited", []));
    assert.isTrue(receipts.admit("process exited", []));
    assert.deepEqual(receipts.take("process exited"), []);
  });

  it("matches a wake whose prompt prefixes the notice, oldest first", () => {
    const receipts = new AcpWakeReceipts();
    receipts.admit("same text", ["r1"]);
    receipts.admit("same text", ["r2"]);
    assert.deepEqual(receipts.take("Restart note.\n\nUser message:\nsame text"), ["r1"]);
    assert.deepEqual(receipts.take("same text"), ["r2"]);
    assert.deepEqual(receipts.take("same text"), []);
    assert.deepEqual(receipts.take("an unrelated delegated completion"), []);
  });
});
