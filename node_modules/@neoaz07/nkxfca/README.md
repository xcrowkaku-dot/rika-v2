# nkxfca

[![npm version](https://img.shields.io/npm/v/@neoaz07/nkxfca.svg)](https://www.npmjs.com/package/@neoaz07/nkxfca)
[![npm downloads](https://img.shields.io/npm/dm/@neoaz07/nkxfca.svg)](https://www.npmjs.com/package/@neoaz07/nkxfca)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![Node.js Version](https://img.shields.io/node/v/@neoaz07/nkxfca.svg)](https://nodejs.org)

**nkxfca** is an advanced Facebook Chat API (FCA) client built for **reliable**, **real-time**, and **modular** interaction with Facebook Messenger.

Developed and maintained by **[NeoKEX](https://github.com/NeoKEX)**.  
Inspired by **ws3-fca** and **@dongdev/fca-unofficial**

---

## Documentation

- **[Cookie Login Guide](COOKIE_LOGIN.md)** — Authenticate using browser cookies
- **[Changelog](CHANGELOG.md)** — Version history and updates
- **[Examples](examples/)** — Code examples and usage patterns

### Support & Issues

- GitHub: [https://github.com/NeoKEX](https://github.com/NeoKEX)
- Issues: [https://github.com/NeoKEX/nkxfca/issues](https://github.com/NeoKEX/nkxfca/issues)

---

## Features

**Authentication**
- Cookie array login (`appState`) — the safest method for long-running bots
- Email/password login with TOTP/2FA support
- Session fingerprint locking — User-Agent, Sec-Ch-Ua, locale, timezone locked per session to prevent detection
- AppState auto-backup and restore on restart

**Real-time Messaging**
- MQTT and HTTP messaging with automatic protocol fallback
- Send text, attachments, stickers, emoji, mentions, and location
- Message editing, unsend, forward, and delete
- Message reactions via HTTP and MQTT
- Pin/unpin messages, list pinned messages

**Anti-Suspension System**
- Circuit breaker — halts activity after repeated suspension signals, resumes after cooldown
- 60+ suspension signal patterns: checkpoints, spam flags, rate limits, identity verification, policy violations, session expiry, and more
- Adaptive per-thread delay that increases with session volume
- Hourly and daily message volume limits with automatic warning pauses
- Warmup mode for fresh sessions — gradually increases allowed message rate
- Humanized typing simulation before every send
- Randomized request intervals and jitter to avoid periodicity detection
- Session fingerprint locking to maintain consistent browser identity
- PostSafe guard: detects auth failures and checkpoint responses in real-time
- MQTT watchdog: detects stale connections and forces clean reconnect

**Stability & Reliability**
- MQTT auto-reconnect with exponential backoff and jitter
- Auto re-login using refreshed AppState when session expires
- TokenRefreshManager with randomized intervals to keep sessions alive
- Sliding-window rate limiter with per-endpoint tracking and accurate concurrency control
- SQLite-backed thread and user data cache for fast lookups

**Thread & Group Management**
- Get thread info, history, pictures, and lists
- Create groups, add/remove members, change admin status
- Update group image, name, color, emoji
- Archive, mute, delete threads
- Create polls, manage notes and rules
- Search threads by name, handle message requests

**User & Friends**
- Get user info (basic and extended), resolve user IDs
- Get full friends list, send/cancel friend requests, unfriend, block/unblock

**Social**
- Comment on posts, share posts, follow/unfollow users

**Themes & Stickers**
- Browse 90+ Messenger themes, apply themes via MQTT
- Generate AI-powered themes with text prompts
- Search stickers, browse packs, add packs, get AI stickers

**E2EE (Opt-In)**
- Application-layer end-to-end encryption for DMs using X25519 + HKDF + AES-256-GCM

**Monitoring**
- `api.getHealthStatus()` — MQTT status, token refresh stats, rate limiter metrics
- Built-in `ProductionMonitor` for request/error/performance telemetry

**Proxy Support**
- Full proxy support via the `proxy` login option

---

## Installation

> **Requirements:** Node.js v20.0.0 or higher

```bash
npm install @neoaz07/nkxfca
```

---

## Quick Start

```js
const fs = require("fs");
const { login } = require("@neoaz07/nkxfca");

const appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));

login({ appState }, {
  online: true,
  listenEvents: true,
  autoMarkRead: true,
  autoReconnect: true,
  simulateTyping: true
}, (err, api) => {
  if (err) return console.error("Login error:", err);

  console.log("Logged in as:", api.getCurrentUserID());

  api.listenMqtt((err, event) => {
    if (err || event.type !== "message" || !event.body) return;

    if (event.body === "/ping") {
      api.sendMessage("pong!", event.threadID);
    }
  });
});
```

---

## Anti-Suspension Configuration

The anti-suspension system is active by default. You can tune it through login options:

```js
login({ appState }, {
  autoReconnect: true,
  listenEvents: true,
  autoMarkRead: true,
  simulateTyping: true,       // humanized typing delays before send
  randomUserAgent: true,      // rotate user agent on each session
  persona: "desktop",         // "desktop" or "android"
  maxConcurrentRequests: 5,   // max parallel HTTP requests
  maxRequestsPerMinute: 50,   // sliding-window rate cap
  requestCooldownMs: 60000,   // per-endpoint cooldown duration
  errorCacheTtlMs: 300000     // how long to suppress repeated errors
}, (err, api) => {
  if (err) throw err;

  // Check anti-suspension and rate limiter status
  console.log(api.getHealthStatus());
});
```

### Circuit Breaker

The circuit breaker trips automatically after detecting 2 or more suspension signals (checkpoints, spam flags, rate limits, etc.). It pauses all activity for 45 minutes by default.

You can also trip or reset it manually:

```js
const { globalAntiSuspension } = require("@neoaz07/nkxfca/src/utils/antiSuspension");

// Manually trip (e.g. after you detect a warning in a response)
globalAntiSuspension.tripCircuitBreaker("manual_pause", 30 * 60 * 1000); // 30 min

// Reset after you've resolved the issue
globalAntiSuspension.resetCircuitBreaker();

// Check status
console.log(globalAntiSuspension.getConfig());
```

### Warmup Mode

Use warmup mode when starting a fresh or recovered session:

```js
const { globalAntiSuspension } = require("@neoaz07/nkxfca/src/utils/antiSuspension");
globalAntiSuspension.enableWarmup(); // limits to 25 msg/hour for 20 minutes
```

---

## End-to-End Encryption for DMs (Opt-In)

Encrypt and decrypt message bodies in direct chats using X25519 + HKDF + AES-256-GCM.

```js
api.e2ee.enable();

// Share your bot's public key with the peer
const botPubKey = api.e2ee.getPublicKey();

// Register the peer's public key for a DM thread
api.e2ee.setPeerKey(threadID, peerPublicKeyBase64);

// Messages to that thread are now auto-encrypted on send
// and auto-decrypted on receive
api.sendMessage("Top secret message", threadID);
```

---

## Security Warning

`appstate.json` contains your Facebook session and must be treated like a password:

- **Never commit `appstate.json` to version control**
- **Never share your `appstate.json` publicly**
- Add it to `.gitignore`
- Use environment variables or a secrets manager in production

---

## Getting Started — Generate `appstate.json`

1. Install a cookie export extension:
   - Chrome/Edge: **C3C FbState** or **CookieEditor**
   - Firefox: **Cookie-Editor**

2. Log in to Facebook in your browser

3. Export cookies as JSON and save as `appstate.json`:

```json
[
  { "key": "c_user", "value": "your-user-id" },
  { "key": "xs", "value": "your-xs-value" }
]
```

4. Use in your bot:

```js
const { login } = require("@neoaz07/nkxfca");
const appState = require("./appstate.json");
login({ appState }, {}, (err, api) => { ... });
```

See **[COOKIE_LOGIN.md](COOKIE_LOGIN.md)** for more formats and troubleshooting.

---

## Bot Example with Commands

```js
const fs = require("fs");
const path = require("path");
const { login } = require("@neoaz07/nkxfca");

const appState = JSON.parse(fs.readFileSync("appstate.json", "utf8"));

login({ appState }, {
  online: true,
  selfListen: false,
  simulateTyping: true,
  autoReconnect: true
}, async (err, api) => {
  if (err) return console.error("Login error:", err);

  console.log("Logged in as:", api.getCurrentUserID());

  const commandsDir = path.join(__dirname, "commands");
  const commands = new Map();

  if (fs.existsSync(commandsDir)) {
    for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith(".js"))) {
      const cmd = require(path.join(commandsDir, file));
      if (cmd.name && typeof cmd.execute === "function") {
        commands.set(cmd.name, cmd);
      }
    }
  }

  api.listenMqtt(async (err, event) => {
    if (err || event.type !== "message" || !event.body) return;

    const prefix = "/";
    if (!event.body.startsWith(prefix)) return;

    const args = event.body.slice(prefix.length).trim().split(/ +/);
    const name = args.shift().toLowerCase();
    const cmd = commands.get(name);
    if (!cmd) return;

    try {
      await cmd.execute({ api, event, args });
    } catch (e) {
      console.error(`Error in /${name}:`, e.message);
      api.sendMessage("An error occurred.", event.threadID);
    }
  });
});
```

---

## AI Themes

```js
// Generate an AI theme from a text prompt
const aiThemes = await api.createAITheme("vibrant ocean sunset purple");
if (aiThemes && aiThemes.length > 0) {
  await api.setThreadThemeMqtt(threadID, aiThemes[0].id);
}

// Browse standard themes
const themes = await api.getTheme(threadID);
await api.setThreadThemeMqtt(threadID, themes[0].id);

// Check current theme
const info = await api.getThemeInfo(threadID);
console.log(info.color, info.emoji);
```

---

## API Reference

### Authentication
| Method | Description |
|---|---|
| `login(credentials, options, callback)` | Log in and receive the API object |
| `api.logout()` | End the session |
| `api.getAppState()` | Get current session cookies |
| `api.getCurrentUserID()` | Get logged-in user ID |

### Messaging
| Method | Description |
|---|---|
| `api.sendMessage(msg, threadID)` | Send (HTTP + MQTT fallback) |
| `api.sendMessageMqtt(msg, threadID)` | Send over MQTT |
| `api.editMessage(text, messageID)` | Edit a message |
| `api.unsendMessage(messageID, threadID)` | Retract a message |
| `api.forwardMessage(messageID, threadID)` | Forward a message |
| `api.deleteMessage(messageIDs)` | Delete locally |
| `api.shareContact(senderID, threadID)` | Share a contact card |

### Reactions & Status
| Method | Description |
|---|---|
| `api.setMessageReaction(reaction, messageID)` | React via HTTP |
| `api.setMessageReactionMqtt(reaction, messageID, threadID)` | React via MQTT |
| `api.sendTypingIndicator(isTyping, threadID)` | Show/hide typing |
| `api.markAsRead(threadID)` | Mark thread as read |
| `api.markAsReadAll()` | Mark all threads as read |
| `api.markAsSeen()` | Mark as seen |
| `api.markAsDelivered(threadID, messageID)` | Mark as delivered |

### Threads
| Method | Description |
|---|---|
| `api.getThreadInfo(threadID)` | Thread metadata |
| `api.getThreadList(limit, timestamp, tags)` | List threads |
| `api.getThreadHistory(threadID, amount, timestamp)` | Message history |
| `api.getThreadPictures(threadID, offset, limit)` | Thread images |
| `api.searchForThread(name)` | Search by name |
| `api.createNewGroup(participantIDs, name?)` | Create group |
| `api.deleteThread(threadID)` | Delete thread |
| `api.muteThread(threadID, muteSeconds)` | Mute thread |
| `api.changeArchivedStatus(threadID, archive)` | Archive/unarchive |
| `api.pinMessage(action, threadID, messageID?)` | Pin/unpin/list |
| `api.createPoll(title, threadID, options?)` | Create poll |
| `api.handleMessageRequest(threadID, accept)` | Accept/decline |

### Group Admin
| Method | Description |
|---|---|
| `api.addUserToGroup(userID, threadID)` | Add member |
| `api.removeUserFromGroup(userID, threadID)` | Remove member |
| `api.changeAdminStatus(threadID, userID, isAdmin)` | Promote/demote |
| `api.changeGroupImage(image, threadID)` | Group photo |
| `api.gcname(name, threadID)` | Rename group |

### Users
| Method | Description |
|---|---|
| `api.getUserInfo(id)` | Basic user info |
| `api.getUserInfoV2(id)` | Extended user info |
| `api.getUserID(name)` | Resolve name to ID |
| `api.getFriendsList()` | Friends list |
| `api.getBotInfo()` | Bot account info |

### Themes & Customization
| Method | Description |
|---|---|
| `api.getTheme(threadID)` | List available themes |
| `api.getThemeInfo(threadID)` | Current theme |
| `api.setThreadThemeMqtt(threadID, themeID)` | Apply theme |
| `api.createAITheme(prompt)` | AI theme |
| `api.changeThreadColor(color, threadID)` | Thread color |
| `api.changeThreadEmoji(emoji, threadID)` | Thread emoji |
| `api.nickname(nickname, threadID, participantID)` | Set nickname |
| `api.emoji(emoji, threadID)` | Thread emoji shorthand |

### Stickers
| Method | Description |
|---|---|
| `api.stickers.search(query)` | Search stickers |
| `api.stickers.listPacks()` | Installed packs |
| `api.stickers.getStorePacks()` | Sticker store |
| `api.stickers.addPack(packID)` | Add pack |
| `api.stickers.getStickersInPack(packID)` | Stickers in pack |
| `api.stickers.getAiStickers(options?)` | AI stickers |

### E2EE
| Method | Description |
|---|---|
| `api.e2ee.enable()` | Enable E2EE |
| `api.e2ee.disable()` | Disable E2EE |
| `api.e2ee.getPublicKey()` | Get public key |
| `api.e2ee.setPeerKey(threadID, key)` | Set peer key |
| `api.e2ee.hasPeer(threadID)` | Has peer key |
| `api.e2ee.clearPeerKey(threadID)` | Remove peer key |

### Social
| Method | Description |
|---|---|
| `api.comment(msg, postID)` | Comment on post |
| `api.share(postID)` | Share post |
| `api.follow(userID, follow)` | Follow/unfollow |
| `api.unfriend(userID)` | Unfriend |
| `api.changeBlockedStatus(userID, block)` | Block/unblock |

### Health
| Method | Description |
|---|---|
| `api.getHealthStatus()` | MQTT, token, rate limiter stats |

---

## Login Options

| Option | Type | Default | Description |
|---|---|---|---|
| `online` | `boolean` | `true` | Appear online |
| `selfListen` | `boolean` | `false` | Receive own messages |
| `listenEvents` | `boolean` | `true` | Receive thread events |
| `listenTyping` | `boolean` | `false` | Receive typing events |
| `updatePresence` | `boolean` | `false` | Broadcast presence |
| `autoMarkDelivery` | `boolean` | `false` | Auto-mark delivered |
| `autoMarkRead` | `boolean` | `true` | Auto-mark read |
| `autoReconnect` | `boolean` | `true` | MQTT auto-reconnect |
| `simulateTyping` | `boolean` | `true` | Humanized typing delays |
| `randomUserAgent` | `boolean` | `false` | Random User-Agent |
| `persona` | `"desktop"\|"android"` | `"desktop"` | Browser persona |
| `proxy` | `string` | — | Proxy URL |
| `forceLogin` | `boolean` | `false` | Force fresh login |
| `maxConcurrentRequests` | `number` | `5` | Max parallel requests |
| `maxRequestsPerMinute` | `number` | `50` | Rate cap per minute |
| `requestCooldownMs` | `number` | `60000` | Endpoint cooldown |
| `errorCacheTtlMs` | `number` | `300000` | Error suppression TTL |
| `stealthMode` | `boolean` | `false` | Extra stealth headers |

---

## Examples

See the **[examples/](examples/)** directory:
- `login-with-cookies.js` — Cookie-based authentication guide
- `verify.js` — Verify the library loads correctly

---

## Credits

- **Developed and maintained by [NeoKEX](https://github.com/NeoKEX)**
- **NeoKEX Team** — development, maintenance, and feature contributions
- **Inspired by ws3-fca** — by @NethWs3Dev and @CommunityExocore

> Copyright (c) 2026 NeoKEX

---

## License

**MIT** — Free to use, modify, and distribute. Attribution appreciated.

See [LICENSE](LICENSE) for full license text.

---

## Links

- **npm:** [https://www.npmjs.com/package/@neoaz07/nkxfca](https://www.npmjs.com/package/@neoaz07/nkxfca)
- **GitHub:** [https://github.com/NeoKEX](https://github.com/NeoKEX)
- **Issues:** [https://github.com/NeoKEX/nkxfca/issues](https://github.com/NeoKEX/nkxfca/issues)
