"use strict";

const utils = require('../utils');

/**
 * @param {Object} defaultFuncs
 * @param {Object} api
 * @param {Object} ctx
 */
module.exports = function (defaultFuncs, api, ctx) {
    /**
     * Thread-type cache so we only look up group status once per thread.
     * Shared with sendMessage via ctx.threadTypeCache.
     */
    function getThreadCache() {
        if (!ctx.threadTypeCache) ctx.threadTypeCache = Object.create(null);
        return ctx.threadTypeCache;
    }

    /**
     * Reliably determines whether a thread is a group by querying the API
     * and caching the result. Falls back to string-length heuristic only on error.
     */
    async function isGroupThread(threadID) {
        const tid = threadID.toString();
        const cache = getThreadCache();
        if (Object.prototype.hasOwnProperty.call(cache, tid)) return !!cache[tid];
        try {
            const info = await api.getThreadInfo(tid);
            cache[tid] = !!info.isGroup;
            return !!info.isGroup;
        } catch (_) {
            const fallback = tid.length >= 16;
            cache[tid] = fallback;
            return fallback;
        }
    }

    /**
     * Sends a typing indicator to a specific thread.
     * @param {boolean} sendTyping - True to show typing indicator, false to hide.
     * @param {string} threadID - The ID of the thread to send the typing indicator to.
     * @param {Function} [callback] - An optional callback function.
     * @returns {Promise<void>}
     */
    return async function sendTypingIndicatorV2(sendTyping, threadID, callback) {
        if (!ctx.mqttClient) {
            const err = new Error("You can only use sendTypingIndicator after you start listening.");
            if (callback) callback(err);
            else throw err;
            return;
        }

        let count_req = 0;

        let isGroup;
        try {
            isGroup = await isGroupThread(threadID);
        } catch (_) {
            isGroup = threadID.toString().length >= 16;
        }

        const wsContent = {
            app_id: 2220391788200892,
            payload: JSON.stringify({
                label: 3,
                payload: JSON.stringify({
                    thread_key: threadID.toString(),
                    is_group_thread: +isGroup,
                    is_typing: +sendTyping,
                    attribution: 0
                }),
                version: 5849951561777440
            }),
            request_id: ++count_req,
            type: 4
        };

        // Wrap publish in a timeout so a stale MQTT connection never hangs this call.
        await new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error("sendTypingIndicator: MQTT publish timed out")), 8000);
            ctx.mqttClient.publish('/ls_req', JSON.stringify(wsContent), {}, (err, _packet) => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve();
            });
        });

        if (callback) callback();
    };
};
