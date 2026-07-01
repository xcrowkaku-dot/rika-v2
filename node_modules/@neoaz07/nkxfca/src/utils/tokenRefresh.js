"use strict";

const utils = require('./index');
const { globalAutoReLoginManager } = require('./autoReLogin');

/**
 * Token Refresh Manager - Enhanced for Maximum Reliability
 * Automatically refreshes fb_dtsg, lsd, and other tokens to prevent expiration
 */

class TokenRefreshManager {
    constructor() {
        this.refreshInterval = null;
        this.REFRESH_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours base
        this.SESSION_CHECK_INTERVAL_MS = 20 * 60 * 1000; // 20 minutes - more frequent health checks
        this.PRESENCE_KEEPALIVE_MS = 5 * 60 * 1000; // 5 minutes - frequent keepalive
        this.COOKIE_REFRESH_INTERVAL_MS = 12 * 60 * 60 * 1000; // 12 hours - twice daily cookie refresh
        this.lastRefresh = Date.now();
        this.lastSessionCheck = Date.now();
        this.lastPresencePing = Date.now();
        this.lastCookieRefresh = Date.now();
        this.failureCount = 0;
        this.MAX_FAILURES = 15; // More tolerance for long-running bots
        this.onSessionExpiry = null;
        this.sessionHealthCheckInterval = null;
        this.presenceKeepaliveInterval = null;
        this.cookieRefreshInterval = null;
        // Lock mechanism to prevent concurrent refresh attempts
        this.isRefreshing = false;
        this.refreshLock = null;
        // Track consecutive successes for adaptive intervals
        this.consecutiveSuccesses = 0;
        // Store context for later use
        this.storedCtx = null;
        this.storedDefaultFuncs = null;
        this.storedFbLink = null;
        // Token cache to minimize requests
        this.tokenCache = new Map();
    }

    /**
     * Acquire refresh lock to prevent concurrent token refresh attempts
     * @returns {Promise<boolean>} true if lock acquired, false if already locked
     */
    async acquireRefreshLock() {
        if (this.isRefreshing) {
            // Wait for existing refresh to complete
            try {
                await this.refreshLock;
            } catch (_) {
                // Previous refresh failed, we can proceed
            }
        }
        
        if (this.isRefreshing) {
            return false; // Still refreshing after waiting
        }
        
        this.isRefreshing = true;
        this.refreshLock = new Promise((resolve) => {
            this._releaseLock = resolve;
        });
        return true;
    }

    /**
     * Release the refresh lock
     */
    releaseRefreshLock() {
        this.isRefreshing = false;
        if (this._releaseLock) {
            this._releaseLock();
            this._releaseLock = null;
        }
    }

