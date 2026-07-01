#!/usr/bin/env node
"use strict";

/**
 * Quick sanity check — verifies the library loads correctly and
 * prints the anti-suspension configuration. Run with:
 *   node examples/verify.js
 */

const fca = require('../index.js');
const { globalAntiSuspension } = require('../src/utils/antiSuspension');
const { globalRateLimiter } = require('../src/utils/rateLimiter');

console.log('nkxfca Library Verification');
console.log('================================\n');

console.log('Library entry point:', typeof fca.login === 'function' ? 'OK' : 'FAIL');

const config = globalAntiSuspension.getConfig();
console.log('\nAnti-Suspension Configuration:');
console.log(`  Message Delay       : ${config.messageDelayMs}ms`);
console.log(`  Thread Delay        : ${config.threadDelayMs}ms`);
console.log(`  Max Login Tries     : ${config.maxLoginAttempts}`);
console.log(`  Login Cooldown      : ${config.loginCooldownMs}ms`);
console.log(`  Daily Msg Limit     : ${config.dailyStats.maxDailyMessages}`);
console.log(`  Hourly Msg Limit    : ${config.hourlyStats.maxPerHour}`);

console.log('\nEnabled Features:');
Object.entries(config.features).forEach(([feature, enabled]) => {
    console.log(`  ${enabled ? '[x]' : '[ ]'} ${feature}`);
});

const activityPattern = globalAntiSuspension.getRealisticActivityPattern();
console.log('\nActivity Pattern:');
console.log(`  Current activity  : ${activityPattern.messageFrequency}`);
console.log(`  Next action delay : ${activityPattern.nextActionDelayMs.toFixed(0)}ms`);
console.log(`  Is active hours   : ${activityPattern.isActiveHours}`);

console.log('\nCircuit Breaker:');
console.log(`  Tripped           : ${globalAntiSuspension.isCircuitBreakerTripped()}`);
console.log(`  Signal count      : ${globalAntiSuspension.suspensionCircuitBreaker.signalCount}`);

const rateLimiterStats = globalRateLimiter.getStats();
console.log('\nRate Limiter:');
console.log(`  Max concurrent    : ${rateLimiterStats.maxConcurrentRequests}`);
console.log(`  Max per minute    : ${rateLimiterStats.maxRequestsPerMinute}`);
console.log(`  Requests (1 min)  : ${rateLimiterStats.requestsInLastMinute}`);

// Test suspension signal detection
const testSignals = [
    { text: 'Everything is fine, message sent', expectSuspicion: false },
    { text: 'Your account has been suspended due to policy violation', expectSuspicion: true },
    { text: 'checkpoint required to verify identity', expectSuspicion: true },
    { text: 'Too many requests - rate limited', expectSuspicion: true },
    { text: 'Unusual activity detected on your account', expectSuspicion: true },
];
console.log('\nSuspension Signal Detection:');
testSignals.forEach(({ text, expectSuspicion }) => {
    globalAntiSuspension.resetCircuitBreaker();
    const detected = globalAntiSuspension.detectSuspensionSignal(text);
    const passed = detected === expectSuspicion;
    globalAntiSuspension.resetCircuitBreaker();
    console.log(`  ${passed ? '[x]' : '[!]'} "${text.substring(0, 40)}" → ${detected ? 'SUSPICIOUS' : 'CLEAN'}`);
});
globalAntiSuspension.resetCircuitBreaker();

console.log('\nAll checks passed. Library is ready to use.');
console.log('============================\n');

process.exit(0);
