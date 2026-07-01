# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [1.0.6] - 2026-03-31

### Fixed

**Session & Long-Term Stability**
- `sendTypingIndicator`: Now verifies `ctx.mqttClient` exists before publishing. Removed unreliable string-length heuristic for group detection — uses API lookup with per-session cache, same as `sendMessage`. Added 8-second timeout so a disconnected MQTT client can no longer hang the call indefinitely.
- `markAsRead`: Replaced a bare Promise that could hang forever if the MQTT client was silently disconnected. Publish now times out after 8 seconds and rejects cleanly.
- `logout`: After successful logout, sensitive tokens (`fb_dtsg`, `fb_dtsg_ag`, `lsd`, `access_token`) are cleared from context so stale credentials cannot be reused. Background timers (token refresh, session monitor, cookie backup) are stopped. The response cache is cleared.
- `buildAPI`: Wrapped `new URL(mqttEndpoint)` in a try/catch — a malformed or missing MQTT endpoint in the page HTML no longer throws an unhandled exception during login.

**Headers**
- `headers.js`: Spin params (`X-Fb-Spin-R/B/T`) were reading from `ctx.master`, which is never set anywhere in the codebase. Fixed to read `ctx.__spin_r`, `ctx.__spin_b`, `ctx.__spin_t` directly, since `buildAPI` spreads them into ctx. Affects both desktop and Android header paths.

**Rate Limiter / Concurrency**
- `rateLimiter.js`: `checkRateLimit` now returns a `release()` function instead of using a hard-coded 1-second `setTimeout` to decrement `activeRequests`. The slot is now released exactly when the request finishes, not after an arbitrary delay — preventing both premature slot release (too fast requests) and slot starvation (slow requests).
- `axios.js`: `requestWithRetry` calls `checkRateLimit` with the endpoint hint and wraps the entire retry loop in `try/finally` to guarantee the concurrency slot is always released regardless of success or failure.

**API Correctness**
- `sendMessage.js`: Error message for invalid `replyToMessage` type was reporting `threadIDType` instead of `messageIDType`.

**Branding & Documentation**
- All `dhoner-fca` references in `README.md`, `COOKIE_LOGIN.md`, `examples/verify.js`, `src/utils/constants.js`, and `src/utils/antiSuspension.js` updated to `@neoaz07/nkxfca`.
- Removed empty `examples/ping.js`.
- `.gitignore` cleaned of unrelated entries; `.npmignore` added to explicitly exclude Replit-specific files from the published package.

---

## [1.0.5] - 2026-03-31

### Fixed

**MQTT**
- `clientId` randomized per session — was hardcoded to `"mqttwsclient"`, causing the server to immediately kick existing connections on reconnect
- `unsubAll` now has a 3-second safety timeout so a stale network cannot permanently block the reconnect path

**HTTP / Axios**
- `postFormData` argument order corrected — `ctx` was not being passed, silently bypassing auth detection on file uploads
- `auto_login` flag resets after 2 minutes via safety timer — a crashed re-login attempt can no longer permanently suppress future session expiry detection

**Session Validation**
- `isSessionValid` no longer requires the user ID in the response body — removes false-negatives that triggered unnecessary re-logins

**Token & Cookie Persistence**
- AppState (cookies) now saved to the database after every token refresh, not only at initial login — prevents stale credentials after restart

**Re-Login**
- Re-login race condition fixed — multiple concurrent session-expiry detections no longer all attempt their own re-login simultaneously
- `SIGINT`/`SIGTERM` process handlers no longer accumulate across re-logins — registered once per process

**Cookie Backup**
- Cookies now saved to the database every 15 minutes (previously only at login)

---

## [1.0.0] - 2026-03-14

