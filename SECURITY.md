# Security & Confidentiality

This describes the actual security posture of AKLA Matter Hub as built — not aspirational. Every document in this system is presumptively privileged client work product; that framing drives the recommendations below more than generic security best practice does.

---

## Technical configuration

React 18/TypeScript SPA on Vite, backed by Supabase (Postgres + pgvector, Auth, Storage, Deno Edge Functions). All client-server traffic is HTTPS with JWT-based Supabase Auth sessions. AI calls go directly to the Anthropic and Voyage AI APIs from Edge Functions — no third AI vendor, no gateway in between.

---

## Authentication

| Feature | Implementation |
|---------|----------------|
| Email/password | Supabase Auth, bcrypt-hashed |
| MFA | Optional TOTP (`MFAEnrollment`/`MFAVerification`) — not currently enforced firm-wide |
| Session | JWT via `useAuth`, persisted to `localStorage` |
| Password reset | Email-based, Supabase-managed |

**Open recommendation, not yet actioned**: Supabase's leaked-password-protection check (against HaveIBeenPwned) is currently **disabled** on the project. It's a one-toggle fix in Auth settings and costs nothing — worth turning on before wider rollout.

---

## Authorization

### Roles

`admin`, `partner`, `associate`, `paralegal` — stored in `user_roles`, never on `profiles` (avoids privilege escalation via a profile update), checked through a `SECURITY DEFINER` `has_role()` function used across RLS policies.

### Access model: firm-wide, not per-matter

This is the load-bearing decision in the whole authorization model, made explicitly during planning rather than defaulted into: **every authenticated firm member can read and write every matter, document, note, task, and chat.** There is no per-matter access control list.

Concretely, RLS policies reduce to two shapes almost everywhere:
- `is_firm_member(auth.uid())` — general read/write, the vast majority of policies.
- `has_role(auth.uid(), 'admin')` (or `'partner'`) — gates document-type taxonomy management, role assignment, and client/matter deletion.

**What this means in practice**: there is no technical barrier between matters. If the firm ever needs an ethical wall for a specific engagement (a genuine possibility in a PPP/infrastructure practice where opposing parties on one deal may be co-counseled on another), that is a manual, out-of-band process today — not something the system enforces. Worth knowing before it's needed, not after.

---

## Database layer

- **RLS is enabled on every table.**
- Storage buckets (`matter-documents`, `precedent-library`) are both **private**, gated by the same `is_firm_member()` check on `storage.objects` policies.
- The `vector` extension lives in a dedicated `extensions` schema, not `public` (a Supabase best-practice recommendation, applied).
- Functions that touch `SECURITY DEFINER` privileges (`has_role`, `is_firm_member`, `handle_new_user`, `match_documents`) have `search_path` pinned and anonymous (`anon`) execute access explicitly revoked — `handle_new_user` is trigger-only and has no RPC access at all; `has_role`/`is_firm_member` are callable by `authenticated` only, which is required since RLS policies invoke them as the querying user.

---

## Data encryption

| Component | Standard |
|-----------|----------|
| Postgres database | AES-256 (Supabase-managed) |
| Storage buckets | AES-256 (Supabase-managed) |
| Transit (API, DB, Edge Functions) | TLS 1.2/1.3 |

## Secrets management

Edge Function secrets (`ANTHROPIC_API_KEY`, `VOYAGE_API_KEY`, plus the Supabase-managed `SUPABASE_SERVICE_ROLE_KEY`) are stored in Supabase's encrypted function-secrets store, never in client code or the repo.

---

## AI vendor confidentiality — the part generic security docs don't cover

Every document ingested here — matter uploads and firm precedent alike — is presumptively privileged. Before real client documents go through this system at any real volume, confirm in writing with both vendors:

- **Anthropic**: use a commercial API agreement, not a consumer product. Commercial API usage is not used for model training by default, but get that confirmed in the actual agreement rather than assumed.
- **Voyage AI**: same standard — confirm data-handling and retention terms before bulk-ingesting the precedent library.

**Data residency**: neither Supabase nor the underlying cloud has a Pakistan region. The nearest available region is Singapore. If any client or government counterparty has a data-residency expectation, that's worth a line in the engagement letter rather than a surprise later.

---

## Human-in-the-loop, by design

Nothing this system produces — a drafted clause, a redline suggestion — is meant to be presentable as final without a lawyer's review, and the product is built around that:

- AI-generated drafts land in an editable Tiptap editor, never a locked/exported artifact, until a lawyer explicitly saves a version.
- Redline suggestions are accept/reject, one at a time — nothing is auto-applied.
- `draft-document`'s system prompt explicitly instructs Claude to insert a marked placeholder (e.g. `[CONCESSION PERIOD — TO BE CONFIRMED]`) rather than invent a commercial term it wasn't given.
- `rag-query` is instructed to say clearly when its knowledge base has nothing relevant, rather than guess — and in testing, correctly distinguished "this is from our conversation" from "this is from the knowledge base" rather than fabricating a citation.

None of this is a substitute for review; it's meant to make the AI's boundaries legible rather than to eliminate the need for a lawyer to actually read the output.

---

## What's not built yet

- No firm-wide audit trail (login/access logging) — the hook that would carry this (`useActivityTracking`) is currently a stub. See [ARCHITECTURE.md](ARCHITECTURE.md#known-gaps--deliberate-v1-limitations).
- No MFA enforcement policy (available per-user, not required).
- No conflicts/ethical-wall tooling, per the firm-wide access decision above.
