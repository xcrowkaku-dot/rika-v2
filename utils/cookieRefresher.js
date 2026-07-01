"use strict";

/**
 * cookieRefresher.js
 *
 * Automatically saves and pushes Facebook session cookies to GitHub
 * every INTERVAL_MS. Uses SHA-1 change detection to avoid redundant pushes.
 *
 * FIX #3: Adaptive backoff — call setBackoffLevel(n) to reduce push frequency:
 *   0 → normal (4 min interval)
 *   1 → 8 min interval
 *   2 → 20 min interval (still saves locally, GitHub push deprioritised)
 *
 * FIX #7: Records consecutive push failures and notifies alertManager when
 *   3 pushes fail in a row.
 */

const crypto  = require("crypto");
const logger  = require("./logger");

const BASE_INTERVAL_MS  = 4 * 60 * 1000;
const FIRST_TICK        = 30 * 1000;
const MIN_PUSH_GAP      = 60 * 1000;

let _timer           = null;
let _firstTimer      = null;
let _api             = null;
let _session         = null;
let _backoffLevel    = 0;        // 0=normal 1=2× 2=5×
let _consecPushFails = 0;        // consecutive GitHub push failures for alert tracking

let _lastHash   = null;
let _lastPushAt = 0;
let _pushCount  = 0;
let _skipCount  = 0;
let _errorCount = 0;
let _startedAt  = 0;

function _intervalMs() {
  const multipliers = [1, 2, 5];
  return BASE_INTERVAL_MS * (multipliers[_backoffLevel] || 1);
}

function _hashState(state) {
  try { return crypto.createHash("sha1").update(JSON.stringify(state)).digest("hex"); } catch { return null; }
}

async function _tick() {
  if (!_api || !_session) return;
  let state;
  try {
    state = _api.getAppState();
  } catch (e) {
    _errorCount++;
    logger.warn("CookieRefresher", "getAppState() failed: " + e.message);
    return;
  }
  if (!Array.isArray(state) || state.length === 0) { logger.debug("CookieRefresher", "State empty — skipping."); return; }

  const hash    = _hashState(state);
  const now     = Date.now();
  const changed = hash && hash !== _lastHash;
  const gapOk   = now - _lastPushAt >= MIN_PUSH_GAP;

  if (!changed) { _skipCount++; logger.debug("CookieRefresher", "No change (skip #" + _skipCount + ")."); return; }
  if (!gapOk)   { logger.debug("CookieRefresher", "Min push gap not met — skipping."); return; }

  try {
    const saved = await _session.saveAndPush(state);
    if (saved) {
      _lastHash        = hash;
      _lastPushAt      = now;
      _pushCount++;
      _consecPushFails = 0;
      // FIX #7: clear failure counter on success
      try { require("./alertManager").clearFailures("cookie_push"); } catch {}
      logger.success("CookieRefresher", `Cookies saved & pushed (push #${_pushCount} | ${state.length} entries | backoff:${_backoffLevel})`);
    } else {
      _errorCount++;
      _consecPushFails++;
      logger.warn("CookieRefresher", "saveAndPush returned false.");
      // FIX #7: alert on 3 consecutive failures
      _maybeAlert();
    }
  } catch (e) {
    _errorCount++;
    _consecPushFails++;
    logger.warn("CookieRefresher", "Push failed: " + e.message);
    _maybeAlert();
  }
}

function _maybeAlert() {
  try {
    require("./alertManager").recordFailure("cookie_push",
      `إخفاقات GitHub المتتالية: ${_consecPushFails}`
    );
  } catch {}
}

// ── Public API ────────────────────────────────────────────────────────────────

function start(api, session) {
  stop();
  _api             = api;
  _session         = session;
  _lastHash        = null;
  _lastPushAt      = 0;
  _pushCount       = 0;
  _skipCount       = 0;
  _errorCount      = 0;
  _consecPushFails = 0;
  _startedAt       = Date.now();

  _firstTimer = setTimeout(() => {
    _firstTimer = null;
    _tick().catch(e => logger.warn("CookieRefresher", "First tick error: " + e.message));
    _timer = setInterval(
      () => _tick().catch(e => logger.warn("CookieRefresher", "Tick error: " + e.message)),
      _intervalMs()
    );
    if (_timer.unref) _timer.unref();
  }, FIRST_TICK);
  if (_firstTimer.unref) _firstTimer.unref();

  logger.info("CookieRefresher", `Started — first push in ${FIRST_TICK / 1000}s, then every ${_intervalMs() / 60000}min (backoff:${_backoffLevel})`);
}

function stop() {
  if (_firstTimer) { clearTimeout(_firstTimer);  _firstTimer = null; }
  if (_timer)      { clearInterval(_timer);       _timer      = null; }
  _api     = null;
  _session = null;
}

async function forceRefresh() {
  if (!_api || !_session) throw new Error("CookieRefresher not running.");
  _lastHash = null;
  await _tick();
  return status();
}

/**
 * FIX #3: Adaptive backoff.
 * level 0 = 4 min | 1 = 8 min | 2 = 20 min
 */
function setBackoffLevel(level) {
  const newLevel = Math.max(0, Math.min(2, level));
  if (newLevel === _backoffLevel) return;
  _backoffLevel = newLevel;
  logger.info("CookieRefresher", `Backoff level set to ${newLevel} — interval ${_intervalMs() / 60000}min`);
  // Restart interval so new period takes effect immediately
  if (_timer) {
    clearInterval(_timer);
    _timer = setInterval(
      () => _tick().catch(e => logger.warn("CookieRefresher", "Tick error: " + e.message)),
      _intervalMs()
    );
    if (_timer.unref) _timer.unref();
  }
}

function clearBackoff() { setBackoffLevel(0); }

function status() {
  return {
    active:          !!_timer || !!_firstTimer,
    backoffLevel:    _backoffLevel,
    intervalMinutes: _intervalMs() / 60000,
    firstTickSec:    FIRST_TICK / 1000,
    pushCount:       _pushCount,
    skipCount:       _skipCount,
    errorCount:      _errorCount,
    consecPushFails: _consecPushFails,
    lastPushAt:      _lastPushAt || null,
    uptimeSec:       _startedAt ? Math.floor((Date.now() - _startedAt) / 1000) : 0,
  };
}

module.exports = { start, stop, forceRefresh, status, setBackoffLevel, clearBackoff };
