// Recruiter-Me backend (Cloudflare Worker)
// - Keeps the AI API key secret (it never reaches the browser)
// - Verifies Cloudflare Turnstile (bot check) when an interview starts
// - Enforces per-visitor and global daily limits so the free quota can't be drained
// - Calls Groq (primary) and falls back to Cloudflare Workers AI
// - Stores NO conversation content. Only anonymous daily counters.

import {
  CANARY, TYPES, STYLES, LENGTHS,
  buildInterviewSystem, buildReportSystem, looksLikeInjection,
} from "./prompts.js";

const LIMITS = {
  jobAdChars: 6000,
  answerChars: 1200,
  assistantChars: 2500,
  maxMessages: 30,
  totalChars: 30000,
};

const LANGUAGES = [
  "auto", "English", "Deutsch", "Español", "Français", "Italiano", "Português",
  "Nederlands", "Polski", "Türkçe", "हिन्दी", "ಕನ್ನಡ", "తెలుగు", "தமிழ்", "العربية", "中文",
];

// ---------- helpers ----------

const enc = new TextEncoder();
const today = () => new Date().toISOString().slice(0, 10);
const hourKey = () => new Date().toISOString().slice(11, 13);
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d);

class HttpError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

function allowedOrigins(env) {
  const list = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (env.DEV_MODE === "1") list.push("http://localhost:8000", "http://127.0.0.1:8000");
  return list;
}

function corsHeaders(origin) {
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function json(data, status, origin) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...(origin ? corsHeaders(origin) : {}),
    },
  });
}

const clean = (s) => String(s ?? "").replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "").trim();

async function hmacKey(secret) {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}
const b64u = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64u = (s) => Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function sha256hex(text) {
  const h = await crypto.subtle.digest("SHA-256", enc.encode(text));
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

// ---------- database (D1) ----------

let schemaReady = false;
async function ensureSchema(db) {
  if (schemaReady) return;
  await db.batch([
    db.prepare("CREATE TABLE IF NOT EXISTS config (k TEXT PRIMARY KEY, v TEXT NOT NULL)"),
    db.prepare("CREATE TABLE IF NOT EXISTS counters (day TEXT NOT NULL, key TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, key))"),
  ]);
  schemaReady = true;
}

// A random signing secret, created once and kept in the database, so the
// owner never has to generate or paste one.
let cachedSecret = null;
async function getSecret(db) {
  if (cachedSecret) return cachedSecret;
  const fresh = b64u(crypto.getRandomValues(new Uint8Array(32)));
  await db.prepare("INSERT OR IGNORE INTO config (k, v) VALUES ('session_secret', ?)").bind(fresh).run();
  const row = await db.prepare("SELECT v FROM config WHERE k = 'session_secret'").first();
  cachedSecret = row.v;
  return cachedSecret;
}

async function bump(db, key, by = 1) {
  const row = await db
    .prepare("INSERT INTO counters (day, key, n) VALUES (?, ?, ?) ON CONFLICT (day, key) DO UPDATE SET n = n + excluded.n RETURNING n")
    .bind(today(), key, by)
    .first();
  return row.n;
}

async function peek(db, key) {
  const row = await db.prepare("SELECT n FROM counters WHERE day = ? AND key = ?").bind(today(), key).first();
  return row ? row.n : 0;
}

// Anonymous stats the owner may look at (no content, no IPs).
async function stat(db, key) {
  try { await bump(db, `stat:${key}`); } catch { /* stats must never break a request */ }
}

// Visitor IDs are a hash of IP + today's date + secret: not reversible and
// they change every day. Old rows are deleted.
async function visitorId(request, db) {
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  const secret = await getSecret(db);
  return (await sha256hex(`${today()}|${ip}|${secret}`)).slice(0, 16);
}

async function cleanup(db) {
  await db.prepare("DELETE FROM counters WHERE day < ? AND key NOT LIKE 'stat:%'").bind(today()).run();
}

// ---------- session tokens ----------

async function makeToken(db, payload) {
  const key = await hmacKey(await getSecret(db));
  const body = b64u(enc.encode(JSON.stringify(payload)));
  const sig = b64u(await crypto.subtle.sign("HMAC", key, enc.encode(body)));
  return `${body}.${sig}`;
}

async function readToken(db, token) {
  const [body, sig] = String(token || "").split(".");
  if (!body || !sig) throw new HttpError(401, "invalid_session");
  const key = await hmacKey(await getSecret(db));
  let ok = false;
  try { ok = await crypto.subtle.verify("HMAC", key, fromB64u(sig), enc.encode(body)); } catch { ok = false; }
  if (!ok) throw new HttpError(401, "invalid_session");
  const payload = JSON.parse(new TextDecoder().decode(fromB64u(body)));
  if (Date.now() > payload.exp) throw new HttpError(401, "session_expired");
  return payload;
}

// ---------- input validation ----------

function validateSetup(raw) {
  const s = raw || {};
  const setup = {
    type: TYPES.includes(s.type) ? s.type : null,
    style: STYLES.includes(s.style) ? s.style : null,
    length: LENGTHS.includes(Number(s.length)) ? Number(s.length) : null,
    language: LANGUAGES.includes(s.language) ? s.language : "auto",
    jobAd: clean(s.jobAd),
  };
  if (!setup.type || !setup.style || !setup.length) throw new HttpError(400, "bad_setup");
  if (setup.type === "jobad") {
    if (setup.jobAd.length < 80) throw new HttpError(400, "job_ad_too_short");
    if (setup.jobAd.length > LIMITS.jobAdChars) throw new HttpError(400, "job_ad_too_long");
    if (looksLikeInjection(setup.jobAd)) throw new HttpError(400, "blocked_input");
  } else {
    setup.jobAd = "";
  }
  return setup;
}

function validateMessages(raw) {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > LIMITS.maxMessages) throw new HttpError(400, "bad_messages");
  let total = 0;
  const msgs = raw.map((m) => {
    const role = m && m.role === "assistant" ? "assistant" : m && m.role === "user" ? "user" : null;
    const content = clean(m && m.content);
    if (!role || !content) throw new HttpError(400, "bad_messages");
    const max = role === "user" ? LIMITS.answerChars : LIMITS.assistantChars;
    if (content.length > max) throw new HttpError(400, role === "user" ? "answer_too_long" : "bad_messages");
    total += content.length;
    return { role, content };
  });
  if (total > LIMITS.totalChars) throw new HttpError(400, "too_long_overall");
  if (msgs[0].role !== "assistant" || msgs[msgs.length - 1].role !== "user") throw new HttpError(400, "bad_messages");
  return msgs;
}

