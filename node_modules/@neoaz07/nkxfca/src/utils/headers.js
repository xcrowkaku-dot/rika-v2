"use strict";

const { randomUserAgent, generateUserAgentByPersona } = require("./user-agents");

/**
 * Strip characters that are illegal in HTTP header values:
 * control chars (except HTAB), DEL, CR, LF, and stringified arrays.
 * This prevents ERR_INVALID_CHAR crashes that expose bot-like behaviour.
 */
function sanitizeHeaderValue(value) {
    if (value === null || value === undefined) return '';
    let str = String(value);

    // Detect accidentally stringified JS arrays like '["performAutoLogin"]'
    if (str.trim().startsWith('[') && str.trim().endsWith(']')) {
        try {
            const parsed = JSON.parse(str);
            if (Array.isArray(parsed)) return '';
        } catch (_) {}
    }

    // Remove control chars (0x00-0x08, 0x0A-0x1F), DEL (0x7F), CR, LF, brackets
    str = str.replace(/[\x00-\x08\x0A-\x1F\x7F\r\n\[\]]/g, '').trim();
    return str;
}

function sanitizeHeaders(headers) {
    const out = {};
    for (const [key, value] of Object.entries(headers)) {
        if (!key || typeof key !== 'string') continue;
        const cleanKey = key.replace(/[^\x21-\x7E]/g, '').trim();
        if (!cleanKey) continue;
        const cleanVal = sanitizeHeaderValue(value);
        if (cleanVal !== '') {
            out[cleanKey] = cleanVal;
        }
    }
    return out;
}

const LOCALE_PROFILES = [
    'en-US,en;q=0.9',
    'en-GB,en;q=0.9,en-US;q=0.8',
    'en-US,en;q=0.9,es;q=0.8',
    'en-US,en;q=0.9,fr;q=0.8',
    'en-CA,en;q=0.9,fr;q=0.8',
    'en-AU,en;q=0.9,en-GB;q=0.8'
];

const TIMEZONE_OFFSETS = [-480, -420, -360, -300, -240, -180, -120, 0, 60, 120, 180, 240, 300, 360, 480, 540, 600];

function getRandomLocale() {
    return LOCALE_PROFILES[Math.floor(Math.random() * LOCALE_PROFILES.length)];
}

function getRandomTimezone() {
    return TIMEZONE_OFFSETS[Math.floor(Math.random() * TIMEZONE_OFFSETS.length)];
}

/**
 * Generates a comprehensive and realistic set of headers for requests to Facebook.
 * @param {string} url - The target URL.
 * @param {object} options - Global options from context.
 * @param {object} ctx - The application context (containing fb_dtsg, lsd, etc.).
 * @param {object} customHeader - Any extra headers to merge.
 * @param {string} requestType - Type of request: 'xhr' for GraphQL/AJAX or 'navigate' for page navigation
 * @returns {object} A complete headers object.
 */
