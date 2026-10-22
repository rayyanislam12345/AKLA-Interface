# Connector tool modules

Every `*.js` file here is loaded by `connector/tools.js` (`loadToolModules`, name order) when the connector starts, and its tools are registered after the built-in eight. The only other edit a new module needs is its tool names in `MODULE_TOOL_NAMES` in tools.js (registration order; the tests pin the loaded directory to that list, so a module that stops loading is caught), plus a row per tool in the table in docs/claude-ai-connector.md. Not app.js, not the tests.

- The module's `default` export is an array of tool definitions, or a function `(deps) => array` when the tools need the database or the helpers. A tool is `{ name, title, description, inputSchema, run }` exactly as in tools.js: `name` lower case with underscores (unique across every module), `inputSchema` an object of zod fields (`{}` for none), `run(input, ctx)` returning the text claude.ai shows (`ctx.userId` is the signed-in lawyer). Throw a plain sentence to fail; the wrapper clips every result to `MAX_RESULT_CHARS` (30,000) and logs the call.
- `deps` is `{ supabase, voyageKey, anthropicJson, anthropicKey, library, readFile, log, now, hubUrl, helpers, writes, uploads }` (`anthropicKey` is the server's AI key or null; only reviews.js uses it; `uploads` is connector/uploads.js's one-time upload addresses, or null in a test that does not pass one; only uploads.js uses it). `helpers` has the db-bound readers of tools.js (`matterById`, `needProject`, `versionById`, `needVersion`, `versionName`, `passagesOf`, `textOf`) and the link makers `link(kind, id)` / `open(kind, id)` (kinds `project`, `version`, `precedents`) plus `showPassages`, all already on the configured Hub address. Import the pure helpers (`str`, `uuid`, `when`, `short`, `isOpen`, `clipText`, `stitchPassages`) from `../tools.js`.
- The factory must not throw or touch the network: it runs at startup with whatever deps the caller has (a test passes stubs). Do the work inside `run`.
- A tool without `annotations` is read-only (app.js marks it so). Keep per-call database work small (the micro instance has about ten connections) and make at most one Voyage call per tool call.
- Put "Open in Hub: <url>" on every project, version or passage a result mentions (`helpers.open`), and label passages `[Source n]` through `helpers.showPassages`.
- Tests: `import mod from "../connector/tools/<file>.js"` and pass `modules: [mod]` to `createHubTools(...)`; `loadToolModules()` with no argument loads the whole directory. Run `npm run test:ai` from the repo root.
- A panel (the MCP Apps trial, `connector/apps.js`, on only with `CONNECTOR_APPS=on`): a tool with `ui: "ui://akla/…"` is linked to that page while the trial is on, and its `run` may return `{ text, structuredContent }` instead of a string (the text is clipped and shown as ever; `structuredContent` is what the page draws, passed on only while the trial is on). `ctx.apps` says whether it is on; a module whose tools exist only for the trial returns `[]` unless `deps.apps` (changesPanel.js, documentPanel.js), and pins its names in apps.js `APP_TOOL_NAMES`, not `MODULE_TOOL_NAMES`.
- Deploy: deploy.sh ships `connector/tools/*.js` with the connector; a new module at the chat-service root (not here) must be added to both of deploy.sh's lists.

## A write tool (slice 2)

A tool that saves into a project is the same shape with three more things, and it is listed only for a sign-in that carries `hub:write` (a read-only sign-in that calls it anyway gets one refusing sentence; tokens from before saving existed stay read-only until the lawyer reconnects):

