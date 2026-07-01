"use strict";

const fs   = require("fs");
const path = require("path");

// ── Bootstrap: logger & config first ──────────────────────────────────────────
const logger    = require("./utils/logger");
const { validate: validateConfig } = require("./utils/config-validator");
const rawConfig = require("./config.json");
const config    = validateConfig(rawConfig);

// ── Core utils ─────────────────────────────────────────────────────────────────
const { SessionManager } = require("./utils/session");
const antiSpam           = require("./utils/antiSpam");
const banManager         = require("./utils/banManager");
const { lockedNames }    = require("./utils/lockedNames");
const nicknameLocks      = require("./utils/nicknameLocks");
const health             = require("./utils/health");
const alertManager       = require("./utils/alertManager");
const diagnostics        = require("./utils/diagnostics");
const { startupSelfCheck, schedule: scheduleMaintenance } = require("./utils/maintenance");
const humanSimulator     = require("./utils/humanSimulator");
const cookieRefresher    = require("./utils/cookieRefresher");
const { login }          = require("@neoaz07/nkxfca");

const { lockedThreads, mutedThreads, groupsCache, autoReplies, groupStats, replyDelay } = require("./state");
const { setBotApi, setBotStatus, logActivity, logViolation, startApiServer, setCookieRefresher, setSession: setApiSession } = require("./api");
const pendingReplies = require("./utils/pendingReplies");
const threadScanner  = require("./utils/threadScanner");
const { MQTT_CONFIG } = require("./config/constants");

// ── Config constants ──────────────────────────────────────────────────────────
const APP_STATE_PATH = path.resolve(__dirname, config.appStatePath);
const COMMANDS_DIR   = path.resolve(__dirname, "commands");
const GH_TOKEN       = process.env.GITHUB_TOKEN || process.env.GITHUB_PERSONAL_ACCESS_TOKEN || "";
const GH_REPO        = "marwanbou540-gif/messenger-bot";

// ── Session manager ───────────────────────────────────────────────────────────
const session = new SessionManager(APP_STATE_PATH, GH_TOKEN, GH_REPO);

// ── Anti-spam configuration ───────────────────────────────────────────────────
antiSpam.configure(config.features.antiSpamCooldownMs);

// ── Startup checks ────────────────────────────────────────────────────────────
startupSelfCheck(APP_STATE_PATH);
scheduleMaintenance();

// ── Health watchdog ───────────────────────────────────────────────────────────
health.start({
  diagnostics,
  onCritical: async (type, report) => {
    logger.error("Bot", "Health critical event: " + type, report);
    await diagnostics.createSnapshot("health_" + type).catch(e =>
      logger.warn("Bot", "Snapshot failed: " + e.message)
    );
  },
});

// ── Command loader ─────────────────────────────────────────────────────────────
function loadCommands() {
  const commands = new Map();
  if (!fs.existsSync(COMMANDS_DIR)) return commands;
  const files = fs.readdirSync(COMMANDS_DIR).filter(f => f.endsWith(".js"));
  for (const file of files) {
    try {
      delete require.cache[require.resolve(path.join(COMMANDS_DIR, file))];
      const cmd = require(path.join(COMMANDS_DIR, file));
      if (!cmd.name || typeof cmd.execute !== "function") continue;
      commands.set(cmd.name.toLowerCase(), cmd);
      if (Array.isArray(cmd.aliases)) {
        for (const alias of cmd.aliases) commands.set(alias.toLowerCase(), cmd);
      }
      logger.debug("Commands", "Loaded: " + cmd.name);
    } catch (e) {
      logger.warn("Commands", "Failed to load " + file + ": " + e.message);
      diagnostics.recordError("Commands", e, { file });
    }
  }
  logger.success("Commands", [...new Set(commands.values())].length + " command(s) loaded.");
  return commands;
}

// ── Permission helpers ────────────────────────────────────────────────────────
function isBotAdmin(senderID) {
  return config.bot.adminIDs.includes(senderID);
}

