"use strict";
const utils = require('../utils');
const mqtt = require('mqtt');
const HttpsProxyAgent = require('https-proxy-agent');
const EventEmitter = require('events');
const { parseDelta } = require('./mqttDeltaValue');
const { globalAutoReLoginManager } = require('../utils/autoReLogin');

// NOTE: form and getSeqID are intentionally kept local to each factory
// invocation (see module.exports below). Do NOT hoist them to module scope —
// doing so causes cross-context contamination when the factory is called
// multiple times (e.g. after auto re-login).

const topics = [
    "/ls_req", "/ls_resp", "/legacy_web", "/webrtc", "/rtc_multi", "/onevc", "/br_sr", "/sr_res",
    "/t_ms", "/thread_typing", "/orca_typing_notifications", "/notify_disconnect",
    "/orca_presence", "/inbox", "/mercury", "/messaging_events",
    "/orca_message_notifications", "/pp", "/webrtc_response"
];

// Optimized constants for better performance
const MQTT_MAX_BACKOFF = 15000;
const MQTT_JITTER_MAX = 600;
const MQTT_QUICK_CLOSE_WINDOW_MS = 1200;
const MQTT_QUICK_CLOSE_THRESHOLD = 3;
const DEFAULT_RECONNECT_DELAY_MS = 1500;
const T_MS_WAIT_TIMEOUT_MS = 6000;

function getRandomReconnectTime() {
    const min = 15 * 60 * 1000;
    const max = 30 * 60 * 1000;
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function generateUUID() {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
        var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
        return v.toString(16);
    });
}

