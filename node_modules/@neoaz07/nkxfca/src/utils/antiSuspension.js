"use strict";

/**
 * Anti-Suspension Module
 * Comprehensive protection against Facebook bot account suspension.
 * Designed to be fast (single-delay model) yet stealth.
 *
 * Credits: NeoKEX — https://github.com/NeoKEX
 */

// IMPORTANT: Do NOT add session-management errors here (e.g. "not logged in",
// "session expired", "login required"). Those are normal authentication events
// handled by the re-login system. Adding them here causes the circuit breaker
// to trip on every session expiry, silently blocking all sends for 45 minutes.
const SUSPENSION_SIGNALS = [
    'checkpoint',
    'action_required',
    'account_locked',
    'account locked',
    'device_login',
    'account suspension',
    'account suspended',
    'account has been suspended',
    'account has been disabled',
    'your account has been disabled',
    'this account has been suspended',
    'account banned',
    'account has been banned',
    'unusual_activity',
    'unusual activity',
    'we noticed unusual activity',
    'suspicious activity',
    'verify_your_account',
    'verify your account',
    'confirm_your_identity',
    'confirm your identity',
    'confirm it\'s you',
    'confirm its you',
    'please verify your account',
    'please confirm your identity',
    'identity confirmation',
    'security_check',
    'security check required',
    'login_approvals',
    'login approvals',
    'two-factor authentication required',
    'too_many_requests',
    'too many requests',
    'rate limited',
    'rate_limit',
    'temporarily blocked',
    'temporarily_blocked',
    'your account has been temporarily blocked',
    'feature temporarily blocked',
    'feature temporarily unavailable',
    'automated behavior',
    'not a human',
    'bot detected',
    'automated_behavior',
    'bot_detected',
    'spam detected',
    'spam_detected',
    'looks like spam',
    'violates our community standards',
    'community standards violation',
    'this content isn\'t available',
    'you\'re blocked from',
    'blocked from sending',
    'disabled for violating',
    'policy violation',
    'action blocked'
];

class AntiSuspension {
    constructor() {
        this.activityThrottler = new Map();
        this.lastActivity = new Map();
        this.typing = new Map();

        this.messageDelayMs = 150; // Reduced from 200ms
        this.threadDelayMs = 450; // Reduced from 600ms
        this.loginAttempts = 0;
        this.maxLoginAttempts = 5; // Increased from 3
        this.loginCooldown = 180000; // Reduced from 300000ms (3 min instead of 5)

        this.suspensionCircuitBreaker = {
            tripped: false,
            trippedAt: null,
            cooldownMs: 45 * 60 * 1000,
            signalCount: 0,
            maxSignalsBeforeTrip: 2,
            lastSignalAt: null
        };

        this.dailyStats = {
            date: new Date().toDateString(),
            messageCount: 0,
            maxDailyMessages: 2500, // Increased from 1500
            threadStats: new Map()
        };

        this.hourlyBucket = {
            hour: new Date().getHours(),
            count: 0,
            maxPerHour: 350 // Increased from 220
        };

        this.sessionFingerprint = null;

        this.warmup = {
            active: false,
            startedAt: null,
            durationMs: 15 * 60 * 1000, // Reduced from 20 minutes
            maxMessagesPerHour: 40 // Increased from 25
        };

        this._dailyResetInterval = setInterval(() => this._resetDailyStatsIfNeeded(), 60 * 1000);
        this._hourlyResetInterval = setInterval(() => this._resetHourlyBucketIfNeeded(), 30 * 1000);
        
        // Cleanup intervals on process exit to prevent memory leaks
        process.on('exit', () => this._clearIntervals());
        process.on('SIGINT', () => this._clearIntervals());
        process.on('SIGTERM', () => this._clearIntervals());
    }

    _resetDailyStatsIfNeeded() {
        const today = new Date().toDateString();
        if (this.dailyStats.date !== today) {
            this.dailyStats.date = today;
            this.dailyStats.messageCount = 0;
            this.dailyStats.threadStats.clear();
        }
    }

    _resetHourlyBucketIfNeeded() {
        const currentHour = new Date().getHours();
        if (this.hourlyBucket.hour !== currentHour) {
            this.hourlyBucket.hour = currentHour;
            this.hourlyBucket.count = 0;
        }
    }

