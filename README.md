# AKLA Matter Hub

The firm's internal matter management and AI drafting hub — track PPP transactions and due-diligence engagements through their document lifecycle, and use the firm's own precedent library to draft and review agreements.

See [ARCHITECTURE.md](ARCHITECTURE.md) for a full technical writeup and [SECURITY.md](SECURITY.md) for the security/confidentiality model.

## What it does

- **Matters** — track a transaction's client, sector, lead partner, and a stage checklist (Origination → Due Diligence → Drafting → Negotiation → Financial Close → Post-Closing), plus parties, tasks, and notes.
- **Documents** — upload drafts against a matter, version them, and move them through a status pipeline (not started → drafting → internal review → with counterparty → negotiation → finalized → executed). Every upload is text-extracted and embedded into the firm's document knowledge base.
- **AI Workspace** — one per-matter page with three tabs: **Ask** (chat grounded in that matter's documents and the firm's precedent library), **Draft** (a guided interview, then a first draft grounded in the firm's standard template and precedent for that document type, exported as a firm-formatted `.docx`), and **Verify** (three review passes — legal clauses & citations, formatting, content & conflicts — with accept/reject and, for Word files, real tracked changes applied to the uploaded `.docx`). Documents can be uploaded, with a document type, from inside the workspace.
- **Document Types** — admin-editable contract taxonomy (Concession Agreement, EPC Contract, financing agreements, etc.) that drives drafting and review.

## Tech stack

React 18 + TypeScript + Vite, Tailwind CSS + shadcn/ui, TanStack Query, React Router. Backend is Supabase (Postgres + pgvector, Auth, Storage, Edge Functions). AI: Anthropic Claude for generation, Voyage AI (`voyage-law-2`, a legal-domain embedding model) for retrieval.

## Local development

```sh
npm install
npm run dev
```

Requires a `.env` with:

```
VITE_SUPABASE_URL="https://<project-ref>.supabase.co"
VITE_SUPABASE_PUBLISHABLE_KEY="sb_publishable_..."
VITE_SUPABASE_PROJECT_ID="<project-ref>"
```

The Supabase project itself needs two Edge Function secrets set (Project Settings → Edge Functions → Secrets): `ANTHROPIC_API_KEY` and `VOYAGE_API_KEY`.

## Other scripts

```sh
npm run build      # production build
npm run lint        # eslint
npm run qa          # Playwright-driven QA bot (qa-bot/)
```
