"use strict";

/**
 * humanSimulator — makes the bot account look like a real human to Facebook.
 *
 * FIX #3: Adaptive backoff support.
 * Call setBackoffLevel(n) to slow all intervals:
 *   0 → normal (default)
 *   1 → 2× intervals (3+ consecutive login failures)
 *   2 → 4× intervals, browse disabled (5+ failures — stealth mode)
 *
 * Returns to level 0 automatically when clearBackoff() is called after
 * a stable login session (defined as 10+ minutes online).
 */

const logger = require("./logger");

const DEFAULT_CONFIG = {
  enabled:             true,
  presenceIntervalMs:  5  * 60_000,
  typingIntervalMs:    12 * 60_000,
  readIntervalMs:      4  * 60_000,
  browseIntervalMs:    18 * 60_000,
  jitterMs:            45_000,
  maxTypingMs:         5_000,
  maxGroupsPerCycle:   3,
  browseBatchSize:     6,
};

let _api          = null;
let _cfg          = { ...DEFAULT_CONFIG };
let _timers       = [];
let _running      = false;
let _backoffLevel = 0;   // 0=normal 1=2× 2=4×
let _stats        = {
  startedAt:       null,
  presenceSent:    0,
  typingSimulated: 0,
  threadsRead:     0,
  browseSessions:  0,
  lastActionAt:    null,
  lastActionType:  null,
  backoffLevel:    0,
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _multiplier() {
  // backoff level: 0→1×, 1→2×, 2→4×
  return Math.pow(2, _backoffLevel);
}

function _jitter(baseMs) {
  const j = _cfg.jitterMs || 45_000;
  return Math.max(5_000, baseMs * _multiplier() + Math.floor((Math.random() * 2 - 1) * j));
}

function _randomGroupIDs(max) {
  try {
    const { groupsCache } = require("../state");
    const ids = [...groupsCache.keys()];
    if (ids.length === 0) return [];
    return ids.sort(() => Math.random() - 0.5).slice(0, max);
  } catch { return []; }
}

function _sleep(minMs, maxMs = minMs) {
  return new Promise(r => setTimeout(r, minMs + Math.floor(Math.random() * (maxMs - minMs))));
}

function _record(type) {
  _stats.lastActionAt   = Date.now();
  _stats.lastActionType = type;
}

function _schedule(fn, delayMs) {
  const t = setTimeout(fn, delayMs);
  t.unref();
  _timers.push(t);
}

// ── 1. Presence heartbeat ─────────────────────────────────────────────────────
function _doPresence() {
  _schedule(async () => {
    if (!_running || !_api) return;
    try {
      if (typeof _api.setOptions === "function") _api.setOptions({ online: true });
      _stats.presenceSent++;
      _record("presence");
      logger.debug("HumanSim", `Presence heartbeat #${_stats.presenceSent} (backoff×${_multiplier()})`);
    } catch (e) { logger.debug("HumanSim", `Presence error: ${e.message}`); }
    _doPresence();
  }, _jitter(_cfg.presenceIntervalMs));
}

// ── 2. Typing simulation ──────────────────────────────────────────────────────
function _doTyping() {
  _schedule(async () => {
    if (!_running || !_api) return;
    // At backoff level 2 skip typing — too risky
    if (_backoffLevel < 2) {
      const [threadID] = _randomGroupIDs(1);
      if (threadID) {
        try {
          const duration = 1_200 + Math.floor(Math.random() * _cfg.maxTypingMs);
          const stopFn   = await _api.sendTypingIndicator(threadID);
          await _sleep(duration);
          if (typeof stopFn === "function") stopFn();
          _stats.typingSimulated++;
          _record("typing");
          logger.debug("HumanSim", `Typing in ${threadID} for ${duration}ms`);
        } catch (e) { logger.debug("HumanSim", `Typing error: ${e.message}`); }
      }
    } else {
      logger.debug("HumanSim", "Typing skipped — backoff level 2.");
    }
    _doTyping();
  }, _jitter(_cfg.typingIntervalMs));
}

// ── 3. Mark threads as read ───────────────────────────────────────────────────
function _doRead() {
  _schedule(async () => {
    if (!_running || !_api) return;
    // Reduce read batch size at higher backoff levels
    const maxGroups = Math.max(1, Math.floor(_cfg.maxGroupsPerCycle / _multiplier()));
    for (const threadID of _randomGroupIDs(maxGroups)) {
      try {
        await _api.markAsRead(threadID, true);
        _stats.threadsRead++;
        _record("markRead");
        logger.debug("HumanSim", `Marked ${threadID} as read`);
        await _sleep(700, 2_500);
      } catch (e) { logger.debug("HumanSim", `markAsRead error: ${e.message}`); }
    }
    _doRead();
  }, _jitter(_cfg.readIntervalMs));
}

// ── 4. Browse session ─────────────────────────────────────────────────────────
function _doBrowse() {
  _schedule(async () => {
    if (!_running || !_api) return;
    // Skip browse sessions entirely at backoff level 2
    if (_backoffLevel >= 2) { logger.debug("HumanSim", "Browse skipped — backoff level 2."); _doBrowse(); return; }

    const batch = _randomGroupIDs(_cfg.browseBatchSize || 6);
    if (batch.length === 0) { _doBrowse(); return; }

    logger.debug("HumanSim", `Browse session — ${batch.length} threads (backoff×${_multiplier()})`);
    for (const threadID of batch) {
      if (!_running) break;
      try {
        await _api.markAsRead(threadID, true);
        _stats.threadsRead++;
        _record("browse");
        await _sleep(1_000, 5_000);
        if (Math.random() < 0.30) {
          try { const s = await _api.sendTypingIndicator(threadID); await _sleep(700, 2_200); if (typeof s === "function") s(); } catch {}
        }
        await _sleep(300, 1_500);
      } catch (e) { logger.debug("HumanSim", `Browse error: ${e.message}`); }
    }
    _stats.browseSessions++;
    _doBrowse();
  }, _jitter(_cfg.browseIntervalMs));
}

// ── Public API ────────────────────────────────────────────────────────────────
function start(api, userConfig = {}) {
  if (_running) stop();
  _api     = api;
  _cfg     = { ...DEFAULT_CONFIG, ...userConfig };
  _running = true;
  _timers  = [];
  _stats   = { startedAt: Date.now(), presenceSent: 0, typingSimulated: 0, threadsRead: 0, browseSessions: 0, lastActionAt: null, lastActionType: null, backoffLevel: _backoffLevel };

  const stagger = [
    [_doPresence,  60_000 + Math.floor(Math.random() * 30_000)],
    [_doTyping,   100_000 + Math.floor(Math.random() * 30_000)],
    [_doRead,      35_000 + Math.floor(Math.random() * 15_000)],
    [_doBrowse,   300_000 + Math.floor(Math.random() * 60_000)],
  ];
  for (const [fn, offset] of stagger) {
    const t = setTimeout(fn, offset); t.unref(); _timers.push(t);
  }

  logger.info("HumanSim", `Started — presence:${_cfg.presenceIntervalMs / 60_000}m typing:${_cfg.typingIntervalMs / 60_000}m read:${_cfg.readIntervalMs / 60_000}m browse:${_cfg.browseIntervalMs / 60_000}m backoff:${_backoffLevel}`);
}

function stop() {
  _running = false;
  for (const t of _timers) clearTimeout(t);
  _timers = [];
  logger.info("HumanSim", "Stopped.");
}

function configure(newConfig) {
  _cfg = { ..._cfg, ...newConfig };
  if (_running && _api) { stop(); start(_api, _cfg); }
}

/**
 * FIX #3: Adaptive backoff.
 * level 0 = normal | 1 = 2× intervals | 2 = 4× intervals + browse/typing disabled
 */
function setBackoffLevel(level) {
  const newLevel = Math.max(0, Math.min(2, level));
  if (newLevel === _backoffLevel) return;
  _backoffLevel = newLevel;
  _stats.backoffLevel = newLevel;
  logger.info("HumanSim", `Backoff level set to ${newLevel} (multiplier: ${_multiplier()}×)`);
  // Restart timers so new intervals take effect immediately
  if (_running && _api) { stop(); start(_api, _cfg); }
}

function clearBackoff() { setBackoffLevel(0); }

function status() {
  return { running: _running, backoffLevel: _backoffLevel, config: { ..._cfg }, stats: { ..._stats } };
}

module.exports = { start, stop, configure, status, setBackoffLevel, clearBackoff };