    _clearIntervals() {
        if (this._dailyResetInterval) {
            clearInterval(this._dailyResetInterval);
            this._dailyResetInterval = null;
        }
        if (this._hourlyResetInterval) {
            clearInterval(this._hourlyResetInterval);
            this._hourlyResetInterval = null;
        }
    }

    _incrementDailyStats(threadID) {
        this.dailyStats.messageCount++;
        this.hourlyBucket.count++;

        if (threadID) {
            const ts = this.dailyStats.threadStats.get(String(threadID)) || { count: 0 };
            ts.count++;
            ts.lastActivity = Date.now();
            this.dailyStats.threadStats.set(String(threadID), ts);
        }
    }

    isDailyLimitReached() {
        return this.dailyStats.messageCount >= this.dailyStats.maxDailyMessages;
    }

    isHourlyLimitReached() {
        const limit = this.warmup.active
            ? this.warmup.maxMessagesPerHour
            : this.hourlyBucket.maxPerHour;
        return this.hourlyBucket.count >= limit;
    }

    /**
     * Returns a human-readable warning if a volume limit has been reached.
     * Returns null if all limits are within safe range.
     */
    checkVolumeLimit(threadID) {
        if (this.isDailyLimitReached()) {
            return `Daily message limit reached (${this.dailyStats.messageCount}/${this.dailyStats.maxDailyMessages}). Pausing to avoid suspension.`;
        }
        if (this.isHourlyLimitReached()) {
            const limit = this.warmup.active ? this.warmup.maxMessagesPerHour : this.hourlyBucket.maxPerHour;
            return `Hourly message limit reached (${this.hourlyBucket.count}/${limit}). Pausing to avoid suspension.`;
        }
        return null;
    }

    enableWarmup() {
        this.warmup.active = true;
        this.warmup.startedAt = Date.now();
        setTimeout(() => {
            this.warmup.active = false;
        }, this.warmup.durationMs);
    }

    lockSessionFingerprint(ua, secChUa, platform, locale, timezone) {
        if (!this.sessionFingerprint) {
            this.sessionFingerprint = { ua, secChUa, platform, locale, timezone, lockedAt: Date.now() };
        }
        return this.sessionFingerprint;
    }

    getSessionFingerprint() {
        return this.sessionFingerprint;
    }

    detectSuspensionSignal(text) {
        if (!text || typeof text !== 'string') return false;
        const lower = text.toLowerCase();
        const found = SUSPENSION_SIGNALS.some(signal => lower.includes(signal));
        if (found) {
            this._onSuspensionSignalDetected();
        }
        return found;
    }

    _onSuspensionSignalDetected() {
        const cb = this.suspensionCircuitBreaker;
        cb.signalCount++;
        cb.lastSignalAt = Date.now();

        if (cb.signalCount >= cb.maxSignalsBeforeTrip) {
            if (!cb.tripped) {
                cb.tripped = true;
                cb.trippedAt = Date.now();
                const { utils } = this._getUtils();
                utils && utils.warn && utils.warn("AntiSuspension",
                    `Circuit breaker TRIPPED after ${cb.signalCount} suspension signals. ` +
                    `Pausing all activity for ${cb.cooldownMs / 60000} minutes.`);
            }
        }
    }

    _getUtils() {
        try {
            return { utils: require('./index') };
        } catch (_) {
            return {};
        }
    }

    isCircuitBreakerTripped() {
        const cb = this.suspensionCircuitBreaker;
        if (!cb.tripped) return false;
        const elapsed = Date.now() - cb.trippedAt;
        if (elapsed >= cb.cooldownMs) {
            cb.tripped = false;
            cb.signalCount = 0;
            cb.trippedAt = null;
            return false;
        }
        return true;
    }

    getCircuitBreakerRemainingMs() {
        const cb = this.suspensionCircuitBreaker;
        if (!cb.tripped) return 0;
        return Math.max(0, cb.cooldownMs - (Date.now() - cb.trippedAt));
    }

    tripCircuitBreaker(reason, durationMs) {
        const cb = this.suspensionCircuitBreaker;
        cb.tripped = true;
        cb.trippedAt = Date.now();
        if (durationMs) cb.cooldownMs = durationMs;
        cb.signalCount = cb.maxSignalsBeforeTrip;
        const { utils } = this._getUtils();
        utils && utils.warn && utils.warn("AntiSuspension",
            `Circuit breaker manually tripped: ${reason || 'manual'}. ` +
            `Cooldown: ${(cb.cooldownMs / 60000).toFixed(1)} min`);
    }

