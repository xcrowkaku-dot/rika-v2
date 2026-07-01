"use strict";

const utils = require('../utils');

module.exports = (defaultFuncs, api, ctx) => {
  return async function deleteMessage(messageID, callback) {
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
      const form = {
        message_id: messageID
      };

      const res = await defaultFuncs.post(
        "https://www.facebook.com/ajax/mercury/delete_messages.php",
        ctx.jar,
        form
      ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));

      if (res && res.error) {
        throw res;
      }

      return callback(null, { success: true });
    } catch (err) {
      utils.error("deleteMessage", err);
      callback(err);
    }

    return returnPromise;
  };
};
