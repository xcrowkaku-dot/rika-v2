"use strict";

const utils = require('./index');

// Network error codes and patterns that indicate a transient connectivity
// issue rather than a genuine Facebook session expiry.
const NETWORK_ERROR_PATTERNS = [
    'ECONNRESET', 'ETIMEDOUT', 'ECONNREFUSED', 'ENETUNREACH',
    'EHOSTUNREACH', 'EAI_AGAIN', 'ENOTFOUND', 'ESOCKETTIMEDOUT',
    'socket hang up', 'network error', 'connect ETIMEDOUT',
    'read ECONNRESET', 'write ECONNRESET'
];

function isNetworkError(err) {
    if (!err) return false;
    const msg = (err.message || String(err || '')).toLowerCase();
    const code = err.code || '';
    return NETWORK_ERROR_PATTERNS.some(p => msg.includes(p.toLowerCase()) || code === p);
}

class AutoReLoginManager {
    constructor() {
        this.credentials = null;
        this.loginOptions = null;
        this.loginCallback = null;
        this.isReLoggingIn = false;
        this.pendingRequests = [];
        this.maxRetries = 5;
        this.retryCount = 0;
        // Track when the last failure occurred so we can decay retryCount
        // automatically after a long quiet period (e.g. temporary FB outage).
        this.lastFailureAt = 0;
        // If last re-login failure was longer than this ago, reset retryCount.
        // Prevents the bot from being permanently dead after a single outage.
        this.retryCountDecayMs = 2 * 60 * 60 * 1000; // 2 hours
        this.onReLoginSuccess = null;
        this.onReLoginFailure = null;
        this.enabled = false;
        this.reLoginInterval = 1000 * 60 * 60 * 24; // 24 hours
        this.sessionMonitorInterval = null;
        this.sessionCheckInterval = 1000 * 60 * 30; // 30 minutes
        // Lock mechanism to prevent race conditions in re-login
        this._reauthLock = null;
        this._reauthLockPromise = null;
    }

    setCredentials(credentials, options, callback) {
        this.credentials = credentials;
        this.loginOptions = options || {};
        this.loginCallback = callback;
        this.enabled = true;
        // Reset retry counter on fresh credential set so old failures
        // from a previous session do not permanently lock re-login.
        this.retryCount = 0;
        // Do NOT call startSessionMonitoring() here — the api object is not
        // available yet. loginHelper calls startSessionMonitoring(api) once
        // all api methods are registered.
    }

    startSessionMonitoring(api) {
        if (this.sessionMonitorInterval) {
            clearInterval(this.sessionMonitorInterval);
        }

        if (!this.enabled || !api) return;

        this.sessionMonitorInterval = setInterval(async () => {
            if (this.isReLoggingIn) return;

            try {
                const isValid = await api.isSessionValid();
                if (isValid === 'network_error') {
                    // Transient connectivity issue — session is probably fine.
                    utils.warn("AutoReLogin", "Session check returned network error — skipping re-login (transient)");
                    return;
                }
                if (!isValid) {
                    utils.warn("AutoReLogin", "Session health check failed, attempting token refresh first...");

                    let refreshed = false;
                    try {
                        if (api.tokenRefreshManager && typeof api.tokenRefreshManager.refreshTokens === 'function') {
                            refreshed = await api.tokenRefreshManager.refreshTokens(
                                api.ctx,
                                api.defaultFuncs,
                                'https://www.facebook.com'
                            );
                        }
                    } catch (refreshErr) {
                        if (isNetworkError(refreshErr)) {
                            utils.warn("AutoReLogin", "Token refresh failed with network error — skipping re-login (transient):", refreshErr.message);
                            return;
                        }
                        utils.warn("AutoReLogin", "Token refresh failed:", refreshErr.message);
                    }

                    if (!refreshed) {
                        utils.warn("AutoReLogin", "Token refresh unsuccessful, triggering automatic re-login");
                        await this.handleSessionExpiry(api, 'https://www.facebook.com', "Session expired during monitoring");
                    } else {
                        utils.log("AutoReLogin", "Token refresh successful, session restored without re-login");
                    }
                }
            } catch (error) {
                if (isNetworkError(error)) {
                    utils.warn("AutoReLogin", "Session monitoring skipped — network error (transient):", error.message);
                    return;
                }
                utils.error("AutoReLogin", "Session monitoring error:", error.message);
            }
        }, this.sessionCheckInterval);

        utils.log("AutoReLogin", `Session monitoring started (interval: ${this.sessionCheckInterval}ms)`);
    }