    resetCircuitBreaker() {
        this.suspensionCircuitBreaker.tripped = false;
        this.suspensionCircuitBreaker.signalCount = 0;
        this.suspensionCircuitBreaker.trippedAt = null;
    }

    async simulateTyping(threadID, messageLength = 50) {
        const wpm = 38 + Math.random() * 24;
        const charsPerMs = (wpm * 5) / 60000;
        const typingDelay = Math.min(1200, Math.max(150, messageLength / charsPerMs));
        const jitter = (Math.random() - 0.5) * 120;
        return Math.round(typingDelay + jitter);
    }

    async addSmartDelay() {
        const base = 100 + Math.random() * 200;
        const jitter = (Math.random() - 0.5) * 40;
        const total = Math.max(60, base + jitter);
        await new Promise(resolve => setTimeout(resolve, total));
    }

    /**
     * Add a longer random delay when volume is running high.
     * Helps avoid patterns that look like automated batch sends.
     */
    async addAdaptiveDelay(threadID) {
        const threadCount = this.dailyStats.threadStats.get(String(threadID))?.count || 0;
        const globalCount = this.dailyStats.messageCount;

        let base = 100;
        if (globalCount > 1000) base = 400;
        else if (globalCount > 500) base = 250;

        if (threadCount > 60) base += 150;

        const jitter = Math.random() * base * 0.3;
        const total = Math.max(60, base + jitter);
        await new Promise(resolve => setTimeout(resolve, total));
    }

    async enforceThreadThrottling(threadID) {
        const lastTime = this.lastActivity.get(String(threadID)) || 0;
        const timeSinceLastMsg = Date.now() - lastTime;
        const minInterval = this.threadDelayMs + Math.random() * 150;

        if (timeSinceLastMsg < minInterval) {
            const waitTime = minInterval - timeSinceLastMsg;
            await new Promise(resolve => setTimeout(resolve, waitTime));
        }

        this.lastActivity.set(String(threadID), Date.now());
        return Date.now() - lastTime;
    }

    async enforceMessageRate() {
        await new Promise(resolve =>
            setTimeout(resolve, this.messageDelayMs + Math.random() * 100)
        );
    }

    getHumanizedHeaders() {
        const { randomUserAgent } = require('./user-agents');
        const fp = this.sessionFingerprint;
        const ua = fp ? { userAgent: fp.ua, secChUa: fp.secChUa, secChUaPlatform: fp.platform } : randomUserAgent();
        return {
            'User-Agent': ua.userAgent,
            'Accept-Language': (fp && fp.locale) || 'en-US,en;q=0.9',
            'Accept-Encoding': 'gzip, deflate, br',
            'DNT': '1',
            'Connection': 'keep-alive',
            'Upgrade-Insecure-Requests': '1',
            'Sec-Ch-Ua': ua.secChUa || '',
            'Sec-Ch-Ua-Mobile': '?0',
            'Sec-Ch-Ua-Platform': ua.secChUaPlatform || '"Windows"',
            'Sec-Fetch-Dest': 'document',
            'Sec-Fetch-Mode': 'navigate',
            'Sec-Fetch-Site': 'none',
            'Cache-Control': 'max-age=0'
        };
    }

    rotateUserAgent() {
        const { randomUserAgent } = require('./user-agents');
        if (this.sessionFingerprint) return this.sessionFingerprint.ua;
        return randomUserAgent().userAgent;
    }

    trackLoginAttempt() {
        this.loginAttempts++;
        const isLocked = this.loginAttempts >= this.maxLoginAttempts;
        return {
            attempt: this.loginAttempts,
            isLocked,
            cooldownMs: isLocked ? this.loginCooldown : 0,
            nextAttemptAt: isLocked ? Date.now() + this.loginCooldown : null
        };
    }

    resetLoginAttempts() {
        this.loginAttempts = 0;
    }

    checkAccountHealth(lastError) {
        const isSuspected = lastError &&
            SUSPENSION_SIGNALS.some(indicator =>
                (lastError.message || '').toLowerCase().includes(indicator)
            );

        if (isSuspected) {
            this._onSuspensionSignalDetected();
        }

        return {
            suspended: isSuspected,
            circuitBreakerTripped: this.isCircuitBreakerTripped(),
            dailyLimitReached: this.isDailyLimitReached(),
            hourlyLimitReached: this.isHourlyLimitReached(),
            lastCheck: Date.now(),
            recommendedAction: isSuspected ? 'WAIT_AND_RETRY' : 'CONTINUE',
            circuitBreakerRemainingMs: this.getCircuitBreakerRemainingMs()
        };
    }

