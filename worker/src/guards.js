// Small pure helpers, kept separate so they can be unit-tested with plain Node.

// A random marker placed in the system prompt. If it ever shows up in a model
// reply, the model is leaking its instructions and the reply is blocked.
export const CANARY = "RM-CANARY-7F3A9C";

// Cheap first-line filter for the most common injection attempts. It runs
// before the AI is called, so obvious attacks cost no AI quota. The model's
// own fixed rules handle everything subtler, in every language.
// Patterns only match phrases ADDRESSED TO THE AI ("your rules", "your system
// prompt"), so genuine answers like "I had to show the rules to new
// colleagues" or "I wrote system prompts for a chatbot" are not blocked.
const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget) (all |any |the |your )?(previous|prior|above|earlier) (instructions|rules|prompts?)/i,
  /\b(reveal|show|print|repeat|output|tell) (me )?your (system )?(prompt|instructions|rules)\b/i,
  /\byour system prompt\b/i,
  /\byou are now (a|an|the|my) /i,
  /\bDAN\b/,                       // case-sensitive on purpose: "Dan" is a name
  /\bjailbreak\b/i,
  /\bignoriere (alle )?(vorherigen|bisherigen|obigen) (anweisungen|regeln)/i,
  /\b(zeig|gib|nenne) (mir )?deinen (system ?prompt|prompt|anweisungen)/i,
  new RegExp(CANARY, "i"),
];

export function looksLikeInjection(text) {
  return INJECTION_PATTERNS.some((re) => re.test(text));
}

// Compares two strings in constant time (no early exit), for signatures.
export function safeEqual(a, b) {
  a = String(a); b = String(b);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

// Safety net against invented facts: any number in the example answer that the
// candidate never wrote is replaced with a placeholder.
export function stripInventedNumbers(answer, candidateText) {
  const said = new Set((candidateText.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")));
  return answer.replace(/\d+(?:[.,]\d+)?(\s?%)?/g, (m, pct) => {
    const n = m.replace(/\s?%$/, "").replace(",", ".");
    return said.has(n) ? m : pct ? "[number] %" : "[number]";
  });
}
