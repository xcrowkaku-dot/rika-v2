"use strict";

const utils = require('../utils');
const { _formatAttachment } = require('../utils/formatters/data/formatAttachment');

const THEME_COLORS = [
    { theme_color: "FF000000", theme_id: "788274591712841", theme_emoji: "🖤", gradient: '["FFF0F0F0"]', should_show_icon: "", theme_name_with_subtitle: "Monochrome" },
    { theme_color: "FFFF5CA1", theme_id: "169463077092846", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Hot Pink" },
    { theme_color: "FF2825B5", theme_id: "271607034185782", theme_emoji: null, gradient: '["FF5E007E","FF331290","FF2825B5"]', should_show_icon: "1", theme_name_with_subtitle: "Shadow" },
    { theme_color: "FFD9A900", theme_id: "2533652183614000", theme_emoji: null, gradient: '["FF550029","FFAA3232","FFD9A900"]', should_show_icon: "1", theme_name_with_subtitle: "Maple" },
    { theme_color: "FFFB45DE", theme_id: "2873642949430623", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Tulip" },
    { theme_color: "FF5E007E", theme_id: "193497045377796", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Grape" },
    { theme_color: "FF7AA286", theme_id: "1455149831518874", theme_emoji: "🌑", gradient: '["FF25C0E1","FFCE832A"]', should_show_icon: "", theme_name_with_subtitle: "Dune" },
    { theme_color: "FFFAAF00", theme_id: "672058580051520", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Honey" },
    { theme_color: "FF0084FF", theme_id: "196241301102133", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Default Blue" },
    { theme_color: "FFFFC300", theme_id: "174636906462322", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Yellow" },
    { theme_color: "FF44BEC7", theme_id: "1928399724138152", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Teal Blue" },
    { theme_color: "FF7646FF", theme_id: "234137870477637", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Bright Purple" },
    { theme_color: "FFF25C54", theme_id: "3022526817824329", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Peach" },
    { theme_color: "FFF01D6A", theme_id: "724096885023603", theme_emoji: null, gradient: '["FF005FFF","FF9200FF","FFFF2E19"]', should_show_icon: "1", theme_name_with_subtitle: "Berry" },
    { theme_color: "FFFF7CA8", theme_id: "624266884847972", theme_emoji: null, gradient: '["FFFF8FB2","FFA797FF","FF00E5FF"]', should_show_icon: "1", theme_name_with_subtitle: "Candy" },
    { theme_color: "FF0084FF", theme_id: "196241301102133", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Classic" },
    { theme_color: "FF0099FF", theme_id: "3273938616164733", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Classic" },
    { theme_color: "FFFA3C4C", theme_id: "2129984390566328", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Red" },
    { theme_color: "FF13CF13", theme_id: "2136751179887052", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Green" },
    { theme_color: "FFFF7E29", theme_id: "175615189761153", theme_emoji: null, gradient: null, should_show_icon: "1", theme_name_with_subtitle: "Orange" }
];

function formatMessage(threadID, data) {
    const baseMessage = {
        threadID: threadID,
        messageID: data.message_id,
        timestamp: data.timestamp_precise,
        author: data.message_sender ? data.message_sender.id : null
    };

    switch (data.__typename) {
        case "ThreadNameMessage":
            return {
                ...baseMessage,
                type: "event",
                logMessageType: "log:thread-name",
                logMessageData: { name: data.thread_name },
                logMessageBody: data.snippet
            };

        case "ThreadImageMessage":
            const metadata = data.image_with_metadata;
            return {
                ...baseMessage,
                type: "event",
                logMessageType: "log:thread-image",
                logMessageData: metadata ? {
                    attachmentID: metadata.legacy_attachment_id,
                    width: metadata.original_dimensions.x,
                    height: metadata.original_dimensions.y,
                    url: metadata.preview.uri
                } : null,
                logMessageBody: data.snippet
            };

        case "GenericAdminTextMessage":
            const adminType = data.extensible_message_admin_text_type;
            
            if (adminType === "CHANGE_THREAD_THEME") {
                const themeColor = data.extensible_message_admin_text.theme_color;
                const colorMatch = THEME_COLORS.find(color => color.theme_color === themeColor);
                
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-color",
                    logMessageData: colorMatch || {
                        theme_color: themeColor,
                        theme_id: null,
                        theme_emoji: null,
                        gradient: null,
                        should_show_icon: null,
                        theme_name_with_subtitle: null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "CHANGE_THREAD_ICON") {
                const thread_icon = data.extensible_message_admin_text?.thread_icon;
                let iconUrl = null;
                
                if (thread_icon) {
                    try {
                        iconUrl = `https://static.xx.fbcdn.net/images/emoji.php/v9/t3c/1/16/${thread_icon.codePointAt(0).toString(16)}.png`;
                    } catch (err) {
                        utils.warn(`getMessage: Error generating icon URL: ${err.message}`);
                    }
                }
                
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-icon",
                    logMessageData: {
                        thread_icon: thread_icon || null,
                        thread_icon_url: iconUrl
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "CHANGE_THREAD_NICKNAME") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:user-nickname",
                    logMessageData: {
                        nickname: data.extensible_message_admin_text?.nickname || null,
                        participant_id: data.extensible_message_admin_text?.participant_id || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "GROUP_POLL") {
                const question = data.extensible_message_admin_text?.question;
                if (!question) {
                    return {
                        ...baseMessage,
                        type: "event",
                        logMessageType: "log:thread-poll",
                        logMessageData: { error: "Missing poll question data" },
                        logMessageBody: data.snippet
                    };
                }
                
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-poll",
                    logMessageData: {
                        question_json: JSON.stringify({
                            id: question.id,
                            text: question.text,
                            total_count: data.extensible_message_admin_text.total_count || 0,
                            viewer_has_voted: question.viewer_has_voted || false,
                            question_type: "",
                            creator_id: data.message_sender ? data.message_sender.id : null,
                            options: (question.options?.nodes || []).map(option => ({
                                id: option.id,
                                text: option.text,
                                total_count: (option.voters?.nodes || []).length,
                                viewer_has_voted: option.viewer_has_voted || false,
                                voters: (option.voters?.nodes || []).map(voter => voter.id)
                            }))
                        }),
                        event_type: (data.extensible_message_admin_text.event_type || "").toLowerCase(),
                        question_id: question.id
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "CHANGE_THREAD_QUICK_REACTION") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-icon",
                    logMessageData: {
                        thread_quick_reaction: data.extensible_message_admin_text?.thread_quick_reaction || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "CHANGE_THREAD_ADMINS") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-admins",
                    logMessageData: {
                        admin_type: data.extensible_message_admin_text?.admin_type || null,
                        target_id: data.extensible_message_admin_text?.target_id || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "CHANGE_THREAD_APPROVAL_MODE") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-approval-mode",
                    logMessageData: {
                        approval_mode: data.extensible_message_admin_text?.approval_mode || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "MESSENGER_CALL_LOG" || adminType === "PARTICIPANT_JOINED_GROUP_CALL") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-call",
                    logMessageData: {
                        event_type: adminType,
                        call_duration: data.extensible_message_admin_text?.call_duration || 0
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "PIN_MESSAGES_V2") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:thread-pinned",
                    logMessageData: {
                        pinned_message_id: data.extensible_message_admin_text?.pinned_message_id || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "UNPIN_MESSAGES_V2") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:unpin-message",
                    logMessageData: {
                        unpinned_message_id: data.extensible_message_admin_text?.unpinned_message_id || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "JOINABLE_GROUP_LINK_MODE_CHANGE") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:link-status",
                    logMessageData: {
                        link_status: data.extensible_message_admin_text?.joinable_mode || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            if (adminType === "MAGIC_WORDS") {
                return {
                    ...baseMessage,
                    type: "event",
                    logMessageType: "log:magic-words",
                    logMessageData: {
                        magic_word: data.extensible_message_admin_text?.magic_word || null
                    },
                    logMessageBody: data.snippet
                };
            }
            
            return {
                ...baseMessage,
                type: "event",
                logMessageType: "log:generic-admin",
                logMessageData: { admin_type: adminType },
                logMessageBody: data.snippet
            };

        case "UserMessage":
            const attachments = [];
            
            if (data.blob_attachments && data.blob_attachments.length > 0) {
                data.blob_attachments.forEach(att => {
                    try {
                        const formatted = _formatAttachment(att);
                        attachments.push(formatted);
                    } catch (ex) {
                        attachments.push({
                            type: "unknown",
                            error: ex.message || ex,
                            rawAttachment: att
                        });
                    }
                });
            } else if (data.extensible_attachment && Object.keys(data.extensible_attachment).length > 0) {
                try {
                    const formatted = _formatAttachment({ extensible_attachment: data.extensible_attachment });
                    attachments.push(formatted);
                } catch (ex) {
                    const storyAtt = data.extensible_attachment.story_attachment || {};
                    attachments.push({
                        type: "share",
                        ID: data.extensible_attachment.legacy_attachment_id,
                        url: storyAtt.url,
                        title: storyAtt.title_with_entities ? storyAtt.title_with_entities.text : null,
                        description: storyAtt.description ? storyAtt.description.text : null,
                        source: storyAtt.source ? storyAtt.source.text : null,
                        image: storyAtt.media && storyAtt.media.image ? storyAtt.media.image.uri : null,
                        width: storyAtt.media && storyAtt.media.image ? storyAtt.media.image.width : null,
                        height: storyAtt.media && storyAtt.media.image ? storyAtt.media.image.height : null,
                        playable: storyAtt.media ? storyAtt.media.is_playable || false : false,
                        duration: storyAtt.media ? storyAtt.media.playable_duration_in_ms || 0 : 0,
                        playableUrl: storyAtt.media && storyAtt.media.playable_url ? storyAtt.media.playable_url : null,
                        subattachments: data.extensible_attachment.subattachments,
                        properties: storyAtt.properties || {}
                    });
                }
            }

            const mentions = {};
            if (data.message && data.message.ranges) {
                data.message.ranges.forEach(mention => {
                    if (mention.entity && mention.entity.id && data.message.text) {
                        mentions[mention.entity.id] = data.message.text.substring(
                            mention.offset,
                            mention.offset + mention.length
                        );
                    }
                });
            }

            return {
                type: "message",
                senderID: data.message_sender ? data.message_sender.id : null,
                body: data.message && data.message.text ? data.message.text : "",
                threadID: threadID,
                messageID: data.message_id,
                reactions: data.message_reactions ? data.message_reactions.map(r => ({ [r.user.id]: r.reaction })) : [],
                attachments: attachments,
                mentions: mentions,
                timestamp: data.timestamp_precise
            };

        default:
            utils.warn(`getMessage: Unknown message type "${data.__typename}"`);
            return {
                ...baseMessage,
                type: "unknown",
                data: data
            };
    }
}

function parseDelta(threadID, delta) {
    if (delta.replied_to_message) {
        return {
            type: "message_reply",
            ...formatMessage(threadID, delta),
            messageReply: formatMessage(threadID, delta.replied_to_message.message)
        };
    } else {
        return formatMessage(threadID, delta);
    }
}

module.exports = function(defaultFuncs, api, ctx) {
    return function getMessage(threadID, messageID, callback) {
        let resolveFunc = function() {};
        let rejectFunc = function() {};
        const returnPromise = new Promise(function(resolve, reject) {
            resolveFunc = resolve;
            rejectFunc = reject;
        });

        if (!callback) {
            callback = function(err, info) {
                if (err) return rejectFunc(err);
                resolveFunc(info);
            };
        }

        if (!threadID || !messageID) {
            return callback({ error: "getMessage: need threadID and messageID" });
        }

        const form = {
            av: ctx.userID,
            fb_dtsg: ctx.fb_dtsg,
            queries: JSON.stringify({
                o0: {
                    doc_id: "1768656253222505",
                    query_params: {
                        thread_and_message_id: {
                            thread_id: threadID,
                            message_id: messageID
                        }
                    }
                }
            })
        };

        defaultFuncs
            .post("https://www.facebook.com/api/graphqlbatch/", ctx.jar, form)
            .then(utils.parseAndCheckLogin(ctx, defaultFuncs))
            .then(resData => {
                if (!resData || resData.length === 0) {
                    throw { error: "getMessage: no response data" };
                }

                if (resData[resData.length - 1].error_results > 0) {
                    throw resData[0].o0.errors;
                }

                if (resData[resData.length - 1].successful_results === 0) {
                    throw {
                        error: "getMessage: there was no successful_results",
                        res: resData
                    };
                }

                const fetchData = resData[0].o0.data.message;
                if (fetchData) {
                    callback(null, parseDelta(threadID, fetchData));
                } else {
                    throw { error: "getMessage: message data not found" };
                }
            })
            .catch(err => {
                utils.error("getMessage", err);
                callback(err);
            });

        return returnPromise;
    };
};