function getHeaders(url, options, ctx, customHeader, requestType = 'navigate') {
    const persona = options?.persona || 'desktop';
    const isAndroid = persona === 'android' || persona === 'mobile';

    let userAgent, secChUa, secChUaFullVersionList, secChUaPlatform, secChUaPlatformVersion;
    let androidData = null;

    if (isAndroid) {
        if (options && options.cachedAndroidUA) {
            userAgent = options.cachedAndroidUA;
            androidData = {
                resolution: options.cachedAndroidResolution,
                locale: options.cachedAndroidLocale,
                device: options.cachedAndroidDevice
            };
        } else {
            const generated = generateUserAgentByPersona('android', options);
            userAgent = generated.userAgent;
            androidData = {
                resolution: generated.resolution,
                locale: generated.locale,
                device: generated.device
            };
        }
    } else {
        if (options && options.cachedUserAgent) {
            userAgent = options.cachedUserAgent;
            secChUa = options.cachedSecChUa;
            secChUaFullVersionList = options.cachedSecChUaFullVersionList;
            secChUaPlatform = options.cachedSecChUaPlatform;
            secChUaPlatformVersion = options.cachedSecChUaPlatformVersion;
        } else {
            const generated = randomUserAgent();
            userAgent = generated.userAgent;
            secChUa = generated.secChUa;
            secChUaFullVersionList = generated.secChUaFullVersionList;
            secChUaPlatform = generated.secChUaPlatform;
            secChUaPlatformVersion = generated.secChUaPlatformVersion;
        }
    }

    const host = new URL(url).hostname;
    const referer = `https://${host}/`;

    const isXhr = requestType === 'xhr';

    const locales = options?.cachedLocale || (androidData?.locale ? androidData.locale.replace('_', '-') : getRandomLocale());
    const timezone = options?.cachedTimezone || getRandomTimezone();

    if (isAndroid) {
        const headers = {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Host': host,
            'Connection': 'keep-alive',
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Accept-Language': locales,
            'Accept-Encoding': 'gzip, deflate',
            'X-FB-HTTP-Engine': 'Liger'
        };

        if (androidData && androidData.resolution) {
            headers['X-FB-Client-Density'] = String(androidData.resolution.density);
        }

        if (ctx) {
            if (ctx.lsd || ctx.fb_dtsg) {
                headers['X-Fb-Lsd'] = ctx.lsd || ctx.fb_dtsg;
            }
            if (ctx.region) {
                headers['X-MSGR-Region'] = ctx.region;
            }
            // Spin params are spread directly into ctx by buildAPI — ctx.master never exists.
            if (ctx.__spin_r) headers['X-Fb-Spin-R'] = String(ctx.__spin_r);
            if (ctx.__spin_b) headers['X-Fb-Spin-B'] = String(ctx.__spin_b);
            if (ctx.__spin_t) headers['X-Fb-Spin-T'] = String(ctx.__spin_t);
        }

        if (customHeader) {
            Object.assign(headers, customHeader);
            if (customHeader.noRef) {
                delete headers.Referer;
            }
        }

        return sanitizeHeaders(headers);
    }

    const isWindows = secChUaPlatform === '"Windows"';
    const isMac = secChUaPlatform === '"macOS"';
    const isLinux = secChUaPlatform === '"Linux"';

    const headers = {
        'Accept': isXhr ? '*/*' : 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8,application/signed-exchange;v=b3;q=0.7',
        'Accept-Language': locales,
        'Accept-Encoding': 'gzip, deflate, br',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'DNT': '1',
        'Dpr': '1',
        'Host': host,
        'Pragma': 'no-cache',
        'Referer': referer,
        'Sec-Ch-Prefers-Color-Scheme': 'light',
        'Sec-Ch-Ua': secChUa,
        'Sec-Ch-Ua-Full-Version-List': secChUaFullVersionList,
        'Sec-Ch-Ua-Mobile': '?0',
        'Sec-Ch-Ua-Model': '""',
        'Sec-Ch-Ua-Platform': secChUaPlatform,
        'Sec-Ch-Ua-Platform-Version': secChUaPlatformVersion,
        'Sec-Fetch-Dest': isXhr ? 'empty' : 'document',
        'Sec-Fetch-Mode': isXhr ? 'cors' : 'navigate',
        'Sec-Fetch-Site': isXhr ? 'same-origin' : 'none',
        'User-Agent': userAgent,
        'Viewport-Width': '1920',
        'X-FB-Timezone-Offset': String(timezone * 60)
    };

    if (isWindows || isMac || isLinux) {
        headers['Sec-Ch-Ua-Arch'] = '"x86"';
        headers['Sec-Ch-Ua-Bitness'] = '"64"';
    }

    if (isXhr) {
        headers['Origin'] = `https://${host}`;
        headers['X-Requested-With'] = 'XMLHttpRequest';
    } else {
        headers['Sec-Fetch-User'] = '?1';
        headers['Upgrade-Insecure-Requests'] = '1';
    }

    if (ctx) {
        if (ctx.lsd || ctx.fb_dtsg) {
            headers['X-Fb-Lsd'] = ctx.lsd || ctx.fb_dtsg;
        }
        if (ctx.region) {
            headers['X-MSGR-Region'] = ctx.region;
        }
        // Spin params are spread directly into ctx by buildAPI — ctx.master never exists.
        if (ctx.__spin_r) headers['X-Fb-Spin-R'] = String(ctx.__spin_r);
        if (ctx.__spin_b) headers['X-Fb-Spin-B'] = String(ctx.__spin_b);
        if (ctx.__spin_t) headers['X-Fb-Spin-T'] = String(ctx.__spin_t);
    }

    if (customHeader) {
        Object.assign(headers, customHeader);
        if (customHeader.noRef) {
            delete headers.Referer;
        }
    }

    return sanitizeHeaders(headers);
}

const meta = (prop) => new RegExp(`<meta property="${prop}" content="([^"]*)"`);

module.exports = {
    getHeaders,
    meta,
    getRandomLocale,
    getRandomTimezone
};