    stopSessionMonitoring() {
        if (this.sessionMonitorInterval) {
            clearInterval(this.sessionMonitorInterval);
            this.sessionMonitorInterval = null;
            utils.log("AutoReLogin", "Session monitoring stopped");
        }
    }

    isEnabled() {
        return this.enabled && this.credentials !== null;
    }

    async handleSessionExpiry(api, fbLinkOrFunc, ERROR_RETRIEVING) {
        if (!this.isEnabled()) {
            utils.warn("AutoReLogin", "Auto re-login not enabled. Credentials not stored.");
            return false;
        }

        // Convert string to function if needed
        const fbLinkFunc = typeof fbLinkOrFunc === 'function' ? fbLinkOrFunc : () => fbLinkOrFunc;

        // Acquire lock to prevent concurrent re-login attempts.
        // If a re-login is already running, wait for it to finish and return
        // its result directly — do NOT start a second parallel re-login.
        if (this._reauthLock || this.isReLoggingIn) {
            utils.log("AutoReLogin", "Re-login already in progress. Waiting for it to complete...");
            return new Promise((resolve, reject) => {
                this.pendingRequests.push({ resolve, reject });
            });
        }

        // Time-based decay: if the last failure was long enough ago (e.g. a
        // temporary Facebook/network outage that has since resolved), reset
        // retryCount so the bot can try again rather than staying permanently dead.
        if (this.retryCount >= this.maxRetries && this.lastFailureAt > 0) {
            const timeSinceLastFailure = Date.now() - this.lastFailureAt;
            if (timeSinceLastFailure >= this.retryCountDecayMs) {
                utils.log("AutoReLogin",
                    `Resetting retryCount (${this.retryCount}) — last failure was ${Math.round(timeSinceLastFailure / 60000)} min ago (decay window: ${this.retryCountDecayMs / 60000} min)`
                );
                this.retryCount = 0;
            }
        }

        if (this.retryCount >= this.maxRetries) {
            utils.error("AutoReLogin", `Maximum re-login attempts (${this.maxRetries}) exceeded`);
            if (this.onReLoginFailure) {
                this.onReLoginFailure(new Error("Max re-login retries exceeded"));
            }
            return false;
        }

        // Set lock
        this.isReLoggingIn = true;
        let releaseLock;
        this._reauthLockPromise = new Promise((resolve) => {
            releaseLock = resolve;
        });
        this._reauthLock = true;

        this.retryCount++;
        utils.log("AutoReLogin", `Starting automatic re-login (attempt ${this.retryCount}/${this.maxRetries})...`);

        try {
            await this.pauseAPIRequests();

            const loginHelperModel = require('../engine/models/loginHelper');
            const setOptionsModel = require('../engine/models/setOptions');
            const buildAPIModel = require('../engine/models/buildAPI');

            await new Promise((resolve, reject) => {
                loginHelperModel(
                    this.credentials,
                    this.loginOptions,
                    (loginError, newApi) => {
                        if (loginError) {
                            reject(loginError);
                            return;
                        }
                        
                        if (api) {
                            api.ctx = newApi.ctx;
                            api.defaultFuncs = newApi.defaultFuncs;
                            
                            if (api.tokenRefreshManager) {
                                api.tokenRefreshManager.resetFailureCount();
                            }
                        }
                        
                        resolve(newApi);
                    },
                    setOptionsModel,
                    buildAPIModel,
                    api,
                    fbLinkFunc, // Use the function we created
                    ERROR_RETRIEVING
                );
            });

            utils.log("AutoReLogin", "Re-login successful! Session restored.");
            this.retryCount = 0;
            this.isReLoggingIn = false;

            this.resolvePendingRequests(true);

            if (this.onReLoginSuccess) {
                this.onReLoginSuccess();
            }

            try {
                if (api && api.listenMqtt && api.ctx && api.ctx._listeningActive) {
                    try {
                        if (typeof api.stopListening === 'function') {
                            try { api.stopListening(); } catch (_) {}
                        }
                        const cb = api.ctx._lastListenCallback || null;
                        if (cb) {
                            api.listenMqtt(cb);
                        } else {
                            api.listenMqtt();
                        }
                    } catch (_) {}
                }
            } catch (_) {}

            return true;
        } catch (error) {
            utils.error("AutoReLogin", `Re-login failed:`, error.message);
            this.isReLoggingIn = false;
            this.lastFailureAt = Date.now();

            if (this.retryCount >= this.maxRetries) {
                this.resolvePendingRequests(false);
                if (this.onReLoginFailure) {
                    this.onReLoginFailure(error);
                }
                // Release lock before returning so waiters are unblocked.
                this._reauthLock = false;
                if (releaseLock) releaseLock();
                return false;
            }

            const backoffDelay = Math.min(30000, Math.pow(2, this.retryCount) * 1000);
            utils.log("AutoReLogin", `Retrying re-login in ${backoffDelay}ms...`);

            // Release the lock BEFORE the retry so the recursive call can
            // acquire it. Without this the recursive call sees _reauthLock=true
            // and deadlocks waiting for a promise that never resolves.
            this._reauthLock = false;
            if (releaseLock) releaseLock();

            await new Promise(resolve => setTimeout(resolve, backoffDelay));

            return await this.handleSessionExpiry(api, fbLinkOrFunc, ERROR_RETRIEVING);
        } finally {
            // Always ensure the lock is released (covers early returns from try block).
            if (this._reauthLock) {
                this._reauthLock = false;
                if (releaseLock) releaseLock();
            }
        }
    }

