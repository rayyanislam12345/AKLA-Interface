// Ask the live assistant a conversation, one message after another in one new
// chat, and print what it looked up, what it said and what it cited.
//
//   node scripts/ask.mjs                       (the Companies Act replay)
//   node scripts/ask.mjs "first question" "a follow-up" ...
//   SAVE_SESSION=1 node scripts/ask.mjs ...    (keep the sign-in for 1 hour in .smoke-tmp/)
//
// Opens the live sign-in page in Chrome; sign in there. The password is only
// ever typed into the page. Prints no tokens, keys or passwords.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const BASE = (process.env.BASE ?? "https://aklachat.duckdns.org").replace(/\/$/, "");
const SITE = process.env.SITE ?? "https://akla-interface.vercel.app";
const SESSION_FILE = ".smoke-tmp/session.json";
const REPLAY = [
  "what does the companies act 2017 say about companeis oeprating on an arms length basis",
  "SHOW ME the source",
  "show me the comapnies act witht e relevant section underlined",
  "its in the law library",
  "find the companies act int he law library, and then within that find the relevant section",
];
const questions = process.argv.slice(2).length ? process.argv.slice(2) : REPLAY;

function readEnv() {
  const vars = {};
  for (const file of [".env", ".env.local"].filter((f) => existsSync(f))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
      const value = m?.[2].replace(/^["']|["']$/g, "");
      if (m && value) vars[m[1]] = value;
    }
  }
  if (!vars.VITE_SUPABASE_URL || !vars.VITE_SUPABASE_PUBLISHABLE_KEY) throw new Error("neither .env nor .env.local has the Supabase URL and publishable key");
  return vars;
}

async function browserSession() {
  const { chromium } = await import("@playwright/test");
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(`${SITE}/auth`);
    console.log("Sign in in the Chrome window that just opened (waiting up to 5 minutes)...");
    await page.waitForURL((u) => !/\/auth/.test(u.pathname), { timeout: 300_000 });
    const stored = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((k) => /^sb-.*-auth-token$/.test(k));
      return key ? localStorage.getItem(key) : null;
    });
    if (!stored) throw new Error("no session was found after signing in");
    const s = JSON.parse(stored);
    return s.currentSession ?? s;
  } finally {
    await browser.close();
  }
}

const env = readEnv();
const supabase = createClient(env.VITE_SUPABASE_URL, env.VITE_SUPABASE_PUBLISHABLE_KEY, { auth: { persistSession: false } });
let saved = null;
if (existsSync(SESSION_FILE)) {
  try { saved = JSON.parse(readFileSync(SESSION_FILE, "utf8")); } catch { saved = null; }
  if (!saved?.savedAt || Date.now() - saved.savedAt > 60 * 60 * 1000) saved = null;
}
const stored = saved ?? (await browserSession());
const { data, error } = await supabase.auth.setSession({ access_token: stored.access_token, refresh_token: stored.refresh_token });
if (error || !data?.session) throw new Error(`the session could not be used: ${error?.message ?? "no session"}`);
const session = data.session;
if (process.env.SAVE_SESSION) {
  mkdirSync(".smoke-tmp", { recursive: true });
  writeFileSync(SESSION_FILE, JSON.stringify({ access_token: session.access_token, refresh_token: session.refresh_token, savedAt: Date.now() }), { mode: 0o600 });
}
console.log(`Signed in as ${session.user?.email}.`);
const headers = { Authorization: `Bearer ${session.access_token}`, apikey: env.VITE_SUPABASE_PUBLISHABLE_KEY, "Content-Type": "application/json" };

async function ask(message, threadId) {
  const resp = await fetch(`${BASE}/chat`, {
    method: "POST", headers, signal: AbortSignal.timeout(15 * 60 * 1000),
    body: JSON.stringify({ matterId: null, documentTypeId: null, laws: null, threadId, message, attachments: [], skill: null, workingArtifactId: null }),
  });
  if (!resp.ok || !resp.body) throw new Error(`POST /chat answered ${resp.status}: ${(await resp.text()).slice(0, 200)}`);
  const turn = { threadId, text: "", notices: [], sources: [], error: null, done: null };
  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";
    for (const part of parts) {
      let event = "message", dataLine = "";
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) dataLine += line.slice(5).trim();
      }
      if (!dataLine) continue;
      const d = JSON.parse(dataLine);
      if (event === "meta") turn.threadId = d.threadId ?? turn.threadId;
      else if (event === "delta") turn.text += d.text ?? "";
      else if (event === "notice") turn.notices.push(d.text);
      else if (event === "sources") turn.sources = d;
      else if (event === "error") turn.error = d.message ?? "unknown error";
      else if (event === "done") turn.done = d;
    }
  }
  return turn;
}

let threadId = null;
for (const [i, q] of questions.entries()) {
  console.log(`\n=== ${i + 1}. LAWYER: ${q}`);
  const started = Date.now();
  const turn = await ask(q, threadId);
  threadId = turn.threadId;
  for (const n of turn.notices) console.log(`   · ${n}`);
  if (turn.error) console.log(`   ERROR: ${turn.error}`);
  const cites = [...new Set([...turn.text.matchAll(/\[Sources?\s+([^\]]+)\]/gi)].flatMap((m) => m[1].match(/\d+/g) ?? []))];
  console.log(`   ASSISTANT (${((Date.now() - started) / 1000).toFixed(0)} s, ${turn.text.length} chars):`);
  console.log(turn.text.split("\n").filter(Boolean).slice(0, 14).map((l) => `     ${l.slice(0, 220)}`).join("\n"));
  if (turn.text.split("\n").filter(Boolean).length > 14) console.log("     …");
  console.log(`   cites: ${cites.length ? cites.map((n) => `[${n}]`).join(" ") : "none"}`);
  for (const s of turn.sources ?? []) console.log(`   source [${s.n ?? "?"}] ${s.label ?? s.act_name ?? s.filename ?? s.scope}${s.section ? ` (s.${s.section})` : ""}`);
}
console.log(`\nChat ${threadId} is in the assistant's Recent list on ${SITE}.`);
