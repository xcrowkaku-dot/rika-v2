"use strict";

const utils = require('../../utils');
const SimpleCache = require('../../utils/cache');
const { globalValidator } = require('../../utils/validation');

/**
 * Builds the core API context and default functions after successful login.
 *
 * @param {string} html The HTML body from the initial Facebook page.
 * @param {object} jar The cookie jar.
 * @param {Array<object>} netData Network data extracted from the HTML.
 * @param {object} globalOptions The global options object.
 * @param {function} fbLinkFunc A function to generate Facebook links.
 * @param {string} errorRetrievingMsg The error message for retrieving user ID.
 * @returns {Array<object>} An array containing [ctx, defaultFuncs, {}].
 */
async function buildAPI(html, jar, netData, globalOptions, fbLinkFunc, errorRetrievingMsg) {
    let userID;
    const cookies = jar.getCookiesSync(fbLinkFunc());
    const primaryProfile = cookies.find((val) => val.cookieString().startsWith("c_user="));
    const secondaryProfile = cookies.find((val) => val.cookieString().startsWith("i_user="));
    if (!primaryProfile && !secondaryProfile) {
        throw new Error(errorRetrievingMsg);
    }
    userID = secondaryProfile?.cookieString().split("=")[1] || primaryProfile.cookieString().split("=")[1];

    const findConfig = (key) => {
        for (const scriptData of netData) {
            if (scriptData.require) {
                for (const req of scriptData.require) {
                    if (Array.isArray(req) && req[0] === key && req[2]) {
                        return req[2];
                    }
                    if (Array.isArray(req) && req[3] && req[3][0] && req[3][0].__bbox && req[3][0].__bbox.define) {
                        for (const def of req[3][0].__bbox.define) {
                            if (Array.isArray(def) && def[0].endsWith(key) && def[2]) {
                                return def[2];
                            }
                        }
                    }
                }
            }
        }
        return null;
    };

    const dtsgData = findConfig("DTSGInitialData");
    const dtsg = dtsgData ? dtsgData.token : utils.getFrom(html, '"token":"', '"');
    
    const lsdData = findConfig("LSD");
    const lsd = lsdData ? lsdData.token : utils.getFrom(html, '"LSD",[],{"token":"', '"');
    
    // Extract additional DTSG AG token for better session persistence
    const dtsgAgData = findConfig("DTSGAGInitialData");
    const fb_dtsg_ag = dtsgAgData ? dtsgAgData.token : utils.getFrom(html, '"DTSGAGInitialData",[],{"token":"', '"');
    
    // Extract spin parameters for consistency
    const spinRMatch = html.match(/"__spin_r":(\d+)/);
    const __spin_r = spinRMatch ? spinRMatch[1] : undefined;
    
    const spinBMatch = html.match(/"__spin_b":"([^"]+)"/);
    const __spin_b = spinBMatch ? spinBMatch[1] : undefined;
    
    const spinTMatch = html.match(/"__spin_t":(\d+)/);
    const __spin_t = spinTMatch ? spinTMatch[1] : undefined;
    
    // Extract hsi (host session identifier)
    const hsiMatch = html.match(/"hsi":"(\d+)"/);
    const hsi = hsiMatch ? hsiMatch[1] : undefined;
    
    // Extract dyn and csr for consistency
    const dynMatch = html.match(/"dyn":"([^"]+)"/);
    const dyn = dynMatch ? dynMatch[1] : undefined;
    
    const csrMatch = html.match(/"csr":"([^"]+)"/);
    const csr = csrMatch ? csrMatch[1] : undefined;
    
    const dtsgResult = { 
        fb_dtsg: dtsg, 
        jazoest: `2${Array.from(dtsg).reduce((a, b) => a + b.charCodeAt(0), '')}`,
        lsd: lsd,
        fb_dtsg_ag: fb_dtsg_ag,
        __spin_r: __spin_r,
        __spin_b: __spin_b,
        __spin_t: __spin_t,
        hsi: hsi,
        dyn: dyn,
        csr: csr
    };

    const clientIDData = findConfig("MqttWebDeviceID");
    const clientID = clientIDData ? clientIDData.clientID : undefined;

    const mqttConfigData = findConfig("MqttWebConfig");
    const mqttAppID = mqttConfigData ? mqttConfigData.appID : undefined;

    const currentUserData = findConfig("CurrentUserInitialData");
    const userAppID = currentUserData ? currentUserData.APP_ID : undefined;

    let primaryAppID = userAppID || mqttAppID;

    let mqttEndpoint = mqttConfigData ? mqttConfigData.endpoint : undefined;

    let region;
    if (mqttEndpoint) {
        try {
            region = new URL(mqttEndpoint).searchParams.get("region")?.toUpperCase();
        } catch (_) {
            // Malformed or missing MQTT endpoint — region stays undefined.
        }
    }
    const irisSeqIDMatch = html.match(/irisSeqID:"(.+?)"/);
    const irisSeqID = irisSeqIDMatch ? irisSeqIDMatch[1] : null;
    if (globalOptions.bypassRegion && mqttEndpoint) {
        const currentEndpoint = new URL(mqttEndpoint);
        currentEndpoint.searchParams.set('region', globalOptions.bypassRegion.toLowerCase());
        mqttEndpoint = currentEndpoint.toString();
        region = globalOptions.bypassRegion.toUpperCase();
    }

    const ctx = {
        userID,
        jar,
        clientID,
        appID: primaryAppID, 
        mqttAppID: mqttAppID, 
        userAppID: userAppID, 
        globalOptions,
        loggedIn: true,
        access_token: "NONE",
        clientMutationId: 0,
        mqttClient: undefined,
        lastSeqId: irisSeqID,
        syncToken: undefined,
        mqttEndpoint,
        wsReqNumber: 0,
        wsTaskNumber: 0,
        reqCallbacks: {},
        callback_Task: {},
        region,
        firstListen: true,
        cache: new SimpleCache(),
        validator: globalValidator,
        ...dtsgResult,
    };
    const defaultFuncs = utils.makeDefaults(html, userID, ctx);

    return [ctx, defaultFuncs, {}];
}

module.exports = buildAPI;