    /**
     * Start automatic token refresh with optimized intervals
     * @param {Object} ctx - Application context
     * @param {Object} defaultFuncs - Default functions
     * @param {string} fbLink - Facebook link
     */
    startAutoRefresh(ctx, defaultFuncs, fbLink) {
        // Store context for later recovery
        this.storedCtx = ctx;
        this.storedDefaultFuncs = defaultFuncs;
        this.storedFbLink = fbLink;
        
        if (this.refreshInterval) {
            clearInterval(this.refreshInterval);
            this.refreshInterval = null;
        }
        if (this.sessionHealthCheckInterval) {
            clearInterval(this.sessionHealthCheckInterval);
            this.sessionHealthCheckInterval = null;
        }
        if (this.presenceKeepaliveInterval) {
            clearInterval(this.presenceKeepaliveInterval);
            this.presenceKeepaliveInterval = null;
        }
        if (this.cookieRefreshInterval) {
            clearInterval(this.cookieRefreshInterval);
            this.cookieRefreshInterval = null;
        }

        const scheduleNext = () => {
            // Adaptive interval: longer after consecutive successes
            const base = this.REFRESH_INTERVAL_MS;
            const successBonus = Math.min(this.consecutiveSuccesses * 15 * 60 * 1000, 4 * 60 * 60 * 1000); // Up to 4 hours bonus
            const interval = base + successBonus;
            
            this.refreshInterval = setTimeout(async () => {
                try {
                    const refreshed = await this.refreshTokens(ctx, defaultFuncs, fbLink);
                    if (refreshed) {
                        this.consecutiveSuccesses++;
                        utils.log("TokenRefresh", `Tokens refreshed successfully (consecutive successes: ${this.consecutiveSuccesses})`);
                    } else {
                        this.consecutiveSuccesses = 0;
                    }
                } catch (error) {
                    this.consecutiveSuccesses = 0;
                    utils.error("TokenRefresh", "Failed to refresh tokens:", error.message);
                } finally {
                    scheduleNext();
                }
            }, interval);
            utils.log("TokenRefresh", `Auto-refresh scheduled in ${Math.round(interval / 60000)}min`);
        };

        // Start session health checks - frequent to catch issues early
        this.sessionHealthCheckInterval = setInterval(async () => {
            try {
                const isHealthy = await this.checkSessionHealth(ctx, defaultFuncs, fbLink);
                if (isHealthy === 'network_error') {
                    utils.warn("TokenRefresh", "Session health probe returned network error — skipping refresh (transient)");
                    return;
                }
                if (!isHealthy) {
                    utils.warn("TokenRefresh", "Session health check failed, triggering refresh");
                    this.consecutiveSuccesses = 0;
                    const refreshed = await this.refreshTokens(ctx, defaultFuncs, fbLink);
                    if (!refreshed) {
                        // Try alternative refresh method
                        await this.refreshTokensAlternative(ctx, defaultFuncs, fbLink);
                    }
                }
            } catch (error) {
                utils.error("TokenRefresh", "Session health check error:", error.message);
            }
        }, this.SESSION_CHECK_INTERVAL_MS);

        // Start presence keepalive for low-activity bots
        this.presenceKeepaliveInterval = setInterval(async () => {
            try {
                await this.sendPresenceKeepalive(ctx);
            } catch (error) {
                utils.warn("TokenRefresh", "Presence keepalive failed:", error.message);
            }
        }, this.PRESENCE_KEEPALIVE_MS);
        
        // Start cookie refresh interval
        this.cookieRefreshInterval = setInterval(async () => {
            try {
                await this.refreshCookies(ctx, defaultFuncs, fbLink);
            } catch (error) {
                utils.warn("TokenRefresh", "Cookie refresh failed:", error.message);
            }
        }, this.COOKIE_REFRESH_INTERVAL_MS);

        utils.log("TokenRefresh", `Session health checks every ${Math.round(this.SESSION_CHECK_INTERVAL_MS / 60000)}min, keepalive every ${Math.round(this.PRESENCE_KEEPALIVE_MS / 60000)}min, cookie refresh every 12h`);

        scheduleNext();
    }

