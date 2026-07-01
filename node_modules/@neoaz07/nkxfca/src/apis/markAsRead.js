"use strict";

const utils = require('../utils');

/**
 * @param {Object} defaultFuncs
 * @param {Object} api
 * @param {Object} ctx
 */
module.exports = function (defaultFuncs, api, ctx) {
  /**
   * Marks a thread as read.
   * @param {string} threadID - The ID of the thread to mark as read.
   * @param {boolean} [read=true] - Whether to mark as read (true) or unread (false). Defaults to true.
   * @param {Function} [callback] - The callback function.
   * @returns {Promise<null|Error>} A Promise that resolves with null on success, or rejects with an Error.
   */
  return async function markAsRead(threadID, read, callback) {
    if (
      utils.getType(read) === "Function" ||
      utils.getType(read) === "AsyncFunction"
    ) {
      callback = read;
      read = true;
    }
    if (read == undefined) {
      read = true;
    }

    if (!callback) {
      callback = () => {};
    }

    const form = {};

    if (typeof ctx.globalOptions.pageID !== "undefined") {
      form["source"] = "PagesManagerMessagesInterface";
      form["request_user_id"] = ctx.globalOptions.pageID;
      form["ids[" + threadID + "]"] = read;
      form["watermarkTimestamp"] = new Date().getTime();
      form["shouldSendReadReceipt"] = true;
      form["commerce_last_message_type"] = "";

      let resData;
      try {
        resData = await defaultFuncs
          .post(
            "https://www.facebook.com/ajax/mercury/change_read_status.php",
            ctx.jar,
            form,
          )
          .then(utils.saveCookies(ctx.jar))
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs));
      } catch (e) {
        callback(e);
        return e;
      }

      if (resData.error) {
        const err = resData.error;
        utils.error("markAsRead", err);
        callback(err);
        return err;
      }

      callback();
      return null;
    } else {
      try {
        if (ctx.mqttClient) {
          await new Promise((resolve, reject) => {
            // Guard against a disconnected MQTT client hanging forever.
            const timer = setTimeout(
              () => reject(new Error("markAsRead: MQTT publish timed out after 8s")),
              8000
            );
            ctx.mqttClient.publish(
              "/mark_thread",
              JSON.stringify({ threadID, mark: "read", state: read }),
              { qos: 1, retain: false },
              (err, _packet) => {
                clearTimeout(timer);
                if (err) reject(err);
                else resolve();
              }
            );
          });
        } else {
          throw {
            error: "You can only use this function after you start listening.",
          };
        }
      } catch (e) {
        callback(e);
        return e;
      }
    }
  };
};