async function isThreadAdmin(api, senderID, threadID) {
  try {
    const info     = await api.getThreadInfo(threadID);
    const adminIDs = (info.adminIDs || []).map(a => a.id);
    if (info.name && groupsCache.has(threadID)) {
      const cached = groupsCache.get(threadID);
      groupsCache.set(threadID, {
        ...cached,
        name:        info.name,
        memberCount: info.participantIDs ? info.participantIDs.length : cached.memberCount,
      });
    }
    return adminIDs.includes(senderID);
  } catch {
    return false;
  }
}

// ── Template formatter ────────────────────────────────────────────────────────
function fmt(template, vars) {
  return template.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "{" + k + "}");
}

// ── FIX #2: Login failure diagnostics ────────────────────────────────────────
// Reads only metadata (count + mtime) from appstate — never cookie contents.
function _getAppstateMeta(appStatePath) {
  try {
    const stat = fs.statSync(appStatePath);
    const raw  = fs.readFileSync(appStatePath, "utf8");
    const data = JSON.parse(raw);
    return {
      cookieCount:  Array.isArray(data) ? data.length : 0,
      modifiedAt:   new Date(stat.mtimeMs).toISOString(),
      sizeBytyes:   stat.size,
    };
  } catch (e) {
    return { cookieCount: 0, modifiedAt: null, error: e.message };
  }
}

function _classifyLoginError(err) {
  const msg = String(err.error || err.message || err).toLowerCase();
  if (msg.includes("retrieving userid") || msg.includes("error retrieving")) {
    const meta = _getAppstateMeta(APP_STATE_PATH);
    if (meta.cookieCount === 0) return { type: "EMPTY_COOKIES", meta };
    return { type: "BLOCKED_OR_EXPIRED", meta };
  }
  if (msg.includes("checkpoint") || msg.includes("confirmation") || msg.includes("suspicious")) {
    return { type: "FACEBOOK_CHECKPOINT", meta: null };
  }
  if (msg.includes("login-approval") || msg.includes("two-factor") || msg.includes("2fa")) {
    return { type: "TWO_FACTOR_REQUIRED", meta: null };
  }
  if (msg.includes("econnreset") || msg.includes("etimedout") || msg.includes("enotfound") || msg.includes("network")) {
    return { type: "NETWORK_ERROR", meta: null };
  }
  return { type: "UNKNOWN", meta: null };
}

function _logLoginFailure(err) {
  const { type, meta } = _classifyLoginError(err);
  switch (type) {
    case "EMPTY_COOKIES":
      logger.error("Login", "FAILED [EMPTY_COOKIES] — appstate.json غير موجود أو فارغ.");
      logger.error("Login", "الحل: صدّر كوكيز فيسبوك جديدة وارفعها عبر لوحة التحكم.");
      break;
    case "BLOCKED_OR_EXPIRED":
      logger.error("Login", `FAILED [BLOCKED_OR_EXPIRED] — عدد الكوكيز: ${meta.cookieCount} | آخر تعديل: ${meta.modifiedAt}`);
      logger.error("Login", "الأسباب المحتملة: انتهت صلاحية الكوكيز أو حجب Replit IP.");
      logger.error("Login", "الحل: افتح فيسبوك من متصفحك، ثم صدّر appstate.json جديد.");
      break;
    case "FACEBOOK_CHECKPOINT":
      logger.error("Login", "FAILED [FACEBOOK_CHECKPOINT] — فيسبوك يطلب تحقق بشري.");
      logger.error("Login", "الحل: سجّل الدخول يدوياً من متصفحك وأكمل التحقق أولاً.");
      break;
    case "TWO_FACTOR_REQUIRED":
      logger.error("Login", "FAILED [TWO_FACTOR_REQUIRED] — المصادقة الثنائية مطلوبة.");
      logger.error("Login", "الحل: أضف كلمة المرور + رمز 2FA في credentials بملف config.json.");
      break;
    case "NETWORK_ERROR":
      logger.warn("Login", "FAILED [NETWORK_ERROR] — خطأ شبكة مؤقت. سيُعاد المحاولة تلقائياً.");
      break;
    default:
      logger.error("Login", "FAILED [UNKNOWN]: " + (err.error || err.message || String(err)));
  }
}

