"use strict";

/**
 * nickall.js — FIX #4: Safe rate-limited queue with status/stop support.
 *
 * Features:
 *  - One active operation per thread at a time.
 *  - Rate-limited: config.nickall.maxPerMinute (default 20) API calls/min.
 *  - `nickall status` — shows progress for the running operation.
 *  - `nickall stop`   — aborts immediately without reverting applied nicks.
 *  - `nickall unlock` — removes nick-lock from this thread.
 *  - `nickall clear`  — removes all nicks and locks in this thread.
 *  - `nickall lock <template>` — apply + lock nicks (enforced every 90 s).
 *  - `nickall <template>` — apply nicks without locking.
 *
 * Template variables: {name} {index} {id}
 */

const { lockedNicknames } = require("../utils/nicknameLocks");

// Per-thread operation state
// Map<threadID, { stop: boolean, done: number, failed: number, total: number, template: string, startedAt: number }>
const _activeOps = new Map();

function _buildNick(template, name, index, id) {
  return template
    .replace(/\{name\}/g,  name)
    .replace(/\{index\}/g, String(index))
    .replace(/\{id\}/g,    id);
}

function _delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function _getRateMs(config) {
  // config.nickall.maxPerMinute defaults to 20 → 3000 ms between calls
  const maxPerMin = (config.nickall && config.nickall.maxPerMinute) || 20;
  return Math.max(500, Math.floor(60000 / maxPerMin));
}

const USAGE = [
  "-nickall <كنية>              — تغيير كنيات الجميع",
  "-nickall lock <كنية>         — تغيير + قفل الكنيات",
  "-nickall unlock              — فك قفل الكنيات",
  "-nickall clear               — حذف الكنيات وأقفالها",
  "-nickall status              — عرض تقدم العملية الجارية",
  "-nickall stop                — إيقاف العملية الجارية فوراً",
  "",
  "متغيرات الكنية: {name} {index} {id}",
].join("\n");

