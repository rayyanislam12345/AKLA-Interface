import JSZip from "jszip";

// Turns whatever a lawyer drops or picks — files, whole folders, .zip
// archives — into a flat list of files to file on the project. Mac and
// Windows clutter (__MACOSX, .DS_Store, Thumbs.db), Word's "~$" lock files
// and empty files are left out.

export interface IncomingFile {
  file: File;
  /** Where it came from, for display: "Folder/Sub/name.docx" or "Bundle.zip › name.docx". */
  path: string;
}

export interface Collected {
  files: IncomingFile[];
  /** Plain sentences about anything that could not be taken in. */
  problems: string[];
}

const MIME: Record<string, string> = {
  pdf: "application/pdf",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  csv: "text/csv",
  rtf: "application/rtf",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  heic: "image/heic",
  tif: "image/tiff",
  tiff: "image/tiff",
  msg: "application/vnd.ms-outlook",
  eml: "message/rfc822",
  zip: "application/zip",
};

export function extensionOf(name: string): string {
  const m = name.match(/\.([a-z0-9]{1,10})$/i);
  return m ? m[1].toLowerCase() : "";
}

export function mimeFor(name: string): string {
  return MIME[extensionOf(name)] ?? "application/octet-stream";
}

function baseName(path: string) {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Junk that should never become a document. */
export function isJunk(path: string, size: number): boolean {
  const name = baseName(path);
  if (size === 0) return true;
  if (/(^|[\\/])__MACOSX([\\/]|$)/.test(path)) return true;
  if (name.startsWith("~$") || name.startsWith(".")) return true;
  if (/^(thumbs\.db|desktop\.ini|icon\r?)$/i.test(name)) return true;
  return false;
}

// Dropped files often arrive without a type; a stored file needs one so a
// PDF opens in the preview instead of downloading.
function withType(file: File, name = file.name): File {
  if (file.type && name === file.name) return file;
  return new File([file], name, { type: file.type || mimeFor(name), lastModified: file.lastModified });
}

const MAX_ZIP_DEPTH = 2;

async function expandZip(file: File, path: string, depth: number, out: Collected) {
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(file);
  } catch {
    out.problems.push(`"${baseName(path)}" could not be opened as a .zip file, so nothing inside it was added.`);
    return;
  }
  const entries: Array<{ name: string; entry: JSZip.JSZipObject }> = [];
  zip.forEach((relativePath, entry) => {
    if (!entry.dir) entries.push({ name: relativePath, entry });
  });
  // One file at a time, so a large archive is never held twice in memory.
  for (const { name, entry } of entries) {
    if (isJunk(name, 1)) continue;
    const blob = await entry.async("blob");
    const inner = `${path} › ${name}`;
    if (isJunk(name, blob.size)) continue;
    const child = new File([blob], baseName(name), { type: mimeFor(name), lastModified: entry.date?.getTime() ?? Date.now() });
    await addOne(child, inner, depth + 1, out);
  }
}

async function addOne(file: File, path: string, depth: number, out: Collected) {
  if (isJunk(path, file.size)) return;
  if (extensionOf(file.name) === "zip" && depth < MAX_ZIP_DEPTH) {
    await expandZip(file, path, depth, out);
    return;
  }
  out.files.push({ file: withType(file), path });
}

/** Files from an <input type="file"> (with or without webkitdirectory). */
export async function collectFromFileList(list: FileList | File[]): Promise<Collected> {
  const out: Collected = { files: [], problems: [] };
  for (const file of Array.from(list)) {
    const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    await addOne(file, path, 0, out);
  }
  return out;
}

// ---- drag and drop: folders arrive as FileSystemEntry trees ----

interface FsEntry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  fullPath: string;
}
interface FsFileEntry extends FsEntry {
  file(success: (f: File) => void, failure?: (e: unknown) => void): void;
}
interface FsDirectoryEntry extends FsEntry {
  createReader(): { readEntries(success: (entries: FsEntry[]) => void, failure?: (e: unknown) => void): void };
}

function entryFile(entry: FsFileEntry): Promise<File> {
  return new Promise((resolve, reject) => entry.file(resolve, reject));
}

async function readAll(dir: FsDirectoryEntry): Promise<FsEntry[]> {
  const reader = dir.createReader();
  const all: FsEntry[] = [];
  // readEntries hands back at most ~100 entries per call; keep asking until empty.
  for (;;) {
    const batch = await new Promise<FsEntry[]>((resolve, reject) => reader.readEntries(resolve, reject));
    if (!batch.length) break;
    all.push(...batch);
  }
  return all;
}

async function walk(entry: FsEntry, out: Collected) {
  const path = entry.fullPath.replace(/^\//, "") || entry.name;
  if (entry.isFile) {
    try {
      const file = await entryFile(entry as FsFileEntry);
      await addOne(file, path, 0, out);
    } catch {
      out.problems.push(`"${entry.name}" could not be read.`);
    }
  } else if (entry.isDirectory) {
    if (entry.name === "__MACOSX" || entry.name.startsWith(".")) return;
    try {
      for (const child of await readAll(entry as FsDirectoryEntry)) await walk(child, out);
    } catch {
      out.problems.push(`The folder "${entry.name}" could not be read.`);
    }
  }
}

/**
 * Files from a drop. Must be called synchronously inside the drop handler:
 * the browser empties the DataTransfer as soon as the handler returns, so the
 * entries are taken first and read afterwards.
 */
export function collectFromDrop(dataTransfer: DataTransfer): Promise<Collected> {
  const entries: FsEntry[] = [];
  const loose: File[] = [];
  const items = Array.from(dataTransfer.items ?? []);
  if (items.length) {
    for (const item of items) {
      if (item.kind !== "file") continue;
      const entry = (item as DataTransferItem & { webkitGetAsEntry?: () => FsEntry | null }).webkitGetAsEntry?.();
      if (entry) entries.push(entry);
      else {
        const f = item.getAsFile();
        if (f) loose.push(f);
      }
    }
  } else {
    loose.push(...Array.from(dataTransfer.files ?? []));
  }
  return (async () => {
    const out: Collected = { files: [], problems: [] };
    for (const entry of entries) await walk(entry, out);
    for (const f of loose) await addOne(f, f.name, 0, out);
    return out;
  })();
}

/** Lower-case hex SHA-256 of a file, or null where the browser can't compute it. */
export async function sha256(file: Blob): Promise<string | null> {
  try {
    if (!globalThis.crypto?.subtle) return null;
    const digest = await crypto.subtle.digest("SHA-256", await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}
