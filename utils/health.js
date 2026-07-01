"use strict";

/**
 * health.js — process health watchdog
 *
 * FIX #7: Integrated alert hooks.
 * Calls onCritical for memory/loop issues as before.
 * Also exposes recordLoginFailure() / recordLoginSuccess() and
 * recordMqttStale() so index.js can push critical events here
 * and have them forwarded to alertManager.
 */

const os     = require("os");
const logger = require("./logger");

const MEM_WARN_MB    = 400;
const MEM_CRIT_MB    = 700;
const LOOP_WARN_MS   = 500;
const LOOP_CRIT_MS   = 3000;
const CHECK_INTERVAL = 30000;

let _onCritical  = null;
let _diagnostics = null;
let _lastReport  = null;

// Login failure tracking
let _loginFailures = 0;
const LOGIN_ALERT_AT = 3;

// MQTT stale tracking
let _mqttStaleAlerted = false;

function _memMB()  { return Math.round(process.memoryUsage().rss / 1024 / 1024); }
function _cpuPct() {
  const cpus = os.cpus();
  let idle = 0, total = 0;
  for (const c of cpus) { for (const t of Object.values(c.times)) total += t; idle += c.times.idle; }
  return total ? ((1 - idle / total) * 100) : 0;
}
function _loopLag() {
  return new Promise(resolve => {
    const t = process.hrtime.bigint();
    setImmediate(() => resolve(Number(process.hrtime.bigint() - t) / 1e6));
  });
}

async function check() {
  const memMB     = _memMB();
  const cpuPct    = _cpuPct();
  const loopLagMs = await _loopLag();

  _lastReport = { memMB, cpuPct: +cpuPct.toFixed(1), loopLagMs: +loopLagMs.toFixed(1), ts: Date.now() };
  if (_diagnostics) _diagnostics.recordHealth(_lastReport);

  if (memMB >= MEM_CRIT_MB) {
    logger.error("Health", `CRITICAL memory: ${memMB} MB (limit ${MEM_CRIT_MB} MB)`);
    if (_onCritical) _onCritical("memory_critical", _lastReport);
  } else if (memMB >= MEM_WARN_MB) {
    logger.warn("Health", `High memory: ${memMB} MB`);
  }

  if (loopLagMs >= LOOP_CRIT_MS) {
    logger.error("Health", `CRITICAL event-loop lag: ${loopLagMs.toFixed(0)} ms`);
    if (_onCritical) _onCritical("loop_critical", _lastReport);
  } else if (loopLagMs >= LOOP_WARN_MS) {
    logger.warn("Health", `High event-loop lag: ${loopLagMs.toFixed(0)} ms`);
  }

  if (cpuPct > 90) logger.warn("Health", `High CPU: ${cpuPct.toFixed(1)}%`);
  logger.debug("Health", `RAM ${memMB} MB | Loop ${loopLagMs.toFixed(0)} ms | CPU ${cpuPct.toFixed(1)}%`);
  return _lastReport;
}

function start({ onCritical, diagnostics } = {}) {
  _onCritical  = onCritical  || null;
  _diagnostics = diagnostics || null;
  const t = setInterval(() => check().catch(e => logger.warn("Health", `Check failed: ${e.message}`)), CHECK_INTERVAL);
  t.unref();
  check().catch(() => {});
  logger.info("Health", `Watchdog started — checks every ${CHECK_INTERVAL / 1000}s`);
}

function snapshot() {
  return _lastReport || { memMB: _memMB(), cpuPct: +_cpuPct().toFixed(1), loopLagMs: 0, ts: Date.now() };
}

// ── FIX #7: Login failure tracking ───────────────────────────────────────────
/**
 * Call from index.js each time a login attempt fails.
 * Fires an alert via alertManager when LOGIN_ALERT_AT threshold is reached.
 */
async function recordLoginFailure() {
  _loginFailures++;
  logger.warn("Health", `Login failure count: ${_loginFailures}`);
  try {
    await require("./alertManager").recordFailure("login",
      `محاولة رقم ${_loginFailures} — راجع appstate.json`
    );
  } catch {}
}

/**
 * Call from index.js on successful login. Resets counters.
 */
function recordLoginSuccess() {
  if (_loginFailures > 0) {
    logger.success("Health", `Login succeeded after ${_loginFailures} failure(s) — resetting counter.`);
    _loginFailures = 0;
    try { require("./alertManager").clearFailures("login"); } catch {}
  }
}

// ── FIX #7: MQTT stale alert ──────────────────────────────────────────────────
/**
 * Call from index.js when the MQTT watchdog detects a stale connection
 * (no events for >10 minutes).
 */
async function recordMqttStale() {
  if (_mqttStaleAlerted) return; // rate-limit to once per outage
  _mqttStaleAlerted = true;
  logger.warn("Health", "MQTT stale alert fired.");
  try {
    await require("./alertManager").recordFailure("mqtt",
      "لم تصل أي أحداث من MQTT منذ أكثر من 10 دقائق"
    );
  } catch {}
}

function clearMqttStale() {
  _mqttStaleAlerted = false;
  try { require("./alertManager").clearFailures("mqtt"); } catch {}
}

module.exports = { start, snapshot, check, recordLoginFailure, recordLoginSuccess, recordMqttStale, clearMqttStale };
