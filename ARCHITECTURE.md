# AKLA Matter Hub — Architecture

## Overview

AKLA Matter Hub is the firm's internal matter management and AI drafting platform, built for a Karachi-based practice working primarily in PPP transactions and infrastructure due diligence. It tracks matters through a stage/document lifecycle and layers three AI capabilities on top of the firm's own document history: precedent-aware drafting, clause-level redline review, and a matter-grounded Q&A chat.

The app is single-tenant by design — every authenticated user is a member of the one firm, and (per an explicit access-model decision) can see every matter. There is no client-facing portal.

---

## Technology Stack

### Frontend
| Technology | Purpose |
|------------|---------|
| **React 18 + TypeScript** | UI |
| **Vite** | Build tool and dev server |
| **Tailwind CSS + shadcn/ui** | Styling and component library (Radix primitives) |
| **React Router v6** | Client-side routing |
| **TanStack Query** | Server state, caching, mutations |
| **Tiptap** | Rich-text editor for AI-generated drafts |
| **docx** | Client-side `.docx` generation for exports |
| **marked** | Renders AI-generated markdown drafts into the Tiptap editor |

### Backend
| Technology | Purpose |
|------------|---------|
| **Supabase** | Postgres, Auth, Storage, Edge Functions |
| **PostgreSQL + pgvector** | Primary database; vector similarity search for the document knowledge base |
| **Deno Edge Functions** | Serverless functions for AI calls, document processing, and RAG |
| **Row Level Security (RLS)** | All data access control |

### AI
| Service | Used for |
|---------|----------|
| **Anthropic Claude** (`claude-sonnet-5`) | All generation: drafting, redline suggestions, chat, guided intake |
| **Voyage AI** (`voyage-law-2`) | Embeddings — a legal-domain-tuned model, chosen over a general-purpose one for clause-level precedent matching |

No other AI vendor is in the stack. There is no AI gateway — Edge Functions call the Anthropic and Voyage APIs directly.

---

## Directory Structure

```
src/
├── components/
│   ├── ui/                 shadcn/Radix primitives
│   ├── AppLayout.tsx        Shell: sidebar + header
│   ├── AppSidebar.tsx        Nav
│   ├── ProtectedRoute.tsx    Auth gate (no per-feature gating — firm-wide access)
│   ├── MFAEnrollment.tsx     TOTP enrollment
│   └── MFAVerification.tsx   TOTP login verification
├── hooks/
│   ├── useAuth.tsx           Session/auth context
│   ├── useClients.ts / useMatters.ts / useMatterDetail.ts / useMatterDocuments.ts
│   ├── useProfiles.ts        Lawyer directory + role assignment
│   ├── useDrafting.ts        draft-document / drafting-interview
│   ├── useRedline.ts         suggest-redline + accept/reject
│   ├── useMatterChat.ts      Threaded matter Q&A
│   └── useActivityTracking.ts  Stub — see "Known gaps" below
├── pages/
│   ├── Dashboard.tsx          Firm-wide matter overview
│   ├── MattersPage.tsx / MatterWorkspacePage.tsx
│   ├── ClientsPage.tsx / TeamPage.tsx / DocumentTypesPage.tsx
│   ├── PrecedentLibraryPage.tsx  Bulk-upload firm-wide precedent, independent of any matter
│   ├── MandateOpportunitiesPage.tsx  Read-only feed synced from the external Mandate Bot scraper
│   ├── WhatsAppActivityPage.tsx  LLM-inferred matters synced from the external whatsapp-dashboard app
│   ├── DraftDocumentPage.tsx / RedlineReviewPage.tsx / MatterChatPage.tsx
│   └── Auth.tsx / ResetPassword.tsx / HelpPage.tsx / NotFound.tsx
├── integrations/supabase/   Client + generated types
└── App.tsx                  Routes

supabase/
├── functions/
│   ├── _shared/extractText.ts   Shared PDF/DOCX/XLSX text extraction
│   ├── process-document/         Storage download → extract → ingest
│   ├── ingest-documents/         Chunk + embed (Voyage) + insert into `documents`
│   ├── rag-query/                Embed query → match_documents → Claude answer (optionally threaded)
│   ├── draft-document/           Precedent/interview-grounded draft generation
│   ├── drafting-interview/       Turn-by-turn intake chat
│   └── suggest-redline/          Clause-level review against precedent
└── migrations/               10 migrations — fresh baseline, no inherited history
```

---

## Database Schema

