"use strict";

const utils = require('../utils');

function generateOfflineThreadingID() {
    return Date.now().toString() + Math.floor(Math.random() * 1000000).toString();
}

function getType(obj) {
    return Object.prototype.toString.call(obj).slice(8, -1);
}

module.exports = function (defaultFuncs, api, ctx) {
    return function changeAdminStatus(threadID, adminID, adminStatus, callback) {
        let resolveFunc = function() {};
        let rejectFunc = function() {};
        const returnPromise = new Promise(function(resolve, reject) {
            resolveFunc = resolve;
            rejectFunc = reject;
        });

        if (!callback) {
            callback = function(err, data) {
                if (err) return rejectFunc(err);
                resolveFunc(data);
            };
        }

        if (getType(threadID) !== "String") {
            return callback({ error: "changeAdminStatus: threadID must be a string" });
        }
        if (getType(adminID) !== "String" && getType(adminID) !== "Array") {
            return callback({ error: "changeAdminStatus: adminID must be a string or an array" });
        }
        if (getType(adminStatus) !== "Boolean") {
            return callback({ error: "changeAdminStatus: adminStatus must be true or false" });
        }

        if (ctx.mqttClient) {
            const tasks = [];
            const isAdmin = adminStatus ? 1 : 0;
            const epochID = generateOfflineThreadingID();

            if (getType(adminID) === "Array") {
                adminID.forEach((id, index) => {
                    tasks.push({
                        failure_count: null,
                        label: "25",
                        payload: JSON.stringify({
                            thread_key: threadID,
                            contact_id: id,
                            is_admin: isAdmin
                        }),
                        queue_name: "admin_status",
                        task_id: index + 1
                    });
                });
            } else {
                tasks.push({
                    failure_count: null,
                    label: "25",
                    payload: JSON.stringify({
                        thread_key: threadID,
                        contact_id: adminID,
                        is_admin: isAdmin
                    }),
                    queue_name: "admin_status",
                    task_id: 1
                });
            }

            let count_req = 0;
            const form = JSON.stringify({
                app_id: "2220391788200892",
                payload: JSON.stringify({
                    epoch_id: epochID,
                    tasks: tasks,
                    version_id: "8798795233522156"
                }),
                request_id: ++count_req,
                type: 3
            });

            ctx.mqttClient.publish("/ls_req", form, {}, (err, _packet) => {
                if (err) {
                    utils.error("changeAdminStatus (MQTT)", err);
                    return callback(err);
                } else {
                    utils.log("Admin status changed successfully via MQTT");
                    return callback(null, { success: true });
                }
            });
        } else {
            utils.warn("MQTT client not available, using HTTP fallback for changeAdminStatus");
            const tasks = [];
            const epochID = generateOfflineThreadingID();

            if (getType(adminID) === "Array") {
                adminID.forEach((id, index) => {
                    tasks.push({
                        label: '25',
                        payload: JSON.stringify({ thread_key: threadID, contact_id: id, is_admin: adminStatus }),
                        queue_name: 'admin_status',
                        task_id: index + 1,
                        failure_count: null
                    });
                });
            } else {
                tasks.push({
                    label: '25',
                    payload: JSON.stringify({ thread_key: threadID, contact_id: adminID, is_admin: adminStatus }),
                    queue_name: 'admin_status',
                    task_id: 1,
                    failure_count: null
                });
            }

            const form = {
                fb_dtsg: ctx.fb_dtsg,
                request_id: 1,
                type: 3,
                payload: {
                    version_id: '3816854585040595',
                    tasks: tasks,
                    epoch_id: epochID,
                    data_trace_id: null
                },
                app_id: '772021112871879'
            };

            form.payload = JSON.stringify(form.payload);

            defaultFuncs
                .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
                .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
                .then(() => {
                    utils.log("Admin status changed successfully via HTTP");
                    callback(null, { success: true });
                })
                .catch(err => {
                    utils.error("changeAdminStatus (HTTP)", err);
                    callback(err);
                });
        }

        return returnPromise;
    };
};
