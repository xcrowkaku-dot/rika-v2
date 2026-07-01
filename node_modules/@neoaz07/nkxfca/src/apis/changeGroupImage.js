"use strict";

const utils = require('../utils');

module.exports = (defaultFuncs, api, ctx) => {
  async function handleUpload(image) {
    const form = {
      images_only: "true",
      "attachment[]": image
    };
    return defaultFuncs
      .postFormData("https://upload.facebook.com/ajax/mercury/upload.php", ctx.jar, form, {})
      .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
      .then(resData => {
        if (resData.error) throw resData;
        return resData.payload.metadata[0];
      });
  }

  return async function changeGroupImage(image, threadID, callback) {
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

      if (!utils.isReadableStream(image)) {
        throw new Error("image must be a readable stream");
      }

      const reqID = ++ctx.wsReqNumber;
      const taskID = ++ctx.wsTaskNumber;

      let responseHandled = false;
      const onResponse = (topic, message) => {
        if (topic !== "/ls_resp" || responseHandled) return;
        let jsonMsg;
        try {
          jsonMsg = JSON.parse(message.toString());
          jsonMsg.payload = JSON.parse(jsonMsg.payload);
        } catch (err) {
          return;
        }
        if (jsonMsg.request_id !== reqID) return;
        responseHandled = true;
        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", onResponse);
        callback(null, { success: true, response: jsonMsg.payload });
        resolveFunc({ success: true, response: jsonMsg.payload });
      };

      const timeout = setTimeout(() => {
        if (!responseHandled) {
          responseHandled = true;
          ctx.mqttClient.removeListener("message", onResponse);
          const err = new Error("MQTT request timeout");
          callback(err);
          rejectFunc(err);
        }
      }, 30000);

      ctx.mqttClient.on("message", onResponse);

      const payload = await handleUpload(image);
      const imageID = payload.image_id;

      const taskPayload = {
        thread_key: threadID,
        image_id: imageID,
        sync_group: 1
      };

      const mqttPayload = {
        epoch_id: utils.generateOfflineThreadingID(),
        tasks: [
          {
            failure_count: null,
            label: "37",
            payload: JSON.stringify(taskPayload),
            queue_name: "thread_image",
            task_id: taskID
          }
        ],
        version_id: "8798795233522156"
      };

      const request = {
        app_id: "2220391788200892",
        payload: JSON.stringify(mqttPayload),
        request_id: reqID,
        type: 3
      };

      ctx.mqttClient.publish("/ls_req", JSON.stringify(request), {
        qos: 1,
        retain: false
      }, (err) => {
        if (err && !responseHandled) {
          responseHandled = true;
          clearTimeout(timeout);
          ctx.mqttClient.removeListener("message", onResponse);
          callback(err);
          rejectFunc(err);
        }
      });
    } catch (err) {
      if (!responseHandled) {
        responseHandled = true;
        clearTimeout(timeout);
        ctx.mqttClient.removeListener("message", onResponse);
        utils.error("changeGroupImage", err);
        callback(err);
        rejectFunc(err);
      }
    }

    return returnPromise;
  };
};
