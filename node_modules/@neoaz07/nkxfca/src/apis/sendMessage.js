"use strict";

const utils = require('../utils');
const e2ee = require('../security/e2ee');
const { globalAntiSuspension } = require('../utils/antiSuspension');

const allowedProperties = {
  attachment: true,
  url: true,
  sticker: true,
  emoji: true,
  emojiSize: true,
  body: true,
  mentions: true,
  location: true,
};

module.exports = (defaultFuncs, api, ctx) => {
  function getThreadCache() {
    if (!ctx.threadTypeCache) ctx.threadTypeCache = Object.create(null);
    return ctx.threadTypeCache;
  }

  async function isGroupThread(threadID, explicitIsGroup) {
    if (utils.getType(explicitIsGroup) === "Boolean") return !!explicitIsGroup;
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

  function detectAttachmentType(attachment) {
    const path = attachment.path || '';
    const ext = path.toLowerCase().split('.').pop();

    const audioTypes = ['mp3', 'wav', 'aac', 'm4a', 'ogg', 'opus', 'flac'];
    const videoTypes = ['mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv'];
    const imageTypes = ['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg'];

    if (audioTypes.includes(ext)) return { voice_clip: "true" };
    if (videoTypes.includes(ext)) return { video: "true" };
    if (imageTypes.includes(ext)) return { image: "true" };
    return { file: "true" };
  }

  async function uploadSingleAttachment(attachment, threadIDHint) {
    if (!utils.isReadableStream(attachment)) {
      throw new Error("Attachment should be a readable stream and not " + utils.getType(attachment) + ".");
    }
    const uploadType = detectAttachmentType(attachment);
    const oksir = await defaultFuncs.postFormData(
      "https://upload.facebook.com/ajax/mercury/upload.php",
      ctx.jar,
      { upload_1024: attachment, ...uploadType },
      {},
      { ...ctx, requestThreadID: threadIDHint }
    ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));

    if (oksir.error) throw new Error(JSON.stringify(oksir));
    return oksir.payload.metadata[0];
  }

  async function uploadAttachment(attachments, threadIDHint) {
    const CONCURRENT_UPLOADS = 3;
    const uploads = [];
    for (let i = 0; i < attachments.length; i += CONCURRENT_UPLOADS) {
      const batch = attachments.slice(i, i + CONCURRENT_UPLOADS);
      const results = await Promise.all(batch.map(a => uploadSingleAttachment(a, threadIDHint)));
      uploads.push(...results);
      if (i + CONCURRENT_UPLOADS < attachments.length) {
        await globalAntiSuspension.addSmartDelay();
      }
    }
    return uploads;
  }

  async function getUrl(url) {
    const resData = await defaultFuncs.post(
      "https://www.facebook.com/message_share_attachment/fromURI/",
      ctx.jar,
      { image_height: 960, image_width: 960, uri: url }
    ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));
    if (!resData || resData.error || !resData.payload) throw new Error("Invalid url");
    return resData.payload.share_data.share_params;
  }

  async function sendContent(form, threadID, isSingleUser, messageAndOTID) {
    if (utils.getType(threadID) === "Array") {
      for (let i = 0; i < threadID.length; i++) {
        form["specific_to_list[" + i + "]"] = "fbid:" + threadID[i];
      }
      form["specific_to_list[" + threadID.length + "]"] = "fbid:" + ctx.userID;
      form["client_thread_id"] = "root:" + messageAndOTID;
      utils.log("sendMessage", "Sending message to multiple users: " + threadID);
    } else {
      if (isSingleUser) {
        form["specific_to_list[0]"] = "fbid:" + threadID;
        form["specific_to_list[1]"] = "fbid:" + ctx.userID;
        form["other_user_fbid"] = threadID;
        form["client_thread_id"] = "root:" + messageAndOTID;
      } else {
        form["thread_fbid"] = threadID;
      }
    }

    if (ctx.globalOptions.pageID) {
      form["author"] = "fbid:" + ctx.globalOptions.pageID;
      form["specific_to_list[1]"] = "fbid:" + ctx.globalOptions.pageID;
      form["creator_info[creatorID]"] = ctx.userID;
      form["creator_info[creatorType]"] = "direct_admin";
      form["creator_info[labelType]"] = "sent_message";
      form["creator_info[pageID]"] = ctx.globalOptions.pageID;
      form["request_user_id"] = ctx.globalOptions.pageID;
      form["creator_info[profileURI]"] = "https://www.facebook.com/profile.php?id=" + ctx.userID;
    }

    const resData = await defaultFuncs.post(
      "https://www.facebook.com/messaging/send/",
      ctx.jar,
      form,
      { ...ctx, requestThreadID: threadID }
    ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));

    if (!resData) throw new Error("Send message failed.");
    if (resData.error) {
      if (resData.error === 1545012) {
        utils.warn("sendMessage", "Got error 1545012. This might mean that you're not part of the conversation " + threadID);
      }
      // Check for suspension signals in error
      globalAntiSuspension.detectSuspensionSignal(String(resData.error) + ' ' + JSON.stringify(resData));
      throw new Error(JSON.stringify(resData));
    }

    const messageInfo = resData.payload.actions.reduce((p, v) => {
      return { threadID: v.thread_fbid, messageID: v.message_id, timestamp: v.timestamp } || p;
    }, null);
    return messageInfo;
  }

  return async (msg, threadID, callback, replyToMessage, isGroup) => {
    if (!callback && (utils.getType(threadID) === "Function" || utils.getType(threadID) === "AsyncFunction")) {
      throw new Error("Pass a threadID as a second argument.");
    }
    if (!replyToMessage && utils.getType(callback) === "String") {
      replyToMessage = callback;
      callback = undefined;
    }

    let resolveFunc = () => {};
    let rejectFunc = () => {};
    let returnPromise = new Promise((resolve, reject) => {
      resolveFunc = resolve;
      rejectFunc = reject;
    });

    if (!callback) {
      callback = (err, data) => {
        if (err) return rejectFunc(err);
        resolveFunc(data);
      };
    }

    let msgType = utils.getType(msg);
    let threadIDType = utils.getType(threadID);
    let messageIDType = utils.getType(replyToMessage);

    if (msgType !== "String" && msgType !== "Object") {
      return callback(new Error("Message should be of type string or object and not " + msgType + "."));
    }
    if (threadIDType !== "Array" && threadIDType !== "Number" && threadIDType !== "String") {
      return callback(new Error("ThreadID should be of type number, string, or array and not " + threadIDType + "."));
    }
    if (replyToMessage && messageIDType !== 'String') {
      return callback(new Error("MessageID should be of type string and not " + messageIDType + "."));
    }

    if (!ctx.validator.isValidMessage(msg)) {
      return callback(new Error("Invalid message content"));
    }
    const threadIDs = Array.isArray(threadID) ? threadID : [threadID];
    if (!ctx.validator.validateIDArray(threadIDs, ctx.validator.isValidThreadID)) {
      return callback(new Error("Invalid thread ID(s)"));
    }

    if (msgType === "String") msg = { body: msg };

    let disallowedProperties = Object.keys(msg).filter(prop => !allowedProperties[prop]);
    if (disallowedProperties.length > 0) {
      return callback(new Error("Dissallowed props: `" + disallowedProperties.join(", ") + "`"));
    }

    try {
      let messageAndOTID = utils.generateOfflineThreadingID();
      let form = {
        client: "mercury",
        action_type: "ma-type:user-generated-message",
        author: "fbid:" + ctx.userID,
        timestamp: Date.now(),
        timestamp_absolute: "Today",
        timestamp_relative: utils.generateTimestampRelative(),
        timestamp_time_passed: "0",
        is_unread: false,
        is_cleared: false,
        is_forward: false,
        is_filtered_content: false,
        is_filtered_content_bh: false,
        is_filtered_content_account: false,
        is_filtered_content_quasar: false,
        is_filtered_content_invalid_app: false,
        is_spoof_warning: false,
        source: "source:chat:web",
        "source_tags[0]": "source:chat",
        ...(msg.body && { body: msg.body }),
        html_body: false,
        ui_push_phase: "V3",
        status: "0",
        offline_threading_id: messageAndOTID,
        message_id: messageAndOTID,
        threading_id: utils.generateThreadingID(ctx.clientID),
        "ephemeral_ttl_mode:": "0",
        manual_retry_cnt: "0",
        has_attachment: !!(msg.attachment || msg.url || msg.sticker),
        signatureID: utils.getSignatureID(),
        ...(replyToMessage && { replied_to_message_id: replyToMessage })
      };

      if (msg.location) {
        if (!msg.location.latitude || !msg.location.longitude) {
          return callback(new Error("location property needs both latitude and longitude"));
        }
        form["location_attachment[coordinates][latitude]"] = msg.location.latitude;
        form["location_attachment[coordinates][longitude]"] = msg.location.longitude;
        form["location_attachment[is_current_location]"] = !!msg.location.current;
      }
      if (msg.sticker) form["sticker_id"] = msg.sticker;
      if (msg.attachment) {
        form.image_ids = [];
        form.gif_ids = [];
        form.file_ids = [];
        form.video_ids = [];
        form.audio_ids = [];
        if (utils.getType(msg.attachment) !== "Array") msg.attachment = [msg.attachment];
        const files = await uploadAttachment(msg.attachment, threadID);
        files.forEach(file => {
          const type = Object.keys(file)[0];
          form["" + type + "s"].push(file[type]);
        });
      }
      if (msg.url) {
        form["shareable_attachment[share_type]"] = "100";
        const params = await getUrl(msg.url);
        form["shareable_attachment[share_params]"] = params;
      }
      if (msg.emoji) {
        if (!msg.emojiSize) msg.emojiSize = "medium";
        if (msg.emojiSize !== "small" && msg.emojiSize !== "medium" && msg.emojiSize !== "large") {
          return callback(new Error("emojiSize property is invalid"));
        }
        if (form.body && form.body !== "") return callback(new Error("body is not empty"));
        form.body = msg.emoji;
        form["tags[0]"] = "hot_emoji_size:" + msg.emojiSize;
      }
      if (msg.mentions) {
        for (let i = 0; i < msg.mentions.length; i++) {
          const mention = msg.mentions[i];
          const tag = mention.tag;
          if (typeof tag !== "string") return callback(new Error("Mention tags must be strings."));
          const offset = msg.body.indexOf(tag, mention.fromIndex || 0);
          if (offset < 0) utils.warn("handleMention", 'Mention for "' + tag + '" not found in message string.');
          if (!mention.id) utils.warn("handleMention", "Mention id should be non-null.");
          const id = mention.id || 0;
          const emptyChar = '\u200E';
          form["body"] = emptyChar + msg.body;
          form["profile_xmd[" + i + "][offset]"] = offset + 1;
          form["profile_xmd[" + i + "][length]"] = tag.length;
          form["profile_xmd[" + i + "][id]"] = id;
          form["profile_xmd[" + i + "][type]"] = "p";
        }
      }

      const isSingleUser = !(await isGroupThread(threadID, isGroup));

      // Late E2EE encryption for plain text only
      try {
        const isPlainText = !!form.body && !msg.mentions && !msg.sticker && !msg.emoji && !msg.url && !msg.attachment;
        if (isPlainText && e2ee.isEnabled(ctx) && e2ee.hasPeer(ctx, threadID) && !isSingleUser) {
          form.body = e2ee.encrypt(ctx, threadID, form.body);
        }
      } catch (_) {}

      // ── Optimised anti-suspension send flow ───────────────────────────────
      // Step 1: enforce thread throttle (single delay — no stacking).
      await globalAntiSuspension.prepareBeforeMessage(threadID, msg.body || '');

      // Step 2: start typing indicator BEFORE the typing delay so the delay
      // is "hidden" inside the visible typing indicator — zero extra latency.
      let typingStarted = false;
      let typingTimeout;
      const shouldSimulateTyping = ctx.globalOptions && ctx.globalOptions.simulateTyping && api.sendTypingIndicator;
      if (shouldSimulateTyping) {
        try {
          await api.sendTypingIndicator(true, threadID);
          typingStarted = true;

          // Typing delay runs while the indicator is already showing.
          const msgLen = (msg.body || '').length;
          const typingMs = await globalAntiSuspension.simulateTyping(threadID, msgLen);
          await new Promise(resolve => setTimeout(resolve, typingMs));

          typingTimeout = setTimeout(() => {
            if (typingStarted) {
              try { api.sendTypingIndicator(false, threadID); } catch (_) {}
              typingStarted = false;
            }
          }, 10000);
        } catch (_) {}
      }

      // Step 3: send.
      try {
        const result = await sendContent(form, threadID, isSingleUser, messageAndOTID);
        callback(null, result);
      } catch (primaryErr) {
        // Fallback to MQTT for group threads or when HTTP send fails.
        if (api.sendMessageMqtt) {
          try {
            const mqttRes = await api.sendMessageMqtt(msg, threadID, replyToMessage);
            callback(null, mqttRes);
          } catch (fallbackErr) {
            callback(primaryErr);
          }
        } else {
          callback(primaryErr);
        }
      } finally {
        if (typingTimeout) clearTimeout(typingTimeout);
        if (typingStarted) {
          try { await api.sendTypingIndicator(false, threadID); } catch (_) {}
        }
      }
    } catch (err) {
      callback(err);
    }
    return returnPromise;
  };
};
