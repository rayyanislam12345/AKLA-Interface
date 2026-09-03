import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// Supabase Storage object keys can silently reject characters a real filename
// often has -- parentheses, ampersands, apostrophes, Urdu/Arabic script,
// leading/trailing whitespace -- with an "Invalid path" error the uploader
// can't otherwise explain. This never touches the display name (the original
// stays in the DB's file_name column); it only sanitizes the storage key.
export function sanitizeStorageFilename(name: string): string {
  const lastDot = name.lastIndexOf(".");
  const base = lastDot > 0 ? name.slice(0, lastDot) : name;
  const ext = lastDot > 0 ? name.slice(lastDot) : "";

  const safeBase = base
    .replace(/[^\w.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  const safeExt = ext.replace(/[^\w.]+/g, "");

  return (safeBase || "file") + safeExt;
}
