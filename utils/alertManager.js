"use strict";

/**
 * alertManager.js — FIX #7
 *
 * Sends alerts to admin IDs (via bot API) or an external webhook when
 * critical failure thresholds are crossed:
 *   • login:       3 consecutive failures
 *   • mqtt:        stale connection >10 min (1 occurrence)
 *   • cookie_push: 3 consecutive GitHub push failures
 *
 * Design rules:
 *  - Never includes cookie contents, tokens, or API keys in any alert.
 *  - Rate-limits: at most 1 alert per type per 15 minutes.
 *  - Bot API reference is injected via setApi() after login succeeds.
 */

const https  = require("https");
const logger = require("./logger");

const THRESHOLDS = {
  login:       3,
  mqtt:        1,
  cookie_push: 3,
};
const ALERT_COOLDOWN_MS = 15 * 60 * 1000;   // 1 alert per type per 15 min

const _failures  = new Map();  // type → { count, lastAlertAt }
let _adminIDs    = [];
let _botApi      = null;
let _webhookUrl  = null;

function setApi(api, adminIDs, webhookUrl) {
  _botApi     = api || null;
  _adminIDs   = Array.isArray(adminIDs) ? adminIDs : [];
  _webhookUrl = webhookUrl || null;
  logger.debug("AlertMgr", `Configured — admins: ${_adminIDs.length}, webhook: ${!!_webhookUrl}`);
}

/**
 * Record a failure of a given type.
 * When the threshold is hit and cooldown has elapsed, fires an alert.
 */
async function recordFailure(type, detail = "") {
  const now = Date.now();
  const rec = _failures.get(type) || { count: 0, lastAlertAt: 0 };
  rec.count++;
  _failures.set(type, rec);

  const threshold  = THRESHOLDS[type] || 3;
  const inCooldown = now - rec.lastAlertAt < ALERT_COOLDOWN_MS;

  if (rec.count >= threshold && !inCooldown) {
    rec.lastAlertAt = now;
    _failures.set(type, rec);
    const msg = _buildMessage(type, rec.count, detail);
    await _sendAlert(type, msg);
  }
}

/**
 * Clear failure count for a type (call on success).
 */
function clearFailures(type) {
  if (_failures.has(type)) {
    _failures.get(type).count = 0;
    logger.debug("AlertMgr", `Failures cleared for type: ${type}`);
  }
}

function _buildMessage(type, count, detail) {
  const ts = new Date().toISOString().replace("T", " ").slice(0, 19);
  const labels = {
    login:       `🚨 تحذير: فشل تسجيل الدخول ${count} مرات متتالية`,
    mqtt:        `🚨 تحذير: MQTT متوقف منذ أكثر من 10 دقائق`,
    cookie_push: `⚠️ تحذير: فشل رفع الكوكيز إلى GitHub ${count} مرات متتالية`,
  };
  const label = labels[type] || `⚠️ تحذير: ${type} — ${count} إخفاقات`;
  return `${label}\nالوقت: ${ts}${detail ? "\n" + detail : ""}`;
}

async function _sendAlert(type, message) {
  logger.warn("AlertMgr", `Alert [${type}]: ${message.split("\n")[0]}`);

  // 1. Send to admin IDs via bot API
  if (_botApi && _adminIDs.length > 0) {
    for (const uid of _adminIDs) {
      try {
        await _botApi.sendMessage(message, uid);
        logger.debug("AlertMgr", `Alert sent to admin ${uid}`);
      } catch (e) {
        logger.warn("AlertMgr", `Failed to send alert to ${uid}: ${e.message}`);
      }
    }
  }

  // 2. Send to external webhook if configured
  if (_webhookUrl) {
    await _postWebhook(_webhookUrl, { type, message, ts: Date.now() }).catch(e =>
      logger.warn("AlertMgr", `Webhook failed: ${e.message}`)
    );
  }
}

function _postWebhook(url, payload) {
  return new Promise((resolve, reject) => {
    const body = Buffer.from(JSON.stringify(payload), "utf8");
    try {
      const u = new URL(url);
      const req = https.request({
        hostname: u.hostname,
        path:     u.pathname + u.search,
        method:   "POST",
        headers:  { "Content-Type": "application/json", "Content-Length": body.length },
      }, res => { res.resume(); resolve(); });
      req.setTimeout(8000, () => req.destroy(new Error("webhook timeout")));
      req.on("error", reject);
      req.write(body);
      req.end();
    } catch (e) { reject(e); }
  });
}

module.exports = { setApi, recordFailure, clearFailures };