// Enhanced retry mechanism with exponential backoff
function retryWithBackoff(fn, maxRetries = 3, baseDelay = 1000) {
    return async function(...args) {
        let lastError;
        for (let i = 0; i < maxRetries; i++) {
            try {
                return await fn.apply(this, args);
            } catch (error) {
                lastError = error;
                if (i === maxRetries - 1) throw lastError;
                
                const delay = Math.min(baseDelay * Math.pow(2, i) + Math.random() * 500, 10000);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
        throw lastError;
    };
}

function calculate(previousTimestamp, currentTimestamp){
    return Math.floor(previousTimestamp + (currentTimestamp - previousTimestamp) + 250);
}

function computeBackoffDelay(ctx, baseDelay, maxBackoff, jitterMax) {
    const attempt = ctx._reconnectAttempts || 0;
    const base = Number.isFinite(baseDelay) && baseDelay > 0 ? baseDelay : DEFAULT_RECONNECT_DELAY_MS;
    const max = Number.isFinite(maxBackoff) && maxBackoff > 0 ? maxBackoff : MQTT_MAX_BACKOFF;
    const jitterCap = Number.isFinite(jitterMax) && jitterMax >= 0 ? jitterMax : MQTT_JITTER_MAX;
    const backoff = Math.min(base * Math.pow(1.5, attempt), max); // Reduced exponent for faster recovery
    const jitter = Math.floor(Math.random() * jitterCap);
    return Math.round(backoff + jitter);
}

/**
 * @param {Object} ctx
 * @param {Object} api
 * @param {string} threadID
 */
function markAsRead(ctx, api, threadID) {
    if (ctx.globalOptions.autoMarkRead && threadID) {
        api.markAsRead(threadID, (err) => {
            if (err) utils.error("autoMarkRead", err);
        });
    }
}

/**
 * @param {Object} defaultFuncs
 * @param {Object} api
 * @param {Object} ctx
 * @param {Function} globalCallback
 * @param {Function} scheduleReconnect
 * @param {Function} emitAuthError - Passed from the factory closure so auth errors can be emitted correctly
 */
async function listenMqtt(defaultFuncs, api, ctx, globalCallback, scheduleReconnect, emitAuthError) {
    function isEndingLikeError(msg) {
        return /No subscription existed|client disconnecting|socket hang up|ECONNRESET/i.test(msg || "");
    }
    function guard(label, fn) {
        return (...args) => {
            try {
                return fn(...args);
            } catch (err) {
                utils.error("MQTT", `${label} handler error:`, err && err.message ? err.message : err);
            }
        };
    }

    if (ctx._reconnectTimer) {
        clearTimeout(ctx._reconnectTimer);
        ctx._reconnectTimer = null;
    }
    if (ctx._tmsTimeout) {
        clearTimeout(ctx._tmsTimeout);
        ctx._tmsTimeout = null;
    }
    if (ctx._mqttWatchdog) {
        clearInterval(ctx._mqttWatchdog);
        ctx._mqttWatchdog = null;
    }
    if (ctx.mqttClient) {
        try { ctx.mqttClient.removeAllListeners(); } catch (_) { }
        try { ctx.mqttClient.end(true); } catch (_) { }
    }

    const chatOn = ctx.globalOptions.online;
    const region = ctx.region;
    const foreground = false;
    const sessionID = Math.floor(Math.random() * Number.MAX_SAFE_INTEGER) + 1;
    const cid = ctx.clientID;
    const cachedUA = ctx.globalOptions.cachedUserAgent || ctx.globalOptions.userAgent;
    const username = {
        u: ctx.userID,
        s: sessionID,
        chat_on: chatOn,
        fg: false,
        d: cid,
        ct: 'websocket',
        aid: 219994525426954,
        aids: null,
        mqtt_sid: '',
        cp: 3,
        ecp: 10,
        st: [],
        pm: [],
        dc: '',
        no_auto_fg: true,
        gas: null,
        pack: [],
        p: null,
        php_override: ""
    };
    const cookies = ctx.jar.getCookiesSync('https://www.facebook.com').join('; ');
    let host;
    if (ctx.mqttEndpoint) {
        host = `${ctx.mqttEndpoint}&sid=${sessionID}&cid=${cid}`;
    } else if (region) {
        host = `wss://edge-chat.facebook.com/chat?region=${region.toLowerCase()}&sid=${sessionID}&cid=${cid}`;
    } else {
        host = `wss://edge-chat.facebook.com/chat?sid=${sessionID}&cid=${cid}`;
    }

    utils.log("Connecting to MQTT...", host);

    const cachedSecChUa = ctx.globalOptions.cachedSecChUa || '"Google Chrome";v="136", "Not;A=Brand";v="99", "Chromium";v="136"';
    const cachedSecChUaPlatform = ctx.globalOptions.cachedSecChUaPlatform || '"Windows"';
    const cachedLocale = ctx.globalOptions.cachedLocale || 'en-US,en;q=0.9';

    // Generate a unique client ID per session like a real browser would
    const mqttClientId = 'mqttwsclient_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
    const options = {
        clientId: mqttClientId,
        protocolId: "MQIsdp",
        protocolVersion: 3,
        username: JSON.stringify(username),
        clean: true,
        wsOptions: {
            headers: {
                Cookie: cookies,
                Origin: "https://www.facebook.com",
                "User-Agent": ctx.globalOptions.userAgent || "Mozilla/5.0",
                Referer: "https://www.facebook.com/",
                Host: "edge-chat.facebook.com",
                Connection: "Upgrade",
                Pragma: "no-cache",
                "Cache-Control": "no-cache",
                Upgrade: "websocket",
                "Sec-WebSocket-Version": "13",
                "Accept-Encoding": "gzip, deflate, br",
                "Accept-Language": cachedLocale,
                'Sec-Ch-Ua': cachedSecChUa,
                'Sec-Ch-Ua-Mobile': '?0',
                'Sec-Ch-Ua-Platform': cachedSecChUaPlatform,
                'Sec-WebSocket-Extensions': 'permessage-deflate; client_max_window_bits'
            },
            origin: 'https://www.facebook.com',
            protocolVersion: 13,
            binaryType: 'arraybuffer'
        },
        keepalive: 60,
        reschedulePings: true,
        connectTimeout: 30000,
        reconnectPeriod: 0
    };

    if (ctx.globalOptions.proxy) options.wsOptions.agent = new HttpsProxyAgent(ctx.globalOptions.proxy);
    ctx._mqttLastConnectAttemptAt = Date.now();
    
    // Create WebSocket stream - using exact fca-unofficial implementation
    let mqttClient;
    
    try {
        const mqtt = require('mqtt');
        const WebSocket = require('ws');
        const { PassThrough, Writable } = require('stream');
        const Duplexify = require('duplexify');
        
        // Exact buildProxy from fca-unofficial
        function buildProxy() {
            let target = null;
            let ended = false;
            const Proxy = new Writable({
                autoDestroy: true,
                write(chunk, enc, cb) {
                    if (ended || this.destroyed) return cb();
                    const ws = target;
                    if (ws && ws.readyState === 1) {
                        try {
                            ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk), cb);
                        } catch (e) {
                            cb(e);
                        }
                    } else cb();
                },
                writev(chunks, cb) {
                    if (ended || this.destroyed) return cb();
                    const ws = target;
                    if (!ws || ws.readyState !== 1) return cb();
                    try {
                        for (const { chunk } of chunks) {
                            ws.send(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
                        }
                        cb();
                    } catch (e) {
                        cb(e);
                    }
                },
                final(cb) {
                    ended = true;
                    const ws = target;
                    target = null;
                    if (ws && (ws.readyState === 0 || ws.readyState === 1)) {
                        try {
                            typeof ws.terminate === "function" ? ws.terminate() : ws.close();
                        } catch { }
                    }
                    cb();
                }
            });
            Proxy.setTarget = ws => {
                if (ended) return;
                target = ws;
            };
            Proxy.hardEnd = () => {
                ended = true;
                target = null;
            };
            return Proxy;
        }
        
        // Exact buildStream from fca-unofficial
        function buildStream(opts, ws, Proxy) {
            const readable = new PassThrough();
            const Stream = Duplexify(undefined, undefined, Object.assign({ end: false, autoDestroy: true }, opts));
            const NoopWritable = new Writable({ write(_c, _e, cb) { cb(); } });
            let pingTimer = null;
            let livenessTimer = null;
            let lastActivity = Date.now();
            let attached = false;
            let style = "prop";
            let closed = false;
            
            const toBuffer = d => {
                if (Buffer.isBuffer(d)) return d;
                if (d instanceof ArrayBuffer) return Buffer.from(d);
                if (ArrayBuffer.isView(d)) return Buffer.from(d.buffer, d.byteOffset, d.byteLength);
                return Buffer.from(String(d));
            };
            
            const swapToNoopWritable = () => {
                try { Stream.setWritable(NoopWritable); } catch { }
            };
            
            const onOpen = () => {
                if (closed) return;
                Proxy.setTarget(ws);
                Stream.setWritable(Proxy);
                Stream.setReadable(readable);
                Stream.emit("connect");
                lastActivity = Date.now();
                clearInterval(pingTimer);
                clearInterval(livenessTimer);
                pingTimer = setInterval(() => {
                    if (!ws || ws.readyState !== 1) return;
                    if (typeof ws.ping === "function") {
                        try { ws.ping(); } catch { }
                    } else {
                        try { ws.send("ping"); } catch { }
                    }
                }, 30000);
                livenessTimer = setInterval(() => {
                    if (!ws || ws.readyState !== 1) return;
                    if (Date.now() - lastActivity > 65000) {
                        try { typeof ws.terminate === "function" ? ws.terminate() : ws.close(); } catch { }
                    }
                }, 10000);
            };
            
            const onMessage = data => {
                lastActivity = Date.now();
                readable.write(toBuffer(style === "dom" && data && data.data !== undefined ? data.data : data));
            };
            
            const onPong = () => {
                lastActivity = Date.now();
            };
            
            const cleanup = () => {
                if (closed) return;
                closed = true;
                clearInterval(pingTimer);
                clearInterval(livenessTimer);
                pingTimer = null;
                livenessTimer = null;
                Proxy.hardEnd();
                swapToNoopWritable();
                if (ws) {
                    detach(ws);
                    try {
                        if (ws.readyState === 1) {
                            typeof ws.terminate === "function" ? ws.terminate() : ws.close();
                        }
                    } catch { }
                    ws = null;
                }
                readable.end();
            };
            
            const onError = err => {
                cleanup();
                Stream.destroy(err);
            };
            
            const onClose = () => {
                cleanup();
                Stream.end();
                if (!Stream.destroyed) Stream.destroy();
            };
            
            const attach = w => {
                if (attached || !w) return;
                attached = true;
                if (typeof w.on === "function" && typeof w.off === "function") {
                    style = "node";
                    w.on("open", onOpen);
                    w.on("message", onMessage);
                    w.on("error", onError);
                    w.on("close", onClose);
                    if (typeof w.on === "function") w.on("pong", onPong);
                } else if (typeof w.addEventListener === "function" && typeof w.removeEventListener === "function") {
                    style = "dom";
                    w.addEventListener("open", onOpen);
                    w.addEventListener("message", onMessage);
                    w.addEventListener("error", onError);
                    w.addEventListener("close", onClose);
                } else {
                    style = "prop";
                    w.onopen = onOpen;
                    w.onmessage = onMessage;
                    w.onerror = onError;
                    w.onclose = onClose;
                }
            };
            
            const detach = w => {
                if (!attached || !w) return;
                attached = false;
                if (style === "node" && typeof w.off === "function") {
                    w.off("open", onOpen);
                    w.off("message", onMessage);
                    w.off("error", onError);
                    w.off("close", onClose);
                    if (typeof w.off === "function") w.off("pong", onPong);
                } else if (style === "dom" && typeof w.removeEventListener === "function") {
                    w.removeEventListener("open", onOpen);
                    w.removeEventListener("message", onMessage);
                    w.removeEventListener("error", onError);
                    w.removeEventListener("close", onClose);
                } else {
                    w.onopen = null;
                    w.onmessage = null;
                    w.onerror = null;
                    w.onclose = null;
                }
            };
            
            attach(ws);
            if (ws && ws.readyState === 1) onOpen();
            
            Stream.on("prefinish", swapToNoopWritable);
            Stream.on("finish", cleanup);
            Stream.on("close", cleanup);
            Proxy.on("close", swapToNoopWritable);
            
            return Stream;
        }
        
        // Create MQTT client exactly like fca-unofficial
        mqttClient = new mqtt.Client(
            () => buildStream(options, new WebSocket(host, options.wsOptions), buildProxy()),
            options
        );
        
        mqttClient.publishSync = mqttClient.publish.bind(mqttClient);
        mqttClient.publish = (topic, message, opts = {}, callback = () => {}) => new Promise((resolve, reject) => {
            mqttClient.publishSync(topic, message, opts, (err, data) => {
                if (err) {
                    callback(err);
                    reject(err);
                } else {
                    callback(null, data);
                    resolve(data);
                }
            });
        });
        ctx.mqttClient = mqttClient;

    } catch (error) {
        utils.error("MQTT", "Failed to create WebSocket connection:", error.message);
        if (ctx.globalOptions.autoReconnect) {
            const baseDelay = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000;
            scheduleReconnect(baseDelay);
        } else {
            globalCallback({ type: "stop_listen", error: error.message || "WebSocket connection failed" });
        }
        return;
    }

    mqttClient.on('error', guard("error", (err) => {
        const msg = String(err && err.message ? err.message : err || "");

        if ((ctx._ending || ctx._cycling) && isEndingLikeError(msg)) {
            utils.log("MQTT", "Expected error during shutdown: " + msg);
            return;
        }

        if (ctx._tmsTimeout) {
            clearTimeout(ctx._tmsTimeout);
            ctx._tmsTimeout = null;
        }
        if (ctx._mqttWatchdog) {
            clearInterval(ctx._mqttWatchdog);
            ctx._mqttWatchdog = null;
        }
        ctx._mqttConnected = false;

        if (/Not logged in|Not logged in\.|blocked the login|checkpoint|401|403/i.test(msg)) {
            try { mqttClient.end(true); } catch (_) { }
            try { if (ctx._autoCycleTimer) clearInterval(ctx._autoCycleTimer); } catch (_) { }
            emitAuthError(/blocked|checkpoint/i.test(msg) ? "login_blocked" : "not_logged_in", msg);
            return;
        }

        utils.error("MQTT error:", msg);
        try { mqttClient.end(true); } catch (_) { }

        if (ctx._ending || ctx._cycling) return;

        if (ctx.globalOptions.autoReconnect) {
            const baseDelay = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000;
            ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
            const d = computeBackoffDelay(ctx, baseDelay, MQTT_MAX_BACKOFF, MQTT_JITTER_MAX);
            utils.warn("MQTT", `Auto-reconnecting in ${d}ms (attempt ${ctx._reconnectAttempts}) due to error`);
            scheduleReconnect(d);
        } else {
            globalCallback({ type: "stop_listen", error: msg || "Connection refused" });
        }
    }));

    // Update activity timestamp on every packet received (including PINGRESP).
    // Without this, the watchdog fires on quiet bots even when the connection is
    // healthy — MQTT keepalive pings don't emit the 'message' event.
    mqttClient.on('packetreceive', () => {
        ctx._lastMqttMessageAt = Date.now();
    });

    mqttClient.on('connect', guard("connect", async () => {
        if (!ctx._mqttConnected) {
            utils.log("MQTT connected successfully");
            ctx._mqttConnected = true;
        }
        ctx._cycling = false;
        ctx._reconnectAttempts = 0;
        ctx._mqttQuickCloseCount = 0;
        if (ctx._reconnectTimer) {
            clearTimeout(ctx._reconnectTimer);
            ctx._reconnectTimer = null;
        }
        ctx.loggedIn = true;
        ctx._lastMqttMessageAt = Date.now();
        if (ctx._mqttWatchdog) {
            clearInterval(ctx._mqttWatchdog);
            ctx._mqttWatchdog = null;
        }
        const watchdogInterval = (ctx._mqttOpt && ctx._mqttOpt.watchdogIntervalMs) || 30000;
        const staleMs = (ctx._mqttOpt && ctx._mqttOpt.staleMs) || 180000;
        ctx._mqttWatchdog = setInterval(() => {
            if (ctx._ending || ctx._cycling || !ctx.globalOptions.autoReconnect) return;
            const last = ctx._lastMqttMessageAt || 0;
            if (last && Date.now() - last > staleMs) {
                utils.warn("MQTT", `No MQTT activity for ${Date.now() - last}ms, cycling connection`);
                try { mqttClient.end(true); } catch (_) { }
                scheduleReconnect((ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000);
            }
        }, watchdogInterval);

        mqttClient.subscribe(topics, { qos: 1 });

        // Send queue setup messages immediately (like fca-unofficial)
        const queue = {
            sync_api_version: 11, 
            max_deltas_able_to_process: 200, 
            delta_batch_size: 200,
            encoding: "JSON", 
            entity_fbid: ctx.userID, 
            initial_titan_sequence_id: ctx.lastSeqId, 
            device_params: null
        };
        const topic = ctx.syncToken ? "/messenger_sync_get_diffs" : "/messenger_sync_create_queue";
        if (ctx.syncToken) { 
            queue.last_seq_id = ctx.lastSeqId; 
            queue.sync_token = ctx.syncToken; 
        }
        mqttClient.publish(topic, JSON.stringify(queue), { qos: 1, retain: false });
        mqttClient.publish("/foreground_state", JSON.stringify({ foreground: chatOn }), { qos: 1 });
        mqttClient.publish("/set_client_settings", JSON.stringify({ make_user_available_when_in_foreground: true }), { qos: 1 });
        
        utils.log("MQTT", "Queue setup messages sent");

        // Disable T_MS timeout to prevent connection cycling
        if (ctx._tmsTimeout) {
            clearTimeout(ctx._tmsTimeout);
            ctx._tmsTimeout = null;
        }

        ctx.tmsWait = function() {
            if (ctx._tmsTimeout) {
                clearTimeout(ctx._tmsTimeout);
                ctx._tmsTimeout = null;
            }
            if (ctx.globalOptions.emitReady) {
                globalCallback(null, { type: "ready", timestamp: Date.now() });
            }
            delete ctx.tmsWait;
        };
        
        // Immediately mark as ready since we're connected
        if (ctx.tmsWait && typeof ctx.tmsWait === "function") ctx.tmsWait();
    }));

    mqttClient.on('message', guard("message", async (topic, message, _packet) => {
        try {
            ctx._lastMqttMessageAt = Date.now();
            let jsonMessage = Buffer.isBuffer(message) ? Buffer.from(message).toString() : message;
            try { jsonMessage = JSON.parse(jsonMessage); } catch (_) { jsonMessage = {}; }

            if (jsonMessage.type === "jewel_requests_add") {
                globalCallback(null, { 
                    type: "friend_request_received", 
                    actorFbId: jsonMessage.from.toString(), 
                    timestamp: Date.now().toString() 
                });
            } else if (jsonMessage.type === "jewel_requests_remove_old") {
                globalCallback(null, { 
                    type: "friend_request_cancel", 
                    actorFbId: jsonMessage.from.toString(), 
                    timestamp: Date.now().toString() 
                });
            } else if (topic === "/t_ms") {
                if (ctx.tmsWait && typeof ctx.tmsWait === "function") ctx.tmsWait();

                if (jsonMessage.firstDeltaSeqId && jsonMessage.syncToken) {
                    ctx.lastSeqId = jsonMessage.firstDeltaSeqId;
                    ctx.syncToken = jsonMessage.syncToken;
                }
                if (jsonMessage.lastIssuedSeqId) {
                    ctx.lastSeqId = parseInt(jsonMessage.lastIssuedSeqId);
                }

                if (jsonMessage.deltas) {
                    for (const delta of jsonMessage.deltas) {
                        parseDelta(defaultFuncs, api, ctx, globalCallback, { delta });
                    }
                }
            } else if (topic === "/thread_typing" || topic === "/orca_typing_notifications") {
                const typ = {
                    type: "typ",
                    isTyping: !!jsonMessage.state,
                    from: jsonMessage.sender_fbid.toString(),
                    threadID: utils.formatID((jsonMessage.thread || jsonMessage.sender_fbid).toString())
                };
                globalCallback(null, typ);
            } else if (topic === "/orca_presence") {
                if (!ctx.globalOptions.updatePresence && jsonMessage.list) {
                    for (const data of jsonMessage.list) {
                        globalCallback(null, { 
                            type: "presence", 
                            userID: String(data.u), 
                            timestamp: data.l * 1000, 
                            statuses: data.p 
                        });
                    }
                }
            }
        } catch (ex) {
            utils.error("MQTT message parse error:", ex && ex.message ? ex.message : ex);
        }
    }));

    mqttClient.on('close', guard("close", async () => {
        utils.warn("MQTT", "Connection closed");
        if (ctx._tmsTimeout) {
            clearTimeout(ctx._tmsTimeout);
            ctx._tmsTimeout = null;
        }
        if (ctx._mqttWatchdog) {
            clearInterval(ctx._mqttWatchdog);
            ctx._mqttWatchdog = null;
        }
        // Save connected state BEFORE clearing it — used for quick-close detection.
        const wasConnected = ctx._mqttConnected;
        ctx._mqttConnected = false;
        if (ctx._ending || ctx._cycling) return;

        // Quick-close detection: only relevant when we closed before a 'connect'
        // event ever fired (wasConnected is still false from initialization).
        if (!wasConnected) {
            const now = Date.now();
            const lastAttempt = ctx._mqttLastConnectAttemptAt || 0;
            if (lastAttempt && now - lastAttempt <= MQTT_QUICK_CLOSE_WINDOW_MS) {
                ctx._mqttQuickCloseCount = (ctx._mqttQuickCloseCount || 0) + 1;
            } else {
                ctx._mqttQuickCloseCount = 0;
            }
            if (ctx._mqttQuickCloseCount >= MQTT_QUICK_CLOSE_THRESHOLD) {
                ctx._mqttQuickCloseCount = 0;
                if (!ctx._mqttReauthing && globalAutoReLoginManager && globalAutoReLoginManager.isEnabled && globalAutoReLoginManager.isEnabled()) {
                    ctx._mqttReauthing = true;
                    
                    // Try to refresh tokens first before full re-login
                    try {
                        if (api && api.tokenRefreshManager && typeof api.tokenRefreshManager.refreshTokens === 'function') {
                            utils.log("MQTT", "Attempting token refresh before re-login...");
                            const refreshed = await api.tokenRefreshManager.refreshTokens(ctx, defaultFuncs, 'https://www.facebook.com');
                            if (refreshed) {
                                utils.log("MQTT", "Token refresh successful, resetting connection state");
                                ctx._mqttReauthing = false;
                                ctx._reconnectAttempts = 0;
                                scheduleReconnect((ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000);
                                return;
                            }
                        }
                    } catch (refreshErr) {
                        utils.warn("MQTT", "Token refresh failed, proceeding with full re-login:", refreshErr.message);
                    }
                    
                    globalAutoReLoginManager.handleSessionExpiry(api, 'https://www.facebook.com', "MQTT quick close loop")
                        .then((ok) => {
                            ctx._mqttReauthing = false;
                            if (ok && ctx.globalOptions.autoReconnect) {
                                ctx._reconnectAttempts = 0;
                                scheduleReconnect((ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000);
                            }
                        })
                        .catch(() => {
                            ctx._mqttReauthing = false;
                            if (ctx.globalOptions.autoReconnect) {
                                scheduleReconnect((ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000);
                            }
                        });
                    // Re-auth handles reconnect in its .then() — do not schedule a
                    // second reconnect here or both will race.
                    return;
                }
            }
        }

        if (ctx.globalOptions.autoReconnect) {
            ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
            const maxAttempts = (ctx._mqttOpt && ctx._mqttOpt.maxReconnectAttempts) || 100;
            if (ctx._reconnectAttempts > maxAttempts) {
                utils.warn("MQTT", `Max reconnect attempts (${maxAttempts}) reached. Pausing for 10 minutes before retrying.`);
                ctx._reconnectAttempts = 0;
                scheduleReconnect(10 * 60 * 1000);
                return;
            }
            const baseDelay = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000;
            const d = computeBackoffDelay(ctx, baseDelay, MQTT_MAX_BACKOFF, MQTT_JITTER_MAX);
            utils.warn("MQTT", `Reconnecting in ${d}ms (attempt ${ctx._reconnectAttempts}/${maxAttempts})`);
            scheduleReconnect(d);
        }
    }));

    mqttClient.on('disconnect', guard("disconnect", () => {
        utils.log("MQTT", "Disconnected");
        if (ctx._tmsTimeout) {
            clearTimeout(ctx._tmsTimeout);
            ctx._tmsTimeout = null;
        }
        if (ctx._mqttWatchdog) {
            clearInterval(ctx._mqttWatchdog);
            ctx._mqttWatchdog = null;
        }
        ctx._mqttConnected = false;
    }));

    mqttClient.on('offline', guard("offline", async () => {
        utils.warn("MQTT", "Connection went offline");
        if (ctx._tmsTimeout) {
            clearTimeout(ctx._tmsTimeout);
            ctx._tmsTimeout = null;
        }
        if (ctx._mqttWatchdog) {
            clearInterval(ctx._mqttWatchdog);
            ctx._mqttWatchdog = null;
        }
        ctx._mqttConnected = false;
        if (!ctx._ending && !ctx._cycling && ctx.globalOptions.autoReconnect) {
            try { mqttClient.end(true); } catch (_) { }
            
            // Try token refresh before reconnecting
            try {
                if (api && api.tokenRefreshManager && typeof api.tokenRefreshManager.refreshTokens === 'function') {
                    utils.log("MQTT", "Refreshing tokens before offline reconnect...");
                    await api.tokenRefreshManager.refreshTokens(ctx, defaultFuncs, 'https://www.facebook.com');
                }
            } catch (_) { /* Ignore refresh errors, will proceed with normal reconnect */ }
            
            // Schedule a reconnect — without this the bot silently stays offline.
            const baseDelay = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000;
            ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
            const d = computeBackoffDelay(ctx, baseDelay, MQTT_MAX_BACKOFF, MQTT_JITTER_MAX);
            utils.warn("MQTT", `Offline — reconnecting in ${d}ms`);
            scheduleReconnect(d);
        }
    }));
}

const MQTT_DEFAULTS = { 
    cycleMs: 30 * 60 * 1000, 
    reconnectDelayMs: 5000, 
    autoReconnect: true,
    watchdogIntervalMs: 30000,
    // 5 minutes — raised from 3 min. The MQTT keepalive is 60 s, so a healthy
    // idle connection gets a PINGRESP every minute.  3 min was too short for
    // quiet bots (overnight low-traffic periods) and caused constant cycling.
    staleMs: 300000,
    reconnectAfterStop: false,
    maxReconnectAttempts: 1000
};

function mqttConf(ctx, overrides) {
    ctx._mqttOpt = Object.assign({}, MQTT_DEFAULTS, ctx._mqttOpt || {}, overrides || {});
    if (typeof ctx._mqttOpt.autoReconnect === "boolean") {
        ctx.globalOptions.autoReconnect = ctx._mqttOpt.autoReconnect;
    }
    return ctx._mqttOpt;
}

module.exports = (defaultFuncs, api, ctx, opts) => {
    const identity = () => {};
    let globalCallback = identity;
    // Local per-invocation state — must NOT be module-level (see note above).
    let form = {};
    let getSeqID;

    function emitAuthError(reason, detail) {
        try { if (ctx._autoCycleTimer) clearTimeout(ctx._autoCycleTimer); } catch (_) { }
        try { if (ctx._reconnectTimer) clearTimeout(ctx._reconnectTimer); } catch (_) { }
        try { ctx._ending = true; } catch (_) { }
        try { if (ctx.mqttClient) ctx.mqttClient.end(true); } catch (_) { }
        ctx.mqttClient = undefined;
        ctx.loggedIn = false;

        // Permanent failures (account blocked, checkpoint) should not auto-recover.
        // Transient "not_logged_in" can recover after the session refreshes itself.
        const isPermanentFailure = /blocked|checkpoint|banned|disabled|account.*lock/i.test(reason + " " + (detail || ""));
        if (isPermanentFailure) {
            ctx._permanentFailure = true;
        }
        
        const msg = detail || reason;
        utils.error("AUTH", `Authentication error -> ${reason}: ${msg}`);
        
        if (typeof globalCallback === "function") {
            globalCallback({
                type: "account_inactive",
                reason: reason,
                error: msg,
                requiresReLogin: true,
                timestamp: Date.now()
            }, null);
        }
        try {
            if (globalAutoReLoginManager && globalAutoReLoginManager.isEnabled && globalAutoReLoginManager.isEnabled()) {
                globalAutoReLoginManager.handleSessionExpiry(api, 'https://www.facebook.com', "Session expired").then((ok) => {
                    if (ok && ctx._listeningActive && typeof api.listenMqtt === 'function') {
                        try {
                            if (typeof api.stopListening === 'function') {
                                try { api.stopListening(); } catch (_) {}
                            }
                            const cb = ctx._lastListenCallback || null;
                            if (cb) {
                                api.listenMqtt(cb);
                            } else {
                                api.listenMqtt();
                            }
                        } catch (_) {}
                    } else if (!ok && !isPermanentFailure && ctx.globalOptions && ctx.globalOptions.autoReconnect) {
                        // Re-login failed but this is not a permanent block — schedule a
                        // long-delay recovery. Facebook sessions often refresh on their own.
                        const recoveryDelay = 15 * 60 * 1000;
                        utils.warn("AUTH", `Re-login failed, scheduling recovery attempt in ${recoveryDelay / 60000} min`);
                        scheduleRecovery(recoveryDelay);
                    }
                }).catch(() => {
                    if (!isPermanentFailure && ctx.globalOptions && ctx.globalOptions.autoReconnect) {
                        const recoveryDelay = 15 * 60 * 1000;
                        utils.warn("AUTH", `Re-login error, scheduling recovery in ${recoveryDelay / 60000} min`);
                        scheduleRecovery(recoveryDelay);
                    }
                });
            } else if (!isPermanentFailure && ctx.globalOptions && ctx.globalOptions.autoReconnect) {
                // No autoReLogin configured — still attempt a long-delay recovery.
                // After 3 days, Facebook sessions may have temporarily expired but will
                // often accept new connections once the session cookie refreshes itself.
                const recoveryDelay = 10 * 60 * 1000;
                utils.warn("AUTH", `No autoReLogin configured, scheduling self-recovery in ${recoveryDelay / 60000} min`);
                scheduleRecovery(recoveryDelay);
            }
        } catch (_) {}
    }

    function installPostGuard() {
        if (ctx._postGuarded) return defaultFuncs.post;
        const rawPost = defaultFuncs.post && defaultFuncs.post.bind(defaultFuncs);
        if (!rawPost) return defaultFuncs.post;

        function postSafe(...args) {
            const lastArg = args[args.length - 1];
            const hasCallback = typeof lastArg === 'function';
            
            if (hasCallback) {
                const originalCallback = args[args.length - 1];
                args[args.length - 1] = function(err, ...cbArgs) {
                    if (err) {
                        const msg = (err && err.error) || (err && err.message) || String(err || "");
                        if (/Not logged in|Not logged in\.|blocked the login|checkpoint|security check|session.*expir|invalid.*session|authentication.*fail|auth.*fail/i.test(msg)) {
                            emitAuthError(
                                /blocked|checkpoint|security/i.test(msg) ? "login_blocked" : "not_logged_in",
                                msg
                            );
                        }
                    }
                    return originalCallback(err, ...cbArgs);
                };
                return rawPost(...args);
            } else {
                const result = rawPost(...args);
                if (result && typeof result.catch === 'function') {
                    return result.catch(err => {
                        const msg = (err && err.error) || (err && err.message) || String(err || "");
                        if (/Not logged in|Not logged in\.|blocked the login|checkpoint|security check|session.*expir|invalid.*session|authentication.*fail|auth.*fail/i.test(msg)) {
                            emitAuthError(
                                /blocked|checkpoint|security/i.test(msg) ? "login_blocked" : "not_logged_in",
                                msg
                            );
                        }
                        throw err;
                    });
                }
                return result;
            }
        }
        defaultFuncs.post = postSafe;
        ctx._postGuarded = true;
        utils.log("MQTT", "PostSafe guard installed for anti-automation detection");
        return postSafe;
    }

    function scheduleReconnect(delayMs) {
        const d = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000;
        const ms = typeof delayMs === "number" ? delayMs : d;
        if (ctx._ending) return;
        if (ctx._reconnectTimer) return;
        utils.warn("MQTT", `Will reconnect in ${ms}ms`);
        ctx._reconnectTimer = setTimeout(() => {
            ctx._reconnectTimer = null;
            getSeqIDWrapper();
        }, ms);
    }

    // scheduleRecovery bypasses the ctx._ending guard so the bot can recover
    // from auth-error shutdowns that are transient (e.g. 3-day session rotation).
    // It must NOT be called for permanent failures (checkpoint, banned account).
    function scheduleRecovery(delayMs) {
        if (ctx._permanentFailure) {
            utils.warn("MQTT", "Recovery skipped — permanent account failure detected");
            return;
        }
        if (ctx._recoveryTimer) return;
        const ms = typeof delayMs === "number" && delayMs > 0 ? delayMs : 10 * 60 * 1000;
        utils.warn("MQTT", `Recovery scheduled in ${Math.round(ms / 60000)} min — will reset state and retry`);
        ctx._recoveryTimer = setTimeout(() => {
            ctx._recoveryTimer = null;
            if (ctx._permanentFailure) return;
            utils.warn("MQTT", "Recovery attempt: resetting _ending flag and reconnecting");
            ctx._ending = false;
            ctx._reconnectAttempts = 0;
            ctx._seqIdFailCount = 0;
            if (!ctx._reconnectTimer) {
                getSeqIDWrapper();
            }
        }, ms);
    }

    let conf = mqttConf(ctx, opts);
    installPostGuard();

    getSeqID = retryWithBackoff(async () => {
        try {
            form = {
                av: ctx.globalOptions.pageID,
                queries: JSON.stringify({
                    o0: {
                        doc_id: "3336396659757871",
                        query_params: {
                            limit: 1,
                            before: null,
                            tags: ["INBOX"],
                            includeDeliveryReceipts: false,
                            includeSeqID: true
                        }
                    }
                })
            };
            utils.log("MQTT", "Getting sequence ID...");
            ctx.t_mqttCalled = false;
            const resData = await defaultFuncs.post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
            
            if (utils.getType(resData) !== "Array") {
                throw { error: "Not logged in" };
            }
            if (!Array.isArray(resData) || !resData.length) {
                throw { error: "getSeqID: empty response" };
            }
            
            const lastRes = resData[resData.length - 1];
            if (lastRes && lastRes.successful_results === 0) {
                throw { error: "getSeqID: no successful results" };
            }
            
            const syncSeqId = resData[0] && resData[0].o0 && resData[0].o0.data && resData[0].o0.data.viewer && resData[0].o0.data.viewer.message_threads && resData[0].o0.data.viewer.message_threads.sync_sequence_id;
            if (syncSeqId) {
                ctx.lastSeqId = syncSeqId;
                ctx._cycling = false;
                utils.log("MQTT", "getSeqID ok -> listenMqtt()");
                listenMqtt(defaultFuncs, api, ctx, globalCallback, scheduleReconnect, emitAuthError);
            } else {
                throw { error: "getSeqID: no sync_sequence_id found" };
            }
        } catch (err) {
            const detail = (err && err.detail && err.detail.message) ? ` | detail=${err.detail.message}` : "";
            const msg = ((err && err.error) || (err && err.message) || String(err || "")) + detail;
            
            if (/blocked the login|checkpoint|security check|authentication.*fail|auth.*fail|login.*block|account.*lock|verification.*requir|banned|disabled/i.test(msg)) {
                utils.error("MQTT", "Auth error in getSeqID: Session/Login blocked (permanent)");
                ctx._seqIdFailCount = 0;
                return emitAuthError("login_blocked", msg);
            }
            
            throw err; // Re-throw for retry mechanism
        }
    }, 3, 1500);

    function getSeqIDWrapper() {
        utils.log("MQTT", "getSeqID call");
        return getSeqID()
            .then(() => { 
                utils.log("MQTT", "getSeqID done");
                ctx._cycling = false;
            })
            .catch(e => { 
                utils.error("MQTT", `getSeqID error: ${e && e.message ? e.message : e}`);
                if (ctx.globalOptions.autoReconnect) {
                    ctx._reconnectAttempts = (ctx._reconnectAttempts || 0) + 1;
                    const baseDelay = (ctx._mqttOpt && ctx._mqttOpt.reconnectDelayMs) || 2000;
                    scheduleReconnect(computeBackoffDelay(ctx, baseDelay, MQTT_MAX_BACKOFF, MQTT_JITTER_MAX));
                }
            });
    }

    function isConnected() {
        return !!(ctx.mqttClient && ctx.mqttClient.connected);
    }

    function unsubAll(cb) {
        if (!isConnected()) return cb && cb();
        let pending = topics.length;
        if (!pending) return cb && cb();
        let fired = false;
        // Safety timeout: if any unsubscribe callback never fires (e.g. network
        // dropped mid-unsub), we still proceed so reconnect is never blocked.
        const safetyTimer = setTimeout(() => {
            if (!fired) {
                fired = true;
                cb && cb();
            }
        }, 3000);
        topics.forEach(t => {
            ctx.mqttClient.unsubscribe(t, () => {
                if (--pending === 0 && !fired) {
                    fired = true;
                    clearTimeout(safetyTimer);
                    cb && cb();
                }
            });
        });
    }

    function endQuietly(next) {
        const finish = () => {
            try { 
                ctx.mqttClient && ctx.mqttClient.removeAllListeners(); 
            } catch (_) { }
            if (ctx._tmsTimeout) {
                clearTimeout(ctx._tmsTimeout);
                ctx._tmsTimeout = null;
            }
            if (ctx._reconnectTimer) {
                clearTimeout(ctx._reconnectTimer);
                ctx._reconnectTimer = null;
            }
            if (ctx._recoveryTimer) {
                clearTimeout(ctx._recoveryTimer);
                ctx._recoveryTimer = null;
            }
            if (ctx._mqttWatchdog) {
                clearInterval(ctx._mqttWatchdog);
                ctx._mqttWatchdog = null;
            }
            ctx.mqttClient = undefined;
            ctx.lastSeqId = null;
            ctx.syncToken = undefined;
            ctx.t_mqttCalled = false;
            ctx._ending = false;
            ctx._mqttConnected = false;
            ctx._seqIdFailCount = 0;
            next && next();
        };
        try {
            if (ctx.mqttClient) {
                if (isConnected()) { 
                    try { 
                        ctx.mqttClient.publish("/browser_close", "{}"); 
                    } catch (_) { } 
                }
                ctx.mqttClient.end(true, finish);
            } else finish();
        } catch (_) { 
            finish(); 
        }
    }

    function delayedReconnect() {
        const d = conf.reconnectDelayMs;
        utils.log("MQTT", `Reconnect in ${d}ms`);
        setTimeout(() => getSeqIDWrapper(), d);
    }

    function forceCycle() {
        if (ctx._cycling) return;
        ctx._cycling = true;
        ctx._ending = true;
        utils.warn("MQTT", "Force cycle begin");
        unsubAll(() => endQuietly(() => delayedReconnect()));
    }

    return (callback) => {
        class MessageEmitter extends EventEmitter {
            stopListening(callback2) {
                const cb = callback2 || function() {};
                utils.log("MQTT", "Stop requested");
                globalCallback = identity;
                ctx._listeningActive = false;

                if (ctx._autoCycleTimer) {
                    clearInterval(ctx._autoCycleTimer);
                    ctx._autoCycleTimer = null;
                    utils.log("MQTT", "Auto-cycle cleared");
                }

                if (ctx._reconnectTimer) {
                    clearTimeout(ctx._reconnectTimer);
                    ctx._reconnectTimer = null;
                    utils.log("MQTT", "Reconnect timer cleared");
                }

                if (ctx._recoveryTimer) {
                    clearTimeout(ctx._recoveryTimer);
                    ctx._recoveryTimer = null;
                    utils.log("MQTT", "Recovery timer cleared");
                }

                if (ctx._tmsTimeout) {
                    clearTimeout(ctx._tmsTimeout);
                    ctx._tmsTimeout = null;
                    utils.log("MQTT", "TMS timeout cleared");
                }
                if (ctx._mqttWatchdog) {
                    clearInterval(ctx._mqttWatchdog);
                    ctx._mqttWatchdog = null;
                    utils.log("MQTT", "Watchdog cleared");
                }

                ctx._ending = true;
                ctx._permanentFailure = false;
                ctx._seqIdFailCount = 0;
                ctx._reconnectAttempts = 0;

                // Stop background timers that would keep making requests
                // to Facebook after the bot is supposed to be idle.
                try {
                    if (api.tokenRefreshManager && typeof api.tokenRefreshManager.stopAutoRefresh === 'function') {
                        api.tokenRefreshManager.stopAutoRefresh();
                        utils.log("MQTT", "Token refresh stopped");
                    }
                } catch (_) {}
                try {
                    if (globalAutoReLoginManager && typeof globalAutoReLoginManager.stopSessionMonitoring === 'function') {
                        globalAutoReLoginManager.stopSessionMonitoring();
                        utils.log("MQTT", "Session monitoring stopped");
                    }
                } catch (_) {}

                unsubAll(() => endQuietly(() => {
                    utils.log("MQTT", "Stopped successfully");
                    cb();
                    conf = mqttConf(ctx, conf);
                    if (conf.reconnectAfterStop) delayedReconnect();
                }));
            }

            async stopListeningAsync() {
                return new Promise(resolve => { 
                    this.stopListening(resolve); 
                });
            }
        }

        const msgEmitter = new MessageEmitter();

        globalCallback = callback || function(error, message) {
            if (error) { 
                utils.error("MQTT", "Emit error");
                return msgEmitter.emit("error", error); 
            }
            if (message && (message.type === "message" || message.type === "message_reply")) {
                markAsRead(ctx, api, message.threadID);
            }
            msgEmitter.emit("message", message);
        };

        ctx._listeningActive = true;
        ctx._lastListenCallback = callback || null;

        conf = mqttConf(ctx, conf);

        if (!ctx.firstListen) ctx.lastSeqId = null;
        ctx.syncToken = undefined;
        ctx.t_mqttCalled = false;

        if (ctx._autoCycleTimer) {
            clearTimeout(ctx._autoCycleTimer);
            ctx._autoCycleTimer = null;
        }

        function scheduleAutoCycle() {
            const base = conf.cycleMs;
            if (!base || base <= 0) return;
            const jitter = Math.floor(base * (0.2 + Math.random() * 0.4));
            const next = base + (Math.random() > 0.5 ? jitter : -jitter);
            ctx._autoCycleTimer = setTimeout(() => {
                ctx._autoCycleTimer = null;
                forceCycle();
                scheduleAutoCycle();
            }, next);
            utils.log("MQTT", `Auto-cycle scheduled: ${next}ms`);
        }
        if (conf.cycleMs && conf.cycleMs > 0) {
            scheduleAutoCycle();
        } else {
            utils.log("MQTT", "Auto-cycle disabled");
        }

        if (!ctx.firstListen || !ctx.lastSeqId) {
            getSeqIDWrapper();
        } else {
            utils.log("MQTT", "Starting listenMqtt");
            listenMqtt(defaultFuncs, api, ctx, globalCallback, scheduleReconnect, emitAuthError);
        }

        if (ctx.firstListen) {
            api.markAsReadAll().catch(err => {
                utils.error("Failed to mark all messages as read on startup:", err);
            });
        }

        ctx.firstListen = false;

        api.stopListening = msgEmitter.stopListening;
        api.stopListeningAsync = msgEmitter.stopListeningAsync;
        return msgEmitter;
    };
};
