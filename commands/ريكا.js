"use strict";

if (!global.malakIntervals) global.malakIntervals = {};

const kingMessage = `𝑹 𝑰 𝑲 𝑨  𝑿   𝒀 𝑼 𝑻 𝑨 
𝑹【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑰【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑲【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑨【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑹【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑰【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑲【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑨【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑹【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑰【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑲【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑨【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑹【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑰【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑲【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

𝑨【🐦‍⬛】┋🛡┋『𒀱』〘⚫〙   ❍⃢⃟⃟ ⃟❍ 

↫🛡↬

َ  ➦   ۬༐  𝑪𝑹𝑶𝑾𝑺 𝐀𝐑𝐄 𝐓𝐇𝐄 𝐊𝐈𝐍𝐆𝐒 𝐎𝐅 𝐅𝐀𝐂𝐄𝐁𝐎𝐎𝐊⇢🔴⇠

   ➥『𝑰 𝑨𝑴 𝑻𝑯𝑬 𝑫𝑬𝑭𝑬𝑵𝑫𝑬𝑹』╮

                   
 َ          ┋ 

➥𝑪𝑼𝑹𝑺𝑬⟺ 𝑹𝑰𝑲𝑨

『༴‌🐦‍⬛⋆‌🔞』⇣؍.َِ
 
.៸࣪៸    𝆺𝅥⃝𝑻𝑯𝑬  ۬༐  𝑮𝑼𝑨𝑹𝑫𝑰𝑨𝑵 ➠〘𓃵〙
ُ           
                           ➥【  𝆺𝅥⃝𝑻𝑯𝑬  ۬༐  𝑪𝑹𝑶𝑾𝑺】

𝑮𝑼𝑨𝑹𝑫𝑰𝑨𝑵 𝙊𝙁 𝒀𑼴𝑻𝑨 ⚪



ُ➨ 𝑵𝑶 𝑶𝑵𝑬 𝑪𝑨𝑵 𝑻𝑶𝑼𝑪𝑯 𝑴𝒀 𝒀𝑼𝑻𝑨`;

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
