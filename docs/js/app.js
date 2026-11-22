// © 2026 Dhanush Satish Reddy. All rights reserved. See LICENSE.
// Recruiter-Me front end. Plain JavaScript, no build step, no trackers.
(() => {
  "use strict";

  const C = window.RM_CONFIG;
  const TEXT = window.RM_TEXT;
  const $ = (id) => document.getElementById(id);

  // ---------- state ----------
  const state = {
    lang: pickLang(),
    setup: null,
    token: null,
    messages: [],      // raw messages as sent to the backend
    total: 5,
    current: 0,
    ended: false,
    busy: false,
    turnstileId: null,
  };
  const t = () => TEXT[state.lang];

  // A random ID this browser keeps, so the "3 interviews per day" limit counts
  // per person instead of per internet connection. It means nothing outside
  // this site, and the server only stores a daily-changing hash of it.
  function clientId() {
    const make = () => [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try {
      let id = localStorage.getItem("rm-client");
      if (!/^[a-f0-9]{32}$/.test(id || "")) { id = make(); localStorage.setItem("rm-client", id); }
      return id;
    } catch {
      state.tempClientId = state.tempClientId || make();
      return state.tempClientId;
    }
  }

  function pickLang() {
    try {
      const saved = localStorage.getItem("rm-lang");
      if (saved === "de" || saved === "en") return saved;
    } catch { /* storage unavailable */ }
    return (navigator.language || "en").toLowerCase().startsWith("de") ? "de" : "en";
  }

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const toHtml = (s) => esc(s).split(/\n{2,}/).map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`).join("");

  function parseReply(raw) {
    let q = null, total = null;
    const m = raw.match(/\[Q(\d+)\s*\/\s*(\d+)\]/i);
    if (m) { q = Number(m[1]); total = Number(m[2]); }
    const end = /\[END\]/i.test(raw);
    const clean = raw
      .replace(/\[Q\d+\s*\/\s*\d+\]\s*/gi, "")
      .replace(/\[END\]/gi, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/^#+\s*/gm, "")
      .trim();
    return { clean, q, total, end };
  }

  async function api(path, body) {
    let r;
    try {
      r = await fetch(C.API_URL + path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(70000),
      });
    } catch (e) {
      throw new Error(e && e.name === "TimeoutError" ? "ai_unavailable" : "network");
    }
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(data.error || "default");
    return data;
  }

  const errText = (code) => t().errors[code] || t().errors.default;
  function showError(el, code) {
    el.textContent = errText(code);
    el.hidden = false;
  }

  function setView(name) {
    ["home", "interview", "report"].forEach((v) => { $(v).hidden = v !== name; });
    document.body.dataset.view = name;
    window.scrollTo(0, 0);
  }

  // ---------- static texts ----------
  function applyTexts() {
    const tx = t();
    document.documentElement.lang = state.lang;
    document.title = tx.htmlTitle;
    document.querySelectorAll("[data-t]").forEach((el) => {
      const v = tx[el.dataset.t];
      if (typeof v === "string") el.textContent = v;
    });
    $("langSwitch").setAttribute("aria-label", tx.langSwitchLabel);
    if ($("themeSwitch") && document.documentElement.classList) refreshThemeButtonSafe();
    $("langSwitch").lang = state.lang === "de" ? "en" : "de";

    $("stepsList").innerHTML = tx.steps
      .map(([h, p]) => `<li><h3>${esc(h)}</h3><p>${esc(p)}</p></li>`).join("");

    renderChoices("typeChoices", "type", tx.types, "werkstudent");
    renderChoices("styleChoices", "style", tx.styles, "realistic");
    renderChoices("lengthChoices", "length",
      Object.fromEntries(Object.entries(tx.lengths).map(([k, v]) => [k, [v, ""]])), "5");

    const sel = $("language");
    const prev = sel.value || (state.lang === "de" ? "Deutsch" : "English");
    sel.innerHTML = window.RM_LANGUAGES
      .map(([val, label]) => `<option value="${esc(val)}">${esc(label || tx.languageAuto)}</option>`).join("");
    sel.value = prev;

    $("ownerLink").textContent = C.OWNER_NAME;
    $("ownerLink").href = C.OWNER_LINKEDIN;

    updateJobAdCount();
    updateAnswerCount();
    if (state.setup) renderAgenda();
    if (!$("report").hidden && state.lastReport) renderReport(state.lastReport);
  }

  function refreshThemeButtonSafe() {
    try { refreshThemeButton(); } catch { /* not ready yet during first render */ }
  }

  function renderChoices(containerId, name, items, fallback) {
    const box = $(containerId);
    const checked = (box.querySelector("input:checked") || {}).value || fallback;
    box.innerHTML = Object.entries(items).map(([value, [title, desc]]) => `
      <label class="choice">
        <input type="radio" name="${name}" value="${esc(value)}" ${value === checked ? "checked" : ""}>
        <span class="choice-box">
          <span class="choice-title">${esc(title)}</span>
          ${desc ? `<span class="choice-desc">${esc(desc)}</span>` : ""}
        </span>
      </label>`).join("");
    if (name === "type") {
      box.querySelectorAll("input").forEach((i) => i.addEventListener("change", toggleJobAd));
      toggleJobAd();
    }
  }

  function toggleJobAd() {
    const type = (document.querySelector('input[name="type"]:checked') || {}).value;
    $("jobAdField").hidden = type !== "jobad";
  }

  function updateJobAdCount() {
    const n = $("jobAd").value.length;
    const el = $("jobAdCount");
    el.textContent = `${n.toLocaleString(state.lang)} / ${C.LIMITS.jobAd.toLocaleString(state.lang)}`;
    el.classList.toggle("over", n > C.LIMITS.jobAd);
  }

  function updateAnswerCount() {
    const n = $("answer").value.length;
    const el = $("answerCount");
    el.textContent = `${n.toLocaleString(state.lang)} / ${C.LIMITS.answer.toLocaleString(state.lang)}`;
    el.classList.toggle("over", n > C.LIMITS.answer);
  }

  // ---------- hero: one question, many languages ----------
  // Hero question: English first, then European and Asian languages take
  // turns (order lives in i18n.js), in a continuous loop. Two stacked layers crossfade, so there is
  // never a moving, half-drawn or empty frame. Screen readers get one fixed
  // label in the page language instead of the changing text.
  function heroLabel() {
    const q = window.RM_HERO_QUESTIONS.find((x) => x.lang === state.lang) || window.RM_HERO_QUESTIONS[0];
    $("heroQ").setAttribute("aria-label", q.text.replace(/\n/g, " "));
  }

  function runHero() {
    const layers = [$("heroText"), $("heroText2")];
    layers.forEach((el) => el.setAttribute("aria-hidden", "true"));
    $("heroQ").setAttribute("role", "heading");
    $("heroQ").setAttribute("aria-level", "1");
    heroLabel();
    const qs = window.RM_HERO_QUESTIONS;
    const set = (el, q) => { el.textContent = q.text; el.lang = q.lang; };
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      set(layers[0], qs.find((q) => q.lang === state.lang) || qs[0]);
      return;
    }
    let i = 0;
    let shown = 0;
    set(layers[0], qs[0]);
    setInterval(() => {
      if (document.hidden || $("home").hidden) return;   // no work in the background or during an interview
      i = (i + 1) % qs.length;
      const next = 1 - shown;
      set(layers[next], qs[i]);
      layers[next].classList.remove("is-out");
      layers[shown].classList.add("is-out");
      shown = next;
    }, 2200);
  }

  // ---------- Turnstile (bot check) ----------
  function loadTurnstile() {
    if (C.SKIP_TURNSTILE) return;
    window.rmTurnstileReady = () => {
      state.turnstileId = window.turnstile.render("#turnstile", {
        sitekey: C.TURNSTILE_SITE_KEY,
        appearance: "interaction-only",
        language: state.lang,
        theme: isDark() ? "dark" : "light",
      });
    };
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit&onload=rmTurnstileReady";
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  }
  function turnstileToken() {
    if (C.SKIP_TURNSTILE) return "dev";
    return window.turnstile && state.turnstileId !== null ? window.turnstile.getResponse(state.turnstileId) : "";
  }
  function resetTurnstile() {
    if (!C.SKIP_TURNSTILE && window.turnstile && state.turnstileId !== null) window.turnstile.reset(state.turnstileId);
  }

  // ---------- setup -> start ----------
  async function onStart(e) {
    e.preventDefault();
    if (state.busy) return;
    const err = $("setupError");
    err.hidden = true;
    const get = (n) => (document.querySelector(`input[name="${n}"]:checked`) || {}).value;
    const setup = {
      type: get("type"),
      style: get("style"),
      length: Number(get("length")),
      language: $("language").value,
      jobAd: $("jobAd").value.trim(),
    };
    if (!$("consent").checked) { showError(err, "consent"); $("consent").focus(); return; }
    if (setup.type === "jobad" && setup.jobAd.length < 80) { showError(err, "job_ad_too_short"); $("jobAd").focus(); return; }
    if (setup.jobAd.length > C.LIMITS.jobAd) { showError(err, "job_ad_too_long"); $("jobAd").focus(); return; }
    const tsToken = turnstileToken();
    if (!tsToken) { showError(err, "bot_check_pending"); $("turnstile").scrollIntoView({ block: "center" }); return; }

    const btn = $("startBtn");
    state.busy = true;
    btn.disabled = true;
    btn.textContent = t().starting;
    try {
      const data = await api("/api/start", { setup, turnstileToken: tsToken, clientId: clientId() });
      Object.assign(state, { setup, token: data.token, messages: [], total: setup.length, current: 0, ended: false, lastReport: null });
      $("transcript").innerHTML = "";
      setView("interview");
      addRecruiter(data.reply, data.sig);
      $("answer").focus();
    } catch (ex) {
      showError(err, ex.message);
    } finally {
      state.busy = false;
      btn.disabled = false;
      btn.textContent = t().start;
      resetTurnstile();
    }
  }

  // ---------- interview ----------
  function renderAgenda() {
    const tx = t();
    const s = state.setup;
    $("progressText").textContent = state.ended ? tx.progressDone : tx.progress(Math.max(1, state.current), state.total);
    $("progressDots").innerHTML = Array.from({ length: state.total }, (_, i) => {
      const n = i + 1;
      const cls = state.ended || n < state.current ? "done" : n === state.current ? "now" : "";
      return `<li class="${cls}"></li>`;
    }).join("");
    const langLabel = s.language === "auto" ? tx.languageAuto : s.language;
    $("setupSummary").innerHTML = [tx.types[s.type][0], tx.styles[s.style][0], langLabel].map(esc).join("<br>");
    const answered = state.messages.some((m) => m.role === "user");
    $("finishBtn").disabled = !answered || state.busy;
    $("finishBtn2").disabled = !answered || state.busy;
  }

  function addRecruiter(raw, sig) {
    // The signature proves to the backend that this message really came from it.
    state.messages.push({ role: "assistant", content: raw, sig });
    const r = parseReply(raw);
    if (r.total) state.total = r.total;
    if (r.q) state.current = r.q;
    if (!state.current) state.current = 1;
    appendMsg("recruiter", r.clean || "…");
    if (r.end) {
      state.ended = true;
      lockAnswer(true);
      renderAgenda();
      makeReport();
      return;
    }
    renderAgenda();
  }

  function appendMsg(who, text) {
    const tx = t();
    const div = document.createElement("div");
    div.className = `msg msg-${who}`;
    div.innerHTML = `<span class="msg-who">${esc(who === "recruiter" ? tx.interviewer : tx.you)}</span><div class="msg-text">${toHtml(text)}</div>`;
    // Only follow new messages if the reader is already near the bottom,
    // so the page never fights someone who scrolled up to reread.
    const nearBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 400;
    $("transcript").appendChild(div);
    if (nearBottom || who === "you") div.scrollIntoView({ block: "nearest" });
    return div;
  }

  function setThinking(on, label) {
    $("thinking").hidden = !on;
    $("thinkingText").textContent = label || t().sending;
    // Screen readers hear the wait too (the visible indicator is shown and hidden).
    $("srStatus").textContent = on ? label || t().sending : "";
  }

  function lockAnswer(locked) {
    $("answer").disabled = locked;
    $("sendBtn").disabled = locked;
  }

  async function onSend(e) {
    e.preventDefault();
    if (state.busy || state.ended) return;
    const box = $("answer");
    const text = box.value.trim();
    const err = $("turnError");
    err.hidden = true;
    if (!text) { box.focus(); return; }
    if (text.length > C.LIMITS.answer) { showError(err, "answer_too_long"); return; }

    state.messages.push({ role: "user", content: text });
    const bubble = appendMsg("you", text);
    box.value = "";
    updateAnswerCount();
    state.busy = true;
    lockAnswer(true);
    renderAgenda();
    setThinking(true);
    try {
      const data = await api("/api/turn", { token: state.token, setup: state.setup, messages: state.messages });
      if (data.blocked) {
        state.messages.pop();
        const note = document.createElement("p");
        note.className = "msg-note";
        note.textContent = t().blocked;
        bubble.after(note);
      } else {
        addRecruiter(data.reply, data.sig);
      }
    } catch (ex) {
      state.messages.pop();
      bubble.remove();
      box.value = text;
      updateAnswerCount();
      showError(err, ex.message);
    } finally {
      state.busy = false;
      setThinking(false);
      if (!state.ended) { lockAnswer(false); box.focus(); }
      renderAgenda();
    }
  }

  async function makeReport() {
    const err = $("turnError");
    err.hidden = true;
    // The transcript for the report must end with an answer.
    const msgs = state.messages.slice();
    while (msgs.length && msgs[msgs.length - 1].role !== "user") msgs.pop();
    if (!msgs.length) return;
    state.busy = true;
    state.ended = true;
    lockAnswer(true);
    renderAgenda();
    setThinking(true, t().preparing);
    try {
      const data = await api("/api/report", { token: state.token, setup: state.setup, messages: msgs });
      state.lastReport = { report: data.report, messages: msgs, setup: state.setup, date: new Date() };
      renderReport(state.lastReport);
      setView("report");
      $("reportTitle") && $("reportTitle").focus();
    } catch (ex) {
      showError(err, ex.message);
      const retry = document.createElement("button");
      retry.className = "btn btn-quiet";
      retry.type = "button";
      retry.textContent = t().finishEarly;
      retry.addEventListener("click", () => { retry.remove(); makeReport(); });
      err.appendChild(document.createElement("br"));
      err.appendChild(retry);
    } finally {
      state.busy = false;
      setThinking(false);
    }
  }

  // ---------- report ----------
  function dots(n) {
    return Array.from({ length: 10 }, (_, i) => `<span class="dot${i < n ? " on" : ""}"></span>`).join("");
  }

  function transcriptText(msgs) {
    const tx = t();
    return msgs.map((m) => `${m.role === "assistant" ? tx.interviewer : tx.you}: ${parseReply(m.content).clean}`).join("\n\n");
  }

  function renderReport({ report: r, messages, setup, date }) {
    const tx = t();
    const list = (items) => `<ul>${items.map((i) => `<li>${esc(i)}</li>`).join("")}</ul>`;
    const meta = `${date.toLocaleDateString(state.lang, { day: "numeric", month: "long", year: "numeric" })}, ${tx.types[setup.type][0]}, ${tx.styles[setup.style][0]}`;
    $("sheet").innerHTML = `
      <header class="sheet-head">
        <div>
          <h1 id="reportTitle" tabindex="-1">${esc(tx.reportTitle)}</h1>
          <p class="sheet-meta">${esc(meta)}</p>
        </div>
        <div class="overall" aria-label="${esc(tx.overall)}: ${r.overall} / 100">
          <span class="overall-num">${r.overall}<small> / 100</small></span>
          <span class="overall-label">${esc(tx.overall)}</span>
        </div>
      </header>
      ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ""}
      <table class="scores">
        <tbody>
          ${r.scores.map((s) => `
            <tr>
              <th scope="row">${esc(s.category)}</th>
              <td class="dots" aria-hidden="true">${dots(s.score)}</td>
              <td class="num">${s.score} / 10</td>
              <td class="comment">${esc(s.comment)}</td>
            </tr>`).join("")}
        </tbody>
      </table>
      <div class="two-col">
        <section><h2>${esc(tx.strengths)}</h2>${list(r.strengths)}</section>
        <section><h2>${esc(tx.improvements)}</h2>${list(r.improvements)}</section>
      </div>
      ${r.improved_answer ? `
        <section>
          <h2>${esc(tx.improved)}</h2>
          <div class="improved">
            <p class="improved-q">${esc(r.improved_answer.question)}</p>
            <p class="improved-a">${esc(r.improved_answer.answer)}</p>
            <small>${esc(tx.improvedNote)}</small>
          </div>
        </section>` : ""}
      ${r.job_fit ? `
        <section class="fit">
          <h2>${esc(tx.jobFit)}</h2>
          <div class="two-col">
            <div><h3>${esc(tx.matches)}</h3>${list(r.job_fit.matches)}</div>
            <div><h3>${esc(tx.gaps)}</h3>${list(r.job_fit.gaps)}</div>
          </div>
        </section>` : ""}
      ${r.next_steps.length ? `<section class="next"><h2>${esc(tx.nextSteps)}</h2>${list(r.next_steps)}</section>` : ""}
      <details class="transcript-box">
        <summary>${esc(tx.transcript)}</summary>
        <div class="transcript-text">${esc(transcriptText(messages))}</div>
      </details>
      <div class="sheet-actions">
        <button class="btn btn-primary" type="button" id="againBtn">${esc(tx.again)}</button>
        <button class="btn btn-quiet" type="button" id="printBtn">${esc(tx.print)}</button>
        <button class="btn btn-quiet" type="button" id="copyBtn">${esc(tx.copy)}</button>
      </div>
      <p class="ai-note">${esc(tx.aiNote)}</p>`;

    $("againBtn").addEventListener("click", () => resetToHome());
    $("printBtn").addEventListener("click", () => window.print());
    $("copyBtn").addEventListener("click", async (ev) => {
      try {
        await navigator.clipboard.writeText(reportText(state.lastReport));
        ev.target.textContent = tx.copied;
        setTimeout(() => { ev.target.textContent = tx.copy; }, 2000);
      } catch { /* clipboard blocked; PDF still works */ }
    });
  }

  function reportText({ report: r, messages, setup }) {
    const tx = t();
    const lines = [
      `Recruiter-Me: ${tx.reportTitle}`,
      `${tx.types[setup.type][0]}, ${tx.styles[setup.style][0]}`,
      "",
      `${tx.overall}: ${r.overall} / 100`,
      r.summary, "",
      ...r.scores.map((s) => `${s.category}: ${s.score}/10. ${s.comment}`), "",
      `${tx.strengths}:`, ...r.strengths.map((s) => `- ${s}`), "",
      `${tx.improvements}:`, ...r.improvements.map((s) => `- ${s}`), "",
    ];
    if (r.improved_answer) lines.push(`${tx.improved}:`, r.improved_answer.question, r.improved_answer.answer, "");
    if (r.job_fit) lines.push(`${tx.matches}:`, ...r.job_fit.matches.map((s) => `- ${s}`), `${tx.gaps}:`, ...r.job_fit.gaps.map((s) => `- ${s}`), "");
    if (r.next_steps.length) lines.push(`${tx.nextSteps}:`, ...r.next_steps.map((s) => `- ${s}`), "");
    lines.push(`${tx.transcript}:`, transcriptText(messages), "", location.href.split("#")[0]);
    return lines.join("\n");
  }

  function resetToHome() {
    Object.assign(state, { setup: null, token: null, messages: [], current: 0, ended: false, busy: false, lastReport: null });
    $("transcript").innerHTML = "";
    $("turnError").hidden = true;
    $("answer").value = "";
    lockAnswer(false);
    setView("home");
    $("setup").focus();
  }

  // ---------- light / dark ----------
  const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
  const isDark = () => {
    const t = document.documentElement.dataset.theme;
    return t ? t === "dark" : darkQuery.matches;
  };
  function refreshThemeButton() {
    const dark = isDark();
    document.documentElement.classList.toggle("is-dark", dark);
    const btn = $("themeSwitch");
    btn.setAttribute("aria-label", dark ? t().themeLight : t().themeDark);
    btn.title = btn.getAttribute("aria-label");
  }
  $("themeSwitch").addEventListener("click", () => {
    const next = isDark() ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("rm-theme", next); } catch { /* ignore */ }
    refreshThemeButton();
  });
  darkQuery.addEventListener("change", refreshThemeButton);

  // ---------- wire up ----------
  $("langSwitch").addEventListener("click", () => {
    state.lang = state.lang === "de" ? "en" : "de";
    try { localStorage.setItem("rm-lang", state.lang); } catch { /* ignore */ }
    applyTexts();
    heroLabel();
  });
  $("setupForm").addEventListener("submit", onStart);
  document.querySelector('.hero a[href="#setup"]').addEventListener("click", (e) => {
    e.preventDefault();
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    $("setup").scrollIntoView({ behavior: reduce ? "auto" : "smooth" });
    $("setup").focus({ preventScroll: true });
  });
  $("jobAd").addEventListener("input", updateJobAdCount);
  $("answer").addEventListener("input", updateAnswerCount);
  $("answer").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) onSend(e);
  });
  $("answerForm").addEventListener("submit", onSend);
  $("finishBtn").addEventListener("click", () => { if (!state.busy) makeReport(); });
  $("finishBtn2").addEventListener("click", () => { if (!state.busy) makeReport(); });
  $("restartBtn").addEventListener("click", () => { if (window.confirm(t().confirmRestart)) resetToHome(); });

  applyTexts();
  refreshThemeButton();
  runHero();
  loadTurnstile();
})();
