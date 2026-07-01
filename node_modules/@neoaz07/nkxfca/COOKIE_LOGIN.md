# Login with Cookie Array

**nkxfca** supports multiple authentication methods. This guide explains how to login using a cookie array instead of email/password credentials.

> **Credits:** Developed and maintained by [NeoKEX](https://github.com/NeoKEX)

---

## Quick Start

```javascript
const { login } = require('@neoaz07/nkxfca');

const cookieArray = [
    { name: 'c_user', value: 'YOUR_USER_ID' },
    { name: 'xs', value: 'YOUR_SESSION_TOKEN' },
    { name: 'fr', value: 'YOUR_FR_TOKEN' },
    { name: 'datr', value: 'YOUR_DEVICE_TOKEN' }
];

login({ appState: cookieArray }, {}, (err, api) => {
    if (err) return console.error('Login failed:', err);
    console.log('Logged in as:', api.getCurrentUserID());
});
```

---

## Supported Cookie Formats

### 1. Cookie Array with `name` property (Recommended)
```javascript
const appState = [
    { name: 'c_user', value: '123456789' },
    { name: 'xs', value: 'abc123...' },
    // ... more cookies
];

login({ appState });
```

### 2. Cookie Array with `key` property
```javascript
const appState = [
    { key: 'c_user', value: '123456789' },
    { key: 'xs', value: 'abc123...' },
];

login({ appState });
```

### 3. Cookie String
```javascript
const cookieString = 'c_user=123456789; xs=abc123...; fr=xyz...; datr=...';

login({ appState: cookieString });
```

---

## Essential Cookies

| Cookie | Purpose | Notes |
|--------|---------|-------|
| `c_user` | User ID | Your Facebook user ID |
| `xs` | Session Token | Authentication token, required |
| `fr` | Fraud Detection | Device/browser fingerprint |
| `datr` | Device Token | Device identifier |

---

## How to Extract Cookies from Browser

### Chrome / Firefox / Edge
1. Navigate to `facebook.com` and log in normally
2. Open Developer Tools — press **F12**
3. Go to **Application** → **Cookies** → **facebook.com**
4. Find and copy these cookies: `c_user`, `xs`, `fr`, `datr`

### Export as Array (from browser console)
```javascript
copy(JSON.stringify(
    document.cookie.split('; ').map(c => {
        const [name, ...rest] = c.split('=');
        return { name, value: rest.join('=') };
    })
))
```

### Using a Browser Extension
- **Chrome/Edge:** "C3C FbState" or "CookieEditor"
- **Firefox:** "Cookie-Editor"

Export the cookies as JSON and save as `appstate.json`.

---

## Complete Example

```javascript
const fs = require('fs');
const { login } = require('@neoaz07/nkxfca');

const appState = JSON.parse(fs.readFileSync('appstate.json', 'utf8'));

login({ appState }, {
    online: true,
    listenEvents: true,
    autoMarkRead: true,
    autoReconnect: true,
    simulateTyping: true
}, (err, api) => {
    if (err) return console.error('Login failed:', err);

    console.log('Logged in as:', api.getCurrentUserID());

    api.listenMqtt((err, event) => {
        if (err || event.type !== 'message') return;
        console.log(`[${event.threadID}] ${event.senderID}: ${event.body}`);
    });
});
```

---

## Cookie Refresh

Facebook cookies may expire after hours or days. If login fails:
1. Log in to Facebook in your browser
2. Export fresh cookies using a browser extension
3. Replace your `appstate.json` with the new cookies
4. Restart your bot

---

## Security Notes

- **Never commit `appstate.json` to version control**
- **Never share your cookies publicly**
- Store cookies in environment variables or secure files (`.env`, secrets manager)
- Rotate cookies periodically for long-running bots
- Each cookie set is tied to a specific browser/device session — do not reuse across machines

---

## Troubleshooting

### Login Fails with Cookie Array
- Ensure `c_user` and `xs` cookies are present
- Check if the cookies are expired — extract fresh ones from your browser
- Verify cookie format: array of objects with `name` and `value` (or `key` and `value`)
- Make sure you are using cookies from a logged-in Facebook session

### Cookies Expire Quickly
- Facebook cookies expire faster when used from a new IP or User-Agent
- Use a consistent residential proxy to extend cookie life
- Avoid switching network locations frequently

### Account Suspended / Checkpoint
- Stop all bot activity immediately
- Complete any Facebook security check in your browser
- Wait at least 24–48 hours before resuming
- Reduce message frequency and enable warmup mode on restart

---

## Alternative: Email/Password Login

> Email/password login is not recommended for bots — it triggers stricter security checks.

```javascript
login({
    email: 'your-email@example.com',
    password: 'your-password'
}, {}, (err, api) => {
    if (err) return console.error(err);
    console.log('Logged in:', api.getCurrentUserID());
});
```

---

## AppState Backup

**nkxfca** automatically saves and restores your session state internally.  
To manually save the current session after login:

```javascript
const fs = require('fs');

login({ appState }, {}, (err, api) => {
    if (err) return;
    // Save refreshed appState
    fs.writeFileSync('appstate.json', JSON.stringify(api.getAppState(), null, 2));
});
```

---

## See Also
- [README.md](./README.md) — Full feature overview
- [examples/](./examples/) — Working code examples
- [CHANGELOG.md](./CHANGELOG.md) — Version history

---

> **Credits:** nkxfca is developed and maintained by [NeoKEX](https://github.com/NeoKEX).  
> Inspired by **ws3-fca** and **@dongdev/fca-unofficial**
