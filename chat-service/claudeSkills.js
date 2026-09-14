// Claude skills the firm uploads as a .zip: a SKILL.md with its references,
// scripts and templates. The skill is stored with Anthropic and runs in
// Anthropic's code execution sandbox, so its scripts genuinely run and the
// Word files it builds come back — which instructions pasted into a prompt
// could never do for a skill that fills a firm master.

import { unzipSync } from "fflate";

const API = "https://api.anthropic.com/v1";
export const MAX_SKILL_BYTES = 30 * 1024 * 1024;
const MAX_SKILL_FILES = 500;
export const CODE_EXECUTION_TOOL = { type: "code_execution_20260521", name: "code_execution" };

const JUNK = /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|\.git)(\/|$)/;

// The YAML front matter a SKILL.md opens with. Only what a skill needs is
// read — name and description — including a description folded over lines.
export function readFrontMatter(text) {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(text);
  if (!match) return { fields: {}, body: text };
  const fields = {};
  const lines = match[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(lines[i]);
    if (!m) continue;
    let value = m[2].trim();
    const block = /^[>|][+-]?$/.test(value);
    if (block) value = "";
    while (i + 1 < lines.length && /^\s+\S/.test(lines[i + 1])) {
      i++;
      value += (value ? " " : "") + lines[i].trim();
    }
    if (/^(["']).*\1$/.test(value)) value = value.slice(1, -1);
    fields[m[1]] = value;
  }
  return { fields, body: text.slice(match[0].length) };
}

/**
 * Reads a skill zip and returns its name, description, instructions and
 * files, each file path set under a folder named for the skill as the
 * Skills API expects. Throws with a reason a lawyer can act on.
 */
export function parseSkillZip(bytes) {
  let entries;
  try {
    let total = 0;
    entries = unzipSync(bytes, {
      filter: (file) => {
        total += file.originalSize;
        if (total > MAX_SKILL_BYTES) throw new Error("too large");
        return !file.name.endsWith("/") && !JUNK.test(file.name);
      },
    });
  } catch (err) {
    if (err?.message === "too large") throw new Error("The skill is larger than 30 MB unpacked, which is the most a skill can be.");
    throw new Error("This file is not a readable .zip archive.");
  }
  const paths = Object.keys(entries);
  if (!paths.length) throw new Error("The zip is empty.");
  if (paths.length > MAX_SKILL_FILES) throw new Error(`The skill has more than ${MAX_SKILL_FILES} files.`);
  if (paths.some((p) => p.includes("..") || p.startsWith("/"))) throw new Error("The zip contains paths outside the skill folder.");

  // SKILL.md at the top of the zip, or at the top of its one folder.
  const skillMd = paths.filter((p) => /^([^/]+\/)?SKILL\.md$/.test(p)).sort((a, b) => a.length - b.length)[0];
  if (!skillMd) throw new Error("No SKILL.md was found at the top of the zip or its folder.");
  const root = skillMd.slice(0, -"SKILL.md".length);
  const outside = paths.filter((p) => !p.startsWith(root));
  if (outside.length) throw new Error(`Everything in the zip must sit in the skill's folder; ${outside[0]} does not.`);

  const text = new TextDecoder().decode(entries[skillMd]);
  const { fields, body } = readFrontMatter(text);
  const name = String(fields.name ?? "").trim();
  const description = String(fields.description ?? "").trim();
  if (!/^[a-z0-9-]{1,64}$/.test(name)) throw new Error("SKILL.md needs a name of up to 64 lowercase letters, numbers and hyphens.");
  if (/anthropic|claude/.test(name)) throw new Error("A skill name cannot contain \"anthropic\" or \"claude\".");
  if (!description || description.length > 1024) throw new Error("SKILL.md needs a description of up to 1024 characters.");

  const files = paths.map((p) => ({ path: `${name}/${p.slice(root.length)}`, bytes: entries[p] }));
  return { name, description, instructions: body.trim(), files, totalBytes: files.reduce((n, f) => n + f.bytes.length, 0) };
}

async function api(key, path, init = {}) {
  const resp = await fetch(`${API}${path}`, {
    ...init,
    headers: { "x-api-key": key, "anthropic-version": "2023-06-01", ...(init.headers ?? {}) },
  });
  if (!resp.ok) {
    const detail = await resp.text().catch(() => "");
    const error = new Error(`Anthropic ${init.method ?? "GET"} ${path} failed (${resp.status}): ${detail.slice(0, 300)}`);
    error.status = resp.status;
    throw error;
  }
  return resp;
}

const skillForm = (files) => {
  const form = new FormData();
  for (const f of files) form.append("files[]", new Blob([f.bytes]), f.path);
  return form;
};

async function findSkillByName(key, name) {
  let page = "";
  for (let i = 0; i < 20; i++) {
    const data = await (await api(key, `/skills?source=custom&limit=100${page ? `&page=${encodeURIComponent(page)}` : ""}`)).json();
    const hit = (data.data ?? []).find((s) => s.display_name === name);
    if (hit) return hit;
    if (!data.has_more || !data.next_page) return null;
    page = data.next_page;
  }
  return null;
}

/**
 * Stores the skill with Anthropic: a new version of the skill already
 * registered under this name, or a new skill. Returns its id and version.
 */
export async function publishSkill(key, parsed, knownSkillId = null) {
  const version = async (id) => {
    const data = await (await api(key, `/skills/${id}/versions`, { method: "POST", body: skillForm(parsed.files) })).json();
    return { skillId: id, versionId: data.id ?? data.version ?? "latest" };
  };
  if (knownSkillId) return version(knownSkillId);
  try {
    const data = await (await api(key, "/skills", { method: "POST", body: skillForm(parsed.files) })).json();
    return { skillId: data.id, versionId: data.latest_version_id ?? "latest" };
  } catch (err) {
    // Already stored under this name — by an earlier upload, or directly.
    const existing = await findSkillByName(key, parsed.name).catch(() => null);
    if (existing) return version(existing.id);
    throw err;
  }
}

export async function unpublishSkill(key, skillId) {
  try {
    await api(key, `/skills/${skillId}`, { method: "DELETE" });
  } catch (err) {
    if (err.status === 404) return;
    // Some accounts require the versions to go first.
    const versions = await (await api(key, `/skills/${skillId}/versions?limit=100`)).json();
    for (const v of versions.data ?? []) await api(key, `/skills/${skillId}/versions/${v.version ?? v.id}`, { method: "DELETE" }).catch(() => {});
    await api(key, `/skills/${skillId}`, { method: "DELETE" });
  }
}

export async function uploadInputFile(key, bytes, filename, mime = "application/octet-stream") {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: mime }), filename);
  return (await (await api(key, "/files", { method: "POST", body: form })).json()).id;
}

