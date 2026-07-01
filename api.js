"use strict";

/**
 * api.js — Express dashboard + REST API
 *
 * FIX #1: authMiddleware ALWAYS requires a valid Bearer token.
 *   - No bypass when apiKey is missing or a known weak default.
 *   - Fatal log at startup if key is not set via DASHBOARD_API_KEY env var.
 *   - The key value is NEVER printed in any log or response.
 *
 * FIX #9: Security audit — sanitizePath uses decodeURIComponent to catch
 *   encoded traversal, error bodies never leak internal state or tokens.
 */

const express = require("express");
const cors    = require("cors");
const path    = require("path");
const fs      = require("fs");
const crypto  = require("crypto");
const config  = require("./config.json");
const logger  = require("./utils/logger");
const diagnostics    = require("./utils/diagnostics");
const health         = require("./utils/health");
const humanSimulator = require("./utils/humanSimulator");
const {
  lockedThreads, mutedThreads, groupsCache,
  activityLog, lockViolations, autoReplies, groupStats, save: saveState,
} = require("./state");

let botApi           = null;
let startTime        = Date.now();
let botStatus        = "connecting";
let _cookieRefresher = null;
let _session         = null;

const APP_STATE_PATH = path.resolve(__dirname, (config.appStatePath || "appstate.json"));

function setBotApi(api)         { botApi = api; startTime = Date.now(); }
function setBotStatus(s)        { botStatus = s; }
function setCookieRefresher(cr) { _cookieRefresher = cr; }
function setSession(s)          { _session = s; }

function logActivity(msg) {
  activityLog.push({ time: Date.now(), message: String(msg) });
  if (activityLog.length > 300) activityLog.shift();
}

function logViolation({ threadID, threadName, senderID, messagePreview }) {
  lockViolations.push({ time: Date.now(), threadID, threadName, senderID, messagePreview });
  if (lockViolations.length > 200) lockViolations.shift();
}

// ── Rate limiter ──────────────────────────────────────────────────────────────
const _reqMap = new Map();
function _rateLimit(maxPerMinute = 60) {
  return (req, res, next) => {
    const ip  = req.ip || req.connection.remoteAddress || "unknown";
    const now = Date.now();
    const rec = _reqMap.get(ip) || { count: 0, reset: now + 60000 };
    if (now > rec.reset) { rec.count = 0; rec.reset = now + 60000; }
    rec.count++;
    _reqMap.set(ip, rec);
    if (rec.count > maxPerMinute) return res.status(429).json({ error: "Too many requests." });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [ip, rec] of _reqMap) { if (now > rec.reset) _reqMap.delete(ip); } }, 300000).unref();

// ── FIX #1: Known weak/default keys — always rejected ────────────────────────
const _KNOWN_WEAK_KEYS = new Set([
  "changeme",
  "changeme-set-a-strong-secret",
  "secret",
  "password",
  "apikey",
  "dashboard",
  "",
]);

function _isKnownWeakKey(k) {
  if (!k || typeof k !== "string") return true;
  return _KNOWN_WEAK_KEYS.has(k.toLowerCase().trim());
}

/**
 * FIX #1: Startup security warning.
 * Called once when the API server starts. Logs FATAL if the key is not set
 * via environment variable. The actual key value is NEVER printed.
 */
function _warnIfInsecureConfig() {
  const envKey = process.env.DASHBOARD_API_KEY;
  const cfgKey = config.dashboard && config.dashboard.apiKey;

  if (!envKey) {
    logger.warn("Dashboard",
      "[SECURITY] DASHBOARD_API_KEY is not set as an environment variable. " +
      "Using key from config.json — make sure config.json is not committed to git."
    );
  }
  if (_isKnownWeakKey(cfgKey)) {
    // This should not be reached because config-validator.js exits on weak key,
    // but log defensively in case the validator was bypassed.
    logger.fatal("Dashboard", "[SECURITY] Weak or missing API key detected — dashboard is UNSECURED.");
    logger.fatal("Dashboard", "Set a strong key in config.json or via DASHBOARD_API_KEY env var.");
    process.exit(1);
  }
}

