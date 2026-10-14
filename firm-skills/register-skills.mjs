// One-off: register packaged firm skills the way POST /skills/upload does,
// without a browser session. Mirrors chat-service/server.js's handler: parse the
// zip, publish to the skills runtime, then upsert the ai_skills row.
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";
import { parseSkillZip, publishSkill } from "/opt/chat-service/claudeSkills.js";
const KEY = process.env.ANTHROPIC_API_KEY;
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });
const CREATED_BY = "ef5f1fd4-9aa8-44cb-bbc1-09cad426403e"; // the admin who registered the existing skills
// The old "Concession Drafing" instructions row is converted in place so its id survives.
const REPLACE_ROW = { "concession-agreement": "b052128c-bbc3-42ca-a7f5-44336cd93c2d" };
for (const zip of process.argv.slice(2)) {
  const parsed = parseSkillZip(new Uint8Array(readFileSync(zip)));
  const forced = REPLACE_ROW[parsed.name];
  const { data: existing } = forced
    ? await db.from("ai_skills").select("id, anthropic_skill_id").eq("id", forced).maybeSingle()
    : await db.from("ai_skills").select("id, anthropic_skill_id").eq("kind", "claude_skill").eq("name", parsed.name).maybeSingle();
  const published = await publishSkill(KEY, parsed, existing?.anthropic_skill_id ?? null);
  const fields = {
    name: parsed.name, description: parsed.description, instructions: parsed.instructions || parsed.description,
    kind: "claude_skill", anthropic_skill_id: published.skillId, anthropic_version_id: published.versionId,
    skill_files: parsed.files.map((f) => ({ path: f.path, size: f.bytes.length })), produces_document: false,
    updated_at: new Date().toISOString(),
  };
  const { data: row, error } = existing
    ? await db.from("ai_skills").update(fields).eq("id", existing.id).select("id, name, kind").single()
    : await db.from("ai_skills").insert({ ...fields, created_by: CREATED_BY }).select("id, name, kind").single();
  if (error) { console.error(`${parsed.name}: published as ${published.skillId} but DB write failed: ${error.message}`); process.exitCode = 1; continue; }
  console.log(`${parsed.name}: ${existing ? "replaced row" : "added"} ${row.id} · ${parsed.files.length} files, ${parsed.totalBytes} bytes · skill ${published.skillId} v ${published.versionId}${parsed.renamed.length ? ` · renamed ${parsed.renamed.length} file(s)` : ""}`);
}
