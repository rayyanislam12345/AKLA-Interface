// Turns any failure into a sentence a lawyer can act on. The database, the
// browser and the servers answer in their own words ("JWT expired", "new row
// violates row-level security policy", "Request failed (500)"); a toast shows
// what that means instead, and keeps a message that is already plain. Saving
// and uploading have their own fuller wording (plainSaveError,
// plainUploadError). Pure: tested in tests/friendlyError.test.js.

export function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) return String((err as { message: unknown }).message ?? "");
  return typeof err === "string" ? err : "";
}

const GENERIC = "Something went wrong. Try again; if it keeps happening, tell an administrator.";

// Words that only a system writes. A message containing one is not shown.
const TECHNICAL =
  /\b(jwt|pgrst\d*|sql|relation|column|constraint|violates|syntax|undefined|null value|uuid|json|token|rpc|edge function|function [a-z_]+\(|schema|stack|typeerror|referenceerror|status code|econn\w*|etimedout|cors|fetch)\b|[a-z]+_[a-z_]+|\(\d{3}\)|\b[45]\d\d\b/i;

/** A plain sentence for `err`; `fallback` when its own words would not help. */
export function friendlyError(err: unknown, fallback: string = GENERIC): string {
  const message = messageOf(err).trim();
  const m = message.toLowerCase();
  if (!message) return fallback;
  if (/failed to fetch|networkerror|network request|load failed|err_internet|offline/.test(m)) {
    return "The Hub couldn't be reached. Check your internet connection and try again.";
  }
  if (/jwt|not authenticated|not signed in|authorization header|session.*(expired|missing)|refresh token|\b401\b|unauthori[sz]ed/.test(m)) {
    return "Your sign-in has expired. Sign in again and retry.";
  }
  if (/row-level security|permission denied|\b403\b|forbidden|not allowed|only an administrator/.test(m)) {
    return /only an administrator/.test(m) ? message : "You don't have permission to do that. Ask an administrator if you need it.";
  }
  if (/invalid login credentials/.test(m)) return "That email and password don't match. Check them, or use Forgot password.";
  if (/email not confirmed/.test(m)) return "Confirm your email first: open the link we sent you, then sign in.";
  if (/rate limit|too many requests|\b429\b/.test(m)) return "Too many attempts in a short time. Wait a minute and try again.";
  if (/too large|payload|maximum allowed size|\b413\b/.test(m)) return "That file is too large.";
  if (/duplicate key|already exists|unique constraint/.test(m)) return "That already exists.";
  if (/foreign key|still referenced|is still in use/.test(m)) return "It is still in use elsewhere in the Hub, so it can't be removed.";
  if (/timeout|timed out|\b504\b/.test(m)) return "That took too long. Try again in a minute.";
  if (/overloaded|\b529\b|\b50[023]\b|internal server error|request failed/.test(m)) {
    return "Something went wrong on the Hub's side. Try again in a minute.";
  }
  return TECHNICAL.test(message) ? fallback : message;
}
