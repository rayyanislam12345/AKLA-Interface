// Turns a failed upload into a sentence a lawyer can act on.
export function plainUploadError(err: unknown): string {
  const message = err instanceof Error ? err.message : typeof err === "object" && err && "message" in err ? String((err as { message: unknown }).message) : String(err ?? "");
  const m = message.toLowerCase();
  if (m.includes("failed to fetch") || m.includes("network") || m.includes("load failed")) return "The file couldn't be sent. Check your connection and try again.";
  if (m.includes("maximum allowed size") || m.includes("too large") || m.includes("payload")) return "This file is too large to upload.";
  if (m.includes("newer document version")) return "A colleague added a version of this document a moment ago. Try the upload again.";
  if (m.includes("does not belong to this project and type")) return "This document's type was changed while you were uploading. Try the upload again.";
  if (m.includes("jwt") || m.includes("not authenticated") || m.includes("forbidden")) return "Your sign-in has expired. Sign in again, then retry the upload.";
  if (m.includes("invalid file name")) return "This file's name can't be used. Rename it and try again.";
  return message || "Something went wrong. Please try again.";
}
