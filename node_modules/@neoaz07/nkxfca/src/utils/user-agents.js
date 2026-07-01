"use strict";
const { getRandom } = require("./constants");

const BROWSER_DATA = {
    windows: {
        platform: "Windows NT 10.0; Win64; x64",
        chromeVersions: ["139.0.0.0", "131.0.6778.86", "130.0.6723.92", "129.0.6668.101", "128.0.6613.120", "127.0.6533.120"],
        edgeVersions: ["139.0.0.0", "131.0.2903.51", "130.0.2849.68", "129.0.2792.89"],
        platformVersion: '"15.0.0"'
    },
    mac: {
        platform: "Macintosh; Intel Mac OS X 10_15_7",
        chromeVersions: ["139.0.0.0", "131.0.6778.86", "130.0.6723.92", "129.0.6668.101", "128.0.6613.120", "127.0.6533.120"],
        edgeVersions: ["139.0.0.0", "131.0.2903.51", "130.0.2849.68", "129.0.2792.89"],
        platformVersion: '"14.7.0"'
    },
    linux: {
        platform: "X11; Linux x86_64",
        chromeVersions: ["139.0.0.0", "131.0.6778.86", "130.0.6723.92", "129.0.6668.101", "128.0.6613.120"],
        edgeVersions: ["139.0.0.0", "131.0.2903.51", "130.0.2849.68"],
        platformVersion: '""'
    }
};

const defaultUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36";

/**
 * Generates a realistic, randomized User-Agent string and related Sec-CH headers.
 * Supports Chrome and Edge browsers across Windows, macOS, and Linux.
 * @returns {{userAgent: string, secChUa: string, secChUaFullVersionList: string, secChUaPlatform: string, secChUaPlatformVersion: string, browser: string}}
 */
