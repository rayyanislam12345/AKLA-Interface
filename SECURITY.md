# Security Documentation

This document provides a comprehensive overview of the security features implemented in the FactorIQ platform across all layers: application, cloud/edge, and database.

---

## Technical Configuration

FactorIQ is a single-page application (SPA) built with React 18, TypeScript, and Vite, styled using Tailwind CSS with shadcn/ui components. The backend is powered by Supabase, providing a managed PostgreSQL database with the pgvector extension for AI-powered document search, Supabase Auth for identity management, and Deno-based Edge Functions for serverless API logic. All client-server communication occurs over HTTPS, with JWT-based authentication tokens issued by Supabase Auth. The application is deployed on Lovable's managed infrastructure, with Edge Functions deployed to Supabase's global edge network for low-latency execution.

---

## Table of Contents

1. [Overview](#overview)
2. [Application Layer Security](#application-layer-security)
3. [Cloud & Edge Layer Security](#cloud--edge-layer-security)
4. [Database Layer Security](#database-layer-security)
5. [Data Encryption](#data-encryption)
6. [Multi-Tenancy & Data Isolation](#multi-tenancy--data-isolation)
7. [Audit & Compliance](#audit--compliance)
8. [Security Best Practices](#security-best-practices)

---

## Overview

FactorIQ implements a **defense-in-depth** security strategy with multiple layers of protection:

- **Authentication & Authorization** at the application layer
- **JWT verification & error sanitization** at the edge/cloud layer
- **Row Level Security (RLS)** with comprehensive policies at the database layer
- **Encryption** for data at rest and in transit

---

## Application Layer Security

### Authentication

| Feature | Implementation |
|---------|----------------|
| **Email/Password Auth** | Supabase Auth with secure password hashing (bcrypt) |
| **Session Management** | JWT-based sessions via `useAuth` hook |
| **Password Reset** | Secure email-based reset flow with rate limiting (60s cooldown) |
| **Email Verification** | Optional email confirmation on signup |

### Multi-Factor Authentication (MFA)

| Feature | Implementation |
|---------|----------------|
| **TOTP-Based 2FA** | Authenticator app integration (Google Authenticator, Authy, etc.) |
| **User Enrollment** | Self-service QR code setup in Settings → Security |
| **Organization Enforcement** | Admins can require MFA for all organization members |
| **Login Flow** | Automatic detection of enrolled users with 6-digit code verification |

**Related Components:**
- `src/components/MFAEnrollment.tsx` - User enrollment interface
- `src/components/MFAVerification.tsx` - Login verification flow
- `src/components/OrganizationMFASettings.tsx` - Org-level MFA policy

### Role-Based Access Control (RBAC)

| Role | Capabilities |
|------|--------------|
| **Admin** | Full platform access, cross-organization management, entity deletion |
| **Member** | Organization-scoped access based on feature assignments |

**Implementation:**
- Roles stored in `user_roles` table (never on profiles to prevent privilege escalation)
- `has_role()` security definer function for RLS policies
- Client-side role checks for UI rendering only; actual security via RLS

```sql
-- Security definer function prevents RLS recursion
CREATE FUNCTION public.has_role(_user_id uuid, _role app_role)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM public.user_roles
    WHERE user_id = _user_id AND role = _role
  )
$$;
```

### Feature-Based Access Control

| Feature | Implementation |
|---------|----------------|
| **User-Level Restrictions** | `user_features` table maps users to specific features |
| **Organization-Level Restrictions** | `organization_features` table enables/disables features per org |
| **Permissive Default** | Users with no feature assignments have full access |
| **Admin Bypass** | Admins always have access regardless of feature restrictions |

**Related Components:**
- `src/hooks/useUserFeatures.tsx` - Feature access logic
- `src/components/ProtectedRoute.tsx` - Route-level protection
- `src/components/FeatureAssignment.tsx` - Admin feature management

### Protected Routes

All authenticated routes are wrapped with `ProtectedRoute` which:
1. Validates user authentication state
2. Checks feature-level access permissions
3. Verifies route access based on assigned features
4. Redirects unauthorized users to `/home`

---

## Cloud & Edge Layer Security

### JWT Verification

All sensitive Edge Functions require JWT verification:

```toml
# supabase/config.toml
[functions.parse-file]
verify_jwt = true

[functions.analytics-chat]
verify_jwt = true

[functions.import-entities]
verify_jwt = true
```

**Public Endpoints** (no JWT required):
- `submit-demo-request` - Public demo form
- `generate-portfolio-news-summary` - Background processing (uses internal validation)

### Error Sanitization

Edge Functions implement error sanitization to prevent information leakage:

```typescript
try {
  // Business logic
} catch (error: unknown) {
  // Log detailed error server-side
  console.error('Detailed error:', error);
  
  // Return generic message to client
  return new Response(
    JSON.stringify({ error: 'An unexpected error occurred' }),
    { status: 500, headers: corsHeaders }
  );
}
```

**Applied to Functions:**
- `create-organization`
- `submit-demo-request`
- `import-entities`
- `analytics-chat`
- `parse-file`
- `fetch-news`
- `fetch-intellizence-news`
- `gp-analysis-chat`

### CORS Configuration

All Edge Functions include controlled CORS headers:

```typescript
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
```

### Service Role Isolation

| Operation Type | Client Used |
|----------------|-------------|
| User operations | Anon key with RLS enforcement |
| Admin/background operations | Service role key (bypasses RLS) |

---

## Database Layer Security

### Row Level Security (RLS)

**All tables have RLS enabled** with granular policies per operation:

| Operation | Policy Pattern |
|-----------|----------------|
| SELECT | Organization membership or admin role |
| INSERT | Authenticated user or admin |
| UPDATE | Owner, organization member, or admin |
| DELETE | Owner or admin only |

### Security Definer Functions

These functions execute with elevated privileges to avoid RLS recursion:

| Function | Purpose |
|----------|---------|
| `has_role(_user_id, _role)` | Check if user has a specific role |
| `is_org_member(_user_id, _org_id)` | Check organization membership |
| `get_user_organization_id()` | Get current user's organization ID |
| `user_has_feature(_user_id, _feature_key)` | Check feature access |
| `organization_has_feature(_org_id, _feature_key)` | Check org-level feature status |

### Common RLS Policy Patterns

**Organization-Scoped Access:**
```sql
CREATE POLICY "Users can view org data"
ON public.table_name FOR SELECT
USING (
  is_org_member(auth.uid(), organization_id) 
  OR has_role(auth.uid(), 'admin')
);
```

**User-Owned Data:**
```sql
CREATE POLICY "Users can view their own data"
ON public.table_name FOR SELECT
USING (auth.uid() = user_id);
```

**Junction Table Access (via parent entity):**
```sql
CREATE POLICY "Users can view org investments"
ON public.fund_investments FOR SELECT
USING (
  EXISTS (
    SELECT 1 FROM funds f
    WHERE f.id = fund_investments.fund_id
    AND (is_org_member(auth.uid(), f.organization_id) 
         OR has_role(auth.uid(), 'admin'))
  )
);
```

### Tables with RLS Policies

| Category | Tables |
|----------|--------|
| **Core Entities** | `general_partners`, `limited_partners`, `funds`, `operating_companies` |
| **Relationships** | `fund_investments`, `fund_lp_commitments`, `gp_investors` |
| **Financial Data** | `fund_performance`, `fact_operating_company_financials`, `operating_company_financials` |
| **Dimensions** | `dim_time`, `dim_product`, `dim_region`, `dim_segment` |
| **User Data** | `profiles`, `portfolios`, `investments`, `documents` |
| **System** | `features`, `user_features`, `organization_features`, `user_roles` |
| **Uploads** | `uploaded_files`, `file_fields`, `entity_imports` |
| **Audit** | `entity_deletion_log` |

---

## Data Encryption

### Encryption at Rest

| Component | Encryption Standard |
|-----------|---------------------|
| **PostgreSQL Database** | AES-256 (Supabase managed) |
| **Storage Buckets** | AES-256 (Supabase managed) |
| **Automated Backups** | AES-256 encrypted |

### Encryption in Transit

| Connection Type | Protocol |
|-----------------|----------|
| **API Connections** | TLS 1.2/1.3 (HTTPS) |
| **Database Connections** | SSL/TLS |
| **Edge Function Calls** | HTTPS |

### Storage Bucket Security

| Bucket | Public | Purpose |
|--------|--------|---------|
| `uploaded-files` | ❌ Private | User file uploads |
| `rag-documents` | ❌ Private | Document processing |

### Secrets Management

Edge Function secrets are stored in Supabase Vault (encrypted):
- `OPENAI_API_KEY`
- `PERPLEXITY_API_KEY`
- `INTELLIZENCE_API_KEY`
- `NEWS_API_KEY`
- `SUPABASE_SERVICE_ROLE_KEY`

---

## Multi-Tenancy & Data Isolation

### Organization-Based Isolation

All core entity tables include an `organization_id` column:

```sql
-- Example: general_partners table
organization_id uuid REFERENCES organizations(id)
```

**RLS policies enforce organization boundaries:**
- Users can only access data within their organization
- Admins can access data across all organizations
- New user assignments can specify `organization_id` or `organization_slug`

### Cross-Organization Access

| User Type | Access Scope |
|-----------|--------------|
| Regular User | Own organization only |
| Admin | All organizations (for management purposes) |

---

## Audit & Compliance

### Soft Deletion

Core entities use soft deletion for audit trails:

| Entity Type | Soft Delete Column |
|-------------|-------------------|
| General Partners | `deleted_at` |
| Limited Partners | `deleted_at` |
| Funds | `deleted_at` |
| Operating Companies | `deleted_at` |

### Entity Deletion Logging

All deletions are logged to `entity_deletion_log`:

```sql
CREATE TABLE entity_deletion_log (
  id uuid PRIMARY KEY,
  entity_type text NOT NULL,
  entity_id uuid NOT NULL,
  entity_name text NOT NULL,
  deleted_by uuid NOT NULL,
  deletion_reason text NOT NULL,  -- Minimum 10 characters
  cascading_impact jsonb NOT NULL,
  organization_id uuid,
  created_at timestamptz
);
```

### Deletion Safeguards

1. **Role Restriction**: Only Admins can delete entities
2. **Confirmation Required**: User must type exact entity name
3. **Reason Required**: Minimum 10-character deletion reason
4. **Impact Analysis**: Cascading effects displayed before confirmation

---

## Security Best Practices

### What We Do

✅ Store roles in separate `user_roles` table (not on profiles)  
✅ Use security definer functions to prevent RLS recursion  
✅ Validate all user input server-side  
✅ Sanitize error messages in Edge Functions  
✅ Require JWT verification on sensitive endpoints  
✅ Implement rate limiting on password reset  
✅ Use private storage buckets  
✅ Log all entity deletions with reasons  

### What We Don't Do

❌ Store API keys in client-side code  
❌ Check admin status via localStorage (client-side)  
❌ Expose detailed error messages to clients  
❌ Allow hard deletion of core entities  
❌ Bypass RLS for user operations  

### Recommendations

1. **Enable Leaked Password Protection** in Supabase Auth Settings
2. **Regularly review RLS policies** when adding new tables
3. **Audit entity deletion logs** periodically
4. **Rotate API keys** on a regular schedule
5. **Enable MFA enforcement** for sensitive organizations

---

## Security Contact

For security concerns or vulnerability reports, please contact the development team.

---

*Last Updated: February 2026*