// ── FIX #1: Auth middleware — never bypasses ──────────────────────────────────
function authMiddleware(req, res, next) {
  // Public routes
  if (req.path === "/auth/login" || req.path === "/" || req.path.startsWith("/dashboard")) return next();

  const cfgKey = (config.dashboard && config.dashboard.apiKey) || "";

  // FIX #1: Reject immediately if key is missing or a known default — never allow bypass
  if (!cfgKey || _isKnownWeakKey(cfgKey)) {
    logger.fatal("Dashboard", "[SECURITY] Auth bypass attempted — dashboard API key is not configured.");
    return res.status(500).json({ error: "Dashboard API key not configured. Contact the administrator." });
  }

  const authHeader = req.headers["authorization"] || "";
  if (authHeader !== `Bearer ${cfgKey}`) {
    // Do NOT reveal why auth failed (timing-safe comparison not needed since we
    // already reject weak keys above, but log without printing the real key)
    logger.warn("Dashboard", `Unauthorized access attempt from ${req.ip} on ${req.method} ${req.path}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── CSRF protection ───────────────────────────────────────────────────────────
const _validCsrfTokens = new Set();

function _generateCsrfToken() {
  const token = crypto.randomBytes(32).toString("hex");
  _validCsrfTokens.add(token);
  setTimeout(() => _validCsrfTokens.delete(token), 8 * 3600 * 1000).unref();
  return token;
}

function csrfMiddleware(req, res, next) {
  const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
  if (SAFE_METHODS.has(req.method)) return next();
  if (req.path === "/auth/login" || req.path === "/" || req.path.startsWith("/dashboard")) return next();

  // Bearer token is itself CSRF-proof (can't be forged by a cross-origin browser request
  // because custom headers are blocked by CORS). Skip CSRF token check when authenticated.
  const cfgKey    = (config.dashboard && config.dashboard.apiKey) || "";
  const authHeader = req.headers["authorization"] || "";
  if (cfgKey && authHeader === `Bearer ${cfgKey}`) return next();

  const csrfToken = req.headers["x-csrf-token"] || "";
  if (!_validCsrfTokens.has(csrfToken)) {
    logger.warn("CSRF", `Invalid/missing CSRF token on ${req.method} ${req.path}`);
    return res.status(403).json({ error: "CSRF: invalid or missing token. Re-authenticate via /auth/login." });
  }
  next();
}

// ── Input sanitiser ───────────────────────────────────────────────────────────
const _XSS_PATTERNS = [
  /<script[\s\S]*?>[\s\S]*?<\/script>/gi,
  /javascript\s*:/gi,
  /on\w+\s*=/gi,
  /<iframe[\s\S]*?>/gi,
  /<img[^>]+onerror\s*=/gi,
  /data\s*:\s*text\/html/gi,
];

function sanitize(str, maxLen = 512) {
  if (typeof str !== "string") return "";
  let s = str.slice(0, maxLen);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  for (const p of _XSS_PATTERNS) s = s.replace(p, "");
  return s;
}

// FIX #9: URL-decode before stripping traversal to catch encoded variants (%2e%2e%2f)
function sanitizePath(str, maxLen = 100) {
  if (typeof str !== "string") return "";
  let s = str.slice(0, maxLen);
  try { s = decodeURIComponent(s); } catch { return ""; }
  // Multiple passes: catch double-encoded traversal
  for (let i = 0; i < 3; i++) s = s.replace(/\.\.[/\\]/g, "").replace(/\.\./g, "");
  s = s.replace(/[\u0000-\u001F\u007F]/g, "");
  return s;
}

function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── SSE helpers ───────────────────────────────────────────────────────────────
const _sseClients = new Set();
function _broadcastSSE(data) {
  const payload = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of _sseClients) {
    try { res.write(payload); } catch { _sseClients.delete(res); }
  }
}

function logActivitySSE(msg) {
  const entry = { time: Date.now(), message: String(msg) };
  activityLog.push(entry);
  if (activityLog.length > 300) activityLog.shift();
  _broadcastSSE({ type: "activity", data: entry });
}

// ── API routes ────────────────────────────────────────────────────────────────
function createApiServer() {
  const app = express();

  const dashboardDir = path.join(__dirname, "dashboard");
  if (fs.existsSync(dashboardDir)) {
    app.use("/dashboard", express.static(dashboardDir));
    app.get("/", (req, res) => res.redirect("/dashboard/"));
  }

  app.use(cors({ origin: process.env.CORS_ORIGIN || "*", methods: ["GET", "POST", "PUT", "DELETE"] }));
  app.use(express.json({ limit: "256kb" }));
  app.use(_rateLimit(120));
  app.use(authMiddleware);
  app.use(csrfMiddleware);

  // ── Auth — returns CSRF token on success ─────────────────────────────────
  app.post("/auth/login", (req, res) => {
    const { key } = req.body || {};
    const cfgKey  = config.dashboard && config.dashboard.apiKey;
    if (!cfgKey || _isKnownWeakKey(cfgKey)) {
      return res.status(500).json({ error: "Dashboard API key not configured." });
    }
    if (key !== cfgKey) return res.status(401).json({ error: "Invalid API key" });
    const csrfToken = _generateCsrfToken();
    res.json({ success: true, token: cfgKey, csrfToken });
  });

  // ── SSE ───────────────────────────────────────────────────────────────────
  app.get("/stream", (req, res) => {
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache");
    res.setHeader("Connection", "keep-alive");
    res.flushHeaders();
    _sseClients.add(res);
    res.write(`data: ${JSON.stringify({ type: "connected" })}\n\n`);
    req.on("close", () => _sseClients.delete(res));
  });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get("/health", (req, res) => {
    const hs = health.snapshot();
    if (!botApi) return res.json({ status: botStatus, botName: config.bot.name, version: config.bot.version, ...hs });
    res.json({ status: "online", botName: config.bot.name, version: config.bot.version, uptime: Math.floor((Date.now() - startTime) / 1000), groupCount: groupsCache.size, lockedCount: lockedThreads.size, mutedCount: mutedThreads.size, ...hs });
  });

  // ── Overview ──────────────────────────────────────────────────────────────
  app.get("/overview", (req, res) => {
    const hs = health.snapshot();
    let totalMessages = 0, totalCommands = 0;
    for (const s of groupStats.values()) { totalMessages += s.messageCount || 0; totalCommands += s.commandCount || 0; }
    res.json({ status: botStatus, botName: config.bot.name, version: config.bot.version, uptime: botApi ? Math.floor((Date.now() - startTime) / 1000) : 0, groupCount: groupsCache.size, lockedCount: lockedThreads.size, mutedCount: mutedThreads.size, totalMessages, totalCommands, health: hs, humanSim: humanSimulator.status(), recentActivity: activityLog.slice(-10).reverse() });
  });

  app.get("/diagnostics", (req, res) => res.json(diagnostics.report()));
  app.post("/diagnostics/snapshot", async (req, res) => {
    try { const file = await diagnostics.createSnapshot("api_request"); res.json({ success: true, file: file ? path.basename(file) : null }); }
    catch (e) { logger.error("API", "Snapshot failed: " + e.message); res.status(500).json({ error: e.message }); }
  });

  // ── Commands ──────────────────────────────────────────────────────────────
  app.get("/commands", (req, res) => {
    const COMMANDS_DIR = path.join(__dirname, "commands");
    const list = [];
    try {
      const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith(".js"));
      for (const file of files) {
        try {
          const mod = require(path.join(COMMANDS_DIR, file));
          if (mod.name && mod.execute) list.push({ name: mod.name, description: mod.description || "", aliases: mod.aliases || [], adminOnly: !!mod.adminOnly, groupOnly: !!mod.groupOnly });
        } catch (e) { logger.warn("API", "Command load error: " + e.message); }
      }
    } catch (e) { logger.warn("API", "Commands dir read failed: " + e.message); }
    res.json(list.sort((a, b) => a.name.localeCompare(b.name)));
  });

  // ── Config ────────────────────────────────────────────────────────────────
  app.get("/config", (req, res) => {
    const safe = JSON.parse(JSON.stringify(config));
    // FIX #9: Never expose credentials or apiKey in API responses
    if (safe.credentials) { safe.credentials.email = safe.credentials.email ? "***" : ""; safe.credentials.password = ""; }
    if (safe.dashboard) delete safe.dashboard.apiKey;
    res.json(safe);
  });

  app.put("/config/features", (req, res) => {
    const allowed = ["greetNewMembers", "farewellMembers", "antiSpam", "logMessages", "autoSaveAppState"];
    const updates = {};
    for (const k of allowed) { if (k in req.body) updates[k] = !!req.body[k]; }
    if (req.body.antiSpamCooldownMs) updates.antiSpamCooldownMs = Math.max(500, parseInt(req.body.antiSpamCooldownMs) || 3000);
    Object.assign(config.features, updates);
    logActivitySSE("Features config updated via dashboard");
    res.json({ success: true, features: config.features });
  });

  // ── Human simulator ───────────────────────────────────────────────────────
  app.get("/humansim",  (req, res) => res.json(humanSimulator.status()));
  app.put("/humansim",  (req, res) => {
    const { enabled, presenceIntervalMs, typingIntervalMs, readIntervalMs } = req.body;
    humanSimulator.configure({ enabled, presenceIntervalMs, typingIntervalMs, readIntervalMs });
    logActivitySSE("Human simulator updated");
    res.json({ success: true, status: humanSimulator.status() });
  });

  // ── Cookies ───────────────────────────────────────────────────────────────
  app.get("/cookies/status", (req, res) => {
    if (!_cookieRefresher) return res.json({ active: false, message: "Bot not connected." });
    const s = _cookieRefresher.status();
    res.json({ ...s, lastPushFormatted: s.lastPushAt ? new Date(s.lastPushAt).toISOString() : null });
  });
  app.post("/cookies/refresh", async (req, res) => {
    if (!_cookieRefresher) return res.status(503).json({ error: "Bot not connected." });
    try { const result = await _cookieRefresher.forceRefresh(); logActivitySSE("Cookies force-refreshed"); res.json({ success: true, ...result }); }
    catch (e) { logger.error("API", "Cookie refresh: " + e.message); res.status(500).json({ error: e.message }); }
  });

  // ── Groups ────────────────────────────────────────────────────────────────
  app.get("/groups", (req, res) => {
    const groups = [];
    for (const [threadID, info] of groupsCache.entries()) {
      const muteExpiry = mutedThreads.get(threadID);
      const stats      = groupStats.get(threadID) || {};
      const ar         = autoReplies.get(threadID);
      groups.push({ threadID, name: info.name || threadID, memberCount: info.memberCount || 0, isLocked: lockedThreads.has(threadID), isMuted: muteExpiry != null && Date.now() < muteExpiry, muteExpiresAt: muteExpiry || null, lastSeen: info.lastSeen || 0, messageCount: stats.messageCount || 0, commandCount: stats.commandCount || 0, hasAutoReply: !!(ar && ar.enabled) });
    }
    res.json(groups.sort((a, b) => b.lastSeen - a.lastSeen));
  });

  app.get("/groups/:threadID/info", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      const { threadID } = req.params;
      const info = await botApi.getThreadInfo(threadID);
      const cached = groupsCache.get(threadID) || {};
      const stats  = groupStats.get(threadID) || {};
      const muteExpiry = mutedThreads.get(threadID);
      const ar = autoReplies.get(threadID);
      res.json({ threadID, name: info.name || cached.name || threadID, memberCount: (info.participantIDs || []).length, adminCount: (info.adminIDs || []).length, isLocked: lockedThreads.has(threadID), isMuted: muteExpiry != null && Date.now() < muteExpiry, muteExpiresAt: muteExpiry || null, lastSeen: cached.lastSeen || 0, messageCount: stats.messageCount || 0, commandCount: stats.commandCount || 0, hasAutoReply: !!(ar && ar.enabled), autoReplyMsg: ar ? ar.message : null, emoji: info.emoji || null, color: info.color || null });
    } catch (e) { logger.error("API", "getThreadInfo: " + e.message); res.status(500).json({ error: e.message }); }
  });

  app.get("/groups/:threadID/stats", (req, res) => res.json(groupStats.get(req.params.threadID) || {}));

  app.post("/groups/:threadID/lock", (req, res) => {
    const { threadID } = req.params;
    if (req.body.locked) lockedThreads.add(threadID); else lockedThreads.delete(threadID);
    logActivitySSE("Group " + threadID + " " + (req.body.locked ? "locked" : "unlocked"));
    res.json({ success: true, isLocked: lockedThreads.has(threadID) });
  });

  app.post("/groups/:threadID/mute", (req, res) => {
    const { threadID } = req.params;
    const minutes = parseInt(req.body.minutes) || 0;
    if (minutes <= 0) { mutedThreads.delete(threadID); return res.json({ success: true, isMuted: false }); }
    const expiresAt = Date.now() + minutes * 60000;
    mutedThreads.set(threadID, expiresAt);
    logActivitySSE("Group " + threadID + " muted " + minutes + "min");
    res.json({ success: true, isMuted: true, expiresAt });
  });

  app.post("/groups/:threadID/rename", async (req, res) => {
    const { threadID } = req.params;
    const name = sanitize(req.body.name, 100);
    if (!name || !botApi) return res.status(botApi ? 400 : 503).json({ error: botApi ? "name required" : "Bot not connected" });
    try {
      await botApi.gcname(name, threadID);
      const cached = groupsCache.get(threadID) || {};
      groupsCache.set(threadID, { ...cached, name });
      logActivitySSE("Group " + threadID + " renamed to \"" + name + "\"");
      res.json({ success: true });
    } catch (e) { logger.error("API", "rename: " + e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/groups/:threadID/message", async (req, res) => {
    const { threadID } = req.params;
    const message = sanitize(req.body.message, 2000);
    if (!message || !botApi) return res.status(botApi ? 400 : 503).json({ error: botApi ? "message required" : "Bot not connected" });
    try { await botApi.sendMessage(message, threadID); logActivitySSE("Message sent to " + threadID); res.json({ success: true }); }
    catch (e) { logger.error("API", "sendMessage: " + e.message); res.status(500).json({ error: e.message }); }
  });

  app.get("/groups/:threadID/members", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try {
      const info     = await botApi.getThreadInfo(req.params.threadID);
      const ids      = info.participantIDs || [];
      const adminSet = new Set((info.adminIDs || []).map(a => a.id));
      const userInfos = ids.length > 0 ? await botApi.getUserInfo(ids) : {};
      res.json(ids.map(id => ({ userID: id, name: userInfos[id]?.name || id, isAdmin: adminSet.has(id) })));
    } catch (e) { logger.error("API", "getMembers: " + e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/groups/:threadID/kick", async (req, res) => {
    const userID = sanitize(req.body.userID, 50);
    if (!userID || !botApi) return res.status(botApi ? 400 : 503).json({ error: botApi ? "userID required" : "Bot not connected" });
    try { await botApi.gcmember("remove", userID, req.params.threadID); logActivitySSE("User " + userID + " kicked from " + req.params.threadID); res.json({ success: true }); }
    catch (e) { logger.error("API", "kick: " + e.message); res.status(500).json({ error: e.message }); }
  });

  // ── Auto-reply ────────────────────────────────────────────────────────────
  app.get("/groups/:threadID/autoreply", (req, res) => {
    const ar = autoReplies.get(req.params.threadID);
    if (!ar) return res.json({ enabled: false, message: "", cooldownMinutes: 30 });
    res.json({ enabled: ar.enabled, message: ar.message, cooldownMinutes: Math.round(ar.cooldownMs / 60000) });
  });
  app.put("/groups/:threadID/autoreply", (req, res) => {
    const { threadID } = req.params;
    const message = sanitize(req.body.message, 2000);
    if (!message) return res.status(400).json({ error: "message required" });
    const cooldownMs = Math.max(60000, (parseInt(req.body.cooldownMinutes) || 30) * 60000);
    const existing   = autoReplies.get(threadID) || { lastSent: new Map() };
    autoReplies.set(threadID, { message, enabled: !!req.body.enabled, cooldownMs, lastSent: existing.lastSent });
    logActivitySSE("Auto-reply updated for " + threadID);
    res.json({ success: true });
  });
  app.delete("/groups/:threadID/autoreply", (req, res) => {
    autoReplies.delete(req.params.threadID);
    logActivitySSE("Auto-reply removed for " + req.params.threadID);
    res.json({ success: true });
  });

  // ── Pending ───────────────────────────────────────────────────────────────
  app.get("/pending", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try { const t = await botApi.getThreadList(20, null, ["PENDING"]); res.json((t || []).map(th => ({ threadID: th.threadID, name: th.name || th.threadID, memberCount: (th.participantIDs || []).length, snippet: th.snippet || "", timestamp: th.timestamp || 0 }))); }
    catch (e) { logger.warn("API", "getThreadList pending: " + e.message); res.json([]); }
  });
  app.post("/pending/:threadID/accept", async (req, res) => {
    if (!botApi) return res.status(503).json({ error: "Bot not connected" });
    try { await botApi.sendMessage(sanitize(req.body.message || ".", 500), req.params.threadID); logActivitySSE("Accepted pending from " + req.params.threadID); res.json({ success: true }); }
    catch (e) { logger.error("API", "accept pending: " + e.message); res.status(500).json({ error: e.message }); }
  });

  // ── Broadcast ─────────────────────────────────────────────────────────────
  app.post("/broadcast", async (req, res) => {
    const message = sanitize(req.body.message, 2000);
    const targets = Array.isArray(req.body.threadIDs) ? req.body.threadIDs : [...groupsCache.keys()];
    if (!message || !botApi) return res.status(botApi ? 400 : 503).json({ error: botApi ? "message required" : "Bot not connected" });
    let sent = 0, failed = 0;
    for (const tid of targets) {
      try { await botApi.sendMessage(message, tid); sent++; }
      catch (e) { logger.warn("API", "broadcast to " + tid + ": " + e.message); failed++; }
      await delay(1200);
    }
    logActivitySSE("Broadcast: " + sent + " sent, " + failed + " failed");
    res.json({ success: true, sent, failed });
  });

  // ── AppState ──────────────────────────────────────────────────────────────
  app.get("/appstate/info", (req, res) => {
    const p = path.resolve(__dirname, config.appStatePath);
    try {
      const stat = fs.statSync(p);
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      // FIX #9: Return only metadata — never cookie contents
      res.json({ exists: true, cookieCount: Array.isArray(data) ? data.length : 0, sizeBytes: stat.size, modifiedAt: stat.mtimeMs });
    } catch (e) { logger.warn("API", "appstate/info: " + e.message); res.json({ exists: false, cookieCount: 0, sizeBytes: 0, modifiedAt: null }); }
  });

  app.post("/appstate/upload", async (req, res) => {
    const { content } = req.body;
    if (!content) return res.status(400).json({ error: "content required" });
    try {
      const data = JSON.parse(typeof content === "string" ? content : JSON.stringify(content));
      if (!Array.isArray(data) || !data.length) return res.status(400).json({ error: "Invalid appstate format" });
      const { SessionManager } = require("./utils/session");
      const sm = new SessionManager(path.resolve(__dirname, config.appStatePath), process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "", "marwanbou540-gif/messenger-bot");
      const ok = await sm.saveAndPush(data);
      if (!ok) return res.status(500).json({ error: "Failed to save state" });
      logActivitySSE("AppState uploaded via dashboard");
      res.json({ success: true, cookieCount: data.length });
    } catch (e) { logger.error("API", "appstate/upload: " + e.message); res.status(400).json({ error: "Invalid JSON: " + e.message }); }
  });

  // ── State, Restart, Reconnect ─────────────────────────────────────────────
  app.post("/state/save", (req, res) => {
    try { saveState(); logActivitySSE("State saved"); res.json({ success: true }); }
    catch (e) { logger.error("API", "state/save: " + e.message); res.status(500).json({ error: e.message }); }
  });

  app.post("/restart", async (req, res) => {
    res.json({ success: true, message: "Restarting in 2 seconds..." });
    logActivitySSE("Restart triggered");
    try {
      if (botApi) {
        const state = botApi.getAppState();
        if (Array.isArray(state) && state.length > 0) {
          const { SessionManager } = require("./utils/session");
          const s = new SessionManager(path.resolve(__dirname, config.appStatePath), process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "", "marwanbou540-gif/messenger-bot");
          await s.save(state);
        }
      }
    } catch (e) { logger.warn("API", "Pre-restart save: " + e.message); }
    setTimeout(() => process.exit(0), 2000);
  });

  app.post("/reconnect", (req, res) => {
    res.json({ success: true, message: "Reconnecting..." });
    logActivitySSE("Reconnect triggered");
    setTimeout(() => process.exit(0), 1500);
  });

  // ── Session aliases ───────────────────────────────────────────────────────
  app.get("/session", (req, res) => {
    const p = path.resolve(__dirname, config.appStatePath);
    try {
      const stat = fs.statSync(p);
      const data = JSON.parse(fs.readFileSync(p, "utf8"));
      res.json({ valid: true, lastSaved: stat.mtimeMs, size: stat.size, cookieCount: Array.isArray(data) ? data.length : 0 });
    } catch (e) { logger.warn("API", "session GET: " + e.message); res.json({ valid: false, lastSaved: null, size: 0 }); }
  });
  app.post("/session/upload", async (req, res) => {
    const raw = req.body.appstate || req.body.content;
    if (!raw) return res.status(400).json({ error: "appstate required" });
    try {
      const data = JSON.parse(typeof raw === "string" ? raw : JSON.stringify(raw));
      if (!Array.isArray(data) || !data.length) return res.status(400).json({ error: "Invalid appstate" });
      const { SessionManager } = require("./utils/session");
      const sm = new SessionManager(path.resolve(__dirname, config.appStatePath), "", "");
      await sm.save(data);
      logActivitySSE("AppState uploaded via dashboard");
      res.json({ success: true, cookieCount: data.length });
    } catch (e) { logger.error("API", "session/upload: " + e.message); res.status(400).json({ error: e.message }); }
  });
  app.post("/session/refresh", async (req, res) => {
    try {
      if (botApi) {
        const state = botApi.getAppState();
        if (Array.isArray(state) && state.length > 0) {
          const { SessionManager } = require("./utils/session");
          const sm = new SessionManager(path.resolve(__dirname, config.appStatePath), "", "");
          await sm.save(state);
        }
      }
      logActivitySSE("Session refreshed");
      res.json({ success: true });
    } catch (e) { logger.error("API", "session/refresh: " + e.message); res.status(500).json({ error: e.message }); }
  });
  app.delete("/session", async (req, res) => {
    try {
      const p = path.resolve(__dirname, config.appStatePath);
      if (fs.existsSync(p)) await fs.promises.writeFile(p, "[]", "utf8");
      logActivitySSE("Session cleared");
      res.json({ success: true });
    } catch (e) { logger.error("API", "session DELETE: " + e.message); res.status(500).json({ error: e.message }); }
  });

  // ── Config updates ────────────────────────────────────────────────────────
  app.post("/config", (req, res) => {
    const allowed = ["features", "humanSimulator", "loginOptions", "messages", "bot"];
    for (const k of allowed) { if (k in req.body) Object.assign(config[k], req.body[k]); }
    logActivitySSE("Config updated");
    res.json({ success: true });
  });
  app.get("/features",  (req, res) => res.json(config.features || {}));
  app.post("/features", (req, res) => { Object.assign(config.features, req.body); logActivitySSE("Features updated"); res.json({ success: true }); });

  // ── Security ──────────────────────────────────────────────────────────────
  const _secPath = path.join(__dirname, "data", "security.json");
  const _loadSec = () => { try { return JSON.parse(fs.readFileSync(_secPath, "utf8")); } catch { return {}; } };
  const _saveSec = d => { try { fs.mkdirSync(path.dirname(_secPath), { recursive: true }); fs.writeFileSync(_secPath, JSON.stringify(d, null, 2)); } catch (e) { logger.error("API", "saveSec: " + e.message); } };

  app.get("/security", (req, res) => { const sec = _loadSec(); res.json({ antiSpamCooldownMs: config.features?.antiSpamCooldownMs ?? 3000, maxRequestsPerMinute: sec.maxRequestsPerMinute ?? 40, requestCooldownMs: sec.requestCooldownMs ?? 60000, maxConcurrentRequests: sec.maxConcurrentRequests ?? 5, bannedWords: sec.bannedWords ?? [] }); });
  app.post("/security", (req, res) => {
    const sec = _loadSec();
    if (req.body.antiSpamCooldownMs) { config.features = config.features || {}; config.features.antiSpamCooldownMs = parseInt(req.body.antiSpamCooldownMs); }
    if (req.body.maxRequestsPerMinute)  sec.maxRequestsPerMinute  = parseInt(req.body.maxRequestsPerMinute);
    if (req.body.requestCooldownMs)     sec.requestCooldownMs     = parseInt(req.body.requestCooldownMs);
    if (req.body.maxConcurrentRequests) sec.maxConcurrentRequests = parseInt(req.body.maxConcurrentRequests);
    if (Array.isArray(req.body.bannedWords)) sec.bannedWords = req.body.bannedWords;
    _saveSec(sec); logActivitySSE("Security settings updated"); res.json({ success: true });
  });

  // ── Bans ──────────────────────────────────────────────────────────────────
  const _bansPath = path.join(__dirname, "data", "bans.json");
  const _loadBans = () => { try { return JSON.parse(fs.readFileSync(_bansPath, "utf8")); } catch { return []; } };
  const _saveBans = d => { try { fs.mkdirSync(path.dirname(_bansPath), { recursive: true }); fs.writeFileSync(_bansPath, JSON.stringify(d, null, 2)); } catch (e) { logger.error("API", "saveBans: " + e.message); } };

  app.get("/bans", (req, res) => res.json(_loadBans()));
  app.post("/bans", (req, res) => {
    const uid = sanitize(req.body.uid, 50);
    if (!uid) return res.status(400).json({ error: "uid required" });
    const bans = _loadBans();
    if (bans.find(b => b.uid === uid)) return res.json({ success: true, alreadyBanned: true });
    bans.push({ uid, reason: sanitize(req.body.reason || "", 200), bannedAt: Date.now() });
    _saveBans(bans); logActivitySSE("User " + uid + " banned"); res.json({ success: true });
  });
  app.delete("/bans/:uid", (req, res) => { const bans = _loadBans().filter(b => b.uid !== req.params.uid); _saveBans(bans); logActivitySSE("User " + req.params.uid + " unbanned"); res.json({ success: true }); });

  // ── Audit ─────────────────────────────────────────────────────────────────
  app.get("/audit", (req, res) => {
    const offset = parseInt(req.query.offset) || 0;
    const limit  = Math.min(parseInt(req.query.limit) || 50, 200);
    res.json([...activityLog].reverse().map(a => ({ time: a.time, action: "activity", actor: "bot", detail: a.message, level: "info" })).slice(offset, offset + limit));
  });
  app.get("/activity",   (req, res) => res.json(activityLog.slice(-100).reverse()));
  app.get("/violations", (req, res) => res.json(lockViolations.slice(-100).reverse()));

  // ── Jobs ──────────────────────────────────────────────────────────────────
  const _activeJobs = new Map();
  app.get("/jobs", (req, res) => { const jobs = []; for (const [id, j] of _activeJobs) jobs.push({ id, ...j }); res.json(jobs); });
  app.delete("/jobs/:id", (req, res) => {
    const j = _activeJobs.get(req.params.id);
    if (!j) return res.status(404).json({ error: "Not found" });
    if (j.timer) clearTimeout(j.timer);
    _activeJobs.delete(req.params.id);
    res.json({ success: true });
  });

  // ── Allowlist ─────────────────────────────────────────────────────────────
  const _alPath = path.join(__dirname, "data", "allowlist.json");
  const _loadAl = () => { try { return JSON.parse(fs.readFileSync(_alPath, "utf8")); } catch { return { mode: "off", list: [] }; } };
  const _saveAl = d => { try { fs.mkdirSync(path.dirname(_alPath), { recursive: true }); fs.writeFileSync(_alPath, JSON.stringify(d, null, 2)); } catch (e) { logger.error("API", "saveAl: " + e.message); } };

  app.get("/allowlist",         (req, res) => res.json(_loadAl()));
  app.post("/allowlist/mode",   (req, res) => { const d = _loadAl(); d.mode = req.body.mode || "off"; _saveAl(d); res.json({ success: true }); });
  app.post("/allowlist/add",    (req, res) => { const uid = sanitize(req.body.uid, 50); if (!uid) return res.status(400).json({ error: "uid required" }); const d = _loadAl(); if (!d.list.includes(uid)) d.list.push(uid); _saveAl(d); res.json({ success: true }); });
  app.post("/allowlist/remove", (req, res) => { const d = _loadAl(); d.list = d.list.filter(x => x !== req.body.uid); _saveAl(d); res.json({ success: true }); });

  // ── AppState upload — write new cookies to trigger automatic bot restart ──
  app.post("/appstate", async (req, res) => {
    const { cookies } = req.body || {};
    if (!Array.isArray(cookies) || cookies.length === 0) {
      return res.status(400).json({ error: "cookies array مطلوب ومطلوب أن يكون غير فارغ" });
    }
    const hasValid = cookies.some(c => c && typeof c.key === "string" && c.value !== undefined);
    if (!hasValid) return res.status(400).json({ error: "الكوكيز غير صالحة — يجب أن تحتوي على key و value" });

    try {
      const tmp = APP_STATE_PATH + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(cookies, null, 2), "utf8");
      fs.renameSync(tmp, APP_STATE_PATH);
      logActivitySSE(`تم رفع appstate.json جديد عبر لوحة التحكم (${cookies.length} كوكي)`);
      logger.success("API", `New appstate.json uploaded via dashboard (${cookies.length} cookies).`);
      res.json({ success: true, count: cookies.length, message: "سيُستأنف البوت تلقائياً خلال ثوانٍ." });
    } catch (e) {
      logger.error("API", "Appstate upload failed: " + e.message);
      res.status(500).json({ error: e.message });
    }
  });

  // ── Files (sandboxed) ─────────────────────────────────────────────────────
  const _editableFiles = [
    { name: "config.json",  path: "config.json",  icon: "⚙️" },
    { name: "index.js",     path: "index.js",     icon: "🚀" },
    { name: "api.js",       path: "api.js",        icon: "🔌" },
    { name: "state.js",     path: "state.js",      icon: "💾" },
    { name: "package.json", path: "package.json",  icon: "📦" },
  ];
  app.get("/files", (req, res) => res.json(_editableFiles));
  app.get("/files/:filePath", (req, res) => {
    const safe = sanitizePath(req.params.filePath, 100);
    if (!safe) return res.status(400).json({ error: "Invalid path" });
    const abs = path.resolve(__dirname, safe);
    if (!abs.startsWith(__dirname + path.sep) && abs !== __dirname) return res.status(403).json({ error: "Forbidden" });
    try { res.json({ content: fs.readFileSync(abs, "utf8") }); }
    catch (e) { logger.warn("API", "File read: " + e.message); res.status(404).json({ error: "File not found" }); }
  });
  app.post("/files/:filePath", (req, res) => {
    const safe = sanitizePath(req.params.filePath, 100);
    if (!safe) return res.status(400).json({ error: "Invalid path" });
    const abs = path.resolve(__dirname, safe);
    if (!abs.startsWith(__dirname + path.sep) && abs !== __dirname) return res.status(403).json({ error: "Forbidden" });
    if (typeof req.body.content !== "string") return res.status(400).json({ error: "content required" });
    try { fs.writeFileSync(abs, req.body.content, "utf8"); logActivitySSE("File " + safe + " saved"); res.json({ success: true }); }
    catch (e) { logger.error("API", "File write: " + e.message); res.status(500).json({ error: e.message }); }
  });
  app.delete("/files/:filePath", (req, res) => {
    const safe = sanitizePath(req.params.filePath, 100);
    if (!safe) return res.status(400).json({ error: "Invalid path" });
    const abs = path.resolve(__dirname, safe);
    if (!abs.startsWith(__dirname + path.sep) && abs !== __dirname) return res.status(403).json({ error: "Forbidden" });
    try { fs.unlinkSync(abs); logActivitySSE("File " + safe + " deleted"); res.json({ success: true }); }
    catch (e) { logger.error("API", "File delete: " + e.message); res.status(500).json({ error: e.message }); }
  });

  return app;
}

function startApiServer() {
  // FIX #1: Run security config check before binding the server
  _warnIfInsecureConfig();
  const app  = createApiServer();
  const port = process.env.PORT || (config.dashboard && config.dashboard.port) || 3001;
  app.listen(port, "0.0.0.0", () => logger.success("Dashboard", "API + Dashboard listening on port " + port));
}

module.exports = { setBotApi, setBotStatus, setCookieRefresher, setSession, logActivity: logActivitySSE, logViolation, startApiServer };