// ── MQTT reconnect watchdog ───────────────────────────────────────────────────
let _lastEventAt    = Date.now();
let _mqttErrorCount = 0;
let _mqttWatchdog   = null;

function startMqttWatchdog(reconnectFn) {
  if (_mqttWatchdog) clearInterval(_mqttWatchdog);
  _mqttErrorCount = 0;
  _mqttWatchdog = setInterval(async () => {
    const staleness = Date.now() - _lastEventAt;
    if (staleness > MQTT_CONFIG.STALE_CONNECTION_MS) {
      logger.error("MQTT", "No events for " + Math.round(staleness / 60000) + "min — restarting...");
      diagnostics.recordError("MQTT", new Error("stale_connection"), { staleness });
      // FIX #7: Fire MQTT stale alert
      await health.recordMqttStale().catch(() => {});
      clearInterval(_mqttWatchdog);
      _mqttWatchdog = null;
      reconnectFn();
    }
  }, 60000);
  _mqttWatchdog.unref();
}

// ── FIX #3: Adaptive backoff ──────────────────────────────────────────────────
// Apply to humanSimulator and cookieRefresher based on consecutive login failures.
function _applyAdaptiveBackoff(failureCount) {
  let level = 0;
  if (failureCount >= 5) level = 2;
  else if (failureCount >= 3) level = 1;
  if (level > 0) {
    humanSimulator.setBackoffLevel(level);
    cookieRefresher.setBackoffLevel(level);
    logger.warn("Backoff", `Adaptive backoff level ${level} applied after ${failureCount} login failure(s).`);
  }
}

function _clearAdaptiveBackoff() {
  humanSimulator.clearBackoff();
  cookieRefresher.clearBackoff();
  logger.debug("Backoff", "Adaptive backoff cleared — normal intervals restored.");
}

