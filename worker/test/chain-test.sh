#!/usr/bin/env bash
# Tests the Groq model chain against a fake Groq server (test/fake-groq.mjs).
# Starts its own fake server and local Worker. Run from the worker folder:
#   bash test/chain-test.sh
set -u
cd "$(dirname "$0")/.."

PASS=0; FAIL=0
check() { if [ "$2" = "1" ]; then PASS=$((PASS+1)); echo "  PASS $1"; else FAIL=$((FAIL+1)); echo "  FAIL $1"; fi; }

stop_all() {
  pkill -f "test/fake-groq.mjs" 2>/dev/null; pkill -f "wrangler dev" 2>/dev/null
  # Wait until the old servers are really gone, so no case talks to a stale one.
  for _ in $(seq 1 20); do
    curl -s -o /dev/null localhost:8787/health || curl -s -o /dev/null localhost:8799/calls || break
    sleep 0.5
  done
  sleep 1
}

run_case() { # $1 = models used up for today, $2 = models with one per-minute limit
  stop_all
  rm -rf .wrangler/state
  EXHAUSTED="$1" RATELIMIT="${2:-}" SLOW="${3:-0}" node test/fake-groq.mjs > /tmp/rm-fake-groq.log 2>&1 &
  npx wrangler dev --local --port 8787 --var MOCK_AI:0 --var GROQ_API_KEY:test \
    --var GROQ_BASE_URL:http://localhost:8799 > /tmp/rm-wrangler.log 2>&1 &
  for _ in $(seq 1 30); do curl -s localhost:8787/health > /dev/null && break; sleep 1; done
  local setup='{"type":"werkstudent","style":"realistic","length":3,"language":"English"}'
  R1=$(curl -s -H Content-Type:application/json -H Origin:http://localhost:8000 \
    -d "{\"setup\":$setup,\"turnstileToken\":\"x\"}" localhost:8787/api/start)
  R2=$(curl -s -H Content-Type:application/json -H Origin:http://localhost:8000 \
    -d "{\"setup\":$setup,\"turnstileToken\":\"x\"}" localhost:8787/api/start)
  # Second step: answer the first question (the recruiter message carries its signature).
  local tok reply sig
  tok=$(echo "$R1" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{process.stdout.write(JSON.parse(d).token||"")}catch{}})')
  T1=""
  if [ -n "$tok" ]; then
    T1=$(echo "$R1" | node -e '
      let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const r=JSON.parse(d);
      process.stdout.write(JSON.stringify({token:r.token,setup:'"$setup"',messages:[{role:"assistant",content:r.reply,sig:r.sig},{role:"user",content:"I like building things."}]}))})' \
      | curl -s -H Content-Type:application/json -H Origin:http://localhost:8000 -d @- localhost:8787/api/turn)
  fi
  CALLS=$(curl -s localhost:8799/calls)
}

echo "Model chain tests"

run_case ""
check "main model answers when nothing is used up" "$(echo "$R1" | grep -q 'Hello from openai/gpt-oss-120b' && echo 1)"
check "second message (with signed recruiter message) gets a reply" "$(echo "$T1" | grep -q '"reply":"\[Q1/3\] Hello from openai/gpt-oss-120b' && echo 1)"

run_case "openai/gpt-oss-120b"
check "switches to the next model when the main one is used up" "$(echo "$R1" | grep -q 'Hello from openai/gpt-oss-20b' && echo 1)"
check "remembers to skip the used-up model" "$(echo "$CALLS" | grep -o 'gpt-oss-120b' | wc -l | grep -qx 1 && echo 1)"

run_case "openai/gpt-oss-120b,openai/gpt-oss-20b,llama-3.3-70b-versatile"
check "clear daily-limit message when every model is used up" "$(echo "$R1" | grep -q '"daily_limit"' && echo 1)"
check "next interview is refused without calling the AI again" "$(echo "$R2" | grep -q '"daily_limit"' && echo "$CALLS" | grep -o '"model"' | wc -l | grep -qx 3 && echo 1)"
check "llama model is sent without reasoning settings" "$(echo "$CALLS" | grep -q '"llama-3.3-70b-versatile","reasoning_effort":null' && echo 1)"

run_case "" "openai/gpt-oss-120b"
check "waits and retries the same model after a per-minute limit" "$(echo "$R1" | grep -q 'Hello from openai/gpt-oss-120b' && echo "$CALLS" | grep -o 'gpt-oss-20b' | wc -l | grep -qx 0 && echo 1)"

# Time budget: every model answers after 40 s. The visitor must get a clear
# error well before that adds up (budget for a question is 35 s).
stop_all
rm -rf .wrangler/state
EXHAUSTED="" SLOW=40000 node test/fake-groq.mjs > /tmp/rm-fake-groq.log 2>&1 &
npx wrangler dev --local --port 8787 --var MOCK_AI:0 --var GROQ_API_KEY:test \
  --var GROQ_BASE_URL:http://localhost:8799 > /tmp/rm-wrangler.log 2>&1 &
for _ in $(seq 1 30); do curl -s localhost:8787/health > /dev/null && break; sleep 1; done
T0=$(date +%s)
R=$(curl -s -m 120 -H Content-Type:application/json -H Origin:http://localhost:8000 \
  -d '{"setup":{"type":"werkstudent","style":"realistic","length":3,"language":"English"},"turnstileToken":"x","clientId":"0123456789abcdef0123456789abcdef"}' localhost:8787/api/start)
T=$(( $(date +%s) - T0 ))
echo "  (slow AI: answer after ${T}s: $R)"
check "slow AI ends with a clear error within the time budget" "$( [ "$T" -le 40 ] && echo "$R" | grep -q '"ai_unavailable"' && echo 1)"

stop_all
echo ""
echo "$PASS passed, $FAIL failed"
[ "$FAIL" = "0" ]
