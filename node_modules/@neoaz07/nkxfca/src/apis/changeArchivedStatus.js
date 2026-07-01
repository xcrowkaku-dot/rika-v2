"use strict";

const utils = require('../utils');

module.exports = (defaultFuncs, api, ctx) => {
  return async function changeArchivedStatus(threadIDs, archive, callback) {
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
      if (utils.getType(archive) === "Function") {
        callback = archive;
        archive = true;
      }

      if (utils.getType(archive) !== "Boolean") {
        throw new Error("archive parameter must be a boolean");
      }

      if (!Array.isArray(threadIDs)) {
        threadIDs = [threadIDs];
      }

      const form = {
        should_archive: archive
      };
      
      threadIDs.forEach(id => {
        form[`thread_fbids[${id}]`] = true;
      });

      const res = await defaultFuncs.post(
        "https://www.facebook.com/ajax/mercury/change_archived_status.php",
        ctx.jar,
        form
      ).then(utils.parseAndCheckLogin(ctx, defaultFuncs));

      if (res && res.error) {
        throw res;
      }

      callback(null, { success: true });
    } catch (err) {
      utils.error("changeArchivedStatus", err);
      callback(err);
    }

    return returnPromise;
  };
};