// ── Message handler ───────────────────────────────────────────────────────────
async function handleMessage(api, event, commands) {
  const { type, body, threadID, senderID } = event;
  if (type !== "message") return;

  const botID = api.getCurrentUserID();
  if (senderID === botID) return;

  if (banManager.isBanned(senderID)) return;
  if (config.features.antiSpam && antiSpam.isAbuser(senderID)) return;

  _lastEventAt = Date.now();

  const isGroup =
    event.isGroup === true ||
    (Array.isArray(event.participantIDs) && event.participantIDs.length > 2) ||
    (event.isGroup !== false && threadID && senderID && threadID !== senderID);

  if (isGroup) {
    const cached = groupsCache.get(threadID) || {};
    groupsCache.set(threadID, {
      name:        cached.name || null,
      memberCount: event.participantIDs ? event.participantIDs.length : (cached.memberCount || 0),
      lastSeen:    Date.now(),
    });
    const stats = groupStats.get(threadID) || { messageCount: 0, commandCount: 0, lastMessageAt: 0 };
    stats.messageCount++;
    stats.lastMessageAt = Date.now();
    groupStats.set(threadID, stats);

    if (body) {
      const ar = autoReplies.get(threadID);
      if (ar && ar.enabled && ar.message && !body.startsWith(config.prefix)) {
        const now      = Date.now();
        const lastSent = ar.lastSent.get(senderID) || 0;
        if (now - lastSent >= ar.cooldownMs) {
          ar.lastSent.set(senderID, now);
          api.sendMessage(ar.message, threadID).catch(e =>
            logger.warn("AutoReply", "Group auto-reply failed: " + e.message)
          );
        }
      }
    }
  }

  // FIX #6: Short professional private auto-reply (ar/en, ≤160 chars)
  if (!isGroup) {
    const autoReplyMsg =
      "🤖 Rika Bot — بوت آلي.\n" +
      "للمساعدة استخدم أمر `help` داخل مجموعة.\n" +
      "This is a bot — use `help` in a group.";
    api.sendMessage(autoReplyMsg, threadID).catch(e =>
      logger.warn("AutoReply", "Private auto-reply failed: " + e.message)
    );
    return;
  }

  if (mutedThreads.has(threadID)) {
    const until = mutedThreads.get(threadID);
    if (Date.now() < until) return;
    mutedThreads.delete(threadID);
  }

  // Lock check is deferred to after command parsing so keyword listeners
  // and auto-replies still work for everyone regardless of lock state.

  const _pendingEntry = pendingReplies.get(senderID);
  if (_pendingEntry && (!body || !body.startsWith(config.prefix))) {
    let _keepAlive = false;
    try {
      const _result = await _pendingEntry.handler((body || "").trim(), api, event);
      _keepAlive = (_result === pendingReplies.KEEP);
    } catch (e) {
      logger.error("PendingReply", "Handler error: " + e.message);
      api.sendMessage("❌ حدث خطأ. حاول مجدداً.", threadID).catch(e2 =>
        logger.warn("PendingReply", "Failed to send error: " + e2.message)
      );
    } finally {
      if (!_keepAlive) pendingReplies.del(senderID);
    }
    return;
  }

  if (!body) return;

  if (/اولترا|ultras/i.test(body)) {
    const imgPath = path.resolve(__dirname, "assets/ultras.jpg");
    try {
      await api.sendMessage({ attachment: fs.createReadStream(imgPath) }, threadID);
    } catch (e) {
      logger.error("KeywordListener", "Failed to send ultras image: " + e.message);
    }
    return;
  }

  if (!body.startsWith(config.prefix)) return;

  const trimmed = body.slice(config.prefix.length).trim();
  const args    = trimmed.split(/\s+/);
  const name    = args.shift().toLowerCase();
  if (!name) return;

  const cmd = commands.get(name);
  if (!cmd) {
    return api.sendMessage(fmt(config.messages.commandNotFound, { cmd: name, prefix: config.prefix }), threadID).catch(e =>
      logger.warn("Command", "Not-found message failed: " + e.message)
    );
  }

  // ── Lock mode: restrict ALL commands to BOT ADMINS only ──────────────────
  if (lockedThreads.has(threadID)) {
    if (!isBotAdmin(senderID)) {
      const cachedGroup = groupsCache.get(threadID);
      logViolation({
        threadID,
        threadName: (cachedGroup && cachedGroup.name) || threadID,
        senderID,
        messagePreview: body.slice(0, 80),
      });
      return api.sendMessage(
        "🔒 البوت مقفل — الأوامر متاحة لأدمن البوت فقط.",
        threadID
      ).catch(e => logger.warn("Command", "Lock message failed: " + e.message));
    }
  }

  if (cmd.groupOnly && !isGroup) {
    return api.sendMessage("❌ هذا الأمر للمجموعات فقط.", threadID).catch(e =>
      logger.warn("Command", "Group-only message failed: " + e.message)
    );
  }

  if (cmd.adminOnly) {
    const botAdm    = isBotAdmin(senderID);
    const threadAdm = botAdm || await isThreadAdmin(api, senderID, threadID);
    if (!botAdm && !threadAdm) {
      return api.sendMessage("🔒 هذا الأمر يتطلب صلاحية مشرف.", threadID).catch(e =>
        logger.warn("Command", "Admin-only message failed: " + e.message)
      );
    }
  }

  if (config.features.antiSpam && antiSpam.isOnCooldown(senderID, cmd.name)) {
    const remaining = (antiSpam.getRemainingCooldown(senderID, cmd.name) / 1000).toFixed(1);
    return api.sendMessage("⏳ انتظر " + remaining + " ثانية.", threadID).catch(e =>
      logger.warn("Command", "Cooldown message failed: " + e.message)
    );
  }
  if (config.features.antiSpam) antiSpam.setCooldown(senderID, cmd.name);

  logger.info("Command", "[" + threadID + "] " + senderID + " → " + config.prefix + cmd.name + " " + args.join(" "));
  if (isGroup) {
    const cs = groupStats.get(threadID) || { messageCount: 0, commandCount: 0, lastMessageAt: 0 };
    cs.commandCount++;
    groupStats.set(threadID, cs);
  }

  if (replyDelay.enabled && replyDelay.ms > 0) {
    await new Promise(r => setTimeout(r, replyDelay.ms));
  }

  try {
    await cmd.execute({ api, event: { ...event, isGroup }, args, commands, mutedThreads, lockedThreads });
  } catch (e) {
    logger.error("Command", "Error in " + config.prefix + cmd.name + ": " + e.message);
    diagnostics.recordError("Command", e, { cmd: cmd.name, threadID, senderID });
    api.sendMessage(config.messages.errorOccurred, threadID).catch(e2 =>
      logger.warn("Command", "Error message failed: " + e2.message)
    );
  }
}

