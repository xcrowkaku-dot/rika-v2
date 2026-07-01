/* eslint-disable no-prototype-builtins */
"use strict";

const axios = require("axios");
const { CookieJar } = require("tough-cookie");
const { wrapper } = require("axios-cookiejar-support");
const FormData = require("form-data");
const { getHeaders } = require("./headers");
const { getType } = require("./constants");
const { globalRateLimiter } = require("./rateLimiter");

const jar = new CookieJar();
const client = wrapper(axios.create({ jar }));

let proxyConfig = {};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Fast path for simple delays - use setImmediate for 0ms delays
const fastDelay = (ms) => {
    if (ms <= 0) return Promise.resolve();
    if (ms <= 1) return new Promise(resolve => setImmediate(resolve));
    return new Promise(resolve => setTimeout(resolve, ms));
};

function adaptResponse(res) {
    const response = res.response || res;
    return {
        ...response,
        body: response.data,
        statusCode: response.status,
        request: {
            uri: new URL(response.config.url),
            headers: response.config.headers,
            method: response.config.method.toUpperCase(),
            form: response.config.data,
            formData: response.config.data
        },
    };
}

/**
 * Inspects an API response body for signs of session expiry or Facebook
 * bot-detection checkpoints and emits the appropriate signals on ctx.
 *
 * Returns true if the response looks like a valid authenticated response,
 * false if it signals logout / checkpoint.
 *
 * When a logout is detected and ctx.performAutoLogin is available the
 * function fires it (non-blocking) and throws so the caller knows the
 * original response is unusable.
 */
async function inspectResponseForSessionIssues(adapted, ctx) {
    if (!ctx || ctx._skipSessionInspect) return;

    const body = adapted.body;
    if (!body) return;

    const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

    // Facebook bot-detection checkpoint IDs
    const isCheckpoint282 = bodyStr.includes('1501092823525282');
    const isCheckpoint956 = bodyStr.includes('828281030927956');
    const isScrapingWarning = bodyStr.includes('XCheckpointFBScrapingWarningController');

    if (isCheckpoint282) {
        const err = new Error('Bot checkpoint 282 detected. Please verify the account.');
        err.error = 'checkpoint_282';
        err.res = body;
        if (ctx._emitter && typeof ctx._emitter.emit === 'function') {
            ctx._emitter.emit('checkpoint_282', { res: body });
        }
        throw err;
    }

    if (isCheckpoint956) {
        const err = new Error('Bot checkpoint 956 detected. Please verify the account.');
        err.error = 'checkpoint_956';
        err.res = body;
        if (ctx._emitter && typeof ctx._emitter.emit === 'function') {
            ctx._emitter.emit('checkpoint_956', { res: body });
        }
        throw err;
    }

    if (isScrapingWarning) {
        const err = new Error('Facebook scraping warning checkpoint detected.');
        err.error = 'checkpoint_scraping';
        err.res = body;
        if (ctx._emitter && typeof ctx._emitter.emit === 'function') {
            ctx._emitter.emit('checkpoint', { type: 'scraping_warning', res: body });
        }
        throw err;
    }

    // Detect session expiry / forced logout.
    // IMPORTANT: Facebook's authenticated homepage also contains login.php links
    // in its nav/footer and has <title>Facebook</title> — any broad HTML-content
    // check will produce false positives and break valid sessions.
    // We ONLY flag a response as a login redirect when:
    //   • The page contains the actual login form elements, OR
    //   • A parsed JSON body explicitly redirects to login.php via a "redirect" field.
    const isLoginRedirect =
        bodyStr.includes('<form id="login_form"') ||
        bodyStr.includes('id="loginbutton"') ||
        bodyStr.includes('"login_page"') ||
        // JSON responses that carry an explicit redirect to the login page.
        // "next" appears alongside login.php only in unauthenticated redirect payloads.
        (bodyStr.includes('login.php') && bodyStr.includes('"next":"'));

    const isLoginBlocked =
        typeof body === 'object' && body !== null && body.error === 1357001;

    if (isLoginBlocked) {
        const err = new Error('Facebook blocked the login.');
        err.error = 'login_blocked';
        err.res = body;
        throw err;
    }

    if (isLoginRedirect) {
        if (ctx._emitter && typeof ctx._emitter.emit === 'function') {
            ctx._emitter.emit('sessionExpired', { res: body });
        }

        if (!ctx.auto_login && typeof ctx.performAutoLogin === 'function') {
            ctx.auto_login = true;
            // Safety: reset the flag after 2 minutes no matter what so future
            // session expiries are never silently swallowed.
            const autoLoginSafetyTimer = setTimeout(() => { ctx.auto_login = false; }, 120000);
            try {
                const ok = await ctx.performAutoLogin();
                clearTimeout(autoLoginSafetyTimer);
                ctx.auto_login = false;
                if (!ok) {
                    const err = new Error('Not logged in. Auto re-login failed.');
                    err.error = 'Not logged in.';
                    err.res = body;
                    throw err;
                }
            } catch (autoErr) {
                clearTimeout(autoLoginSafetyTimer);
                ctx.auto_login = false;
                throw autoErr;
            }
        } else {
            const err = new Error('Not logged in. Session has expired.');
            err.error = 'Not logged in.';
            err.res = body;
            throw err;
        }
    }
}