module.exports = {
  name:        "nickall",
  aliases:     ["na", "allnick"],
  description: "تغيير كنيات جميع الأعضاء مع دعم القفل وإدارة الطابور.",
  usage:       USAGE,
  category:    "Group",
  groupOnly:   true,
  adminOnly:   true,

  async execute({ api, event, args }) {
    const sub      = (args[0] || "").toLowerCase();
    const threadID = event.threadID;
    let config;
    try { config = require("../config.json"); } catch { config = {}; }
    const prefix = config.prefix || "-";

    // ── status ────────────────────────────────────────────────────────────
    if (sub === "status") {
      const op = _activeOps.get(threadID);
      if (!op) return api.sendMessage("ℹ️ لا توجد عملية nickall جارية في هذه المجموعة.", threadID);
      const elapsed = Math.round((Date.now() - op.startedAt) / 1000);
      const pct     = op.total > 0 ? Math.round((op.done + op.failed) / op.total * 100) : 0;
      return api.sendMessage(
        `📊 تقدم nickall:\n` +
        `• الكنية: "${op.template}"\n` +
        `• نجح: ${op.done} | فشل: ${op.failed} | الكل: ${op.total}\n` +
        `• التقدم: ${pct}%\n` +
        `• الوقت المنقضي: ${elapsed}s`,
        threadID
      );
    }

    // ── stop ──────────────────────────────────────────────────────────────
    if (sub === "stop") {
      const op = _activeOps.get(threadID);
      if (!op) return api.sendMessage("ℹ️ لا توجد عملية nickall جارية.", threadID);
      op.stop = true;
      return api.sendMessage(
        `🛑 تم إصدار أمر الإيقاف.\n` +
        `• تم تطبيق: ${op.done} من أصل ${op.total}\n` +
        `الكنيات المطبقة تبقى دون تراجع.`,
        threadID
      );
    }

    // ── unlock ────────────────────────────────────────────────────────────
    if (sub === "unlock") {
      lockedNicknames.delete(threadID);
      return api.sendMessage("🔓 تم فك قفل الكنيات.", threadID);
    }

    // ── clear ─────────────────────────────────────────────────────────────
    if (sub === "clear") {
      if (_activeOps.has(threadID)) return api.sendMessage("⏳ عملية nickall جارية — استخدم `stop` أولاً.", threadID);
      lockedNicknames.delete(threadID);
      let info;
      try { info = await api.getThreadInfo(threadID); }
      catch (e) { return api.sendMessage("❌ فشل جلب المجموعة: " + e.message, threadID); }
      const ids   = info.participantIDs || [];
      const rateMs = _getRateMs(config);
      await api.sendMessage(`⏳ جارٍ حذف ${ids.length} كنية (معدل: ${Math.round(60000 / rateMs)}/دقيقة)...`, threadID);

      // Register op so `status` works during clear too
      const op = { stop: false, done: 0, failed: 0, total: ids.length, template: "(clear)", startedAt: Date.now() };
      _activeOps.set(threadID, op);
      try {
        for (const uid of ids) {
          if (op.stop) break;
          try { await api.nickname("", threadID, uid); op.done++; } catch { op.failed++; }
          await _delay(rateMs);
        }
      } finally { _activeOps.delete(threadID); }
      return api.sendMessage(`✅ حذف الكنيات: نجح ${op.done}، فشل ${op.failed}`, threadID);
    }

    // ── lock + set / set only ─────────────────────────────────────────────
    let doLock   = false;
    let template = "";

    if (sub === "lock") {
      doLock   = true;
      template = args.slice(1).join(" ").trim();
    } else {
      template = args.join(" ").trim();
    }

    if (!template) return api.sendMessage("❌ استخدام:\n" + USAGE, threadID);

    // Prevent running two ops on the same thread simultaneously
    if (_activeOps.has(threadID)) {
      return api.sendMessage(
        "⏳ تعذّر البدء — يوجد nickall جارٍ بالفعل.\n" +
        "استخدم `" + prefix + "nickall status` للاطلاع على التقدم، أو `" + prefix + "nickall stop` للإيقاف.",
        threadID
      );
    }

    let info;
    try { info = await api.getThreadInfo(threadID); }
    catch (e) { return api.sendMessage("❌ فشل جلب المجموعة: " + e.message, threadID); }

    const ids = info.participantIDs || [];
    if (ids.length === 0) return api.sendMessage("❌ لا يوجد أعضاء.", threadID);

    // Fetch names in batches of 50
    const userNames = {};
    for (let i = 0; i < ids.length; i += 50) {
      try {
        const chunk = await api.getUserInfo(ids.slice(i, i + 50));
        for (const [uid, u] of Object.entries(chunk || {})) userNames[uid] = u.name || uid;
      } catch {}
    }

    const rateMs   = _getRateMs(config);
    const lockMode = doLock ? " + قفل 🔒" : "";
    await api.sendMessage(
      `⏳ nickall: ${ids.length} عضو${lockMode} — "${template}"\n` +
      `معدل: ${Math.round(60000 / rateMs)}/دقيقة | اكتب \`${prefix}nickall status\` لمتابعة التقدم`,
      threadID
    );

    if (doLock) {
      if (!lockedNicknames.has(threadID)) lockedNicknames.set(threadID, new Map());
    }

    // Register operation
    const op = { stop: false, done: 0, failed: 0, total: ids.length, template, startedAt: Date.now() };
    _activeOps.set(threadID, op);

    try {
      for (let i = 0; i < ids.length; i++) {
        if (op.stop) break;
        const uid  = ids[i];
        const name = userNames[uid] || uid;
        const nick = _buildNick(template, name, i + 1, uid);
        try {
          await api.nickname(nick, threadID, uid);
          if (doLock) lockedNicknames.get(threadID).set(uid, nick);
          op.done++;
        } catch { op.failed++; }
        await _delay(rateMs);
      }
    } finally {
      _activeOps.delete(threadID);
    }

    const stopped  = op.stop ? "\n⛔ تم الإيقاف مبكراً." : "";
    const lockNote = doLock
      ? "\n🔒 الكنيات مقفولة وتُطبَّق تلقائياً كل 90 ثانية."
      : "\nللقفل: " + prefix + "nickall lock <كنية>";

    api.sendMessage(
      `✅ nickall انتهى:\n• نجح: ${op.done}\n• فشل: ${op.failed}${stopped}${lockNote}`,
      threadID
    );
  },
};
