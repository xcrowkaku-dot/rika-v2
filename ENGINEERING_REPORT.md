# Eagle Bot v2.2.0 — Engineering Report (Rounds 1 + 2)

_Updated: 2026-06-29 — Two rounds of security, stability & feature hardening_

---

## Round 1 — Security & Stability Fixes (10 items)

| # | Area | Fix | Files |
|---|------|-----|-------|
| 1 | UX | Short professional ar/en auto-reply for private messages (≤160 chars) | `index.js` |
| 2 | Security | API key validation: ≥32 chars + uppercase + numbers + symbols; `process.exit(1)` if weak | `utils/config-validator.js` |
| 3 | Security | `config.json` + `*.log` in `.gitignore`; created `.env.example` + `config.example.json` | `.gitignore` |
| 4 | Observability | Logger `OK:1` → `SUCCESS:5` (unique level, distinct from INFO) | `utils/logger.js` |
| 5 | Performance | `groupsCache` LRU cap at 5000; overrides `Map.set` to evict oldest on overflow | `state.js`, `config/constants.js` |
| 6 | Resilience | MQTT exponential backoff: `5s × 2ⁿ`, max 10 attempts then `process.exit(1)` | `index.js` |
| 7 | Data safety | Atomic async session writes via `fs.promises.writeFile` + `.tmp → rename` | `utils/session.js` |
| 8 | Security | `sanitizePath()` with URL-decode + multi-pass traversal strip; XSS patterns in `sanitize()` | `api.js` |
| 9 | Security | CSRF token issued on login; all `POST/PUT/DELETE` require `X-CSRF-Token`; origin mismatch blocked | `api.js` |
| 10 | Quality | All `.catch(() => {})` replaced with `logger.warn/error()` calls | `index.js`, `api.js` |

---

## Round 2 — Advanced Security, Diagnostics & Features (9 items)

| # | Area | Fix | Files |
|---|------|-----|-------|
| 1 | Security | `authMiddleware` never bypasses: rejects missing or known-weak keys; fatal startup warning if `DASHBOARD_API_KEY` not set via env | `api.js` |
| 2 | Diagnostics | Login failure classifier: maps to `BLOCKED_OR_EXPIRED / FACEBOOK_CHECKPOINT / TWO_FACTOR / NETWORK_ERROR / UNKNOWN`; logs appstate cookie count + mtime only — cookie contents never exposed | `index.js` |
| 3 | Anti-detection | Adaptive backoff for `humanSimulator` + `cookieRefresher`: level 0→1→2 (1×/2×/4× intervals) on ≥3/≥5 consecutive login failures; cleared on stable login | `utils/humanSimulator.js`, `utils/cookieRefresher.js`, `index.js` |
| 4 | Reliability | `nickall` safe queue: 1 op per thread, configurable `maxPerMinute` rate limit, `nickall status` + `nickall stop` subcommands (instant abort, no revert) | `commands/nickall.js` |
| 5 | Features | `handleEvent` implements greet/farewell via `log:subscribe`/`log:unsubscribe` nkxfca event types; controlled by `config.features.greetNewMembers`/`farewellMembers` | `index.js` |
| 6 | UX | Auto-reply already hardened in Round 1 (≤160 chars, ar/en, guides user to group `help`) | `index.js` |
| 7 | Alerting | NEW `alertManager.js`: sends Messenger DM to admin IDs or external webhook on: 3 login failures, MQTT stale >10 min, 3 consecutive GitHub push failures. Rate-limited (1 alert/type/15 min) | `utils/alertManager.js`, `utils/health.js`, `utils/cookieRefresher.js` |
| 8 | Quality | `tests/` with built-in `node:test`: 4 suites covering `config-validator`, `antiSpam`, `lockedNames`, `nicknameLocks`. `npm test` script added | `tests/*.test.js`, `package.json` |
| 9 | Security | Audit: middleware rejects all known-default keys; `appstate/info` returns count+mtime only; `/config` endpoint strips `apiKey` + passwords; `sanitizePath` URL-decodes before strip; no tokens logged anywhere | `api.js`, `utils/session.js` |

