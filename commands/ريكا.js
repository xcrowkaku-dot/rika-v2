"use strict";

if (!global.malakIntervals) global.malakIntervals = {};

const kingMessage = `𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙆-𐎅𐏍🔴-ⵣ-👹𒉺-𝙆-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝘼-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙎-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙊-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙈-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙊-𐎅𐏍🔴-ⵣ-👹𒉺𖢣-𝙆-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙐-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙍-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝘼-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙂-𐎅𐏍🔴-ⵣ-👹𒉺-𖢣-𝙀-


 ➣🇦🇱 𝆺𝅥⃝𝗗𝗘𝗩𝗜𝗟 ۬༐ 𝗞𝗮𝗸𝘂🇦🇱𒁂 
  ‌                 ⏤͟͟͞͞🔴                         
     𝑺𝑶𝑼𝑳 𝑶𝑭 𝑨 𝑾𝑨𝑹𝑹𝑰𝑶𝑹     
 ‌ ‌     ─⃝͎̽𝙎𖤌˖𝘼ɵ⃪𝆭͜͡X͎𝆭̽ʌ𝆭⃟ɴ𝙄☠️𝆺𝅥⃝𝙈✬     
 ٛ  , 𝑪𝑹𝑶𝑾𝑺  ۬ ۬  ༐  𝗠𝗢𝗡𝗦𝗧𝗘𝗥𝗦`;

const INTERVAL_MS = 45_000; // 45 seconds

module.exports = {
  name: "ريكا",
  description: "يرسل رسالة الغراب كل 45 ثانية",
  usage: "-ريكا دفاع | -ريكا وقف",
  category: "الملاك",

  async execute({ api, event, args }) {
    const { threadID } = event;
    const sub = (args[0] || "").trim();

    // ── وقف: stop any active interval ──────────────────────────────────────
    if (sub === "وقف") {
      if (global.malakIntervals[threadID]) {
        clearInterval(global.malakIntervals[threadID]);
        delete global.malakIntervals[threadID];
        return api.sendMessage("تم ايقاف ريكا 👑🪽", threadID);
      }
      return api.sendMessage("ريكا غير مفعّلة أصلاً!", threadID);
    }

    // ── دفاع: flood with king message ──────────────────────────────────────
    if (sub === "دفاع") {
      if (global.malakIntervals[threadID]) {
        return api.sendMessage("ريكا مفعّلة بالفعل! قل *ريكا وقف لإيقافها.", threadID);
      }
      // Reserve slot BEFORE await to prevent race condition
      global.malakIntervals[threadID] = true;
      await api.sendMessage("تم تفعيل ريكا دفاع كل 45 ثانية 👑🪽", threadID);
      global.malakIntervals[threadID] = setInterval(() => {
        api.sendMessage(kingMessage, threadID).catch(() => {});
      }, INTERVAL_MS);
      return;
    }

    // ── رسالة: flood with a custom message ─────────────────────────────────
    if (sub === "رسالة") {
      const customText = args.slice(1).join(" ").trim();
      if (!customText) {
        return api.sendMessage(
          "📝 اكتب الرسالة بعد الأمر:\n*ريكا رسالة <النص>",
          threadID
        );
      }
      if (global.malakIntervals[threadID]) {
        return api.sendMessage("ريكا مفعّلة بالفعل! قل *ريكا وقف لإيقافها.", threadID);
      }
      // Reserve slot BEFORE await to prevent race condition
      global.malakIntervals[threadID] = true;
      await api.sendMessage(`تم تفعيل رسالة ريكا كل 45 ثانية 👑🪽\n\n"${customText}"`, threadID);
      global.malakIntervals[threadID] = setInterval(() => {
        api.sendMessage(customText, threadID).catch(() => {});
      }, INTERVAL_MS);
      return;
    }

    return api.sendMessage(
      "الاستخدام:\n*ريكا دفاع — تشغيل رسالة الملاك\n*ريكا رسالة <النص> — تشغيل رسالة مخصصة\n*ريكا وقف — إيقاف",
      threadID
    );
  },
};
