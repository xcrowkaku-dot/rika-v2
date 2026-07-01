"use strict";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

function freshLockedNames() {
  delete require.cache[require.resolve("../utils/lockedNames")];
  return require("../utils/lockedNames");
}

describe("lockedNames", () => {
  let lockedNames;
  beforeEach(() => {
    ({ lockedNames } = freshLockedNames());
    lockedNames.clear(); // clean state
  });

  test("is empty initially", () => {
    assert.equal(lockedNames.size, 0);
  });

  test("set adds a threadID → name mapping", () => {
    lockedNames.set("thread1", "My Group");
    assert.equal(lockedNames.has("thread1"), true);
    assert.equal(lockedNames.get("thread1"), "My Group");
  });

  test("get returns undefined for unknown threadID", () => {
    assert.equal(lockedNames.get("nonexistent"), undefined);
  });

  test("delete removes the entry", () => {
    lockedNames.set("thread1", "My Group");
    lockedNames.delete("thread1");
    assert.equal(lockedNames.has("thread1"), false);
  });

  test("delete on missing key does not throw", () => {
    assert.doesNotThrow(() => lockedNames.delete("missing_thread"));
  });

  test("multiple threads tracked independently", () => {
    lockedNames.set("t1", "Group A");
    lockedNames.set("t2", "Group B");
    assert.equal(lockedNames.get("t1"), "Group A");
    assert.equal(lockedNames.get("t2"), "Group B");
    lockedNames.delete("t1");
    assert.equal(lockedNames.has("t1"), false);
    assert.equal(lockedNames.has("t2"), true);
  });

  test("overwrite updates the locked name", () => {
    lockedNames.set("t1", "First Name");
    lockedNames.set("t1", "Updated Name");
    assert.equal(lockedNames.get("t1"), "Updated Name");
  });

  test("clear removes all entries", () => {
    lockedNames.set("t1", "A");
    lockedNames.set("t2", "B");
    lockedNames.clear();
    assert.equal(lockedNames.size, 0);
  });

  test("iteration yields all entries", () => {
    lockedNames.set("ta", "Alpha");
    lockedNames.set("tb", "Beta");
    const entries = [...lockedNames.entries()];
    assert.equal(entries.length, 2);
    const keys = entries.map(([k]) => k).sort();
    assert.deepEqual(keys, ["ta", "tb"]);
  });
});