---

## Security Posture Summary

| Threat | Before Round 1 | After Round 1 | After Round 2 |
|--------|---------------|--------------|--------------|
| Weak API key | Accepted silently | Rejected at startup | Also blocked in middleware; env-var warning |
| Cookie contents in logs | Possible | Removed | Verified: count + mtime only |
| Path traversal | None | Basic strip | URL-decoded before strip (3 passes) |
| XSS in dashboard inputs | Unprotected | Stripped | — |
| CSRF | None | Token required | — |
| Default credentials in git | Committed | `.gitignore` added | — |
| Login failures undetected | Silent retries | Logged | Classified + admin alerts |
| MQTT silent death | No detection | Watchdog | Alert sent + adaptive backoff |

---

## File Map

```
artifacts/messenger-bot/
├── index.js                  — Bot entry: login, MQTT, events, commands
├── api.js                    — Express dashboard + REST API + CSRF
├── state.js                  — In-memory state with LRU eviction
├── commands/
│   ├── nickall.js            — Rate-limited queue + status/stop
│   └── ...
├── utils/
│   ├── alertManager.js       — NEW: admin DM + webhook alerting
│   ├── antiSpam.js           — Cooldown + abuse detection
│   ├── config-validator.js   — Strong-key + field validation
│   ├── cookieRefresher.js    — Auto GitHub push (adaptive backoff)
│   ├── health.js             — Process watchdog + login/MQTT alert hooks
│   ├── humanSimulator.js     — Human behaviour (adaptive backoff)
│   ├── logger.js             — Rotating file logger (SUCCESS level 5)
│   ├── lockedNames.js        — Thread name lock map
│   ├── nicknameLocks.js      — Per-user nickname lock + enforcer
│   └── session.js            — Atomic async cookie persistence
├── config/
│   └── constants.js          — Shared tunables (MQTT, cache, security)
└── tests/
    ├── antiSpam.test.js
    ├── config-validator.test.js
    ├── lockedNames.test.js
    └── nicknameLocks.test.js
```

---

## How to Run Tests

```bash
cd artifacts/messenger-bot
node --test tests/**/*.test.js
# or via npm:
pnpm test
```

---

## Outstanding Item

The bot cannot log in because `appstate.json` cookies are rejected from Replit's IP — this is a **Facebook session issue**, not a code defect. Resolution:

1. Export fresh Facebook cookies from your browser (e.g. c3c FCA Ext / EditThisCookie)
2. Upload via dashboard: `POST /appstate/upload`
3. The bot saves, pushes to GitHub, and restarts automatically

---

# Madox v2.1.0 — Original Report (archived below)

**Date:** 2026-05-19  
**Scope:** Full codebase audit, bug repair, security hardening, and optimization  
**Files modified:** 12  
**Commits:** 12 (individual commit per file for traceable history)

---

## Critical Fixes

### 1. `commands/lockname.js` — SyntaxError (command failed to load entirely)

**Bug:** Raw literal newlines were embedded inside JavaScript string literals throughout the file.  
In JavaScript strict mode, a newline character inside a single- or double-quoted string literal is a syntax error. Every string that spanned more than one line using actual newlines (instead of `\n` escape sequences) caused Node's parser to throw a SyntaxError at module load time, making the entire `lockname` command permanently unavailable.

**Fix:** Rewrote all multi-line strings to use proper `\n` escape sequences.  
Affected messages: unlock confirmation, usage instructions, error messages, lock confirmation.

---

### 2. `api.js` — Path Traversal Security Vulnerability (3 endpoints)

