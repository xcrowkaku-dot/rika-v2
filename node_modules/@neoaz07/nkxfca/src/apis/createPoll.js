"use strict";

const utils = require('../utils');

module.exports = (defaultFuncs, api, ctx) => {
  return async function createPoll(threadID, questionText, options, callback) {
    let resolveFunc = () => {};
    let rejectFunc = () => {};
    const returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (!callback) {
      callback = (err, result) => {
        if (err) return rejectFunc(err);
        resolveFunc(result);
      };
    }

    try {
      if (!ctx.mqttClient) {
        throw new Error("Not connected to MQTT. Please use listenMqtt first.");
      }

      if (!threadID || typeof threadID !== "string") {
        throw new Error("Invalid threadID");
      }

      if (!questionText || typeof questionText !== "string") {
        throw new Error("questionText must be a string");
      }

      if (!Array.isArray(options) || options.length < 2) {
        throw new Error("options must be an array with at least 2 options");
      }

      const payload = {
        epoch_id: utils.generateOfflineThreadingID(),
        tasks: [
          {
            failure_count: null,
            label: "163",
            payload: JSON.stringify({
              question_text: questionText,
              thread_key: threadID,
              options: options,
              sync_group: 1
            }),
            queue_name: "poll_creation",
            task_id: Math.floor(Math.random() * 1001)
          }
        ],
        version_id: "8768858626531631"
      };

      const form = JSON.stringify({
        app_id: "772021112871879",
        payload: JSON.stringify(payload),
        request_id: ++ctx.wsReqNumber,
        type: 3
      });

      ctx.mqttClient.publish("/ls_req", form);
      callback(null, { success: true });
    } catch (err) {
      utils.error("createPoll", err);
      callback(err);
    }

    return returnPromise;
  };
};
