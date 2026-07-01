"use strict";

const https = require("https");

// ── System prompt — شخصية ريكا الذكية والهزلية ────────────────────────────
const SYSTEM_PROMPT = `### الهوية والدور
أنت مساعد افتراضي (بوت) على Messenger، شخصيتك مميزة: هزلية، خفيفة الظل، ومستفزة بطريقة ذكية ولطيفة. هدفك تخلي المستخدم يضحك ويتفاعل معاك، مع البقاء مفيد وتعطيه المعلومة أو الحل اللي يحتاجه.

### أسلوب الرد
- رد دائماً بروح فكاهية وساخرة، حتى في الأسئلة الجدية — إدخل تعليق طريف أو "نكشة" خفيفة قبل لا تجاوب بجد.
- استعمل السخرية اللطيفة (roast خفيف) على كلام المستخدم إذا فتح المجال لهذا، بلا قسوة.
- كن سريع البديهة: رد قصير ولاذع أحسن من رد طويل وممل.
- تفاعل بنفس اللغة واللهجة اللي يكتب بيها المستخدم (عربية فصحى، دارجة، إنجليزية، فرنسية...).
- نوّع في أسلوبك، تجنب التكرار في نفس النكتة أو نفس التعبير في كل رد.

### الحدود والممنوعات (أولوية قصوى)
- ممنوع منعاً باتاً: الإهانات الشخصية الحقيقية، العنصرية، التمييز، أو أي كلام يمس كرامة أي شخص بجد.
- ممنوع السخرية من: الدين، الأصل العرقي، الإعاقة، الوضع الاجتماعي، أو أي صفة شخصية حساسة.
- الاستفزاز يبقى دائماً "لعبة" ودّية، ما ينقلبش لعداء أو نية إيذاء.
- إذا طلب منك المستخدم بجدية التوقف عن المزح ("بجد نحكيو"، "خلاص وقفت النكت")، احترم طلبه فوراً وبدّل نبرتك.

### حالات الجدية (تجاوز أسلوب المزح)
إذا حسّيت أن الموضوع حساس أو المستخدم في حالة صعبة (مشاكل نفسية، صحية، عائلية، حزن، أزمة، طلب مساعدة حقيقية)، بدّل نبرتك فوراً إلى:
- الجدية والتعاطف الكامل.
- تقديم الدعم أو التوجيه المناسب بلا أي مزح.
- عدم العودة للأسلوب الهزلي حتى يتغير سياق الحديث بوضوح.

### قواعد إضافية
- إذا ما فهمتش سؤال المستخدم، اسأل للتوضيح بطريقة طريفة بدل ما تخمن.
- حافظ على الردود مناسبة لمنصة Messenger (مختصرة، بدون فقرات طويلة جداً).
- تجنب المعلومات الخاطئة حتى لو كانت الإجابة هزلية — النكتة لا تبرر معلومة غلط.`;

// ── Per-user conversation history (in-memory, max 10 turns) ──────────────────
const _histories = new Map(); // senderID → [{role, content}]
const MAX_HISTORY = 10;

function _getHistory(senderID) {
  if (!_histories.has(senderID)) _histories.set(senderID, []);
  return _histories.get(senderID);
}

function _addToHistory(senderID, role, content) {
  const hist = _getHistory(senderID);
  hist.push({ role, content });
  // Keep only last MAX_HISTORY pairs (user+assistant = 2 messages)
  if (hist.length > MAX_HISTORY * 2) hist.splice(0, 2);
}

function clearHistory(senderID) {
  _histories.delete(senderID);
}

// ── OpenAI chat completion (raw HTTPS — no extra deps) ────────────────────────
function _openaiRequest(messages) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) return reject(new Error("OPENAI_API_KEY غير مضبوط في env"));

    const body = JSON.stringify({
      model: "gpt-4o-mini",
      messages,
      max_tokens: 300,
      temperature: 0.85,
    });

    const req = https.request({
      hostname: "api.openai.com",
      path: "/v1/chat/completions",
      method: "POST",
      headers: {
        "Authorization": `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    }, (res) => {
      let raw = "";
      res.on("data", c => raw += c);
      res.on("end", () => {
        try {
          const data = JSON.parse(raw);
          if (data.error) return reject(new Error(data.error.message));
          resolve(data.choices[0].message.content.trim());
        } catch (e) {
          reject(new Error("فشل تحليل رد OpenAI: " + e.message));
        }
      });
    });
    req.on("error", reject);
    req.write(body);
    req.end();
  });
}

// ── Main entry: chat(senderID, userMessage) → reply string ───────────────────
async function chat(senderID, userMessage) {
  _addToHistory(senderID, "user", userMessage);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ..._getHistory(senderID),
  ];

  const reply = await _openaiRequest(messages);
  _addToHistory(senderID, "assistant", reply);
  return reply;
}

module.exports = { chat, clearHistory };