**Bug:** The file sanitization code in the GET/POST/DELETE `/files/:filePath` endpoints used:
```js
const safe = sanitize(req.params.filePath, 100).replace(/../g, '');
```
In a JavaScript regex, `.` matches **any character** — not just a literal dot. The pattern `/../` therefore matches **any two-character sequence**, meaning every filename passed through this code had its characters progressively stripped (e.g. `config.json` → `nfig.json`). This mangled all valid filenames and silently broke the file-read/write dashboard features.

Worse: the intent of the replacement was to strip `..` (parent directory traversal). Because the regex was wrong, `../` sequences were NOT correctly stripped, leaving a residual path traversal risk that the `path.resolve() + startsWith()` guard only partially mitigated (it correctly blocks absolute escapes, but relative ones within the sanitized string could still behave unexpectedly).

**Fix:** Changed the regex to properly escape the dots:
```js
const safe = sanitize(req.params.filePath, 100).replace(/\.\./g, '');
```
Applied to all three endpoints (GET, POST, DELETE).

---

### 3. `api.js` — Wrong Environment Variable Name (2 endpoints)

**Bug:** The `/appstate/upload` and `/restart` endpoints used `process.env.GITHUB_TOKEN` to construct a `SessionManager` for GitHub cookie backup. The actual configured secret is `GITHUB_PERSONAL_ACCESS_TOKEN`. This caused all dashboard-triggered appstate uploads and pre-restart saves to silently use an empty token, making GitHub pushes fail with authentication errors.

**Fix:** Corrected both usages to `process.env.GITHUB_PERSONAL_ACCESS_TOKEN`.

---

## Robustness / API Guard Fixes

### 4. `commands/react.js` — messageID Property Variant

**Bug:** Used `event.messageID` unconditionally to react to a message. In some nkxfca forks and versions, the property is `messageId` (camelCase `d`) or `mid`. If the property was missing, `setMessageReaction` was called with `undefined`, which nkxfca silently rejects or throws.

**Fix:**
```js
const msgID = event.messageID || event.messageId || event.mid;
```
Added a null-check with a user-facing error if no ID is found.

---

### 5. `commands/profile.js` — getUserInfoV2 May Not Exist

**Bug:** Called `api.getUserInfoV2(targetID)` unconditionally. This method does not exist in the standard nkxfca API; it is present only in some forks. Calling an undefined function throws a TypeError that crashes the command handler.

**Fix:** Check `typeof api.getUserInfoV2 === "function"` before calling it, then fall back to the universally available `api.getUserInfo([targetID])`.

---

### 6. `commands/kick.js` — getThreadInfo Unguarded

**Bug:** `api.getThreadInfo(event.threadID)` was called without a try/catch to determine admin IDs. If the API call fails (network error, invalid thread, bot not in thread), the unhandled rejection crashed the command handler silently.

**Fix:** Wrapped in try/catch. On failure, `adminIDs` defaults to `[]` and the kick proceeds as a best-effort action, consistent with how other commands handle partial info loss.

---

### 7. `commands/members.js` — getUserInfo Unguarded + Large Group Support

**Bug:** A single `api.getUserInfo(allIDs)` call was made for all members at once. For groups with 100+ members, this exceeds Facebook's API batch size limit and throws. Also, the call had no error handling.

