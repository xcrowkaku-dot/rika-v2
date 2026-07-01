"use strict";

const utils = require("../utils");
const setOptionsModel = require('./models/setOptions');
const buildAPIModel = require('./models/buildAPI');
const loginHelperModel = require('./models/loginHelper');

let globalOptions = {};
let ctx = null;
let defaultFuncs = null;
let api = null;

const fbLink = (ext) => ("https://www.facebook.com" + (ext ? '/' + ext : ''));
const ERROR_RETRIEVING = "Error retrieving userID. This can be caused by many factors, including being blocked by Facebook for logging in from an unknown location. Try logging in with a browser to verify.";

/**
 * Initiates the login process for a Facebook account.
 *
 * @param {object} credentials The user's login credentials (e.g., email/password or appState cookies).
 * @param {object} [options={}] Optional login configurations.
 * @param {function} [callback] Optional callback function. If omitted, returns a Promise.
 * @returns {Promise|void} Returns Promise if no callback provided, otherwise void.
 */
async function login(credentials, options, callback) {
    if (typeof options === "function") {
        callback = options;
        options = {};
    }
    
    let promiseCallback = null;
    let rejectFunc = null;
    let resolveFunc = null;
    let returnPromise = null;

    if (typeof callback !== "function") {
        returnPromise = new Promise(function (resolve, reject) {
            resolveFunc = resolve;
            rejectFunc = reject;
        });
        promiseCallback = function (error, api) {
            if (error) return rejectFunc(error);
            return resolveFunc(api);
        };
        callback = promiseCallback;
    }

    if ('logging' in options) {
        utils.logOptions(options.logging);
    }
    const defaultOptions = {
        selfListen: false,
        listenEvents: true,
        listenTyping: false,
        simulateTyping: true,
        updatePresence: false,
        forceLogin: false,
        autoMarkDelivery: false,
        autoMarkRead: true,
        autoReconnect: true,
        online: true,
        emitReady: false,
        userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/136.0.0.0 Safari/537.36",
    };
    Object.assign(globalOptions, defaultOptions, options);

    await setOptionsModel(globalOptions, options);

    loginHelperModel(
        credentials,
        globalOptions,
        (loginError, loginApi) => {
            if (loginError) {
                return callback(loginError);
            }
            api = loginApi;
            ctx = loginApi.ctx;
            defaultFuncs = loginApi.defaultFuncs;
            return callback(null, loginApi);
        },
        setOptionsModel,
        buildAPIModel,
        api,
        fbLink, 
        ERROR_RETRIEVING
    );

    return returnPromise;
}

module.exports = {
    login
};
