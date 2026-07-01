"use strict";

/**
 * Adaptive Rate Limiting Manager - Optimized for Performance
 * Sliding-window per-minute and per-second rate limiting to prevent
 * Facebook from flagging automated behaviour.
 */

class RateLimiter {
    constructor() {
        this.threadCooldowns = new Map();
        this.endpointCooldowns = new Map();
        this.errorCache = new Map();

        this.ERROR_CACHE_TTL = 300000;
        this.COOLDOWN_DURATION = 60000;
        this.MAX_REQUESTS_PER_MINUTE = 80; // Increased from 50 for better throughput
        this.MAX_CONCURRENT_REQUESTS = 8; // Increased from 5

        this.activeRequests = 0;

        // Sliding window: store timestamps of recent requests
        this._requestWindow = [];
        this._WINDOW_MS = 60000;

        // Per-endpoint sliding windows
        this._endpointWindows = new Map();
        this._MAX_PER_ENDPOINT_PER_MINUTE = 30; // Increased from 20
        
        // Fast path cache for cooldown checks
        this._cooldownCache = new Map();
        this._COOLDOWN_CACHE_TTL = 500; // 500ms cache for cooldown checks
    }

    configure(opts = {}) {
        if (typeof opts.maxConcurrentRequests === 'number' && opts.maxConcurrentRequests > 0 && opts.maxConcurrentRequests <= 50) {
            this.MAX_CONCURRENT_REQUESTS = Math.floor(opts.maxConcurrentRequests);
        }
        if (typeof opts.maxRequestsPerMinute === 'number' && opts.maxRequestsPerMinute > 0 && opts.maxRequestsPerMinute <= 1000) {
            this.MAX_REQUESTS_PER_MINUTE = Math.floor(opts.maxRequestsPerMinute);
        }
        if (typeof opts.requestCooldownMs === 'number' && opts.requestCooldownMs >= 0 && opts.requestCooldownMs <= 10 * 60 * 1000) {
            this.COOLDOWN_DURATION = Math.floor(opts.requestCooldownMs);
        }
        if (typeof opts.errorCacheTtlMs === 'number' && opts.errorCacheTtlMs >= 0 && opts.errorCacheTtlMs <= 24 * 60 * 60 * 1000) {
            this.ERROR_CACHE_TTL = Math.floor(opts.errorCacheTtlMs);
        }
    }

    // ─── Thread cooldowns ─────────────────────────────────────────────────────

    isThreadOnCooldown(threadID) {
        const now = Date.now();
        // Fast path: check cache first
        const cacheKey = `t:${threadID}`;
        const cached = this._cooldownCache.get(cacheKey);
        if (cached && now - cached.ts < this._COOLDOWN_CACHE_TTL) {
            return cached.result;
        }
        
        const cooldownEnd = this.threadCooldowns.get(threadID);
        let result = false;
        if (!cooldownEnd) {
            result = false;
        } else if (now >= cooldownEnd) {
            this.threadCooldowns.delete(threadID);
            result = false;
        } else {
            result = true;
        }
        
        this._cooldownCache.set(cacheKey, { ts: now, result });
        return result;
    }

    setThreadCooldown(threadID, duration = null) {
        this.threadCooldowns.set(threadID, Date.now() + (duration || this.COOLDOWN_DURATION));
        // Invalidate cache
        this._cooldownCache.delete(`t:${threadID}`);
    }

    // ─── Endpoint cooldowns ───────────────────────────────────────────────────

    isEndpointOnCooldown(endpoint) {
        const now = Date.now();
        // Fast path: check cache
        const cacheKey = `e:${endpoint}`;
        const cached = this._cooldownCache.get(cacheKey);
        if (cached && now - cached.ts < this._COOLDOWN_CACHE_TTL) {
            return cached.result;
        }
        
        const cooldownEnd = this.endpointCooldowns.get(endpoint);
        let result = false;
        if (!cooldownEnd) {
            result = false;
        } else if (now >= cooldownEnd) {
            this.endpointCooldowns.delete(endpoint);
            result = false;
        } else {
            result = true;
        }
        
        this._cooldownCache.set(cacheKey, { ts: now, result });
        return result;
    }

    setEndpointCooldown(endpoint, duration = null) {
        this.endpointCooldowns.set(endpoint, Date.now() + (duration || this.COOLDOWN_DURATION));
        this._cooldownCache.delete(`e:${endpoint}`);
    }

    // ─── Error suppression ────────────────────────────────────────────────────

    shouldSuppressError(key) {
        const cachedTime = this.errorCache.get(key);
        if (!cachedTime) {
            this.errorCache.set(key, Date.now());
            return false;
        }
        if (Date.now() - cachedTime > this.ERROR_CACHE_TTL) {
            this.errorCache.set(key, Date.now());
            return false;
        }
        return true;
    }

    // ─── Sliding-window rate checking ─────────────────────────────────────────

    /**
     * Prune timestamps older than the window and return the current count.
     * Optimized with batch pruning.
     */
    _pruneWindow(arr) {
        const cutoff = Date.now() - this._WINDOW_MS;
        // Binary search for the first valid timestamp
        let left = 0, right = arr.length;
        while (left < right) {
            const mid = Math.floor((left + right) / 2);
            if (arr[mid] < cutoff) {
                left = mid + 1;
            } else {
                right = mid;
            }
        }
        if (left > 0) {
            arr.splice(0, left);
        }
        return arr.length;
    }

    isGloballyRateLimited() {
        const count = this._pruneWindow(this._requestWindow);
        return count >= this.MAX_REQUESTS_PER_MINUTE;
    }

