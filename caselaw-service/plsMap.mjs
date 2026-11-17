// Maps Pakistan Law Site once, so its search and judgment pages can be read by
// the service. Signs in with the account in .env, saves the first pages a
// person sees after signing in (plus the site's own page scripts) into
// .pls-pages/, then signs out. It only opens pages; it submits nothing.
//
//   node caselaw-service/plsMap.mjs
//
// The saved pages are subscription content and stay out of git.
import { mkdir, writeFile } from "node:fs/promises";
import { PlsSession, PlsError } from "./pls.js";

try { process.loadEnvFile(new URL("./.env", import.meta.url)); } catch { /* env may already be set */ }

const OUT = new URL("./.pls-pages/", import.meta.url);
const WANTED = /search|case|judg|citation|statut|law|journal|book|index|report/i;
const AVOID = /log\s?-?out|sign\s?-?out|logoff|delete|clear|remove|payment|subscri|password|profile|feedback/i;
const LIBRARY = /jquery|bootstrap|wow|easing|fittext|modernizr|respond/i;
const MAX_PAGES = 10;
const MAX_SCRIPTS = 12;

const session = new PlsSession();
const index = [];

async function save(name, url, text) {
  await writeFile(new URL(name, OUT), text);
  index.push({ file: name, url, chars: text.length });
  console.log(`  saved ${name}  (${text.length} chars)  ${new URL(url).pathname}`);
}

function sameSite(href, from) {
  try {
    const u = new URL(href, from);
    return u.host === new URL(from).host && /^https?:$/.test(u.protocol) ? u : null;
  } catch { return null; }
}

try {
  await mkdir(OUT, { recursive: true });
  console.log("Signing in…");
  const landingUrl = await session.signIn();
  const landing = await session.request(landingUrl);
  session.noteSignOut(landing.text);
  await save("01-landing.html", landing.url, landing.text);

  const links = new Map();
  for (const m of landing.text.matchAll(/<a\b[^>]*href="([^"#][^"]*)"[^>]*>([\s\S]*?)<\/a>/gi)) {
    const u = sameSite(m[1], landing.url);
    const label = m[2].replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
    if (!u || AVOID.test(u.pathname + " " + label)) continue;
    if (WANTED.test(u.pathname + " " + label) && !links.has(u.toString())) links.set(u.toString(), label);
  }
  let n = 2;
  for (const [url, label] of [...links].slice(0, MAX_PAGES)) {
    const page = await session.request(url);
    session.noteSignOut(page.text);
    await save(`${String(n++).padStart(2, "0")}-page.html`, page.url, `<!-- link text: ${label} -->\n${page.text}`);
  }

  const scripts = new Set();
  for (const m of landing.text.matchAll(/<script[^>]*src="([^"]+)"/gi)) {
    const u = sameSite(m[1], landing.url);
    if (u && !LIBRARY.test(u.pathname)) scripts.add(u.toString());
  }
  let s = 1;
  for (const url of [...scripts].slice(0, MAX_SCRIPTS)) {
    const js = await session.request(url);
    await save(`script-${String(s++).padStart(2, "0")}.js`, js.url, js.text);
  }

  await writeFile(new URL("index.json", OUT), JSON.stringify({ mappedAt: new Date().toISOString(), landingUrl, signOutUrl: session.signOutUrl, pages: index }, null, 2));
  console.log(`Done: ${index.length} files in caselaw-service/.pls-pages/`);
} catch (err) {
  if (err instanceof PlsError && err.code === "IN_USE") {
    console.error("Someone is signed in to this account right now. Nothing was changed. Try again when it is free, or use another account in .env.");
  } else if (err instanceof PlsError) {
    console.error(`Could not sign in: ${err.message} (${err.code})`);
  } else {
    console.error(`Stopped: ${err.message}`);
  }
  process.exitCode = 2;
} finally {
  if (session.signedIn) {
    const out = await session.signOut().catch(() => false);
    console.log(out ? "Signed out." : "No sign-out link was found; the session was left to time out. Sign out in the browser if the account shows as in use.");
  }
}