**Fix:** Batched into chunks of 50 with a try/catch per chunk. Added message chunking: if the full member list exceeds 3,800 characters (near Messenger's limit), it is split across multiple sequential messages.

---

### 8. `commands/poll.js` — createPoll API Guard

**Bug:** Called `api.createPoll(...)` unconditionally. This method is not available in all nkxfca versions. Calling an undefined function throws a TypeError.

**Fix:**
```js
if (typeof api.createPoll !== "function") {
  return api.sendMessage("❌ The poll feature is not supported by the current API version.", event.threadID);
}
```

---

### 9. `commands/theme.js` — getTheme / createAITheme / setThreadThemeMqtt Guards

**Bug:** Three separate API methods (`api.getTheme`, `api.createAITheme`, `api.setThreadThemeMqtt`) were called unconditionally. None of these are in the base nkxfca API and all vary by fork. Any missing method caused a TypeError.

**Fix:** Added `typeof api.X === "function"` guard before each call, with a fallback to `api.changeThreadColor` where applicable and a user-facing unsupported message otherwise.

---

### 10. `commands/emoji.js` — changeThreadEmoji Guard

**Bug:** `api.changeThreadEmoji` is not universally available. Called unconditionally.

**Fix:** Added runtime guard with user-facing "not supported" message if the method is absent.

---

### 11. `commands/admin.js` — gcrule / changeAdminStatus Fallback

**Bug:** `api.gcrule` is the primary method in nkxfca for promoting/demoting admins, but it is absent in several forks. Called unconditionally, causing a TypeError crash.

**Fix:** Tries `api.gcrule` first; falls back to `api.changeAdminStatus`; returns a user-friendly "not supported" message if neither exists.

---

## Infrastructure Fix

### 12. `nixpacks.toml` — Invalid Nix Package Name + pip Invocation

**Bug:** The nixpacks setup phase listed `python3-pip` as a package name. This is not a valid nixpkgs attribute — the correct name is `python3Packages.pip`. Additionally, the build phase used `pip3 install`, which may not be in PATH depending on the Nix profile.

**Fix:**
```toml
nixPkgs = ["python3", "python3Packages.pip", "ffmpeg", "git", "curl"]
```
```bash
python3 -m pip install -q --no-cache-dir yt-dlp
```
Using `python3 -m pip` is the most reliable invocation regardless of PATH configuration. Also changed `npm install` to `npm install --production` to exclude dev-only packages from the deployment image.

---

## Memory Leak Fix

### 13. `utils/antiSpam.js` — Purge Interval Logic

**Bug:** The cleanup interval ran every 2 minutes and deleted entries older than `_cooldownMs` (often 3 seconds). In practice, entries were deleted almost immediately since 3s < 120s, causing the map to flush constantly and potentially miss active cooldowns for users who re-trigger commands in the same 2-minute window. On the other hand, if `_cooldownMs` was reconfigured to a large value (e.g. 60s), the purge interval was too infrequent.

**Fix:** Purge interval extended to 5 minutes. Retention window set to `max(_cooldownMs * 2, 120_000)` to ensure entries are kept long enough to enforce the cooldown, while still cleaning up stale entries regularly.

---

## Summary Table

| File | Severity | Type | Fix |
|------|----------|------|-----|
| `commands/lockname.js` | 🔴 Critical | SyntaxError | Raw newlines → `\n` escapes |
| `api.js` | 🔴 Critical | Security | Path traversal regex `/../g` → `/\.\./g` (×3) |
| `api.js` | 🟠 High | Bug | Wrong env var `GITHUB_TOKEN` → `GITHUB_PERSONAL_ACCESS_TOKEN` (×2) |
| `commands/react.js` | 🟠 High | Bug | `event.messageID` fallback chain added |
| `commands/profile.js` | 🟠 High | Bug | `getUserInfoV2` → `getUserInfo` fallback |
| `commands/kick.js` | 🟡 Medium | Robustness | `getThreadInfo` wrapped in try/catch |
| `commands/members.js` | 🟡 Medium | Robustness | Batched getUserInfo + message chunking |
| `commands/poll.js` | 🟡 Medium | Robustness | `createPoll` method guard |
| `commands/theme.js` | 🟡 Medium | Robustness | Three API method guards + fallbacks |
| `commands/emoji.js` | 🟡 Medium | Robustness | `changeThreadEmoji` method guard |
| `commands/admin.js` | 🟡 Medium | Robustness | `gcrule` → `changeAdminStatus` fallback |
| `nixpacks.toml` | 🟡 Medium | Infrastructure | Correct nixpkgs name + `python3 -m pip` |
| `utils/antiSpam.js` | 🟢 Low | Memory leak | Improved purge interval and retention logic |

---

*Report generated automatically during maintenance pass. All changes are committed individually with descriptive messages for traceable git history.*
