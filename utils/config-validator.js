"use strict";

const logger = require("./logger");
const { SECURITY } = require("../config/constants");

const REQUIRED = [
  { path: "prefix",                            type: "string"  },
  { path: "appStatePath",                      type: "string"  },
  { path: "bot.name",                          type: "string"  },
  { path: "bot.version",                       type: "string"  },
  { path: "bot.adminIDs",                      type: "array"   },
  { path: "features.antiSpam",                 type: "boolean" },
  { path: "features.antiSpamCooldownMs",       type: "number"  },
  { path: "dashboard.port",                    type: "number"  },
];

const DEFAULTS = {
  "features.autoSaveAppState":          true,
  "features.autoSaveIntervalMs":        900000,
  "features.greetNewMembers":           true,
  "features.farewellMembers":           true,
  "features.logMessages":               true,
  "loginOptions.online":                true,
  "loginOptions.selfListen":            false,
  "loginOptions.listenEvents":          true,
  "loginOptions.autoMarkRead":          true,
  "loginOptions.autoReconnect":         true,
  "loginOptions.maxConcurrentRequests": 5,
  "loginOptions.maxRequestsPerMinute":  40,
  "loginOptions.requestCooldownMs":     60000,
};

function _get(obj, dotPath) {
  return dotPath.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function _set(obj, dotPath, val) {
  const keys = dotPath.split(".");
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== "object") cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = val;
}

// FIX #2: Strong API key validation — ≥32 chars + uppercase + numbers + symbols
function _isStrongApiKey(key) {
  if (typeof key !== "string") return false;
  if (key.length < SECURITY.MIN_API_KEY_LENGTH) return false;
  if (!/[A-Z]/.test(key)) return false;
  if (!/[0-9]/.test(key)) return false;
  if (!/[^A-Za-z0-9]/.test(key)) return false;
  return true;
}

const WEAK_KEYS = new Set(["changeme-set-a-strong-secret", "changeme", "", "secret"]);

function validate(config) {
  let errors = 0, warnings = 0;

  // Required field checks
  for (const { path, type } of REQUIRED) {
    const val = _get(config, path);
    if (val === undefined || val === null) {
      logger.error("Config", `Missing required field: "${path}"`);
      errors++;
    } else if (type === "array" && !Array.isArray(val)) {
      logger.error("Config", `Field "${path}" must be an array`);
      errors++;
    } else if (type !== "array" && typeof val !== type) {
      logger.error("Config", `Field "${path}" must be ${type}, got ${typeof val}`);
      errors++;
    }
  }

  if (errors > 0) {
    logger.fatal("Config", `${errors} critical error(s) in config — cannot start.`);
    process.exit(1);
  }

  // Apply defaults
  for (const [dotPath, defVal] of Object.entries(DEFAULTS)) {
    if (_get(config, dotPath) === undefined) {
      _set(config, dotPath, defVal);
      logger.debug("Config", `Default applied: ${dotPath} = ${defVal}`);
    }
  }

  // Environment variable overrides (applied before security checks so env key is validated too)
  if (process.env.DASHBOARD_API_KEY) {
    _set(config, "dashboard.apiKey", process.env.DASHBOARD_API_KEY);
    logger.info("Config", "Dashboard API key loaded from environment.");
  }
  if (process.env.BOT_PREFIX)      { config.prefix = process.env.BOT_PREFIX; logger.info("Config", `Prefix overridden: "${config.prefix}"`); }
  if (process.env.DASHBOARD_PORT)  { _set(config, "dashboard.port", parseInt(process.env.DASHBOARD_PORT)); }
  if (process.env.BOT_ADMIN_IDS)   {
    config.bot.adminIDs = process.env.BOT_ADMIN_IDS.split(",").map(s => s.trim()).filter(Boolean);
    logger.info("Config", `Admin IDs loaded from environment (${config.bot.adminIDs.length}).`);
  }
  if (process.env.BOT_EMAIL)    { config.credentials = config.credentials || {}; config.credentials.email    = process.env.BOT_EMAIL; }
  if (process.env.BOT_PASSWORD) { config.credentials = config.credentials || {}; config.credentials.password = process.env.BOT_PASSWORD; }

  // FIX #2: Enforce strong API key — block startup if key is weak
  const apiKey = _get(config, "dashboard.apiKey");
  if (WEAK_KEYS.has(apiKey)) {
    logger.fatal("Config", "[SECURITY] Dashboard API key is a known default/placeholder. Set a strong key via DASHBOARD_API_KEY env var.");
    logger.fatal("Config", "Requirements: ≥32 characters, at least one uppercase letter, one number, one symbol.");
    process.exit(1);
  }
  if (!_isStrongApiKey(apiKey)) {
    logger.fatal("Config", "[SECURITY] Dashboard API key is too weak.");
    logger.fatal("Config", "Requirements: ≥32 characters, at least one uppercase letter, one number, one symbol.");
    process.exit(1);
  }

  // Range checks
  const saveInterval = _get(config, "features.autoSaveIntervalMs");
  if (saveInterval < 60000) { logger.warn("Config", "autoSaveIntervalMs < 60s may trigger GitHub rate limits."); warnings++; }

  const spamCooldown = _get(config, "features.antiSpamCooldownMs");
  if (spamCooldown < 500) { logger.warn("Config", "antiSpamCooldownMs < 500ms is unlikely to deter spam."); warnings++; }

  const port = _get(config, "dashboard.port");
  if (port && (port < 1024 || port > 65534)) { logger.warn("Config", `Port ${port} is outside recommended range (1024-65534).`); warnings++; }

  if (config.bot.adminIDs && config.bot.adminIDs.length === 0) {
    logger.warn("Config", "No admin IDs configured — admin commands will be inaccessible."); warnings++;
  }

  logger.success("Config", `Validation complete — ${warnings} warning(s).`);
  return config;
}

module.exports = { validate };