// Event handler — disabled (no events active)
async function handleEvent() {}

// ── AppState file watcher — resumes bot automatically on new cookies ──────────
let _appStateWatcherActive = false;

function _startAppStateWatcher() {
  if (_appStateWatcherActive) return;
  _appStateWatcherActive = true;
  logger.info("Bot", "Watching for new appstate.json — will restart automatically when detected.");
  session.watch((newState) => {
    logger.success("Bot", "✅ New appstate.json detected — resuming bot login...");
    _appStateWatcherActive = false;
    _restartAttempt = 0;
    setTimeout(startBot, 2000);
  });
}

function _stopAppStateWatcher() {
  if (!_appStateWatcherActive) return;
  _appStateWatcherActive = false;
  session.unwatch();
}

// ── Bot launcher with exponential backoff ─────────────────────────────────────
let _restartAttempt = 0;
const MAX_RESTART_DELAY = 300000;

function startBot() {
  cookieRefresher.stop();
  _stopAppStateWatcher();

  let appState;
  try {
    appState = session.load();
  } catch (e) {
    if (e.message === "ALL_SOURCES_INVALID") {
      logger.error("Bot", "❌ appstate.json غير موجود أو غير صالح — الكوكيز منتهية الصلاحية.");
      logger.error("Bot", "الحل: صدّر كوكيز فيسبوك جديدة وضعها في appstate.json أو ارفعها عبر لوحة التحكم.");
      setBotStatus("offline — awaiting valid appstate.json");
      _startAppStateWatcher();
      return;
    }
    throw e;
  }

  const commands = loadCommands();

  logger.info("Bot", "Starting " + config.bot.name + " v" + config.bot.version + " (attempt " + (_restartAttempt + 1) + ")...");

  // FIX #3: Apply adaptive backoff before each login attempt
  _applyAdaptiveBackoff(_restartAttempt);

  const credentials = { appState };
  if (config.credentials && config.credentials.email && config.credentials.password) {
    credentials.email    = config.credentials.email;
    credentials.password = config.credentials.password;
    logger.info("Bot", "Email/password credentials loaded for auto re-login.");
  }

  let loginTimer = setTimeout(() => {
    logger.error("Bot", "Login timed out after 2 minutes — forcing retry.");
    diagnostics.recordError("Bot", new Error("login_timeout"));
    _restartAttempt++;
    const delay = Math.min(30000 * Math.pow(1.5, Math.min(_restartAttempt, 8)), MAX_RESTART_DELAY);
    setBotStatus("offline — login timeout, retrying...");
    // FIX #7: Record login failure on timeout
    health.recordLoginFailure().catch(() => {});
    setTimeout(startBot, delay);
  }, 120000);

  login(credentials, config.loginOptions, async (err, api) => {
    clearTimeout(loginTimer);

    if (err) {
      // FIX #2: Detailed login failure diagnostics
      _logLoginFailure(err);
      diagnostics.recordError("Bot", new Error(String(err.error || err.message || err)));

      // FIX #7: Record login failure for alert threshold tracking
      await health.recordLoginFailure().catch(() => {});

      if (err.error === "login-approval" || String(err).includes("checkpoint")) {
        logger.error("Bot", "Account requires human verification — pausing auto-retry.");
        logger.info("Bot", "Complete verification in browser, then replace appstate.json to resume.");
        setBotStatus("offline — checkpoint required");
        _startAppStateWatcher(); // Resume automatically when new cookies are provided
        return;
      }

      _restartAttempt++;
      const delay = Math.min(30000 * Math.pow(1.5, Math.min(_restartAttempt, 8)), MAX_RESTART_DELAY);
      logger.info("Bot", "Retrying in " + (delay / 1000).toFixed(0) + "s (attempt " + _restartAttempt + ")...");
      setBotStatus("offline — retrying...");
      // Also watch for new appstate.json during the retry wait — if the user provides
      // fresh cookies the bot will restart immediately rather than waiting for the timer.
      _startAppStateWatcher();
      setTimeout(startBot, delay);
      return;
    }

    _restartAttempt = 0;
    _clearAdaptiveBackoff(); // FIX #3: Restore normal intervals
    health.recordLoginSuccess(); // FIX #7: Clear failure counters
    health.clearMqttStale();

    const botID = api.getCurrentUserID();
    logger.success("Bot", "Logged in! Bot ID: " + botID);
    logger.info("Bot", "Prefix: \"" + config.prefix + "\" | Commands: " + [...new Set(commands.values())].length);

    // FIX #7: Register admin IDs + bot API in alertManager
    alertManager.setApi(
      api,
      config.bot.adminIDs || [],
      process.env.ALERT_WEBHOOK_URL || null
    );

    // Save fresh cookies immediately after login
    try {
      const fresh = api.getAppState();
      if (Array.isArray(fresh) && fresh.length > 0) {
        await session.saveAndPush(fresh);
        logger.success("AppState", "Fresh cookies saved after login (" + fresh.length + " entries).");
      }
    } catch (e) {
      logger.warn("AppState", "Post-login save failed: " + e.message);
    }

    cookieRefresher.start(api, session);
    setCookieRefresher(cookieRefresher);
    setBotApi(api);
    threadScanner.setApi(api);
    setBotStatus("online");
    nicknameLocks.setApi(api);

    if (config.humanSimulator && config.humanSimulator.enabled) {
      humanSimulator.start(api, config.humanSimulator);
      logger.info("HumanSim", "Human simulator started.");
    }

    api.onReLoginSuccess = async () => {
      logger.success("Bot", "Auto re-login succeeded.");
      health.recordLoginSuccess();
      _clearAdaptiveBackoff();
      try {
        const fresh = api.getAppState();
        if (Array.isArray(fresh) && fresh.length > 0) await session.saveAndPush(fresh);
      } catch (e) {
        logger.warn("Bot", "Re-login state save failed: " + e.message);
      }
    };

    api.onReLoginFailure = async (e) => {
      logger.error("Bot", "Auto re-login failed permanently: " + e.message);
      await health.recordLoginFailure().catch(() => {});
      setBotStatus("offline — re-login failed");
      cookieRefresher.stop();
      await diagnostics.createSnapshot("relogin_failure").catch(e2 =>
        logger.warn("Bot", "Snapshot failed: " + e2.message)
      );
      logger.info("Bot", "Scheduling full bot restart in 60s...");
      // Use startBot() instead of process.exit(1) — avoids rapid Replit workflow restart loops
      setTimeout(() => { _restartAttempt = 0; startBot(); }, 60000);
    };

    _lastEventAt = Date.now();
    let _mqttRestartCount = 0;

    startMqttWatchdog(() => {
      logger.info("Bot", "MQTT watchdog triggered reconnect.");
      setBotStatus("offline — reconnecting...");
      cookieRefresher.stop();
      humanSimulator.stop();
      setTimeout(startBot, MQTT_CONFIG.RESTART_BACKOFF_MS);
    });

    // FIX #6: MQTT exponential backoff — 5s×2^attempt, max 10 attempts then exit
    api.listenMqtt(async (mqttErr, event) => {
      if (mqttErr) {
        _mqttErrorCount++;
        logger.warn("MQTT", "Listen error #" + _mqttErrorCount + ": " + (mqttErr.message || mqttErr));
        diagnostics.recordError("MQTT", mqttErr instanceof Error ? mqttErr : new Error(String(mqttErr)));

        if (_mqttErrorCount >= MQTT_CONFIG.ERROR_THRESHOLD) {
          _mqttRestartCount++;
          if (_mqttRestartCount > MQTT_CONFIG.MAX_RESTART_ATTEMPTS) {
            const COOLDOWN_MS = 15 * 60 * 1000; // 15-minute cooldown instead of exit(1)
            logger.error("MQTT", `Exceeded ${MQTT_CONFIG.MAX_RESTART_ATTEMPTS} restart attempts — cooling down ${COOLDOWN_MS / 60000} min.`);
            setBotStatus("offline — cooldown (15 min)");
            cookieRefresher.stop();
            humanSimulator.stop();
            if (_mqttWatchdog) { clearInterval(_mqttWatchdog); _mqttWatchdog = null; }
            _mqttRestartCount = 0;
            _restartAttempt   = 0;
            setTimeout(startBot, COOLDOWN_MS);
            return;
          }
          const backoff = Math.min(
            MQTT_CONFIG.RESTART_BACKOFF_MS * Math.pow(2, _mqttRestartCount - 1),
            MQTT_CONFIG.MAX_RESTART_DELAY
          );
          logger.error("MQTT", `${MQTT_CONFIG.ERROR_THRESHOLD} errors — reconnecting in ${backoff / 1000}s (attempt ${_mqttRestartCount}/${MQTT_CONFIG.MAX_RESTART_ATTEMPTS}).`);
          if (_mqttWatchdog) { clearInterval(_mqttWatchdog); _mqttWatchdog = null; }
          setBotStatus("offline — reconnecting...");
          cookieRefresher.stop();
          humanSimulator.stop();
          _mqttErrorCount = 0;
          setTimeout(startBot, backoff);
        }
        return;
      }

      _mqttErrorCount = 0;
      if (!event) return;
      _lastEventAt = Date.now();
      health.clearMqttStale(); // FIX #7: Clear stale alert on first good event
      try {
        if (event.type === "message")    await handleMessage(api, event, commands);
        else if (event.type === "log:subscribe" || event.type === "log:unsubscribe") {
          await handleEvent(api, event);
        }
      } catch (e) {
        logger.error("Bot", "Unhandled event error: " + e.message);
        diagnostics.recordError("Bot", e);
      }
    });

    logger.success("Bot", "Listening via MQTT...");
  });
}

// ── Process-level safety net ──────────────────────────────────────────────────
process.on("uncaughtException", async (e) => {
  logger.error("Process", "Uncaught exception: " + e.message);
  logger.error("Process", e.stack);
  diagnostics.recordError("Process", e);
  await diagnostics.createSnapshot("uncaught_exception").catch(() => {});
});

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.warn("Process", "Unhandled rejection: " + msg);
  diagnostics.recordError("Process", reason instanceof Error ? reason : new Error(msg));
});

process.on("SIGINT",  () => { cookieRefresher.stop(); humanSimulator.stop(); logger.info("Bot", "SIGINT — shutting down."); process.exit(0); });
process.on("SIGTERM", () => { cookieRefresher.stop(); humanSimulator.stop(); logger.info("Bot", "SIGTERM — shutting down."); process.exit(0); });

// ── Start everything ──────────────────────────────────────────────────────────
startApiServer();
setApiSession(session); // Pass session to API so /appstate endpoint can write cookies
startBot();