    isEndpointRateLimited(endpoint) {
        if (!this._endpointWindows.has(endpoint)) return false;
        const count = this._pruneWindow(this._endpointWindows.get(endpoint));
        return count >= this._MAX_PER_ENDPOINT_PER_MINUTE;
    }

    _recordRequest(endpoint) {
        const now = Date.now();
        this._requestWindow.push(now);
        // Prune less frequently for better performance
        if (this._requestWindow.length > this.MAX_REQUESTS_PER_MINUTE * 3) {
            this._pruneWindow(this._requestWindow);
        }
        if (endpoint) {
            if (!this._endpointWindows.has(endpoint)) {
                this._endpointWindows.set(endpoint, []);
            }
            const ew = this._endpointWindows.get(endpoint);
            ew.push(now);
            if (ew.length > this._MAX_PER_ENDPOINT_PER_MINUTE * 3) {
                this._pruneWindow(ew);
            }
        }
    }

    // ─── Adaptive delay ───────────────────────────────────────────────────────

    getAdaptiveDelay(retryCount, errorCode = null) {
        const baseDelays = [1000, 2500, 5000, 10000]; // Reduced base delays
        const base = baseDelays[Math.min(retryCount, baseDelays.length - 1)];

        if (errorCode === 1545012 || errorCode === 1675004) {
            return base * 1.5; // Reduced from 2x
        }
        if (errorCode === 368 || errorCode === 10) {
            return base * 2; // Reduced from 3x
        }
        return base;
    }

    async addHumanizedDelay(min = 100, max = 350) { // Reduced delays
        const delay = Math.floor(Math.random() * (max - min + 1)) + min;
        await new Promise(resolve => setTimeout(resolve, delay));
    }

    /**
     * Check global and concurrent rate limits.
     * Will wait until below limit, then record the request.
     */
    async checkRateLimit(skipHumanDelay = false, endpoint = null) {
        // Fast path: try immediate slot acquisition
        if (this.activeRequests < this.MAX_CONCURRENT_REQUESTS) {
            if (!this.isGloballyRateLimited()) {
                if (!endpoint || !this.isEndpointRateLimited(endpoint)) {
                    if (!skipHumanDelay) {
                        await this.addHumanizedDelay();
                    }
                    this.activeRequests++;
                    this._recordRequest(endpoint);
                    return () => {
                        this.activeRequests = Math.max(0, this.activeRequests - 1);
                    };
                }
            }
        }

        // Slow path: wait for slot
        while (this.activeRequests >= this.MAX_CONCURRENT_REQUESTS) {
            await new Promise(resolve => setTimeout(resolve, 50)); // Reduced from 100ms
        }

        // Wait for per-minute global window to clear
        let waitCycles = 0;
        const maxCycles = 120; // Increased from 60
        while (this.isGloballyRateLimited()) {
            if (waitCycles++ > maxCycles) break;
            await new Promise(resolve => setTimeout(resolve, 500)); // Reduced from 1000ms
        }

        // Wait for per-endpoint window to clear
        if (endpoint) {
            let epCycles = 0;
            const maxEpCycles = 60; // Increased from 30
            while (this.isEndpointRateLimited(endpoint)) {
                if (epCycles++ > maxEpCycles) break;
                await new Promise(resolve => setTimeout(resolve, 500));
            }
        }

        if (!skipHumanDelay) {
            await this.addHumanizedDelay();
        }

        this.activeRequests++;
        this._recordRequest(endpoint);

        return () => {
            this.activeRequests = Math.max(0, this.activeRequests - 1);
        };
    }

    // ─── Cleanup ──────────────────────────────────────────────────────────────

    cleanup() {
        const now = Date.now();

        for (const [key, time] of this.errorCache.entries()) {
            if (now - time > this.ERROR_CACHE_TTL) this.errorCache.delete(key);
        }
        for (const [key, time] of this.threadCooldowns.entries()) {
            if (now >= time) this.threadCooldowns.delete(key);
        }
        for (const [key, time] of this.endpointCooldowns.entries()) {
            if (now >= time) this.endpointCooldowns.delete(key);
        }

        // Prune all endpoint windows
        for (const [key, arr] of this._endpointWindows.entries()) {
            this._pruneWindow(arr);
            if (arr.length === 0) this._endpointWindows.delete(key);
        }
        this._pruneWindow(this._requestWindow);
        
        // Clear cooldown cache
        this._cooldownCache.clear();
    }

    getStats() {
        this._pruneWindow(this._requestWindow);
        return {
            activeRequests: this.activeRequests,
            maxConcurrentRequests: this.MAX_CONCURRENT_REQUESTS,
            maxRequestsPerMinute: this.MAX_REQUESTS_PER_MINUTE,
            requestsInLastMinute: this._requestWindow.length,
            threadCooldowns: this.threadCooldowns.size,
            endpointCooldowns: this.endpointCooldowns.size,
            errorCacheSize: this.errorCache.size
        };
    }

    getCooldownRemaining(threadID) {
        const cooldownEnd = this.threadCooldowns.get(threadID);
        if (!cooldownEnd) return 0;
        return Math.max(0, cooldownEnd - Date.now());
    }

    getEndpointCooldownRemaining(endpoint) {
        const cooldownEnd = this.endpointCooldowns.get(endpoint);
        if (!cooldownEnd) return 0;
        return Math.max(0, cooldownEnd - Date.now());
    }
}

const globalRateLimiter = new RateLimiter();

setInterval(() => globalRateLimiter.cleanup(), 60000);

module.exports = {
    RateLimiter,
    globalRateLimiter,
    configureRateLimiter: (opts) => globalRateLimiter.configure(opts),
    getRateLimiterStats: () => globalRateLimiter.getStats()
};
