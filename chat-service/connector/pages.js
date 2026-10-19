// The connector's few pages: the sign-in form claude.ai sends a lawyer to,
// the error page, and a short "what is this" page. Server-rendered, no
// scripts, no outside assets. Everything shown is escaped.

export const escapeHtml = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STYLE = `
  :root { color-scheme: light; }
  body { margin: 0; font: 16px/1.5 -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; background: #f4f5f7; color: #1b2430; }
  main { max-width: 420px; margin: 8vh auto; padding: 32px 28px; background: #fff; border-radius: 12px; box-shadow: 0 2px 12px rgba(16, 24, 40, .08); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p { margin: 8px 0; }
  .muted { color: #5b6573; font-size: 14px; }
  label { display: block; margin-top: 14px; font-weight: 600; font-size: 14px; }
  input { width: 100%; box-sizing: border-box; margin-top: 4px; padding: 10px 12px; font-size: 16px; border: 1px solid #c9d0d9; border-radius: 8px; }
  input:focus { outline: 2px solid #1d4ed8; border-color: #1d4ed8; }
  button { margin-top: 20px; width: 100%; padding: 11px; font-size: 16px; font-weight: 600; color: #fff; background: #1b2a4a; border: 0; border-radius: 8px; cursor: pointer; }
  .error { margin-top: 14px; padding: 10px 12px; background: #fdecec; color: #8a1c1c; border-radius: 8px; font-size: 14px; }
  .note { margin-top: 14px; padding: 10px 12px; background: #eef4ff; color: #1e3a8a; border-radius: 8px; font-size: 14px; }
  ul { padding-left: 20px; }
`;

const shell = (title, body) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title><style>${STYLE}</style></head>
<body><main>${body}</main></body></html>`;

// What a sign-in that may save is told, on the sign-in page and the about
// page: the three facts of the write foundation (asks first, recorded,
// never deletes) and the one setting claude.ai's Research mode needs.
const SAVING_TERMS = `<ul>
<li>It can search and read the firm's projects, documents, precedents and law library.</li>
<li>It can save a <strong>new</strong> version of a document into a project. claude.ai asks you before every save, and every save is recorded against your name. It never replaces or deletes anything, and saving is filing, not legal approval.</li>
<li>In claude.ai's Research mode tools run without asking, so under the connector's <strong>Tool permissions</strong> set the saving tools to <strong>Needs approval</strong>.</li>
</ul>`;

/**
 * The sign-in form. `fields` are the OAuth parameters carried through as
 * hidden inputs; `error` is a sentence to show; `needsTotp` opens the form
 * on the authenticator code; `canWrite` says whether this sign-in will
 * grant hub:write (the page then says what saving means).
 */
export function signInPage({ action = "/oauth/authorize", fields = {}, email = "", error = null, needsTotp = false, clientName = null, redirectHost = "", canWrite = false } = {}) {
  const hidden = Object.entries(fields)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  // The client names itself at registration; the address it is sent back
  // to is what the server checked, so that is what the lawyer is told.
  const who = clientName ? `<strong>${escapeHtml(clientName)}</strong>` : "The app you are connecting";
  const where = redirectHost ? `<p class="note">After you sign in you will be sent back to <strong>${escapeHtml(redirectHost)}</strong>.</p>` : "";
  const asking = canWrite
    ? "is asking to read the firm's projects, documents and law library on your behalf, and to save new versions into projects as you."
    : "is asking to read the firm's projects, documents and law library on your behalf.";
  const terms = canWrite
    ? SAVING_TERMS
    : `<p class="muted">Read-only: the app can search and read; it cannot change or save anything on the Hub.</p>`;
  return shell("Sign in to AKLA Hub", `
<h1>Sign in to AKLA Hub</h1>
<p class="muted">${who} ${asking} Sign in with your Hub login. Your password stays here; the app receives only a key for the Hub, which you can withdraw at any time.</p>
${where}
<form method="post" action="${escapeHtml(action)}" autocomplete="on">
${hidden}
<label for="email">Email</label>
<input id="email" name="email" type="email" value="${escapeHtml(email)}" required autocomplete="username" ${needsTotp ? "" : "autofocus"}>
<label for="password">Password</label>
<input id="password" name="password" type="password" required autocomplete="current-password">
<label for="totp">Authenticator code</label>
<input id="totp" name="totp" type="text" inputmode="numeric" pattern="[0-9 ]*" maxlength="7" autocomplete="one-time-code" placeholder="Only if your account uses an authenticator app" ${needsTotp ? "autofocus" : ""}>
${needsTotp ? '<div class="note">Enter the 6-digit code from your authenticator app, then sign in again.</div>' : ""}
${error ? `<div class="error">${escapeHtml(error)}</div>` : ""}
<button type="submit">Sign in and connect</button>
</form>
${terms}`);
}

/** A plain error page. */
export function errorPage({ title = "Something went wrong", message = "", status = 400 } = {}) {
  const hint = status === 429 ? "" : "<p class=\"muted\">If this keeps happening, remove the AKLA Hub connector in claude.ai (Customize &gt; Connectors) and add it again.</p>";
  return shell(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>${hint}`);
}

/** What the connector is, for anyone who opens its address in a browser. */
export function aboutPage({ mcpUrl }) {
  return shell("AKLA Hub connector", `
<h1>AKLA Hub connector</h1>
<p>This is the firm's connector for claude.ai. It lets a lawyer's own Claude search the Hub's projects, documents, precedents and law library, with citations, and file what it writes into a project.</p>
<p>To add it: in claude.ai open <strong>Customize &gt; Connectors &gt; Add custom connector</strong>, give it the address <code>${escapeHtml(mcpUrl)}</code>, and sign in with your Hub login when asked. If you connected before saving existed, remove the connector and add it again to allow saving.</p>
${SAVING_TERMS}
<ul>
<li>Only approved firm members can connect.</li>
<li>It does not see the Hub's chats or chat files.</li>
</ul>
<p class="muted">Questions: the Hub's administrators.</p>`);
}
