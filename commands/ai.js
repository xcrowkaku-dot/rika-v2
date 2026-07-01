"use strict";

const aiChat = require("../utils/aiChat");

module.exports = {
  name: "ai",
  aliases: ["ريكا_ai", "chat"],
  description: "تحدث مع ريكا الذكية — ترد بروح هزلية وتساعدك",
  usage: "*ai <رسالتك>",
  category: "ذكاء اصطناعي",

  async execute({ api, event, args }) {
    const { threadID, senderID } = event;
    const text = args.join(" ").trim();

    if (!text) {
      return api.sendMessage(
        "😒 كتبت أمر فاضي؟ قولي شو تبي!\nالاستخدام: *ai <رسالتك>",
        threadID
      );
    }

    // sub-command: clear history
    if (text === "clear" || text === "مسح") {
      aiChat.clearHistory(senderID);
      return api.sendMessage("🗑️ تم مسح المحادثة — نبدأ من الصفر!", threadID);
    }

    try {
      const reply = await aiChat.chat(senderID, text);
      await api.sendMessage(reply, threadID);
    } catch (e) {
      await api.sendMessage("❌ AI واجه مشكلة: " + e.message, threadID);
    }
  },
};