// ---------- Turnstile ----------

async function verifyTurnstile(env, token, ip) {
  if (env.DEV_MODE === "1" && !env.TURNSTILE_SECRET) return true;
  if (!env.TURNSTILE_SECRET) throw new HttpError(500, "server_not_configured");
  if (!token) throw new HttpError(403, "bot_check_failed");
  const form = new FormData();
  form.append("secret", env.TURNSTILE_SECRET);
  form.append("response", token);
  if (ip) form.append("remoteip", ip);
  const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", { method: "POST", body: form });
  const data = await r.json().catch(() => ({}));
  if (!data.success) throw new HttpError(403, "bot_check_failed");
  return true;
}

// ---------- AI calls ----------

function mockAI(messages, mode) {
  if (mode === "report") {
    return JSON.stringify({
      summary: "Mock report. The candidate answered all questions.",
      scores: [
        { category: "Structure", score: 6, comment: "ok" },
        { category: "Relevance", score: 7, comment: "ok" },
        { category: "Evidence", score: 5, comment: "ok" },
        { category: "Motivation", score: 8, comment: "ok" },
        { category: "Communication", score: 7, comment: "ok" },
      ],
      strengths: ["Clear motivation", "Friendly tone"],
      improvements: ["Use numbers", "Use STAR"],
      improved_answer: { question: "Mock question", answer: "Mock better answer with [number]." },
      job_fit: null,
      next_steps: ["Practise STAR", "Research the company"],
    });
  }
  const sys = messages[0].content;
  const total = Number((sys.match(/Ask exactly (\d+) main/) || [])[1] || 5);
  const asked = messages.filter((m) => m.role === "assistant" && /\[Q\d+\//.test(m.content)).length;
  if (asked === 0) return `Welcome! This is a mock. [Q1/${total}] Why do you want this role?`;
  if (asked >= total) return "Thank you, that was the last question. [END]";
  return `[Q${asked + 1}/${total}] Mock question number ${asked + 1}?`;
}

async function callGroq(env, messages, mode) {
  const body = {
    model: env.GROQ_MODEL || "openai/gpt-oss-120b",
    messages,
    temperature: mode === "report" ? 0.3 : 0.7,
    max_completion_tokens: mode === "report" ? 2200 : 600,
    // The scorecard gets more thinking time: it must follow the language and
    // no-invented-facts rules strictly. Interview questions stay fast.
    reasoning_effort: mode === "report" ? "medium" : "low",
    include_reasoning: false,
  };
  if (mode === "report") body.response_format = { type: "json_object" };
  const r = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  if (!r.ok) {
    const err = new Error(`groq_${r.status}`);
    err.status = r.status;
    throw err;
  }
  const data = await r.json();
  const text = data?.choices?.[0]?.message?.content;
  if (!text) throw new Error("groq_empty");
  return text;
}

async function callWorkersAI(env, messages, mode) {
  const out = await env.AI.run(env.FALLBACK_MODEL || "@cf/google/gemma-4-26b-a4b-it", {
    messages,
    max_tokens: mode === "report" ? 2000 : 500,
    temperature: mode === "report" ? 0.3 : 0.7,
  });
  const text = typeof out === "string" ? out
    : out?.response ?? out?.choices?.[0]?.message?.content ?? out?.result?.response;
  if (!text) throw new Error("workers_ai_empty");
  return typeof text === "string" ? text : JSON.stringify(text);
}

async function askAI(env, db, messages, mode) {
  if (env.DEV_MODE === "1" && env.MOCK_AI === "1") return { text: mockAI(messages, mode), provider: "mock" };
  if (env.GROQ_API_KEY) {
    try {
      return { text: await callGroq(env, messages, mode), provider: "groq" };
    } catch (e) {
      console.log("Groq failed, using fallback:", e.message);
    }
  }
  try {
    const text = await callWorkersAI(env, messages, mode);
    await stat(db, "fallback_used");
    return { text, provider: "workers-ai" };
  } catch (e) {
    console.log("Workers AI failed:", e.message);
    throw new HttpError(503, "ai_unavailable");
  }
}

// Output guard: block replies that leak the instructions.
function guardReply(text) {
  if (text.includes(CANARY) || /FIXED RULES|PLAYBOOK \(editable/i.test(text)) return null;
  return text;
}

// Safety net against invented facts: any number in the example answer that the
// candidate never wrote is replaced with a placeholder.
function stripInventedNumbers(answer, candidateText) {
  const said = new Set((candidateText.match(/\d+(?:[.,]\d+)?/g) || []).map((n) => n.replace(",", ".")));
  return answer.replace(/\d+(?:[.,]\d+)?(\s?%)?/g, (m, pct) => {
    const n = m.replace(/\s?%$/, "").replace(",", ".");
    return said.has(n) ? m : pct ? "[number] %" : "[number]";
  });
}

function parseReport(text, candidateText = "") {
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try {
    const r = JSON.parse(m[0]);
    const list = (a, n) => (Array.isArray(a) ? a.map((x) => clean(x)).filter(Boolean).slice(0, n) : []);
    const scores = (Array.isArray(r.scores) ? r.scores : []).slice(0, 5).map((s) => ({
      category: clean(s?.category).slice(0, 60),
      score: Math.min(10, Math.max(1, Math.round(num(s?.score, 1)))),
      comment: clean(s?.comment).slice(0, 300),
    }));
    if (scores.length === 0) return null;
    return {
      summary: clean(r.summary).slice(0, 800),
      scores,
      overall: Math.round((scores.reduce((a, s) => a + s.score, 0) / scores.length) * 10),
      strengths: list(r.strengths, 4),
      improvements: list(r.improvements, 4),
      improved_answer: r.improved_answer && r.improved_answer.answer
        ? {
            question: clean(r.improved_answer.question).slice(0, 400),
            answer: stripInventedNumbers(clean(r.improved_answer.answer).slice(0, 1200), candidateText),
          }
        : null,
      job_fit: r.job_fit && (r.job_fit.matches || r.job_fit.gaps)
        ? { matches: list(r.job_fit.matches, 6), gaps: list(r.job_fit.gaps, 6) }
        : null,
      next_steps: list(r.next_steps, 3),
    };
  } catch {
    return null;
  }
}

// ---------- limits ----------

async function enforceCallLimits(env, db, vid, sid) {
  const perHour = num(env.MAX_CALLS_PER_VISITOR_HOUR, 20);
  const perSession = num(env.MAX_CALLS_PER_SESSION, 14);
  const perDay = num(env.DAILY_AI_CALLS, 180);

  if ((await peek(db, "global:ai_calls")) >= perDay) throw new HttpError(429, "daily_limit");
  if ((await bump(db, `v:${vid}:h${hourKey()}`)) > perHour) throw new HttpError(429, "visitor_limit");
  if ((await bump(db, `s:${sid}`)) > perSession) throw new HttpError(429, "session_limit");
  await bump(db, "global:ai_calls");
}

// ---------- routes ----------

async function handleStart(request, env, db, body) {
  const setup = validateSetup(body.setup);
  const ip = request.headers.get("CF-Connecting-IP");
  const vid = await visitorId(request, db);

  if ((await peek(db, "global:interviews")) >= num(env.DAILY_INTERVIEWS, 25)) throw new HttpError(429, "daily_limit");
  if ((await peek(db, `v:${vid}:interviews`)) >= num(env.MAX_INTERVIEWS_PER_VISITOR_DAY, 3)) throw new HttpError(429, "visitor_daily_limit");

  await verifyTurnstile(env, body.turnstileToken, ip);

  if (Math.random() < 0.1) await cleanup(db);

  const sid = b64u(crypto.getRandomValues(new Uint8Array(12)));
  await enforceCallLimits(env, db, vid, sid);
  await bump(db, "global:interviews");
  await bump(db, `v:${vid}:interviews`);
  await Promise.all([
    stat(db, "started"), stat(db, `type:${setup.type}`), stat(db, `style:${setup.style}`), stat(db, `lang:${setup.language}`),
  ]);

  const messages = [
    { role: "system", content: buildInterviewSystem(setup) },
    { role: "user", content: "(The candidate is ready. Start the interview now.)" },
  ];
  const { text } = await askAI(env, db, messages, "chat");
  const reply = guardReply(text);
  if (!reply) throw new HttpError(502, "ai_error");

  const token = await makeToken(db, { sid, exp: Date.now() + 60 * 60 * 1000 });
  return { token, reply };
}

async function handleTurn(request, env, db, body, mode) {
  const session = await readToken(db, body.token);
  const setup = validateSetup(body.setup);
  const msgs = validateMessages(body.messages);
  const last = msgs[msgs.length - 1].content;

  if (mode === "chat" && looksLikeInjection(last)) {
    await stat(db, "blocked_injection");
    return { reply: null, blocked: true };
  }

  const vid = await visitorId(request, db);
  await enforceCallLimits(env, db, vid, session.sid);

  if (mode === "chat") {
    const messages = [{ role: "system", content: buildInterviewSystem(setup) }, ...msgs];
    const { text } = await askAI(env, db, messages, "chat");
    const reply = guardReply(text);
    if (!reply) {
      await stat(db, "blocked_output");
      return { reply: null, blocked: true };
    }
    return { reply };
  }

  // report
  const transcript = msgs
    .map((m) => `${m.role === "assistant" ? "INTERVIEWER" : "CANDIDATE"}: ${m.content}`)
    .join("\n\n");
  const messages = [
    { role: "system", content: buildReportSystem(setup) },
    { role: "user", content: `<transcript>\n${transcript}\n</transcript>\n\nWrite the JSON report now.` },
  ];
  const { text } = await askAI(env, db, messages, "report");
  const candidateText = msgs.filter((m) => m.role === "user").map((m) => m.content).join("\n");
  const report = parseReport(text, candidateText);
  if (!report) throw new HttpError(502, "report_failed");
  await stat(db, "completed");
  return { report };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const okOrigin = allowedOrigins(env).includes(origin) ? origin : null;

    if (url.pathname === "/" || url.pathname === "/health") {
      return json({ ok: true, service: "recruiter-me" }, 200, okOrigin);
    }
    if (!url.pathname.startsWith("/api/")) return json({ error: "not_found" }, 404, okOrigin);
    if (!okOrigin) return json({ error: "origin_not_allowed" }, 403, null);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(okOrigin) });
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, 405, okOrigin);

    const len = Number(request.headers.get("Content-Length") || 0);
    if (len > 64 * 1024) return json({ error: "too_large" }, 413, okOrigin);

    try {
      const text = await request.text();
      if (text.length > 64 * 1024) throw new HttpError(413, "too_large");
      let body;
      try { body = JSON.parse(text); } catch { throw new HttpError(400, "bad_json"); }

      const db = env.DB;
      await ensureSchema(db);

      let result;
      if (url.pathname === "/api/start") result = await handleStart(request, env, db, body);
      else if (url.pathname === "/api/turn") result = await handleTurn(request, env, db, body, "chat");
      else if (url.pathname === "/api/report") result = await handleTurn(request, env, db, body, "report");
      else throw new HttpError(404, "not_found");

      return json(result, 200, okOrigin);
    } catch (e) {
      if (e instanceof HttpError) {
        if (e.status === 429) await stat(env.DB, `limit:${e.code}`).catch(() => {});
        return json({ error: e.code, ...e.extra }, e.status, okOrigin);
      }
      console.log("Unexpected error:", e && e.stack);
      return json({ error: "server_error" }, 500, okOrigin);
    }
  },
};