async function requestWithRetry(requestFunction, retries = 5, endpoint = '', threadID = '', ctx = null) {
    // Fast path for simple requests
    const isSimpleRequest = !endpoint && !threadID;
    
    // Acquire rate limit slot with optimized path
    let releaseSlot = null;
    if (!isSimpleRequest) {
        releaseSlot = await globalRateLimiter.checkRateLimit(false, endpoint);
    }

    // Check cooldowns efficiently
    if (!isSimpleRequest) {
        if (globalRateLimiter.isEndpointOnCooldown("__GLOBAL__")) {
            const cooldown = globalRateLimiter.getEndpointCooldownRemaining("__GLOBAL__");
            if (cooldown > 0) {
                console.warn(`Global cooldown active. Waiting ${cooldown}ms...`);
                await delay(cooldown);
            }
        }

        if (endpoint && globalRateLimiter.isEndpointOnCooldown(endpoint)) {
            const cooldown = globalRateLimiter.getEndpointCooldownRemaining(endpoint);
            if (cooldown > 0) {
                console.warn(`Endpoint ${endpoint} on cooldown. Waiting ${cooldown}ms...`);
                await delay(cooldown);
            }
        }

        if (threadID && globalRateLimiter.isThreadOnCooldown(threadID)) {
            const cooldown = globalRateLimiter.getCooldownRemaining(threadID);
            if (cooldown > 0) {
                console.warn(`Thread ${threadID} on cooldown. Waiting ${cooldown}ms...`);
                await delay(cooldown);
            }
        }
    }

    const checkAndApplyRateLimitCooldowns = (responseBody) => {
        const ERROR_COOLDOWNS = {
            1545012: 60000,
            1675004: 30000,
            368: 120000,
            404: 5000,
            500: 10000,
            503: 30000
        };

        const applyCooldown = (errorCode) => {
            if (errorCode && ERROR_COOLDOWNS[errorCode]) {
                if (threadID) {
                    globalRateLimiter.setThreadCooldown(threadID, ERROR_COOLDOWNS[errorCode]);
                }
                if (endpoint) {
                    globalRateLimiter.setEndpointCooldown(endpoint, ERROR_COOLDOWNS[errorCode]);
                }
                console.warn(`Rate limit detected (error ${errorCode}). Applied cooldown.`);
                return true;
            }
            return false;
        };

        if (!responseBody || typeof responseBody !== 'object') {
            return false;
        }

        if (applyCooldown(responseBody.error)) {
            return true;
        }

        if (Array.isArray(responseBody)) {
            for (const item of responseBody) {
                if (item && typeof item === 'object') {
                    if (applyCooldown(item.error)) return true;
                    if (item.errors && Array.isArray(item.errors)) {
                        for (const err of item.errors) {
                            const code = err.code || err.extensions?.code;
                            if (applyCooldown(code)) return true;
                        }
                    }
                }
            }
        }

        if (responseBody.errors && Array.isArray(responseBody.errors)) {
            for (const err of responseBody.errors) {
                const code = err.code || err.extensions?.code;
                if (applyCooldown(code)) return true;
            }
        }

        return false;
    };

    try {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await requestFunction();
                const adapted = adaptResponse(res);

                checkAndApplyRateLimitCooldowns(adapted.body);

                // Inspect for session expiry / bot-detection checkpoints
                await inspectResponseForSessionIssues(adapted, ctx);

                return adapted;
            } catch (error) {
                // If this is a session/checkpoint error we already raised, propagate immediately
                if (error.error === 'Not logged in.' ||
                    error.error === 'checkpoint_282' ||
                    error.error === 'checkpoint_956' ||
                    error.error === 'checkpoint_scraping' ||
                    error.error === 'login_blocked') {
                    throw error;
                }

                // Abort immediately on invalid header characters - retrying won't help
                if (error.code === 'ERR_INVALID_CHAR' ||
                    (error.message && error.message.includes('Invalid character in header'))) {
                    const e = new Error('Invalid header content detected. Request aborted.');
                    e.error = 'invalid_header';
                    e.code = 'ERR_INVALID_CHAR';
                    e.originalError = error;
                    throw e;
                }

                // Network errors - might be transient
                const isNetworkError = error.code && [
                    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH',
                    'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT'
                ].includes(error.code);

                if (error.response) {
                    const adapted = adaptResponse(error.response);
                    checkAndApplyRateLimitCooldowns(adapted.body);
                }

                if (i === retries - 1) {
                    console.error(`Request failed after ${retries} attempts:`, error.message);
                    if (error.response) {
                        return adaptResponse(error.response);
                    }
                    throw error;
                }
                
                // Adaptive backoff: network errors get shorter delays
                const baseMultiplier = isNetworkError ? 0.5 : 1;
                const backoffTime = Math.min(
                    (Math.pow(2, i) * 1000 * baseMultiplier) + Math.floor(Math.random() * 1000),
                    30000 // Cap at 30 seconds
                );
                
                if (backoffTime > 100) {
                    console.warn(`Request attempt ${i + 1} failed. Retrying in ${Math.round(backoffTime)}ms...`);
                    await delay(backoffTime);
                } else {
                    // Fast path for very short delays
                    await fastDelay(backoffTime);
                }
            }
        }
    } finally {
        // Always release the concurrency slot regardless of outcome.
        if (typeof releaseSlot === 'function') releaseSlot();
    }
}