function randomUserAgent() {
    const os = getRandom(Object.keys(BROWSER_DATA));
    const data = BROWSER_DATA[os];

    const useEdge = Math.random() > 0.7 && data.edgeVersions;
    const versions = useEdge ? data.edgeVersions : data.chromeVersions;
    const version = getRandom(versions);
    const majorVersion = version.split('.')[0];
    const browserName = useEdge ? 'Microsoft Edge' : 'Google Chrome';
    const browserIdentifier = useEdge ? 'Edg' : 'Chrome';

    const userAgent = useEdge 
        ? `Mozilla/5.0 (${data.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36 Edg/${version}`
        : `Mozilla/5.0 (${data.platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;

    const greeseValue = Math.random() > 0.5 ? '99' : '8';
    const brands = useEdge ? [
        `"Chromium";v="${majorVersion}"`,
        `"Not(A:Brand";v="${greeseValue}"`,
        `"${browserName}";v="${majorVersion}"`
    ] : [
        `"${browserName}";v="${majorVersion}"`,
        `"Not;A=Brand";v="${greeseValue}"`,
        `"Chromium";v="${majorVersion}"`
    ];

    const secChUa = brands.join(', ');
    const secChUaFullVersionList = brands.map(b => {
        const match = b.match(/v="(\d+)"/);
        if (match && match[1] === majorVersion) {
            return b.replace(`v="${majorVersion}"`, `v="${version}"`);
        }
        return b;
    }).join(', ');

    const platformName = os === 'windows' ? 'Windows' : os === 'mac' ? 'macOS' : 'Linux';

    return {
        userAgent,
        secChUa,
        secChUaFullVersionList,
        secChUaPlatform: `"${platformName}"`,
        secChUaPlatformVersion: data.platformVersion,
        browser: browserName
    };
}

function randomInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
}

function randomChoice(arr) {
    return arr[Math.floor(Math.random() * arr.length)];
}

function randomBuildId() {
    const prefixes = ["QP1A", "RP1A", "SP1A", "TP1A", "UP1A", "AP4A"];
    return `${randomChoice(prefixes)}.${randomInt(180000, 250000)}.${randomInt(10, 99)}`;
}

function randomResolution() {
    const presets = [
        { width: 720, height: 1280, density: 2.0 },
        { width: 1080, height: 1920, density: 2.625 },
        { width: 1080, height: 2400, density: 3.0 },
        { width: 1440, height: 3040, density: 3.5 },
        { width: 1440, height: 3200, density: 4.0 }
    ];
    return randomChoice(presets);
}

function randomFbav() {
    return `${randomInt(390, 499)}.${randomInt(0, 3)}.${randomInt(0, 2)}.${randomInt(10, 60)}.${randomInt(100, 999)}`;
}

function randomOrcaUA() {
    const androidVersions = ["8.1.0", "9", "10", "11", "12", "13", "14"];
    const devices = [
        { brand: "samsung", model: "SM-G996B" },
        { brand: "samsung", model: "SM-S908E" },
        { brand: "Xiaomi", model: "M2101K9AG" },
        { brand: "OPPO", model: "CPH2219" },
        { brand: "vivo", model: "V2109" },
        { brand: "HUAWEI", model: "VOG-L29" },
        { brand: "asus", model: "ASUS_I001DA" },
        { brand: "Google", model: "Pixel 6" },
        { brand: "realme", model: "RMX2170" }
    ];
    const carriers = [
        "Viettel Telecom", "Mobifone", "Vinaphone",
        "T-Mobile", "Verizon", "AT&T",
        "Telkomsel", "Jio", "NTT DOCOMO",
        "Vodafone", "Orange"
    ];
    const locales = [
        "vi_VN", "en_US", "en_GB", "id_ID",
        "th_TH", "fr_FR", "de_DE", "es_ES", "pt_BR"
    ];
    const archs = ["arm64-v8a", "armeabi-v7a"];

    const androidVersion = randomChoice(androidVersions);
    const device = randomChoice(devices);
    const buildId = randomBuildId();
    const resolution = randomResolution();
    const fbav = randomFbav();
    const fbbv = randomInt(320000000, 520000000);
    const arch = `${randomChoice(archs)}:${randomChoice(archs)}`;
    const selectedLocale = randomChoice(locales);
    const selectedCarrier = randomChoice(carriers);

    const userAgent = `Dalvik/2.1.0 (Linux; U; Android ${androidVersion}; ${device.model} Build/${buildId}) ` +
        `[FBAN/Orca-Android;FBAV/${fbav};FBPN/com.facebook.orca;` +
        `FBLC/${selectedLocale};FBBV/${fbbv};FBCR/${selectedCarrier};` +
        `FBMF/${device.brand};FBBD/${device.brand};FBDV/${device.model};` +
        `FBSV/${androidVersion};FBCA/${arch};` +
        `FBDM/{density=${resolution.density.toFixed(1)},width=${resolution.width},height=${resolution.height}};` +
        `FB_FW/1;]`;

    return {
        userAgent,
        androidVersion,
        device,
        buildId,
        resolution,
        fbav,
        fbbv,
        locale: selectedLocale,
        carrier: selectedCarrier
    };
}

function generateUserAgentByPersona(persona = 'desktop', options = {}) {
    if (persona === 'android' || persona === 'mobile') {
        if (options.cachedAndroidUA && options.cachedAndroidDevice) {
            return {
                userAgent: options.cachedAndroidUA,
                androidVersion: options.cachedAndroidVersion,
                device: options.cachedAndroidDevice,
                buildId: options.cachedAndroidBuildId,
                resolution: options.cachedAndroidResolution,
                fbav: options.cachedAndroidFbav,
                fbbv: options.cachedAndroidFbbv,
                locale: options.cachedAndroidLocale,
                carrier: options.cachedAndroidCarrier,
                persona: 'android'
            };
        }

        const androidData = randomOrcaUA();
        return {
            ...androidData,
            persona: 'android'
        };
    }

    if (options.cachedUserAgent && options.cachedSecChUa) {
        return {
            userAgent: options.cachedUserAgent,
            secChUa: options.cachedSecChUa,
            secChUaFullVersionList: options.cachedSecChUaFullVersionList,
            secChUaPlatform: options.cachedSecChUaPlatform,
            secChUaPlatformVersion: options.cachedSecChUaPlatformVersion,
            browser: options.cachedBrowser || 'Google Chrome',
            persona: 'desktop'
        };
    }

    const desktopData = randomUserAgent();
    return {
        ...desktopData,
        persona: 'desktop'
    };
}

function cachePersonaData(options, personaData) {
    if (personaData.persona === 'android') {
        options.cachedAndroidUA = personaData.userAgent;
        options.cachedAndroidVersion = personaData.androidVersion;
        options.cachedAndroidDevice = personaData.device;
        options.cachedAndroidBuildId = personaData.buildId;
        options.cachedAndroidResolution = personaData.resolution;
        options.cachedAndroidFbav = personaData.fbav;
        options.cachedAndroidFbbv = personaData.fbbv;
        options.cachedAndroidLocale = personaData.locale;
        options.cachedAndroidCarrier = personaData.carrier;
    } else {
        options.cachedUserAgent = personaData.userAgent;
        options.cachedSecChUa = personaData.secChUa;
        options.cachedSecChUaFullVersionList = personaData.secChUaFullVersionList;
        options.cachedSecChUaPlatform = personaData.secChUaPlatform;
        options.cachedSecChUaPlatformVersion = personaData.secChUaPlatformVersion;
        options.cachedBrowser = personaData.browser;
    }
    return options;
}

module.exports = {
    defaultUserAgent,
    windowsUserAgent: defaultUserAgent,
    randomUserAgent,
    randomBuildId,
    randomResolution,
    randomFbav,
    randomOrcaUA,
    generateUserAgentByPersona,
    cachePersonaData,
};