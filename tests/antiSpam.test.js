"use strict";

const { test, describe, beforeEach } = require("node:test");
const assert = require("node:assert/strict");

// Fresh require each test suite — but antiSpam is a singleton so we clear its
// module cache in beforeEach to get a clean state.
function freshAntiSpam() {
  delete require.cache[require.resolve("../utils/antiSpam")];
  return require("../utils/antiSpam");
}

describe("antiSpam — cooldown", () => {
  let as;
  beforeEach(() => { as = freshAntiSpam(); as.configure(100); }); // 100ms cooldown for fast tests

  test("user not on cooldown initially", () => {
    assert.equal(as.isOnCooldown("u1", "cmd"), false);
  });

  test("user is on cooldown immediately after setCooldown", () => {
    as.setCooldown("u1", "cmd");
    assert.equal(as.isOnCooldown("u1", "cmd"), true);
  });

  test("getRemainingCooldown decreases over time", async () => {
    // configure() enforces a minimum of 500 ms, so test with the enforced value
    as.configure(500);
    as.setCooldown("u1", "cmd");
    const r1 = as.getRemainingCooldown("u1", "cmd");
    await new Promise(r => setTimeout(r, 50));
    const r2 = as.getRemainingCooldown("u1", "cmd");
    // After waiting, remaining should be strictly less
    assert.ok(r2 < r1, "remaining should decrease over time");
  });

  test("getRemainingCooldown returns positive ms while cooling down", () => {
    as.configure(500);
    as.setCooldown("u1", "cmd");
    const remaining = as.getRemainingCooldown("u1", "cmd");
    assert.ok(remaining > 0, "remaining should be > 0");
    assert.ok(remaining <= 500, "remaining should be <= cooldown");
  });

  test("getRemainingCooldown returns 0 for user not on cooldown", () => {
    assert.equal(as.getRemainingCooldown("unknown", "cmd"), 0);
  });

  test("clearCooldown removes the specific cooldown", () => {
    as.setCooldown("u1", "cmd");
    as.clearCooldown("u1", "cmd");
    assert.equal(as.isOnCooldown("u1", "cmd"), false);
  });

  test("cooldown is per-command — different commands are independent", () => {
    as.configure(500);
    as.setCooldown("u1", "cmdA");
    assert.equal(as.isOnCooldown("u1", "cmdA"), true);
    assert.equal(as.isOnCooldown("u1", "cmdB"), false);
  });

  test("cooldown is per-user — different users are independent", () => {
    as.configure(500);
    as.setCooldown("u1", "cmd");
    assert.equal(as.isOnCooldown("u1", "cmd"), true);
    assert.equal(as.isOnCooldown("u2", "cmd"), false);
  });
});

describe("antiSpam — abuse detection", () => {
  let as;
  beforeEach(() => { as = freshAntiSpam(); as.configure(200); });

  test("user not flagged as abuser initially", () => {
    assert.equal(as.isAbuser("u1"), false);
  });

  test("user flagged as abuser after hitting threshold via repeated cooldown violations", () => {
    as.configure(5000); // long cooldown so violations can accumulate
    as.setCooldown("u1", "cmd");
    // Trigger 8 violations (ABUSE_THRESHOLD)
    for (let i = 0; i < 8; i++) { as.isOnCooldown("u1", "cmd"); }
    assert.equal(as.isAbuser("u1"), true);
  });

  test("getAbuseCount returns violation count", () => {
    as.configure(5000);
    as.setCooldown("u1", "cmd");
    as.isOnCooldown("u1", "cmd"); // 1 violation
    as.isOnCooldown("u1", "cmd"); // 2 violations
    const count = as.getAbuseCount("u1");
    assert.ok(count >= 1, "abuse count should be ≥ 1");
  });

  test("resetAbuse clears the abuse flag", () => {
    as.configure(5000);
    as.setCooldown("u1", "cmd");
    for (let i = 0; i < 8; i++) as.isOnCooldown("u1", "cmd");
    assert.equal(as.isAbuser("u1"), true);
    as.resetAbuse("u1");
    assert.equal(as.isAbuser("u1"), false);
  });

  test("clearCooldown also resets abuse", () => {
    as.configure(5000);
    as.setCooldown("u1", "cmd");
    for (let i = 0; i < 8; i++) as.isOnCooldown("u1", "cmd");
    assert.equal(as.isAbuser("u1"), true);
    as.clearCooldown("u1");
    assert.equal(as.isAbuser("u1"), false);
  });

  test("getAbuseCount returns 0 for unknown user", () => {
    assert.equal(as.getAbuseCount("unknown_user"), 0);
  });
});
