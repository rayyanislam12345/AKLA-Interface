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

/**
 * The sign-in form. `fields` are the OAuth parameters carried through as
 * hidden inputs; `error` is a sentence to show; `needsTotp` opens the form
 * on the authenticator code.
 */
export function signInPage({ action = "/oauth/authorize", fields = {}, email = "", error = null, needsTotp = false, clientName = null, redirectHost = "" } = {}) {
  const hidden = Object.entries(fields)
    .filter(([, v]) => v != null && v !== "")
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}">`)
    .join("\n");
  // The client names itself at registration; the address it is sent back
  // to is what the server checked, so that is what the lawyer is told.
  const who = clientName ? `<strong>${escapeHtml(clientName)}</strong>` : "The app you are connecting";
  const where = redirectHost ? `<p class="note">After you sign in you will be sent back to <strong>${escapeHtml(redirectHost)}</strong>.</p>` : "";
  return shell("Sign in to AKLA Hub", `
<h1>Sign in to AKLA Hub</h1>
<p class="muted">${who} is asking to read the firm's projects, documents and law library on your behalf. Sign in with your Hub login. Your password stays here; the app receives only a key for the Hub, which you can withdraw at any time.</p>
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
<p class="muted">Read-only: the app can search and read; it cannot change or save anything on the Hub.</p>`);
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
<p>This is the firm's connector for claude.ai. It lets a lawyer's own Claude search the Hub's projects, documents, precedents and law library, with citations.</p>
<p>To add it: in claude.ai open <strong>Customize &gt; Connectors &gt; Add custom connector</strong>, give it the address <code>${escapeHtml(mcpUrl)}</code>, and sign in with your Hub login when asked.</p>
<ul>
<li>Read-only: it can search and read, never change or save.</li>
<li>Only approved firm members can connect.</li>
<li>It does not see the Hub's chats or chat files.</li>
</ul>
<p class="muted">Questions: the Hub's administrators.</p>`);
}