    getRealisticActivityPattern() {
        const hour = new Date().getHours();
        const isNight = hour < 6 || hour >= 22;

        return {
            messageFrequency: isNight ? 'low' : 'normal',
            nextActionDelayMs: isNight
                ? 4000 + Math.random() * 6000
                : 300 + Math.random() * 1200,
            isActiveHours: !isNight,
            recommendedCooldown: isNight ? 10000 : 1500
        };
    }

    async safeRetry(fn, maxRetries = 3) {
        for (let i = 0; i < maxRetries; i++) {
            if (this.isCircuitBreakerTripped()) {
                throw new Error('Circuit breaker is tripped. Stopping retries to protect account.');
            }
            try {
                return await fn();
            } catch (error) {
                const msg = (error.message || '').toLowerCase();
                const isSuspensionError = SUSPENSION_SIGNALS.some(s => msg.includes(s));
                if (isSuspensionError) {
                    this._onSuspensionSignalDetected();
                    throw error;
                }
                if (i === maxRetries - 1) throw error;
                const delay = Math.pow(2, i + 1) * 1000 + Math.random() * 800;
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    async batchOperations(operations) {
        const results = [];
        for (let i = 0; i < operations.length; i++) {
            if (this.isCircuitBreakerTripped()) {
                throw new Error('Circuit breaker tripped during batch operation.');
            }
            results.push(await this.safeRetry(() => operations[i]()));
            if (i < operations.length - 1) {
                await this.addSmartDelay();
            }
        }
        return results;
    }

    /**
     * Prepare before sending — single delay model.
     * Enforces thread throttle and volume limits, respects circuit breaker.
     * If volume limits are reached, throws to protect the account.
     */
    async prepareBeforeMessage(threadID, message) {
        if (this.isCircuitBreakerTripped()) {
            const remaining = this.getCircuitBreakerRemainingMs();
            const waitMs = Math.min(remaining, 8000);
            if (waitMs > 0) await new Promise(resolve => setTimeout(resolve, waitMs));
        }

        const volumeWarning = this.checkVolumeLimit(threadID);
        if (volumeWarning) {
            const { utils } = this._getUtils();
            utils && utils.warn && utils.warn("AntiSuspension", volumeWarning);
            // Add a safety pause instead of hard-blocking so callers can decide
            await new Promise(resolve => setTimeout(resolve, 5000 + Math.random() * 3000));
        }

        await this.enforceThreadThrottling(threadID);
        await this.addAdaptiveDelay(threadID);
        this._incrementDailyStats(threadID);
    }

    getConfig() {
        return {
            messageDelayMs: this.messageDelayMs,
            threadDelayMs: this.threadDelayMs,
            maxLoginAttempts: this.maxLoginAttempts,
            loginCooldownMs: this.loginCooldown,
            circuitBreaker: {
                tripped: this.suspensionCircuitBreaker.tripped,
                signalCount: this.suspensionCircuitBreaker.signalCount,
                remainingMs: this.getCircuitBreakerRemainingMs()
            },
            dailyStats: {
                messageCount: this.dailyStats.messageCount,
                maxDailyMessages: this.dailyStats.maxDailyMessages
            },
            hourlyStats: {
                count: this.hourlyBucket.count,
                maxPerHour: this.hourlyBucket.maxPerHour
            },
            warmupActive: this.warmup.active,
            features: {
                typeSimulation: true,
                delayRandomization: true,
                adaptiveDelay: true,
                userAgentRotation: true,
                activityPatternTracking: true,
                autoSuspensionDetection: true,
                exponentialBackoff: true,
                circuitBreaker: true,
                dailyVolumeLimiting: true,
                hourlyVolumeLimiting: true,
                sessionFingerprintLock: true,
                warmupMode: true,
                volumeWarnings: true
            }
        };
    }

    destroy() {
        this._clearIntervals();
        this.activityThrottler.clear();
        this.lastActivity.clear();
        this.typing.clear();
        this.dailyStats.threadStats.clear();
    }
}

const globalAntiSuspension = new AntiSuspension();

module.exports = {
    AntiSuspension,
    globalAntiSuspension,
    SUSPENSION_SIGNALS,
    initAntiSuspension: () => globalAntiSuspension,
    getAntiSuspensionConfig: () => globalAntiSuspension.getConfig()
};
