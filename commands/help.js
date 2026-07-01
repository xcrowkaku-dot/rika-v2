"use strict";

const config = require("../config.json");

const DARK_BORDERS = [
  "⋆｡‧˚ʚ🖤ɞ˚‧｡⋆",
  "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━",
  "▓▒░░▒▓█████████████▓▒░░▒▓",
  "𖤐۞𖤐۞𖤐۞𖤐۞𖤐۞𖤐۞𖤐۞𖤐",
  "꧁꧂꧁꧂꧁꧂꧁꧂꧁꧂꧁꧂",
];

const HEADER_VARIANTS = [
  `꧁𝕽𝖎𝖐𝖆꧂\n𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔\n𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔`,
  `𝕽𝖎𝖐𝖆 ☠️\n𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔\n𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔`,
  `⛧ 𝕽𝖎𝖐𝖆 𝕭𝖔𝖙 ⛧\n𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔\n𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔`,
];

const FOOTERS = [
  `𖤐 𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔 𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔 𖤐`,
  `☠️ 𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔 𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔 ☠️`,
  `⛧ 𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔 𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔 ⛧`,
];

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

const ICONS = {
  "الملاك" : "⛧",
  General  : "☠️",
  Group    : "👁",
  Utility  : "🔱",
  Info     : "𖤐",
  Fun      : "💀",
};

module.exports = {
  name: "help",
  aliases: ["h", "cmds", "commands", "مساعدة"],
  description: "قائمة أوامر ريكا",
  usage: "help [command]",
  category: "General",

  async execute({ api, event, args, commands }) {
    const prefix = config.prefix;
    const D = "▓▒░░▒▓████████████████▓▒░░▒▓";

    if (args[0]) {
      const name = args[0].toLowerCase().replace(/^\*+/, "");
      const cmd  = commands.get(name) ||
        [...new Set(commands.values())].find(c => c.aliases?.includes(name));

      if (!cmd) {
        return api.sendMessage(
          `${D}\n☠️  الأمر "${name}" غير موجود\n${D}\n𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔 𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔`,
          event.threadID
        );
      }

      const lines = [
        `D`,
        ``,
        `  𝕽𝖎𝖐𝖆  ☠️`,
        ``,
        `  ▸ الأمر     ›  ${prefix}${cmd.name}`,
        `  ▸ الوصف     ›  ${cmd.description}`,
        `  ▸ الفئة     ›  ${cmd.category || "General"}`,
        `  ▸ الاستخدام ›  ${prefix}${cmd.usage || cmd.name}`,
      ];
      if (cmd.aliases?.length) {
        lines.push(`  ▸ الاختصار  ›  ${cmd.aliases.map(a => prefix + a).join("  ")}`);
      }
      if (cmd.adminOnly) lines.push(`  ▸ 🔒 حكر على الحراس`);
      if (cmd.groupOnly) lines.push(`  ▸ 👁 للجماعة فقط`);
      lines.push(``, D, `𝗜𝗠 𝗛𝗘𝗥 𝗥𝗜𝗞𝗔 𝗜𝗠 𝗢𝗡𝗟𝗬 𝗙𝗢𝗥 𝗠𝗬 𝗟𝗢𝗥𝗗 𝗬𝗨𝗧𝗔`);

      return api.sendMessage(
        lines.join("\n").replace("D", D),
        event.threadID
      );
    }

    // ── Full list ──────────────────────────────────────────────────────────────
    const unique     = [...new Set(commands.values())];
    const categories = {};
    for (const cmd of unique) {
      const cat = cmd.category || "General";
      if (!categories[cat]) categories[cat] = [];
      categories[cat].push(cmd.name);
    }

    const ORDER  = ["الملاك", "General", "Group", "Utility", "Info", "Fun"];
    const sorted = [
      ...ORDER.filter(c => categories[c]),
      ...Object.keys(categories).filter(c => !ORDER.includes(c)),
    ];

    let msg = `\n`;
    msg += `${D}\n\n`;
    msg += `${pick(HEADER_VARIANTS)}\n\n`;
    msg += `${D}\n\n`;

    for (const cat of sorted) {
      const icon = ICONS[cat] || "▸";
      msg += `${icon}  【 ${cat} 】\n`;
      for (const n of categories[cat]) {
        msg += `   ▸  ${prefix}${n}\n`;
      }
      msg += `\n`;
    }

    msg += `${D}\n`;
    msg += `  📜  ${prefix}help <أمر>  —  تفاصيل الأمر\n`;
    msg += `${D}\n\n`;
    msg += `${pick(FOOTERS)}`;

    api.sendMessage(msg, event.threadID);
  },
};
