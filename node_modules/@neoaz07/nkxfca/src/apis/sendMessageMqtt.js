"use strict";

const utils = require('../utils');
const { globalAntiSuspension } = require('../utils/antiSuspension');

module.exports = (defaultFuncs, api, ctx) => {
  function detectAttachmentType(attachment) {
    const p = attachment.path || "";
    const ext = p.toLowerCase().split(".").pop();
    const audio = ["mp3", "wav", "aac", "m4a", "ogg", "opus", "flac"];
    const video = ["mp4", "mov", "avi", "mkv", "webm", "wmv", "flv"];
    const image = ["jpg", "jpeg", "png", "gif", "bmp", "webp", "svg"];
    if (audio.includes(ext)) return { voice_clip: "true" };
    if (video.includes(ext)) return { video: "true" };
    if (image.includes(ext)) return { image: "true" };
    return { file: "true" };
  }

  async function uploadAttachment(attachments, callback) {
    callback = callback || function () {};
    var uploads = [];
    try {
      for (var i = 0; i < attachments.length; i++) {
        if (!utils.isReadableStream(attachments[i])) {
          throw { error: "Attachment should be a readable stream and not " + utils.getType(attachments[i]) + "." };
        }
        
        if (i > 0) {
          await globalAntiSuspension.addSmartDelay();
        }
        
        var form = {
          upload_1024: attachments[i],
          ...detectAttachmentType(attachments[i]),
        };
        
        const upload = await defaultFuncs
          .postFormData("https://upload.facebook.com/ajax/mercury/upload.php", ctx.jar, form, {}, { ...ctx, requestThreadID: String(ctx._lastThreadHint || "") })
          .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
          .then(resData => {
            if (resData.error) throw resData;
            return resData.payload.metadata[0];
          });
        
        uploads.push(upload);
      }
      callback(null, uploads);
    } catch (err) {
      utils.error("uploadAttachment", err);
      return callback(err);
    }
  }

  function getSendPayload(threadID, msg, otid) {
    const isString = typeof msg === 'string';
    const body = isString ? msg : msg.body || "";
    otid = otid.toString() || utils.generateOfflineThreadingID().toString();
    let payload = {
      thread_id: threadID.toString(),
      otid,
      source: 0,
      send_type: 1,
      sync_group: 1,
      text: body,
      initiating_source: 1,
      skip_url_preview_gen: 0,
    };
    if (typeof msg === 'object') {
      if (msg.sticker) {
        payload.send_type = 2;
        payload.sticker_id = msg.sticker;
        payload.text = null;
      }
      if (msg.attachment) {
        payload.send_type = 3;
        payload.attachment_fbids = Array.isArray(msg.attachment) ? msg.attachment : [msg.attachment];
      }
    }
    return payload;
  }

  function extractIdsFromPayload(payload) {
    let messageID = null;
    let threadID = null;
    function walk(n) {
      if (Array.isArray(n)) {
        if (n[0] === 5 && (n[1] === "replaceOptimsiticMessage" || n[1] === "replaceOptimisticMessage")) {
          messageID = String(n[3]);
        }
        if (n[0] === 5 && n[1] === "writeCTAIdToThreadsTable") {
          const a = n[2];
          if (Array.isArray(a) && a[0] === 19) threadID = String(a[1]);
        }
        for (const x of n) walk(x);
      }
    }
    walk(payload?.step);
    return { threadID, messageID };
  }

  function publishWithAck(content, reqID, callback) {
    return new Promise((resolve, reject) => {
      if (!ctx.mqttClient || typeof ctx.mqttClient.on !== "function" || typeof ctx.mqttClient.publish !== "function") {
        const err = new Error("MQTT client is not initialized");
        utils.error("sendMessageMqtt", err);
        callback && callback(err);
        return reject(err);
      }

      if (typeof ctx.mqttClient.setMaxListeners === "function") {
        ctx.mqttClient.setMaxListeners(0);
      }

      let done = false;
      const cleanup = () => {
        if (done) return;
        done = true;
        ctx.mqttClient.removeListener("message", handleRes);
      };
      const handleRes = (topic, message) => {
        if (topic !== "/ls_resp") return;
        let jsonMsg;
        try {
          jsonMsg = JSON.parse(message.toString());
          jsonMsg.payload = JSON.parse(jsonMsg.payload);
        } catch {
          return;
        }
        if (jsonMsg.request_id !== reqID) return;
        const { threadID, messageID } = extractIdsFromPayload(jsonMsg.payload);
        const result = { messageID, threadID };
        cleanup();
        callback && callback(undefined, result);
        resolve(result);
      };
      ctx.mqttClient.on("message", handleRes);
      ctx.mqttClient.publish("/ls_req", JSON.stringify(content), { qos: 1, retain: false }, err => {
        if (err) {
          cleanup();
          callback && callback(err);
          reject(err);
        }
      });
      setTimeout(() => {
        if (done) return;
        cleanup();
        const err = { error: "Timeout waiting for ACK" };
        callback && callback(err);
        reject(err);
      }, 15000);
    });
  }

  return async (msg, threadID, replyToMessage, callback) => {
    if (typeof msg !== 'string' && typeof msg !== 'object') {
      throw new Error("Message should be of type string or object, not " + utils.getType(msg) + ".");
    }

    if (typeof threadID !== 'string' && typeof threadID !== 'number') {
      throw new Error("threadID must be a string or number.");
    }

    if (!callback && typeof threadID === "function") {
      throw new Error("Pass a threadID as a second argument.");
    }

    if (!callback && typeof replyToMessage === "function") {
      callback = replyToMessage;
      replyToMessage = null;
    }

    // Apply anti-suspension throttling and volume checks before every MQTT send
    try {
      await globalAntiSuspension.prepareBeforeMessage(String(threadID), typeof msg === 'string' ? msg : (msg.body || ''));
    } catch (suspErr) {
      utils.warn("sendMessageMqtt", "Anti-suspension check raised:", suspErr && suspErr.message ? suspErr.message : suspErr);
    }

    const timestamp = Date.now();
    const otid = utils.generateOfflineThreadingID();
    const epoch_id = utils.generateOfflineThreadingID();
    const payload = getSendPayload(threadID, msg, otid);

    const tasks = [{
      label: "46",
      payload,
      queue_name: threadID.toString(),
      task_id: 0,
      failure_count: null,
    }, {
      label: "21",
      payload: {
        thread_id: threadID.toString(),
        last_read_watermark_ts: timestamp,
        sync_group: 1,
      },
      queue_name: threadID.toString(),
      task_id: 1,
      failure_count: null,
    }];

    if (replyToMessage) {
      tasks[0].payload.reply_metadata = {
        reply_source_id: replyToMessage,
        reply_source_type: 1,
        reply_type: 0,
      };
    }

    const request_id = ++ctx.wsReqNumber;
    const form = {
      app_id: "2220391788200892",
      payload: {
        tasks,
        epoch_id,
        version_id: "6120284488008082",
        data_trace_id: null,
      },
      request_id,
      type: 3,
    };

    if (msg.attachment) {
      try {
        ctx._lastThreadHint = threadID;
        const files = await new Promise((resolve, reject) => {
          uploadAttachment(
            Array.isArray(msg.attachment) ? msg.attachment : [msg.attachment],
            (err, files) => {
              if (err) return reject(err);
              return resolve(files);
            }
          );
        });
        form.payload.tasks[0].payload.attachment_fbids = files.map(file => Object.values(file)[0]);
      } catch (err) {
        utils.error("Attachment upload failed:", err);
        throw err;
      }
    }

    form.payload.tasks.forEach(task => {
      task.payload = JSON.stringify(task.payload);
    });
    form.payload = JSON.stringify(form.payload);
    
    return publishWithAck(form, request_id, callback);
  };
};