    /**
     * Check if session is healthy using a lightweight AJAX ping instead of a
     * full homepage load.  Fetching the full homepage every 2 hours is a clear
     * automation fingerprint; a small presence/ping endpoint is far less
     * conspicuous and produces a much smaller response.
     *
     * @param {Object} ctx - Application context
     * @param {Object} defaultFuncs - Default functions
     * @param {string} fbLink - Facebook link
     * @returns {Promise<boolean>}
     */
    async checkSessionHealth(ctx, defaultFuncs, fbLink) {
        try {
            // Use a lightweight AJAX endpoint that only returns a small JSON
            // payload — not the full multi-megabyte homepage.
            const probeUrl = 'https://www.facebook.com/ajax/presence/reconnect.php';
            const probeCtx = { ...ctx, _skipSessionInspect: true };
            const resp = await utils.get(
                probeUrl,
                ctx.jar,
                { reason: 'reconnect', __a: 1, __req: 'probe' },
                ctx.globalOptions,
                probeCtx
            );

            const body = resp.body;
            if (!body) return false;

            const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);

            // If we get a login-page redirect in the probe response the session is gone
            const isLoginPage =
                bodyStr.includes('<form id="login_form"') ||
                bodyStr.includes('"login_page"') ||
                bodyStr.includes('id="loginbutton"');

            if (isLoginPage) return false;

            const isCheckpoint =
                bodyStr.includes('"checkpoint"') && bodyStr.includes('"flow_type"');
            if (isCheckpoint) return false;

            this.lastSessionCheck = Date.now();
            return true;
        } catch (error) {
            const msg = error.message || '';
            const code = error.code || '';
            const NETWORK_CODES = ['ECONNRESET','ETIMEDOUT','ECONNREFUSED','ENETUNREACH',
                                   'EHOSTUNREACH','EAI_AGAIN','ENOTFOUND','ESOCKETTIMEDOUT'];
            const isNetworkErr = NETWORK_CODES.some(c => code === c || msg.includes(c)) ||
                                 msg.includes('socket hang up') || msg.includes('network error');
            if (isNetworkErr) {
                utils.warn("TokenRefresh", "Session health check: network error (ignoring):", msg);
                // Return a sentinel so callers can skip refresh instead of triggering re-login.
                return 'network_error';
            }
            if (msg.includes('Not logged in') || msg.includes('Session has expired')) {
                utils.error("TokenRefresh", "Session health check: session expired:", msg);
                return false;
            }
            utils.warn("TokenRefresh", "Session health check unexpected error (treating as healthy):", msg);
            return true;
        }
    }

    /**
     * Manually refresh tokens with retry logic
     * @param {Object} ctx - Application context
     * @param {Object} defaultFuncs - Default functions
     * @param {string} fbLink - Facebook link
     * @param {number} retryCount - Current retry attempt (internal use)
     * @returns {Promise<boolean>}
     */
    async refreshTokens(ctx, defaultFuncs, fbLink, retryCount = 0) {
        // Acquire lock to prevent concurrent refresh attempts
        const lockAcquired = await this.acquireRefreshLock();
        if (!lockAcquired) {
            utils.warn("TokenRefresh", "Token refresh already in progress, skipping concurrent request");
            return false;
        }

        const MAX_RETRIES = 3;
        const RETRY_DELAYS = [2000, 5000, 10000];
        
        try {
            // Validate ctx.jar exists
            if (!ctx || !ctx.jar) {
                throw new Error("Invalid context: cookie jar not available");
            }

            const resp = await utils.get(fbLink, ctx.jar, null, ctx.globalOptions, { noRef: true });
            
            const html = resp.body;
            if (!html) {
                throw new Error("Empty response from Facebook");
            }

            // Precise check - broad html.includes("login") is a false positive because
            // Facebook includes the word "login" all over authenticated pages too.
            const isLoginPage = html.includes('<form id="login_form"') ||
                               html.includes('id="loginbutton"') ||
                               html.includes('"login_page"') ||
                               html.includes('id="email" name="email"');
            const isCheckpoint = html.includes('"checkpoint"') && html.includes('"flow_type"');

            if (isLoginPage || isCheckpoint) {
                if (isCheckpoint) {
                    try {
                        const { globalAntiSuspension } = require('./antiSuspension');
                        globalAntiSuspension.tripCircuitBreaker('checkpoint_on_token_refresh', 60 * 60 * 1000);
                    } catch (lockErr) {
                        utils.warn("TokenRefresh", "Failed to trip circuit breaker for checkpoint:", lockErr.message);
                    }
                }
                throw new Error("Session expired or checkpoint required");
            }

            const dtsgMatch = html.match(/"DTSGInitialData",\[],{"token":"([^"]+)"/);
            if (dtsgMatch) {
                ctx.fb_dtsg = dtsgMatch[1];
                ctx.ttstamp = "2";
                for (let i = 0; i < ctx.fb_dtsg.length; i++) {
                    ctx.ttstamp += ctx.fb_dtsg.charCodeAt(i);
                }
            } else {
                throw new Error("Failed to extract fb_dtsg token");
            }

            const lsdMatch = html.match(/"LSD",\[],{"token":"([^"]+)"/);
            if (lsdMatch) {
                ctx.lsd = lsdMatch[1];
            }

            const jazoestMatch = html.match(/jazoest=(\d+)/);
            if (jazoestMatch) {
                ctx.jazoest = jazoestMatch[1];
            }

            const revisionMatch = html.match(/"client_revision":(\d+)/);
            if (revisionMatch) {
                ctx.__rev = revisionMatch[1];
            }

            // Extract additional tokens for better session persistence
            const dtsgAgMatch = html.match(/"DTSGAGInitialData",\[],{"token":"([^"]+)"/);
            if (dtsgAgMatch) {
                ctx.fb_dtsg_ag = dtsgAgMatch[1];
            }

            const spinRMatch = html.match(/"__spin_r":(\d+)/);
            if (spinRMatch) {
                ctx.__spin_r = spinRMatch[1];
            }

            const spinBMatch = html.match(/"__spin_b":"([^"]+)"/);
            if (spinBMatch) {
                ctx.__spin_b = spinBMatch[1];
            }

            const spinTMatch = html.match(/"__spin_t":(\d+)/);
            if (spinTMatch) {
                ctx.__spin_t = spinTMatch[1];
            }

            const hsiMatch = html.match(/"hsi":"(\d+)"/);
            if (hsiMatch) {
                ctx.hsi = hsiMatch[1];
            }

            const dynMatch = html.match(/"dyn":"([^"]+)"/);
            if (dynMatch) {
                ctx.dyn = dynMatch[1];
            }

            const csrMatch = html.match(/"csr":"([^"]+)"/);
            if (csrMatch) {
                ctx.csr = csrMatch[1];
            }

            this.lastRefresh = Date.now();
            this.failureCount = 0;
            try {
                if (globalAutoReLoginManager && globalAutoReLoginManager.isEnabled && globalAutoReLoginManager.isEnabled()) {
                    const appState = utils.getAppState(ctx.jar);
                    globalAutoReLoginManager.updateAppState(appState);
                }
            } catch (updateErr) {
                utils.warn("TokenRefresh", "Failed to update appState in re-login manager:", updateErr.message);
            }
            // Persist the refreshed cookies to the database so that a bot
            // restart after a token refresh doesn't load stale cookies.
            try {
                const { backupAppStateSQL } = require('../database/appStateBackup');
                await backupAppStateSQL(ctx.jar, ctx.userID);
                utils.log("TokenRefresh", "AppState persisted to database after token refresh");
            } catch (backupErr) {
                utils.warn("TokenRefresh", "Failed to persist AppState after token refresh:", backupErr.message);
            }
            return true;
        } catch (error) {
            this.failureCount++;
            utils.error("TokenRefresh", `Refresh failed (attempt ${retryCount + 1}/${MAX_RETRIES + 1}):`, error.message);
            
            if (this.failureCount >= this.MAX_FAILURES) {
                utils.error("TokenRefresh", `Maximum failures (${this.MAX_FAILURES}) reached. Session may be expired.`);
                if (this.onSessionExpiry && typeof this.onSessionExpiry === 'function') {
                    this.onSessionExpiry(error);
                }
                return false;
            }
            
            if (retryCount < MAX_RETRIES) {
                const delay = RETRY_DELAYS[retryCount];
                utils.log("TokenRefresh", `Retrying in ${delay}ms...`);
                // Release the lock BEFORE the recursive call — the inner call
                // needs to acquire it and would deadlock waiting on a lock held
                // by this call (which in turn is blocked awaiting the inner call).
                this.releaseRefreshLock();
                await new Promise(resolve => setTimeout(resolve, delay));
                return await this.refreshTokens(ctx, defaultFuncs, fbLink, retryCount + 1);
            }
            
            return false;
        } finally {
            // Always release the lock
            this.releaseRefreshLock();
        }
    }

    /**
     * Alternative token refresh using different endpoints - fallback method
     * @param {Object} ctx - Application context
     * @param {Object} defaultFuncs - Default functions
     * @param {string} fbLink - Facebook link
     * @returns {Promise<boolean>}
     */
    async refreshTokensAlternative(ctx, defaultFuncs, fbLink) {
        const endpoints = [
            'https://www.facebook.com/ajax/bootloader-endpoint/',
            'https://www.facebook.com/ajax/navigation/',
            'https://www.messenger.com/',
            'https://www.facebook.com/messages/'
        ];
        
        for (const endpoint of endpoints) {
            try {
                utils.log("TokenRefresh", `Trying alternative endpoint: ${endpoint}`);
                const resp = await utils.get(endpoint, ctx.jar, { __a: 1 }, ctx.globalOptions, { noRef: true, _skipSessionInspect: true });
                const html = resp.body;
                
                if (!html || typeof html !== 'string') continue;
                
                // Check for login page
                if (html.includes('<form id="login_form"') || html.includes('id="loginbutton"')) {
                    continue; // Try next endpoint
                }
                
                // Try to extract tokens with multiple patterns
                const tokens = this.extractTokensFromHtml(html);
                if (tokens.fb_dtsg) {
                    ctx.fb_dtsg = tokens.fb_dtsg;
                    ctx.ttstamp = "2";
                    for (let i = 0; i < ctx.fb_dtsg.length; i++) {
                        ctx.ttstamp += ctx.fb_dtsg.charCodeAt(i);
                    }
                }
                if (tokens.lsd) ctx.lsd = tokens.lsd;
                if (tokens.jazoest) ctx.jazoest = tokens.jazoest;
                if (tokens.__rev) ctx.__rev = tokens.__rev;
                
                if (tokens.fb_dtsg) {
                    utils.log("TokenRefresh", `Alternative refresh successful via ${endpoint}`);
                    this.lastRefresh = Date.now();
                    this.failureCount = 0;
                    
                    // Persist tokens
                    try {
                        const { backupAppStateSQL } = require('../database/appStateBackup');
                        await backupAppStateSQL(ctx.jar, ctx.userID);
                    } catch (_) {}
                    
                    return true;
                }
            } catch (error) {
                utils.warn("TokenRefresh", `Alternative endpoint ${endpoint} failed:`, error.message);
                continue;
            }
        }
        
        return false;
    }

    /**
     * Extract all tokens from HTML using multiple regex patterns
     * @param {string} html - HTML content
     * @returns {Object} Extracted tokens
     */
    extractTokensFromHtml(html) {
        const tokens = {};
        
        // DTSG patterns
        const dtsgPatterns = [
            /"DTSGInitialData",\[],{"token":"([^"]+)"/,
            /name="fb_dtsg" value="([^"]+)"/,
            /"token":"([^"]+)"[^}]*"DTSGInitialData"/,
            /DTSG[^}]*token[^"]*"([^"]+)"/
        ];
        
        for (const pattern of dtsgPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                tokens.fb_dtsg = match[1];
                break;
            }
        }
        
        // LSD patterns
        const lsdPatterns = [
            /"LSD",\[],{"token":"([^"]+)"/,
            /name="lsd" value="([^"]+)"/
        ];
        
        for (const pattern of lsdPatterns) {
            const match = html.match(pattern);
            if (match && match[1]) {
                tokens.lsd = match[1];
                break;
            }
        }
        
        // Jazoest
        const jazoestMatch = html.match(/jazoest=(\d+)/) || html.match(/name="jazoest" value="(\d+)/);
        if (jazoestMatch) tokens.jazoest = jazoestMatch[1];
        
        // Revision
        const revMatch = html.match(/"client_revision":(\d+)/) || html.match(/"__rev":(\d+)/);
        if (revMatch) tokens.__rev = revMatch[1];
        
        // Additional tokens
        const hsiMatch = html.match(/"hsi":"(\d+)"/);
        if (hsiMatch) tokens.hsi = hsiMatch[1];
        
        const dynMatch = html.match(/"dyn":"([^"]+)"/);
        if (dynMatch) tokens.dyn = dynMatch[1];
        
        const csrMatch = html.match(/"csr":"([^"]+)"/);
        if (csrMatch) tokens.csr = csrMatch[1];
        
        return tokens;
    }

    /**
     * Send a lightweight presence keepalive ping to prevent session expiration
     * due to inactivity for low-activity bots.
     * @param {Object} ctx - Application context
     */
    async sendPresenceKeepalive(ctx) {
        try {
            // Use the same lightweight endpoint as session health check
            const probeUrl = 'https://www.facebook.com/ajax/presence/reconnect.php';
            const resp = await utils.get(
                probeUrl,
                ctx.jar,
                { reason: 'keepalive', __a: 1, __req: 'keepalive' },
                ctx.globalOptions,
                { noRef: true, _skipSessionInspect: true }
            );
            this.lastPresencePing = Date.now();
            return true;
        } catch (error) {
            // Silent failure - don't spam logs for keepalive failures
            return false;
        }
    }

    /**
     * Refresh cookies to extend session lifetime
     * @param {Object} ctx - Application context
     * @param {Object} defaultFuncs - Default functions
     * @param {string} fbLink - Facebook link
     */
    async refreshCookies(ctx, defaultFuncs, fbLink) {
        try {
            // Visit a lightweight page to refresh cookies
            const probeUrl = 'https://www.facebook.com/ajax/bootloader-endpoint/'; 
            const probeCtx = { ...ctx, _skipSessionInspect: true };
            await utils.get(
                probeUrl,
                ctx.jar,
                { __a: 1, __req: 'cookierefresh' },
                ctx.globalOptions,
                probeCtx
            );
            
            this.lastCookieRefresh = Date.now();
            utils.log("TokenRefresh", "Cookies refreshed successfully");
            
            // Persist updated cookies
            try {
                const { backupAppStateSQL } = require('../database/appStateBackup');
                await backupAppStateSQL(ctx.jar, ctx.userID);
            } catch (backupErr) {
                utils.warn("TokenRefresh", "Failed to persist refreshed cookies:", backupErr.message);
            }
            
            return true;
        } catch (error) {
            utils.warn("TokenRefresh", "Cookie refresh failed:", error.message);
            return false;
        }
    }

    /**
     * Stop automatic token refresh
     */
    stopAutoRefresh() {
        if (this.refreshInterval) {
            clearTimeout(this.refreshInterval);
            this.refreshInterval = null;
            utils.log("TokenRefresh", "Auto-refresh disabled");
        }
        if (this.sessionHealthCheckInterval) {
            clearInterval(this.sessionHealthCheckInterval);
            this.sessionHealthCheckInterval = null;
            utils.log("TokenRefresh", "Session health checks disabled");
        }
        if (this.presenceKeepaliveInterval) {
            clearInterval(this.presenceKeepaliveInterval);
            this.presenceKeepaliveInterval = null;
            utils.log("TokenRefresh", "Presence keepalive disabled");
        }
        if (this.cookieRefreshInterval) {
            clearInterval(this.cookieRefreshInterval);
            this.cookieRefreshInterval = null;
            utils.log("TokenRefresh", "Cookie refresh disabled");
        }
    }

    /**
     * Get time until next refresh
     * @returns {number} Milliseconds until next refresh
     */
    getTimeUntilNextRefresh() {
        if (!this.refreshInterval) return -1;
        return Math.max(0, this.REFRESH_INTERVAL_MS - (Date.now() - this.lastRefresh));
    }

    /**
     * Check if tokens need immediate refresh
     * @returns {boolean}
     */
    needsImmediateRefresh() {
        return (Date.now() - this.lastRefresh) >= this.REFRESH_INTERVAL_MS;
    }

    /**
     * Set callback for session expiry detection
     * @param {Function} callback - Callback function to trigger on session expiry
     */
    setSessionExpiryCallback(callback) {
        this.onSessionExpiry = callback;
    }

    /**
     * Reset failure count (useful after successful re-login)
     */
    resetFailureCount() {
        this.failureCount = 0;
    }

    /**
     * Get current failure count
     * @returns {number}
     */
    getFailureCount() {
        return this.failureCount;
    }

    /**
     * Get comprehensive status for monitoring and debugging
     * @returns {Object}
     */
    getStatus() {
        const now = Date.now();
        return {
            lastRefresh: this.lastRefresh,
            lastSessionCheck: this.lastSessionCheck,
            lastPresencePing: this.lastPresencePing,
            timeSinceLastRefresh: now - this.lastRefresh,
            timeSinceLastSessionCheck: now - this.lastSessionCheck,
            timeSinceLastPresencePing: now - this.lastPresencePing,
            nextRefreshIn: this.getTimeUntilNextRefresh(),
            failureCount: this.failureCount,
            maxFailures: this.MAX_FAILURES,
            isHealthy: this.failureCount < this.MAX_FAILURES,
            refreshIntervalMs: this.REFRESH_INTERVAL_MS,
            sessionCheckIntervalMs: this.SESSION_CHECK_INTERVAL_MS,
            presenceKeepaliveIntervalMs: this.PRESENCE_KEEPALIVE_MS
        };
    }
}

module.exports = {
    TokenRefreshManager
};