```
clients ──< matters ──< matter_stages
                    ├─< matter_parties
                    ├─< matter_documents ──< document_versions ──< redline_suggestions
                    ├─< matter_notes
                    ├─< matter_tasks
                    └─< ai_chat_threads ──< ai_chat_messages

document_types ──< matter_documents
               └─< documents (via document_type_id)

profiles ──< user_roles
documents          (RAG store: matter-scoped context + firm-wide precedent, one table)
```

| Table | Purpose |
|-------|---------|
| `profiles` | One row per `auth.users` row, auto-created via a trigger on signup |
| `user_roles` | `admin` / `partner` / `associate` / `paralegal`, checked via `has_role()` |
| `clients` | Client entities |
| `matters` | The core transaction/engagement record |
| `matter_stages` | Per-matter stage checklist, seeded from a default PPP pipeline on creation |
| `matter_parties` | Counterparties on a matter (name + role, e.g. "EPC Contractor") |
| `document_types` | The firm's contract taxonomy — admin-editable via Document Types |
| `matter_documents` | A document instance on a matter (title, type, status) |
| `document_versions` | Version history — every upload or AI-generated/redlined export is a new row |
| `documents` | The RAG store: chunked text + `vector(1024)` embedding + metadata. Doubles as matter-scoped context (`matter_id` set) and firm-wide precedent library (`is_precedent = true`) |
| `redline_suggestions` | Structured AI review output per document version — clause reference, original/suggested text, rationale, accept/reject status |
| `matter_notes` / `matter_tasks` | Activity log and to-dos per matter |
| `ai_chat_threads` / `ai_chat_messages` | Persistent chat — used by both the guided drafting interview and the matter Q&A chat (distinguished by `title`) |
| `support_requests` | Backing table for the Help page's contact form |
| `mandate_opportunities` | Read-only feed of business-development leads (tenders/consulting opportunities), written only by the external Mandate Bot sync job — see below |
| `whatsapp_account_links` | Maps whatsapp-dashboard's own local usernames to firm member profiles — self-service (created on first "Link WhatsApp" click) or admin-set via the Team page — see below |
| `whatsapp_matters` / `whatsapp_documents` | LLM-inferred matters and captured attachments synced from whatsapp-dashboard. Two-tier visibility: private to the capturing lawyer until linked (`matter_id`) to a real Matter, at which point it's firm-visible like everything else — see below |

### Key functions

- `has_role(user_id, role)` — SQL, `SECURITY DEFINER`, used throughout RLS policies.
- `is_firm_member(user_id)` — true for any row present in `profiles`; the basis of the firm-wide access model.
- `match_documents(query_embedding, ...)` — pgvector cosine-similarity search over `documents`, filterable by matter, document type, and precedent-only.
- `handle_new_user()` — trigger, creates a `profiles` row on `auth.users` insert.

### Storage buckets

- `matter-documents` (private) — uploaded and AI-generated document files, one folder per matter.
- `precedent-library` (private) — firm-wide precedent uploads independent of a specific matter, via the Precedent Library page (bulk multi-file upload, tagged by document type, `matter_id` null).
- `mandate-documents` (private) — PDFs Mandate Bot downloaded for each matched opportunity, one folder per opportunity. No authenticated-user write policy — only the sync job's service-role key writes here.
- `whatsapp-documents` (private) — attachments captured from tracked WhatsApp chats. Access is gated per-object through the `whatsapp_documents` row for that path (via `can_access_whatsapp_document()`), not folder-prefix convention — mirrors the same owner-or-linked visibility as `whatsapp_matters`. No authenticated-user write policy.

---

## Authentication & Authorization

- **Auth**: Supabase Auth, email/password, with optional TOTP MFA (`MFAEnrollment`/`MFAVerification`).
- **Roles**: `admin`, `partner`, `associate`, `paralegal` — stored in `user_roles`, never on `profiles`, to avoid privilege-escalation-via-update. `has_role()` is the canonical check, used inside RLS policies.
- **Access model**: firm-wide. Any authenticated firm member can read/write matters, documents, notes, tasks, and chat. There is no per-matter ACL — this was an explicit decision (documented in the original planning pass) favoring simplicity for a small, close-knit practice over conflict-screening infrastructure the firm doesn't currently need.
- **Admin-gated actions**: managing the document-type taxonomy (`document_types`), assigning roles (`user_roles`), and deleting clients/matters require `admin` (or `partner`, for client/matter deletion).
- **`ProtectedRoute`**: gates on authentication only — no per-feature flag system (the FactorIQ-era `features`/`user_features` tables were dropped along with the rest of that product).

---

## Edge Functions Reference