export async function downloadOutputFile(key, fileId) {
  const meta = await (await api(key, `/files/${fileId}`)).json();
  const bytes = new Uint8Array(await (await api(key, `/files/${fileId}/content`)).arrayBuffer());
  return { filename: meta.filename ?? `${fileId}.bin`, mime: meta.mime_type ?? null, bytes };
}

/** Every file the sandbox handed back in a turn's content. */
export function outputFileIds(content) {
  const ids = [];
  const walk = (value) => {
    if (Array.isArray(value)) return value.forEach(walk);
    if (!value || typeof value !== "object") return;
    if (typeof value.file_id === "string" && /_output$|_result$/.test(String(value.type ?? ""))) ids.push(value.file_id);
    for (const child of Object.values(value)) if (child && typeof child === "object") walk(child);
  };
  walk(content);
  return [...new Set(ids)];
}

/**
 * One turn with the skill in force. Long runs come back paused; they are
 * resumed in the same container until the skill finishes.
 */
export async function runSkillTurn({ key, model, skillRefs, system, messages, containerId, signal, onProgress, maxContinuations = 20 }) {
  let conversation = [...messages];
  let container = containerId ? { id: containerId, skills: skillRefs } : { skills: skillRefs };
  const content = [];
  const usage = { input_tokens: 0, output_tokens: 0 };
  let data = null;
  for (let turn = 0; turn <= maxContinuations; turn++) {
    const resp = await api(key, "/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model, max_tokens: 32000, system, container, tools: [CODE_EXECUTION_TOOL], messages: conversation }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15 * 60_000)]) : AbortSignal.timeout(15 * 60_000),
    });
    data = await resp.json();
    usage.input_tokens += data.usage?.input_tokens ?? 0;
    usage.output_tokens += data.usage?.output_tokens ?? 0;
    content.push(...(data.content ?? []));
    if (data.container?.id) container = { id: data.container.id, skills: skillRefs };
    onProgress?.(data);
    if (data.stop_reason !== "pause_turn") break;
    conversation = [...conversation, { role: "assistant", content: data.content }];
  }
  const text = content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return {
    text,
    content,
    stopReason: data?.stop_reason ?? null,
    container: data?.container ? { id: data.container.id, expiresAt: data.container.expires_at } : null,
    fileIds: outputFileIds(content),
    usage,
  };
}