    async pauseAPIRequests() {
        utils.log("AutoReLogin", "Pausing API requests during re-login...");
        await new Promise(resolve => setTimeout(resolve, 1000));
    }

    resolvePendingRequests(success) {
        utils.log("AutoReLogin", `Resolving ${this.pendingRequests.length} pending requests (success: ${success})`);
        
        this.pendingRequests.forEach(({ resolve, reject }) => {
            if (success) {
                resolve(true);
            } else {
                reject(new Error("Re-login failed"));
            }
        });
        
        this.pendingRequests = [];
    }

    setReLoginSuccessCallback(callback) {
        this.onReLoginSuccess = callback;
    }

    setReLoginFailureCallback(callback) {
        this.onReLoginFailure = callback;
    }

    updateAppState(appState) {
        if (!this.credentials) return;
        if (!Array.isArray(appState) || appState.length === 0) return;
        if (!this.credentials.appState || Array.isArray(this.credentials.appState) || typeof this.credentials.appState === "string") {
            this.credentials.appState = appState;
        }
    }

    disable() {
        this.enabled = false;
        this.stopSessionMonitoring();
        this.credentials = null;
        this.loginOptions = null;
        this.loginCallback = null;
        utils.log("AutoReLogin", "Auto re-login disabled and credentials cleared");
    }

    reset() {
        this.retryCount = 0;
        this.isReLoggingIn = false;
        this.pendingRequests = [];
    }
}

const globalAutoReLoginManager = new AutoReLoginManager();

module.exports = {
    AutoReLoginManager,
    globalAutoReLoginManager,
    isNetworkError
};
