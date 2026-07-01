"use strict";

/**
 * Formats a cookie array into a string for use in a cookie jar.
 * @param {Array<string>} arr - An array containing cookie parts.
 * @param {string} url - The base URL for the cookie domain.
 * @returns {string} The formatted cookie string.
 */
function formatCookie(arr, url) {
    return (
        arr[0] + "=" + arr[1] + "; Path=" + arr[3] + "; Domain=" + url + ".com"
    );
}

/**
 * Normalizes cookie header strings by removing malformed inputs and cleaning up the format.
 * Handles various cookie formats including headers with "Cookie:" prefix and multiline inputs.
 * @param {string} cookieString - The raw cookie string to normalize.
 * @returns {Array<string>} An array of normalized cookie key-value pairs.
 */
function normalizeCookieHeaderString(cookieString) {
    let str = String(cookieString || "").trim();
    if (!str) return [];

    if (/^cookie\s*:/i.test(str)) {
        str = str.replace(/^cookie\s*:/i, "").trim();
    }

    str = str.replace(/\r?\n/g, " ").replace(/\s*;\s*/g, ";");

    const parts = str.split(";").map(v => v.trim()).filter(Boolean);
    const output = [];

    for (const part of parts) {
        const eqIndex = part.indexOf("=");
        if (eqIndex <= 0) continue;

        const key = part.slice(0, eqIndex).trim();
        const value = part.slice(eqIndex + 1).trim().replace(/^"(.*)"$/, "$1");

        if (!key) continue;
        output.push(`${key}=${value}`);
    }

    return output;
}

/**
 * Sets cookies in a jar from an array of key-value pairs with domain-aware logic.
 * Ensures cookies are properly set across .facebook.com and .messenger.com domains.
 * @param {object} jar - The cookie jar instance.
 * @param {Array<string>} cookiePairs - Array of cookie strings in "key=value" format.
 * @param {string} domain - The domain to set cookies for (defaults to ".facebook.com").
 * @returns {void}
 */
function setJarFromPairs(jar, cookiePairs, domain = ".facebook.com") {
    const expires = new Date(Date.now() + 31536000000).toUTCString();
    const domains = [".facebook.com", ".messenger.com"];

    for (const cookiePair of cookiePairs) {
        for (const cookieDomain of domains) {
            const cookieStr = `${cookiePair}; expires=${expires}; domain=${cookieDomain}; path=/;`;
            try {
                if (typeof jar.setCookieSync === 'function') {
                    jar.setCookieSync(cookieStr, `https://${cookieDomain}`);
                } else if (typeof jar.setCookie === 'function') {
                    jar.setCookie(cookieStr, `https://${cookieDomain}`);
                }
            } catch (err) {
            }
        }
    }
}

/**
 * Enhanced cookie formatter with multi-domain support.
 * @param {Array<string>} arr - An array containing cookie parts [name, value, ...].
 * @param {string} service - The service name ('facebook' or 'messenger').
 * @returns {string} The formatted cookie string with proper domain.
 */
function formatCookieWithDomain(arr, service = 'facebook') {
    const name = String(arr?.[0] || "");
    const value = String(arr?.[1] || "");
    return `${name}=${value}; Domain=.${service}.com; Path=/; Secure`;
}

module.exports = formatCookie;
module.exports.formatCookie = formatCookie;
module.exports.normalizeCookieHeaderString = normalizeCookieHeaderString;
module.exports.setJarFromPairs = setJarFromPairs;
module.exports.formatCookieWithDomain = formatCookieWithDomain;