function setProxy(proxyUrl) {
    if (proxyUrl) {
        try {
            const parsedProxy = new URL(proxyUrl);
            proxyConfig = {
                proxy: {
                    host: parsedProxy.hostname,
                    port: parsedProxy.port,
                    protocol: parsedProxy.protocol.replace(":", ""),
                    auth: parsedProxy.username && parsedProxy.password ? {
                        username: parsedProxy.username,
                        password: parsedProxy.password,
                    } : undefined,
                },
            };
        } catch (e) {
            console.error("Invalid proxy URL. Please use a full URL format (e.g., http://user:pass@host:port).");
            proxyConfig = {};
        }
    } else {
        proxyConfig = {};
    }
}

function cleanGet(url) {
    const fn = () => client.get(url, { timeout: 60000, ...proxyConfig });
    return requestWithRetry(fn);
}

async function get(url, reqJar, qs, options, ctx, customHeader) {
    const config = {
        headers: getHeaders(url, options, ctx, customHeader),
        timeout: 60000,
        params: qs,
        ...proxyConfig,
        validateStatus: (status) => status >= 200 && status < 600,
        // Enable response compression for faster transfers
        decompress: true,
        // Optimize for performance
        maxContentLength: 50 * 1024 * 1024, // 50MB max
        maxBodyLength: 50 * 1024 * 1024
    };
    const endpoint = new URL(url).pathname;
    const threadHint = ctx && ctx.requestThreadID ? String(ctx.requestThreadID) : '';
    return requestWithRetry(async () => await client.get(url, config), 3, endpoint, threadHint, ctx);
}

async function post(url, reqJar, form, options, ctx, customHeader) {
    const headers = getHeaders(url, options, ctx, customHeader, 'xhr');
    let data = form;
    let contentType = headers['Content-Type'] || 'application/x-www-form-urlencoded';

    if (contentType.includes('json')) {
        data = JSON.stringify(form);
    } else {
        // Use URLSearchParams for better performance on large forms
        const transformedForm = new URLSearchParams();
        for (const key in form) {
            if (form.hasOwnProperty(key)) {
                let value = form[key];
                if (getType(value) === "Object") {
                    value = JSON.stringify(value);
                }
                transformedForm.append(key, value);
            }
        }
        data = transformedForm.toString();
    }

    headers['Content-Type'] = contentType;

    const config = {
        headers,
        timeout: 60000,
        ...proxyConfig,
        validateStatus: (status) => status >= 200 && status < 600,
        decompress: true,
        maxContentLength: 50 * 1024 * 1024,
        maxBodyLength: 50 * 1024 * 1024
    };
    const endpoint = new URL(url).pathname;
    const threadHint = ctx && ctx.requestThreadID ? String(ctx.requestThreadID) : '';
    return requestWithRetry(async () => await client.post(url, data, config), 3, endpoint, threadHint, ctx);
}

async function postFormData(url, reqJar, form, qs, options, ctx) {
    const formData = new FormData();
    for (const key in form) {
        if (form.hasOwnProperty(key)) {
            formData.append(key, form[key]);
        }
    }

    const customHeader = { "Content-Type": `multipart/form-data; boundary=${formData.getBoundary()}` };

    const config = {
        headers: getHeaders(url, options, ctx, customHeader, 'xhr'),
        timeout: 60000,
        params: qs,
        ...proxyConfig,
        validateStatus: (status) => status >= 200 && status < 600,
    };
    const endpoint = new URL(url).pathname;
    const threadHint = ctx && ctx.requestThreadID ? String(ctx.requestThreadID) : '';
    return requestWithRetry(async () => await client.post(url, formData, config), 3, endpoint, threadHint, ctx);
}

module.exports = {
  cleanGet,
  get,
  post,
  postFormData,
  getJar: () => jar,
  setProxy,
  requestWithRetry
};
