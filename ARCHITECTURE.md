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

### Key functions

- `has_role(user_id, role)` — SQL, `SECURITY DEFINER`, used throughout RLS policies.
- `is_firm_member(user_id)` — true for any row present in `profiles`; the basis of the firm-wide access model.
- `match_documents(query_embedding, ...)` — pgvector cosine-similarity search over `documents`, filterable by matter, document type, and precedent-only.
- `handle_new_user()` — trigger, creates a `profiles` row on `auth.users` insert.

### Storage buckets

- `matter-documents` (private) — uploaded and AI-generated document files, one folder per matter.
- `precedent-library` (private) — reserved for firm-wide precedent uploads independent of a specific matter; not yet wired to any UI (all current precedent ingestion goes through matter documents flagged `is_precedent`).

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

## Known gaps / deliberate v1 limitations

- **`useActivityTracking` is a stub.** The FactorIQ-era version logged against tables that no longer exist. A matter-hub-appropriate audit trail (logins, matter/document access) hasn't been rebuilt.
- **Redline export requires the same session.** `RedlineReviewPage` needs the extracted source text to build the clean export, and that text isn't cached across visits — re-run the review to enable export if you're returning to a page with existing suggestions.
- **No native Word tracked-changes.** Redline suggestions are accept/reject in-app; the export is a clean revised `.docx`, not a document with OOXML revision marks. Flagged from the start as a deliberate v1 scope decision, not an oversight.
- **`document_types.required_fields`** exists in the schema (a hint for the drafting interview) but has no editing UI yet — no document type currently has it populated.
- **No data-residency option in Pakistan.** The Supabase project runs on the nearest available region; there is no AWS/Supabase presence in Pakistan itself. See [SECURITY.md](SECURITY.md).
- **Onboarding the rest of the firm** (10-11 more lawyers) hasn't happened yet — there's one admin test account.
