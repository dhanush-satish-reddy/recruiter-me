// Fake Groq API for local tests of the model chain.
// EXHAUSTED: comma-separated models that answer "429 tokens per day".
import http from "node:http";
const exhausted = new Set((process.env.EXHAUSTED || "").split(",").filter(Boolean));
// RATELIMIT: models that answer one "tokens per minute" 429 (retry-after 1 s) before working.
const minuteLimited = new Set((process.env.RATELIMIT || "").split(",").filter(Boolean));
const calls = [];
http.createServer((req, res) => {
  if (req.url === "/calls") { res.end(JSON.stringify(calls)); return; }
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const { model, reasoning_effort } = JSON.parse(body);
    calls.push({ model, reasoning_effort: reasoning_effort ?? null });
    if (minuteLimited.has(model)) {
      minuteLimited.delete(model);
      res.writeHead(429, { "Content-Type": "application/json", "retry-after": "1" });
      res.end(JSON.stringify({ error: { message: `Rate limit reached for model \`${model}\` on tokens per minute (TPM): Limit 8000. Please try again in 1s.` } }));
      return;
    }
    if (exhausted.has(model)) {
      res.writeHead(429, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { message: `Rate limit reached for model \`${model}\` on tokens per day (TPD): Limit 200000, Used 199990` } }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: `[Q1/3] Hello from ${model}. Why this role?` } }] }));
  });
}).listen(Number(process.env.PORT || 8799));
