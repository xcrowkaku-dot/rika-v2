"use strict";

const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path   = require("path");

// Load the real validator; mock process.exit so it throws instead of killing the process
let _exitCode = null;
const _origExit = process.exit;
process.exit = (code) => { _exitCode = code; throw new Error("process.exit(" + code + ")"); };

function resetExit() { _exitCode = null; }

// Re-require to get a fresh validate fn each time (constants module is stateful)
function loadValidator() {
  // Ensure modules are freshly loaded
  delete require.cache[require.resolve("../utils/config-validator")];
  delete require.cache[require.resolve("../config/constants")];
  return require("../utils/config-validator");
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function goodConfig(overrides = {}) {
  return Object.assign({
    prefix: "-",
    appStatePath: "./appstate.json",
    bot: { name: "Eagle", version: "2.0", adminIDs: ["123"], language: "en" },
    features: { antiSpam: true, antiSpamCooldownMs: 3000 },
    dashboard: { apiKey: "Eagle@Bot2026-Secure!Key#Dashboard99XZ", port: 3001 },
    loginOptions: {},
    messages: {},
  }, overrides);
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("config-validator", () => {

  test("accepts a valid config without throwing", () => {
    const { validate } = loadValidator();
    resetExit();
    const out = validate(goodConfig());
    assert.ok(out, "should return validated config");
  });

  test("exits on missing required field (prefix)", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig();
    delete cfg.prefix;
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)"),
      "missing prefix should call process.exit(1)"
    );
  });

  test("exits on missing adminIDs", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig();
    delete cfg.bot.adminIDs;
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)")
    );
  });

  test("exits on weak API key (default placeholder)", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig({ dashboard: { apiKey: "changeme-set-a-strong-secret", port: 3001 } });
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)"),
      "weak key should call process.exit(1)"
    );
  });

  test("exits on short API key (<32 chars)", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig({ dashboard: { apiKey: "Short@1", port: 3001 } });
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)")
    );
  });

  test("exits on API key with no symbols", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig({ dashboard: { apiKey: "AAAA1234567890abcdefghijklmnopqrst", port: 3001 } });
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)")
    );
  });

  test("exits on API key with no uppercase", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig({ dashboard: { apiKey: "eagle@bot2026-secure!key#dashboard99", port: 3001 } });
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)")
    );
  });

  test("exits on API key with no numbers", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig({ dashboard: { apiKey: "Eagle@Bot-Secure!Key#Dashboard-XZQ!!!", port: 3001 } });
    assert.throws(
      () => validate(cfg),
      (e) => e.message.includes("process.exit(1)")
    );
  });

  test("applies default for missing optional fields", () => {
    const { validate } = loadValidator();
    resetExit();
    const cfg = goodConfig();
    delete cfg.loginOptions; // optional — should be defaulted
    const out = validate(cfg);
    // Should not throw; defaults applied silently
    assert.ok(out);
  });

  test("env var DASHBOARD_API_KEY overrides config value", () => {
    const { validate } = loadValidator();
    resetExit();
    const strongKey = "Env@Var2026-Override!Strong#Key99XX";
    process.env.DASHBOARD_API_KEY = strongKey;
    try {
      const cfg = goodConfig({ dashboard: { apiKey: "changeme-set-a-strong-secret", port: 3001 } });
      // With env override the validator should NOT exit even though config key is weak
      const out = validate(cfg);
      assert.ok(out);
    } finally {
      delete process.env.DASHBOARD_API_KEY;
    }
  });
});

// Restore process.exit after all tests
process.on("exit", () => { process.exit = _origExit; });
