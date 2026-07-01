"use strict";

const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

function freshNicknameLocks() {
  delete require.cache[require.resolve("../utils/nicknameLocks")];
  delete require.cache[require.resolve("../utils/logger")];
  return require("../utils/nicknameLocks");
}

describe("nicknameLocks", () => {
  let lockedNicknames;
  beforeEach(() => {
    ({ lockedNicknames } = freshNicknameLocks());
    lockedNicknames.clear();
  });

  test("is empty initially", () => {
    assert.equal(lockedNicknames.size, 0);
  });

  test("set stores Map<userID, nickname> per threadID", () => {
    const members = new Map();
    members.set("user1", "👑 Eagle");
    members.set("user2", "🎯 Sniper");
    lockedNicknames.set("thread1", members);
    assert.equal(lockedNicknames.has("thread1"), true);
    assert.equal(lockedNicknames.get("thread1").get("user1"), "👑 Eagle");
    assert.equal(lockedNicknames.get("thread1").get("user2"), "🎯 Sniper");
  });

  test("get returns undefined for unknown threadID", () => {
    assert.equal(lockedNicknames.get("unknown_thread"), undefined);
  });

  test("delete removes a thread's lock map", () => {
    lockedNicknames.set("t1", new Map([["u1", "Nick"]]));
    lockedNicknames.delete("t1");
    assert.equal(lockedNicknames.has("t1"), false);
  });

  test("delete on missing key does not throw", () => {
    assert.doesNotThrow(() => lockedNicknames.delete("no_such_thread"));
  });

  test("multiple threads stored independently", () => {
    lockedNicknames.set("t1", new Map([["ua", "Alpha"]]));
    lockedNicknames.set("t2", new Map([["ub", "Beta"]]));
    assert.equal(lockedNicknames.get("t1").get("ua"), "Alpha");
    assert.equal(lockedNicknames.get("t2").get("ub"), "Beta");
    lockedNicknames.delete("t1");
    assert.equal(lockedNicknames.has("t1"), false);
    assert.equal(lockedNicknames.has("t2"), true);
  });

  test("adding users to an existing thread map", () => {
    lockedNicknames.set("t1", new Map([["u1", "Nick1"]]));
    lockedNicknames.get("t1").set("u2", "Nick2");
    assert.equal(lockedNicknames.get("t1").size, 2);
    assert.equal(lockedNicknames.get("t1").get("u2"), "Nick2");
  });

  test("overwriting a user's nickname in a thread", () => {
    lockedNicknames.set("t1", new Map([["u1", "Old"]]));
    lockedNicknames.get("t1").set("u1", "New");
    assert.equal(lockedNicknames.get("t1").get("u1"), "New");
  });

  test("clear removes all thread locks", () => {
    lockedNicknames.set("t1", new Map([["u1", "A"]]));
    lockedNicknames.set("t2", new Map([["u2", "B"]]));
    lockedNicknames.clear();
    assert.equal(lockedNicknames.size, 0);
  });

  test("setApi does not throw when api is null (no enforce timer side effects in test)", () => {
    const mod = freshNicknameLocks();
    // setApi with null should be a no-op / not crash
    assert.doesNotThrow(() => mod.setApi(null));
  });

  test("setApi accepts a mock api object", () => {
    const mod = freshNicknameLocks();
    const mockApi = { changeNickname: async () => {}, nickname: async () => {} };
    assert.doesNotThrow(() => mod.setApi(mockApi));
  });
});