Initial public release of **nkxfca** — a full rewrite/rebranding of the FCA-KEX engine.  
Developed and maintained by [NeoKEX](https://github.com/NeoKEX).

### Added

**Core**
- Login via `appState` cookie arrays (supports `name/value`, `key/value`, and cookie strings)
- Multi-persona support: `desktop` (Chrome/Edge) and `android/mobile` personas
- Real-time MQTT messaging with `listenMqtt` and `sendMessageMqtt`
- HTTP send with automatic MQTT fallback (`sendMessage`)
- MQTT auto-reconnect with exponential backoff and jitter
- MQTT watchdog timer to detect and recover from idle/stale connections
- `TokenRefreshManager` with randomized refresh intervals to avoid detectable periodicity
- `AutoReLogin` using refreshed AppState on session expiry
- AppState backup/restore to disk to survive crashes
- SQLite-backed thread and user data caching via Sequelize

**Anti-Suspension System**
- `AntiSuspension` class with circuit breaker — trips after repeated suspension signals
- Expanded suspension signal detection: 60+ patterns covering checkpoints, spam flags, session expiry, rate limits, policy violations, identity verification, and more
- Adaptive per-thread message delay that scales with session volume
- Hourly and daily volume limits with automatic warning pauses
- `checkVolumeLimit()` called before every `sendMessage` and `sendMessageMqtt` send
- Warmup mode — reduced hourly limit for fresh sessions
- Session fingerprint locking: User-Agent, Sec-Ch-Ua, locale, timezone locked per session
- `safeRetry()` with suspension-aware exponential backoff
- `batchOperations()` for safe, sequential multi-send workflows

**API Methods**
- `api.sendMessage`, `api.sendMessageMqtt`, `api.listenMqtt`
- `api.editMessage`, `api.unsendMessage`, `api.forwardMessage`, `api.deleteMessage`
- `api.setMessageReaction`, `api.setMessageReactionMqtt`, `api.pinMessage`
- `api.sendTypingIndicator`, `api.markAsRead`, `api.markAsReadAll`, `api.markAsSeen`, `api.markAsDelivered`
- `api.getThreadInfo`, `api.getThreadList`, `api.getThreadHistory`, `api.getThreadPictures`
- `api.getMessage`, `api.getUserInfo`, `api.getUserInfoV2`, `api.getUserID`
- `api.getFriendsList`, `api.friend`, `api.unfriend`, `api.searchForThread`
- `api.createNewGroup`, `api.addUserToGroup`, `api.removeUserFromGroup`, `api.changeAdminStatus`
- `api.changeGroupImage`, `api.changeThreadColor`, `api.changeThreadEmoji`
- `api.gcname`, `api.emoji`, `api.nickname`, `api.theme`, `api.muteThread`
- `api.createPoll`, `api.handleMessageRequest`, `api.changeBlockedStatus`
- `api.changeAvatar`, `api.changeBio`, `api.comment`, `api.share`, `api.follow`
- `api.getTheme`, `api.getThemeInfo`, `api.setThreadTheme`, `api.setThreadThemeMqtt`
- `api.createAITheme`, `api.stickers.*`, `api.e2ee.*`
- `api.getHealthStatus`, `api.httpGet`, `api.httpPost`, `api.httpPostFormData`
- `api.addExternalModule`, `api.shareContact`, `api.resolvePhotoUrl`, `api.logout`

**TypeScript Support**
- Full `index.d.ts` with all methods, events, options, and types

**Production Monitoring**
- `ProductionMonitor` — request counts, error rates, response times, rate limit telemetry

---

> **Developed and maintained by [NeoKEX](https://github.com/NeoKEX)**  
> Inspired by **ws3-fca** and **@dongdev/fca-unofficial**

### Fixed

**MQTT Reliability**
- `close` handler now captures `wasConnected` before clearing `ctx._mqttConnected`, so the quick-close detection window is evaluated correctly instead of always being skipped
- Re-auth triggered by the quick-close threshold now `return`s immediately, preventing a duplicate reconnect from the normal backoff path racing against it
- `offline` event now schedules a backoff reconnect after ending the client — previously the bot would silently stay offline with no recovery
- Added `maxReconnectAttempts` cap (default 100): after hitting the cap the library pauses 10 minutes before resetting, preventing an indefinite 30 s retry loop that is a detectable bot pattern

**Session & Auth**
- `stopListening` now stops the token-refresh manager and session monitor — they were continuing to hit Facebook endpoints after the bot was asked to stop
- `api.isSessionValid` replaced the full homepage fetch (~400 kB) with a lightweight presence-ping endpoint, reducing bandwidth and detection surface
- `startSessionMonitoring(api)` moved to after `api.isSessionValid` is registered in `loginHelper`, so the health-check interval can actually invoke it (previously it was called 70 lines before `api.isSessionValid` existed)
- `setCredentials` now resets `retryCount = 0` on every fresh login, preventing 3 prior re-login failures from permanently locking out future re-logins for the process lifetime

**Core**
- Internal `listenMqtt` function now receives `emitAuthError` as a parameter at both call sites; previously both callers omitted it, causing a `ReferenceError` whenever an auth error arrived on the MQTT connection

---

## [1.0.0] - 2026-03-14

Initial public release of **dhoner-fca** — a full rewrite/rebranding of the FCA-KEX engine.  
Developed and maintained by [NeoKEX](https://github.com/NeoKEX).

### Added

**Core**
- Login via `appState` cookie arrays (supports `name/value`, `key/value`, and cookie strings)
- Multi-persona support: `desktop` (Chrome/Edge) and `android/mobile` personas
- Real-time MQTT messaging with `listenMqtt` and `sendMessageMqtt`
- HTTP send with automatic MQTT fallback (`sendMessage`)
- MQTT auto-reconnect with exponential backoff and jitter
- MQTT watchdog timer to detect and recover from idle/stale connections
- `TokenRefreshManager` with randomized refresh intervals to avoid detectable periodicity
- `AutoReLogin` using refreshed AppState on session expiry
- AppState backup/restore to disk to survive crashes
- SQLite-backed thread and user data caching via Sequelize

**Anti-Suspension System**
- `AntiSuspension` class with circuit breaker — trips after repeated suspension signals
- Expanded suspension signal detection: 60+ patterns covering checkpoints, spam flags, session expiry, rate limits, policy violations, identity verification, and more
- Adaptive per-thread message delay that scales with session volume
- Hourly and daily volume limits with automatic warning pauses
- `checkVolumeLimit()` called before every `sendMessage` and `sendMessageMqtt` send
- Warmup mode — reduced hourly limit for fresh sessions
- Session fingerprint locking: User-Agent, Sec-Ch-Ua, locale, timezone locked per session
- `safeRetry()` with suspension-aware exponential backoff
- `batchOperations()` for safe, sequential multi-send workflows
- MQTT Sec-Ch-Ua header updated to Chrome 136 (matching default User-Agent)
- PostSafe guard on HTTP post to detect auth failures in real-time

**API Methods**
- `api.sendMessage(msg, threadID)` — HTTP send with MQTT fallback
- `api.sendMessageMqtt(msg, threadID)` — MQTT send
- `api.listenMqtt(callback)` — real-time event listener
- `api.editMessage(text, messageID)` — in-place message edit
- `api.unsendMessage(messageID, threadID)` — retract a message
- `api.forwardMessage(messageID, threadID)` — forward a message
- `api.deleteMessage(messageIDs)` — delete locally
- `api.setMessageReaction(reaction, messageID)` — react via HTTP
- `api.setMessageReactionMqtt(reaction, messageID, threadID)` — react via MQTT
- `api.pinMessage(action, threadID, messageID?)` — pin/unpin/list pins
- `api.sendTypingIndicator(isTyping, threadID)` — typing status
- `api.markAsRead/markAsReadAll/markAsSeen/markAsDelivered` — message status
- `api.getThreadInfo/getThreadList/getThreadHistory/getThreadPictures` — thread data
- `api.getMessage(messageID)` — fetch a specific message
- `api.getUserInfo/getUserInfoV2/getUserID` — user data
- `api.getFriendsList/friend/unfriend` — friends management
- `api.searchForThread(name)` — search threads by name
- `api.createNewGroup/addUserToGroup/removeUserFromGroup/changeAdminStatus` — group admin
- `api.changeGroupImage/changeThreadColor/changeThreadEmoji` — group customization
- `api.gcname/emoji/nickname/theme` — per-thread personalization
- `api.muteThread/changeArchivedStatus/deleteThread` — thread management
- `api.createPoll` — create a poll in a thread
- `api.handleMessageRequest` — accept/decline message requests
- `api.changeBlockedStatus/changeAvatar/changeBio` — account actions
- `api.comment/share/follow` — social interactions
- `api.getTheme/getThemeInfo/setThreadTheme/setThreadThemeMqtt` — Messenger themes
- `api.createAITheme(prompt)` — generate AI-powered chat themes
- `api.stickers.search/listPacks/getStorePacks/addPack/getStickersInPack/getAiStickers` — sticker API
- `api.e2ee.enable/disable/getPublicKey/setPeerKey/encrypt/decrypt` — application-layer E2EE (X25519 + HKDF + AES-256-GCM)
- `api.getHealthStatus()` — MQTT, token refresh, and rate limiter telemetry
- `api.httpGet/httpPost/httpPostFormData` — raw HTTP helpers
- `api.addExternalModule(moduleObj)` — extend the API at runtime
- `api.shareContact/resolvePhotoUrl/getAccess/logout/getAppState/getCurrentUserID`
- `api.notes/gcrule/gcmember/story/realtime/getBotInfo/getBotInitialData/getUserInfoV2` — extended APIs

**TypeScript Support**
- Full `index.d.ts` with all methods, events, options, and types exported under `declare module "dhoner-fca"`

**Production Monitoring**
- `ProductionMonitor` — request counts, error rates, response times, rate limit telemetry
- `api.getHealthStatus()` providing MQTT, token refresh, and rate limiter stats

### Fixed
- Sec-Ch-Ua MQTT header aligned with Chrome 136 User-Agent (was Chrome 131)
- `sendMessageMqtt` now calls `prepareBeforeMessage` before every send
- `sendMessage` now calls `prepareBeforeMessage` before every send
- Volume limit checks (`isDailyLimitReached`, `isHourlyLimitReached`) now apply to both send paths
- TypeScript: removed duplicate `API` interface declaration and stray closing brace
- Database path renamed from `fca_kex_database` to `dhoner_fca_database`
- Credits function updated to reference `dhoner-fca` and `github.com/NeoKEX`

---

> **Developed and maintained by [NeoKEX](https://github.com/NeoKEX)**  
> Inspired by **ws3-fca** and **@dongdev/fca-unofficial**