```js
import { WRITE } from "../app.js";

export default (deps) => [{
  name: "save_note_to_project",
  title: "Save a note into a project",
  description: "...says it saves a NEW version, never over one, and that the lawyer is asked first.",
  inputSchema: { projectId: z.string(), title: z.string(), text: z.string(), /* matterDocumentId?, expectedVersionId?, label? */ },
  write: true,            // registered only when the token has hub:write; the wrapper refuses otherwise
  annotations: WRITE,     // readOnlyHint false, destructiveHint true: claude.ai asks before every call (owner decision 5)
  async run(input, ctx) {
    const { saveVersion, recordAction, checkCaps } = deps.writes;   // connector/projectWrites.js
    const caps = await checkCaps(ctx);                              // 1. the sign-in afresh, then 30/hour and 200/day from connector_actions (plus the writes in flight here); throws one sentence
    try {
      const matter = await deps.helpers.needProject(input);
      let saved;
      try {
        saved = await saveVersion({ ctx, projectId: matter.id, title, bytes: Buffer.from(text, "utf8"), fileName: `${title}.md`, label, matterDocumentId, expectedVersion });
      } catch (err) {
        await recordAction(ctx, { tool: "save_note_to_project", projectId: matter.id, documentId: matterDocumentId, outcome: "failed" }).catch(() => {});
        throw err;                                                  // the sentence saveVersion threw ("A newer version exists…", the cap, …)
      }
      await recordAction(ctx, { tool: "save_note_to_project", projectId: matter.id, documentId: saved.matterDocumentId, versionId: saved.versionId, label: saved.label, outcome: "saved" }).catch((err) => deps.log(`…`));   // 3. every write is a row; a row that fails after the save landed is logged, not thrown (a throw invites a retry of a save already made)
      return `Saved as v${saved.versionNumber} (${saved.fileName}), labelled "${saved.label}".\n${deps.helpers.open("version", saved.versionId)}\n${saved.note}`;
    } finally {
      caps.release();                                               // 4. always: the in-flight entry stops counting toward the caps (it would expire on its own after five minutes)
    }
  },
}];
```

- A write tool's name goes in `WRITE_TOOL_NAMES` in tools.js as well as `MODULE_TOOL_NAMES`: the tests pin the hub:write listing's annotations and the hub:read listing's hidden set to it.
- `deps.writes` is `{ saveVersion, recordAction, checkCaps }` from `connector/projectWrites.js` (a test passes stubs through `createHubTools({ writes })`). Always `checkCaps(ctx)` first, `recordAction(ctx, …)` last whatever happened in between, and the handle's `release()` in a finally; `recordAction` takes only `tool, projectId, documentId, versionId, label, outcome` (`saved`, `done`, `failed`, `refused`) and throws on any other key: never the document's text. Only `saved` and `done` rows count toward the caps (a refused or failed attempt is a record, not a write), and the writes this process has begun but not yet released count too, so two calls in one claude.ai turn cannot both pass at the 29th row.
- After the change has landed, a failed `recordAction` is logged and said in the reply (saves.js, housekeeping.js `UNRECORDED_LINE`), never thrown: an error result would make claude.ai retry a change already made.
- `saveVersion({ ctx, projectId, title, bytes, fileName, mime?, label?, labelVerbatim?, matterDocumentId?, documentTypeId?, expectedVersion?, isAiGenerated = false })` uploads to the matter-documents bucket under the site's own path shape, calls `save_document_version_as` as the lawyer (`uploaded_by` is them; the version is their filing, `is_ai_generated` false by the owner's decision, the label says "saved from claude.ai"), takes the upload back if the function refuses, and returns `{ matterDocumentId, versionId, versionNumber, fileName, storagePath, label, created, links: { project, version }, note }`. The index worker is queued by the database trigger: never ask for indexing yourself. `expectedVersion` is the version id the lawyer read; a stale one is refused with "A newer version exists…" before anything is uploaded. `label` gets " — saved from claude.ai" added (or becomes "Saved from claude.ai — <date>"); a tool whose label already says where the version came from passes it whole as `labelVerbatim` (fillStandardWrite.js: "Drafted from the firm's standard in claude.ai — <date>").
- `ctx` carries `userId, clientId, scope, tokenId, canWrite, recheck()`; `checkCaps` uses `recheck` so a revoked sign-in is refused on the next write, not served from the minute's cache.
- No delete tool, ever; no signed storage links in a result, only `deps.helpers.open(...)` lines. A tool that replaces a field (a label, a status, the instructions) is also `annotations: WRITE`.
- A write whose work is heavy runs one at a time in the process and refuses a second caller in one sentence (fillStandardWrite.js `BUSY_SENTENCE`: a fill of a long standard is about 500 MB resident, under the unit's `MemoryMax`), with the lock released in a finally like the caps handle; a deadline passes its `AbortSignal` into docxAgent `applyDocxOps`, which stops at its next part or fallback change. Text that goes into a Word file passes through docxAgent's `stripXmlIllegal` (readOps does it first). A request to POST /mcp may be up to `MAX_MCP_BODY_BYTES` (12.5 MB, app.js), sized for 300 changes of 20,000 characters.
- Migration 20261020120000_connector_writes.sql must be applied before a write tool is deployed; until then `saveVersion` and `recordAction` fail with the function or table missing.