| Function | Calls | Purpose |
|----------|-------|---------|
| `process-document` | Voyage (via ingest-documents) | Downloads a file from storage, extracts text (PDF via `unpdf`, DOCX via `mammoth`, XLSX via `xlsx`), hands off to `ingest-documents` |
| `ingest-documents` | Voyage `voyage-law-2` | Chunks text, embeds each chunk (batched), inserts into `documents` with `matter_id`/`document_type_id`/`is_precedent` |
| `rag-query` | Voyage + Claude | Embeds a query, runs `match_documents`, asks Claude to answer grounded in the results. Optionally threaded (pass `matterId`) — persists to `ai_chat_threads`/`ai_chat_messages` and feeds prior turns back to Claude so follow-ups have context. Without `matterId`, stays stateless (used for ad hoc precedent search) |
| `draft-document` | Claude | Pulls the firm's most recent precedent of the chosen document type (direct filter, not semantic — the precedent library isn't large enough yet to need re-ranking) plus known matter parties, and/or a guided-interview transcript, and asks Claude for a full first draft |
| `drafting-interview` | Claude | Turn-by-turn intake chat — asks one question at a time, returns `{ready, message}` as JSON, persists every turn |
| `suggest-redline` | Voyage's precedent (already embedded) + Claude | Downloads a document version, extracts text, pulls precedent, asks Claude for a JSON array of clause-level suggestions; clears stale pending suggestions before inserting fresh ones on re-review |

**A recurring implementation detail worth knowing**: Claude Sonnet 5 can emit a `thinking` content block ahead of the `text` block (extended thinking). Every function that parses a Claude response finds the `text`-typed block explicitly rather than assuming `content[0]` — this was a real bug caught during development (see git history on `rag-query`, `drafting-interview`, `draft-document`, `suggest-redline`) and matters for anyone adding a new Claude-calling function.

---

## Mandate Bot (external scraper)

Mandate Bot is a Python scraper (Playwright + OCR) that watches Pakistani public-procurement portals (BPPT, PPRA/EPMS, KPPRA, Sindh, P&D KP) plus the World Bank and Asian Development Bank for tenders/consulting opportunities matching the firm's keywords. It lives in its own repository, [`AKLA_Mandate_Bot`](https://github.com/rayyanislam12345/AKLA_Mandate_Bot), entirely decoupled from this app's codebase — the only coupling is that it writes into this project's Supabase instance.

- **Schedule**: GitHub Actions, `0 23 * * *` (23:00 UTC = 04:00 PKT), plus `workflow_dispatch` for manual runs.
- **Flow per run**: scrape → append new matches to `logs/matches.csv` (skipping anything in `state/seen.json`) → `sync_to_supabase.py` upserts each row into `mandate_opportunities` (keyed on a stable `dedupe_key`, mirroring the bot's own `Tender.key` logic) and uploads that opportunity's downloaded PDFs to the `mandate-documents` bucket → the updated `state/seen.json` is committed back to the repo so the next (ephemeral) runner picks up where the last one left off.
- **Why state gets committed back**: GitHub Actions runners are ephemeral — without persisting `state/seen.json` in git, every run would start from zero and re-download/re-match everything, defeating dedupe and risking portal rate-limiting.
- **`MandateOpportunitiesPage`** reads `mandate_opportunities` directly (firm-wide, read-only — `is_firm_member()`-gated `select`, no write policy for authenticated users) and lists each opportunity's saved PDFs on demand via `storage.from('mandate-documents').list()` + a signed URL per file.

---

## whatsapp-dashboard (external, continuously-running)

whatsapp-dashboard is a standalone Node.js/Express app (in `whatsapp-dashboard/`, its own `package.json`/`node_modules`, not part of this app's build) where each lawyer links their own WhatsApp account via QR code. It listens to every message in real time, uses Claude to drop personal chats and group work chats into LLM-inferred "matters" with running summaries, and captures attachments. Unlike Mandate Bot, this is a **continuously-running server with persistent browser session state (wppconnect/Puppeteer)** — it cannot become a scheduled/ephemeral job. It runs on a DigitalOcean droplet, behind Caddy/HTTPS at a free DuckDNS hostname (see `whatsapp-dashboard/DEPLOY.md`) — the Matters Hub reaches it via `VITE_WHATSAPP_API_URL`, which only needs setting in production (dev keeps using `vite.config.ts`'s own proxy to a locally-run copy).

- **No separate site**: whatsapp-dashboard's own frontend (`public/`) still exists but the Matters Hub never sends anyone to it. `vite.config.ts` proxies `/whatsapp-api/*` to `localhost:3740/api/*`, so from the browser's perspective there's exactly one origin. `whatsapp-dashboard/src/supabaseAuthBridge.js` is what makes that origin-merge also cover *auth*: given a Supabase access token (attached by `useWhatsAppConnection.ts`'s `whatsappApiFetch` on every call), it resolves the caller's linked `whatsapp_user_id` and sets `req.session.userId` — every existing Express route already just reads that, so `whatsapp.js`/`sessionManager.js`/`summarizer.js`/`backfill.js`/`qa.js`/`store.js` needed zero changes. The original username/password login (`/api/login`, `public/login.html`) still exists untouched, just unused by the Hub.
- **Self-service linking**: `POST /api/supabase-link` (called from the "Link WhatsApp" button on `WhatsAppActivityPage` when a firm member has no `whatsapp_account_links` row yet) creates a whatsapp-dashboard account keyed on the caller's own Supabase profile id — globally unique, so no name collision is possible and no admin step is required — inserts the link row, and calls `sessionManager.ensureSession()` to start a fresh WhatsApp Web session on the spot (the next `/status` poll shows the QR code). Pre-existing accounts with real historical data (e.g. one manually linked before this existed) keep working exactly the same way; self-service is just how a *new* link gets created.
- **Sync**: hooks directly into the app's existing 5-minute `summarize()` cycle (`whatsapp-dashboard/src/index.js` → `whatsapp-dashboard/src/sync/supabaseSync.js`) rather than a separate job — there's no ephemeral-runner problem to solve, so piggybacking on the loop that already owns the local JSON store avoids a second process racing the first. Requires `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`/`SUPABASE_ANON_KEY` in `whatsapp-dashboard/.env` (the service-role key must be the actual **project** `service_role` key from Project Settings → API — a personal access token, `sbp_...`, looks superficially similar but is rejected by the project's own API); sync and the auth bridge are both no-ops (app still works standalone) if unset.
- **Two-tier visibility**: an *unlinked* `whatsapp_matters` row is visible only to `owner_id` (the capturing lawyer) — deliberate, since this data may hold privileged/personal client communications from an individual lawyer's own device. Linking it to a real `matters` row (`matter_id`) is an affirmative act of sharing that makes it firm-visible from then on, matching the rest of the app's no-per-matter-ACL model. The UPDATE RLS policy's `USING` clause mirrors the SELECT policy, so a lawyer can only ever link a row they could already see — nobody can force-expose another lawyer's private, unlinked matter by guessing a UUID. `matter_id` is otherwise sync-owned data protected two ways: column-level `GRANT UPDATE (matter_id)` (authenticated users can't touch any other column) and a `BEFORE UPDATE` trigger (`protect_whatsapp_matter_link()`) that resets `matter_id` to its prior value whenever the service role writes.
- **`WhatsAppActivityPage`** is one page for everything: a "Your WhatsApp Connection" card (link/QR/status/Backfill/Ask — `useWhatsAppConnection.ts`) plus the firm-wide (RLS-filtered) synced-matters list + link-to-Matter UI (`useWhatsAppMatters.ts`). `MatterWorkspacePage` surfaces already-linked activity inline once a matter has any.
- No raw-message/timeline table synced to Supabase in v1 — `whatsapp_matters.chat_history` (jsonb, mirrors the local `matters.json`'s per-chat summary timeline) is enough for the UI; the high-volume, privileged raw message archive stays local, backing only whatsapp-dashboard's own `/api/ask`.

---

## Known gaps / deliberate v1 limitations

- **`useActivityTracking` is a stub.** The FactorIQ-era version logged against tables that no longer exist. A matter-hub-appropriate audit trail (logins, matter/document access) hasn't been rebuilt.
- **Redline export requires the same session.** `RedlineReviewPage` needs the extracted source text to build the clean export, and that text isn't cached across visits — re-run the review to enable export if you're returning to a page with existing suggestions.
- **No native Word tracked-changes.** Redline suggestions are accept/reject in-app; the export is a clean revised `.docx`, not a document with OOXML revision marks. Flagged from the start as a deliberate v1 scope decision, not an oversight.
- **`document_types.required_fields`** exists in the schema (a hint for the drafting interview) but has no editing UI yet — no document type currently has it populated.
- **No data-residency option in Pakistan.** The Supabase project runs on the nearest available region; there is no AWS/Supabase presence in Pakistan itself. See [SECURITY.md](SECURITY.md).
- **Onboarding the rest of the firm** (10-11 more lawyers) hasn't happened yet — there's one admin test account.
