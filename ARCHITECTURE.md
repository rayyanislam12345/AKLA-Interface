# FactorIQ Platform Architecture

## Overview

FactorIQ is a private equity portfolio management and analytics platform built for institutional investors, general partners (GPs), and limited partners (LPs). The platform provides comprehensive tools for tracking investments, analyzing fund performance, managing operating companies, deal sourcing and management, project planning, and generating insights through AI-powered analytics.

---

## Technology Stack

### Frontend
| Technology | Purpose |
|------------|---------|
| **React 18** | UI library with hooks-based architecture |
| **TypeScript** | Type-safe development |
| **Vite** | Build tool and development server |
| **Tailwind CSS** | Utility-first CSS framework |
| **shadcn/ui** | Component library built on Radix UI |
| **React Router v6** | Client-side routing |
| **TanStack Query** | Server state management and caching |
| **Recharts** | Data visualization and charting |

### Backend
| Technology | Purpose |
|------------|---------|
| **Supabase** | Backend-as-a-Service platform |
| **PostgreSQL** | Primary database with pgvector extension |
| **Supabase Auth** | Authentication and user management |
| **Supabase Edge Functions** | Serverless Deno functions |
| **Row Level Security (RLS)** | Data access control |

### External Integrations
| Service | Purpose |
|---------|---------|
| **Google Gemini** | Primary AI engine — deal research, analysis, workspace agent, graph generation, thumbnails |
| **OpenAI API** | Analytics chat, GP analysis, RAG queries, document embeddings |
| **Perplexity API** | News summaries and PDF summarization |
| **Intellizence API** | News and market intelligence |
| **Microsoft Graph / Outlook** | Calendar sync, meeting management (OAuth) |

---

## Application Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        CLIENT (Browser)                          │
├─────────────────────────────────────────────────────────────────┤
│  React Application                                               │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │   Pages     │ │ Components  │ │   Hooks     │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
│  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐                │
│  │  TanStack   │ │   Router    │ │  Supabase   │                │
│  │   Query     │ │             │ │   Client    │                │
│  └─────────────┘ └─────────────┘ └─────────────┘                │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      SUPABASE PLATFORM                           │
├─────────────────────────────────────────────────────────────────┤
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐  │
│  │  Auth Service   │  │  Edge Functions │  │    Storage      │  │
│  │  (JWT tokens)   │  │  (Deno runtime) │  │  (File buckets) │  │
│  └─────────────────┘  └─────────────────┘  └─────────────────┘  │
│                              │                                   │
│  ┌───────────────────────────▼───────────────────────────────┐  │
│  │                    PostgreSQL Database                     │  │
│  │  ┌─────────────┐ ┌─────────────┐ ┌─────────────┐          │  │
│  │  │   Tables    │ │  Functions  │ │  pgvector   │          │  │
│  │  │   + RLS     │ │  + Triggers │ │  Extension  │          │  │
│  │  └─────────────┘ └─────────────┘ └─────────────┘          │  │
│  └───────────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
```

---

## AI Model Usage

| Model | Provider | Used By |
|-------|----------|---------|
| **Gemini 2.5 Pro** | Google | Complex analysis tasks |
| **Gemini 2.5 Flash** | Google | Deal research, deal analysis, thesis fit, investment analysis, workspace agent, graph generation, project scenarios, operators chat |
| **Gemini 2.5 Flash (Image)** | Google | Contextual thumbnail generation for deals and projects |
| **GPT-4o-mini** | OpenAI | Analytics chat, GP analysis, RAG document Q&A |
| **Sonar Pro** | Perplexity | News summaries, PDF summarization |
| **text-embedding-3-small** | OpenAI | Document vectorization for RAG |

All LLM calls are routed through the **Lovable AI Gateway**.

---

## Directory Structure

```
src/
├── assets/                 # Static images, icons, video metadata
├── components/
│   ├── ui/                 # shadcn/ui base components
│   ├── deal-manager/       # Deal Manager workspace (pipeline, cards, workspace tabs)
│   ├── graph-generator/    # Graph Generator (selectors, chart rendering, saved graphs)
│   ├── projects/           # Projects workspace (scenarios, documents, notes)
│   ├── report/             # Report generation components
│   ├── workspace/          # Analytics Workspace AI agent + dashboard renderer
│   └── [Feature]*.tsx      # Feature-specific components
├── contexts/
│   ├── DealChatContext.tsx  # Deal Manager AI chat state
│   └── ProjectChatContext.tsx # Project AI chat state
├── hooks/
│   ├── useAuth.tsx         # Authentication context and hooks
│   ├── useOrganization.tsx # Multi-tenancy context
│   ├── useUserFeatures.tsx # Feature-gated navigation
│   ├── useGraphGenerator.ts # Graph generator logic
│   ├── useSavedGraphs.ts   # Persisted graph management
│   ├── useOutlookAuth.ts   # Microsoft OAuth integration
│   ├── use-mobile.tsx      # Responsive utilities
│   └── use-toast.ts        # Toast notifications
├── integrations/
│   ├── supabase/           # Supabase client and types
│   ├── dealFinder.ts       # Deal sourcing integration
│   ├── intellizence.ts     # News API integration
│   └── newsapi.ts          # News aggregation
├── lib/
│   ├── utils.ts            # Utility functions (cn, etc.)
│   ├── columnMapper.ts     # AI-assisted column mapping
│   ├── dataTransformer.ts  # Data normalization pipeline
│   ├── templateProcessor.ts # Upload template processing
│   ├── schemaRegistry.ts   # Entity schema definitions
│   ├── templateIdentifier.ts # Auto template detection
│   ├── exportToExcel.ts    # Excel export functionality
│   ├── generateReportPdf.ts # PDF report generation
│   ├── financialForecasting.ts # Forecasting models
│   └── reportConfig.ts     # Report configuration
├── pages/                  # Route page components
├── types/                  # TypeScript type definitions
├── App.tsx                 # Root component with routing
├── main.tsx                # Application entry point
└── index.css               # Global styles and CSS variables

supabase/
├── functions/              # Edge Functions (see Edge Functions section)
├── migrations/             # Database migration files
└── config.toml             # Supabase configuration
```

---

## Database Schema

### Core Entities

```
┌──────────────────┐     ┌──────────────────┐     ┌──────────────────┐
│  organizations   │────▶│      funds       │────▶│ fund_performance │
└──────────────────┘     └──────────────────┘     └──────────────────┘
         │                       │
         │                       ▼
         │               ┌──────────────────┐
         │               │ fund_investments │
         │               └──────────────────┘
         │                       │
         ▼                       ▼
┌──────────────────┐     ┌──────────────────┐
│ general_partners │     │operating_companies│
└──────────────────┘     └──────────────────┘
         │                       │
         │                       ├──────────────────────┐
         │                       ▼                      ▼
         │               ┌──────────────────┐  ┌──────────────────┐
         │               │   _financials    │  │ _operational_    │
         │               └──────────────────┘  │    _metrics      │
         │                                     └──────────────────┘
         │                       │
         │                       ▼
         │               ┌──────────────────┐
         │               │   _cyber         │
         │               └──────────────────┘
         │
         ▼
┌──────────────────┐     ┌──────────────────┐
│ limited_partners │────▶│fund_lp_commitments│
└──────────────────┘     └──────────────────┘
```

### Deal Manager & Projects

```
┌──────────────────┐     ┌──────────────────┐
│      deals       │────▶│ deal_documents   │
│                  │────▶│ deal_stages      │
│                  │────▶│ deal_notes       │
│                  │────▶│ deal_meetings    │
└──────────────────┘     └──────────────────┘

┌──────────────────┐     ┌──────────────────┐
│    projects      │────▶│ project_documents│
│                  │────▶│ project_notes    │
│                  │────▶│ project_scenarios│
└──────────────────┘     └──────────────────┘
```

### Dimensional Model (Operating Company Analytics)

```
                    ┌──────────────┐
                    │   dim_time   │
                    └──────┬───────┘
                           │
┌──────────────┐   ┌──────▼────────────────────┐   ┌──────────────┐
│ dim_product  │──▶│ fact_operating_company_   │◀──│ dim_region   │
└──────────────┘   │       financials           │   └──────────────┘
                   └──────▲────────────────────┘
                          │
                   ┌──────┴───────┐
                   │ dim_segment  │
                   └──────────────┘
```

### Key Tables

| Table | Description |
|-------|-------------|
| **Core Entities** | |
| `organizations` | Multi-tenant organization entities |
| `organization_members` | User-to-organization membership with roles |
| `profiles` | Extended user profile data |
| `user_roles` | Application-level roles (admin, moderator, user) |
| **Funds & Investments** | |
| `funds` | Investment fund entities |
| `fund_performance` | Historical fund performance metrics (NAV, IRR, MOIC, TVPI, DPI) |
| `fund_investments` | Fund-level investment records linking funds to operating companies |
| `fund_lp_commitments` | LP commitment tracking |
| **Entities** | |
| `general_partners` | GP entities with comprehensive financial and performance data |
| `limited_partners` | LP entities |
| `operating_companies` | Portfolio company entities |
| `operating_company_financials` | Company financial statements |
| `operating_company_operational_metrics` | KPIs and operational data |
| `operating_company_cyber` | Cybersecurity metrics |
| **Deal Manager** | |
| `deals` | Deal pipeline records with AI analysis fields |
| `deal_documents` | Deal-associated document uploads with AI summaries |
| `deal_stages` | Pipeline stage tracking with checklists |
| `deal_notes` | Deal activity notes |
| `deal_meetings` | Calendar/meeting records (with Outlook sync) |
| **Projects** | |
| `projects` | Strategic planning projects |
| `project_documents` | Project-associated documents |
| `project_notes` | Project activity log |
| `project_scenarios` | Scenario analysis models |
| **Deal Sourcing** | |
| `deal_searches` | Saved deal search criteria |
| `deal_opportunities` | Discovered deal opportunities |
| **Documents & RAG** | |
| `documents` | RAG document store with vector embeddings |
| `uploaded_files` | File metadata for uploaded documents |
| `file_fields` | Extracted field metadata from files |
| **Dimensional Model** | |
| `dim_time` | Time dimension (date, month, quarter, fiscal year) |
| `dim_product` | Product dimension per operating company |
| `dim_region` | Geographic dimension per operating company |
| `dim_segment` | Business segment dimension per operating company |
| `fact_operating_company_financials` | Fact table with financial metrics by dimensions |
| **Feature Governance** | |
| `features` | Available platform features with routes |
| `user_features` | Per-user feature assignments |
| `organization_features` | Per-organization feature assignments |
| `organization_ai_policies` | AI usage policies at org/feature level |
| **AI Analysis** | |
| `gp_analyses` | AI-generated GP analysis snapshots |
| `gp_analysis_prompts` | Configurable analysis prompt templates |
| `portfolio_news_prompts` | News summary prompt templates |
| `portfolio_news_summaries` | Generated news summaries |
| **Other** | |
| `custom_templates` | User-created upload templates |
| `entity_imports` | Bulk import tracking |
| `entity_deletion_log` | Audit trail for entity deletions |
| `bridge_preferences` | User preferences for value creation bridge charts |

### Enums

| Enum | Values |
|------|--------|
| `investment_type` | `lp_fund`, `co_investment`, `gp_equity` |
| `investment_status` | `active`, `exited`, `written_off`, `under_loi` |
| `financial_period` | `Monthly`, `Quarterly`, `Annual`, `At Entry` |
| `cash_flow_type` | `capital_call`, `distribution`, `management_fee`, `other` |
| `app_role` | `admin`, `moderator`, `user` |
| `benchmark_type` | `market_index`, `peer_group`, `custom` |

---

## Authentication & Authorization

### Authentication Flow

```
┌─────────┐     ┌─────────────┐     ┌─────────────┐
│  User   │────▶│ Supabase    │────▶│  Database   │
│         │     │ Auth        │     │  (profiles) │
└─────────┘     └─────────────┘     └─────────────┘
                      │
                      ▼
               ┌─────────────┐
               │ JWT Token   │
               │ (session)   │
               └─────────────┘
```

### Authorization Layers

1. **Application Roles** (`user_roles` table)
   - `admin`: Full system access
   - `moderator`: Extended permissions
   - `user`: Standard user access

2. **Organization Membership** (`organization_members` table)
   - `owner`: Can manage organization and members
   - `member`: Standard organization access

3. **Feature Governance** (`features`, `user_features`, `organization_features`)
   - Feature-gated navigation and access control
   - Organization-level AI policy management

4. **Row Level Security (RLS)**
   - All tables have RLS enabled
   - Policies enforce user-based and organization-based access
   - Helper functions: `has_role()`, `is_org_member()`, `get_user_organization_id()`

### Key RLS Patterns

```sql
-- User owns the record
auth.uid() = user_id

-- User is organization member
is_org_member(auth.uid(), organization_id)

-- User has specific role
has_role(auth.uid(), 'admin'::app_role)

-- Authenticated users (read-only shared data)
true  -- For SELECT on reference data
```

---

## Key Features & Modules

### 1. Portfolio Management
- **Location**: `src/pages/Portfolios.tsx`, `src/components/PortfolioOverview.tsx`
- Multi-asset portfolio tracking (LP Funds, Co-Investments, GP Equity)
- Performance metrics aggregation
- Investment lifecycle management

### 2. Fund Performance Analytics
- **Location**: `src/pages/FundPerformancePage.tsx`, `src/components/FundPerformance.tsx`
- Historical performance tracking (IRR, MOIC, TVPI, DPI, RVPI)
- NAV trending and analysis
- Fee tracking (management fees, carried interest)

### 3. General Partner Analysis
- **Location**: `src/pages/GeneralPartnersPage.tsx`, `src/components/GeneralPartnerDashboard.tsx`
- Comprehensive GP metrics dashboard
- AI-powered performance analysis (Gemini)
- Interactive chat-based insights

### 4. Operating Company Management
- **Location**: `src/pages/OperatingCompaniesPage.tsx`, `src/components/OperationalMetricsDashboard.tsx`
- Financial statement tracking
- Operational KPI monitoring
- Cybersecurity risk assessment
- Dimensional analysis (product/region/segment breakdowns)

### 5. Document Intelligence (RAG)
- **Location**: `src/components/DocumentManager.tsx`, `src/components/AnalyticsChat.tsx`
- Document upload and processing
- Vector embedding generation (OpenAI)
- Semantic search and Q&A

### 6. Deal Sourcing (Deal Finder)
- **Location**: `src/pages/DealFinderPage.tsx`, `src/components/DealSearchFilters.tsx`
- Multi-criteria deal search
- Saved search management
- Opportunity tracking and promotion to Deal Manager

### 7. News & Intelligence
- **Location**: `src/components/IntellizenceNewsSearch.tsx`
- Portfolio-relevant news aggregation
- AI-generated summaries (Perplexity)
- Industry monitoring

### 8. Reporting
- **Location**: `src/pages/ReportsPage.tsx`, `src/components/report/`
- Configurable report templates
- PDF and Excel export
- Multi-entity report generation

### 9. Deal Manager
- **Location**: `src/pages/DealManagerPage.tsx`, `src/components/deal-manager/`
- Full deal pipeline with stage tracking (Screening → Closed)
- Deal workspace with 6 tabs: Overview, Details, Documents, AI Analysis, Notes, Meetings
- **Details tab**: Populated via AI research (same data as Deal Finder) with company overview, financial metrics, and sources
- Automated AI analysis on deal creation: thumbnail, thesis fit, investment analysis, company research
- Document upload with AI summarization and RAG vectorization
- Financial model generation (DCF, LBO, Comparables) via AI tool-calling
- AI chat assistant with persistent history

### 10. Projects & Scenario Analysis
- **Location**: `src/pages/ProjectsPage.tsx`, `src/components/projects/`
- Strategic planning workspace with project cards
- Scenario modeling with AI-powered analysis
- Project documents with AI processing
- AI chat assistant for project insights

### 11. Graph Generator
- **Location**: `src/pages/GraphGeneratorPage.tsx`, `src/components/graph-generator/`
- Custom chart creation with entity/data point/time frame selectors
- AI-powered chart generation (Gemini)
- Style prompt customization
- Saved graphs management
- Save-to-page functionality

### 12. Analytics Workspace
- **Location**: `src/pages/WorkspacePage.tsx`, `src/components/workspace/`
- AI-powered analysis agent (Gemini)
- Dynamic dashboard rendering from AI-generated specifications
- Natural language query interface

### 13. Unified Upload System
- **Location**: `src/components/SimpleUploadAgent.tsx`, `src/lib/templateProcessor.ts`
- Auto template detection for entity types
- AI-assisted column mapping (`ai-column-mapper`)
- Multi-sheet Excel support
- Data validation and transformation pipeline
- Support for: operating companies, funds, GPs, LPs, fund performance, financials, operational metrics

### 14. AI Policy Governance
- **Location**: `src/components/AIPolicyManager.tsx`, `src/components/OrganizationFeaturesAdmin.tsx`
- Organization-level AI policy management
- Feature-level AI policy configuration
- Fund investment thesis management for deal analysis

---

## Edge Functions Architecture

### Document Processing Pipeline

```
┌─────────────┐     ┌─────────────────┐     ┌─────────────────┐
│   Upload    │────▶│ process-document│────▶│ ingest-documents│
│   (Client)  │     │ (extract text)  │     │ (embed + store) │
└─────────────┘     └─────────────────┘     └─────────────────┘
                                                     │
                                                     ▼
                                            ┌─────────────────┐
                                            │   documents     │
                                            │   (pgvector)    │
                                            └─────────────────┘
                                                     │
                                                     ▼
                    ┌─────────────────┐     ┌─────────────────┐
                    │    rag-query    │◀────│   User Query    │
                    │ (semantic search│     │                 │
                    │  + AI response) │     └─────────────────┘
                    └─────────────────┘
```

### Deal Manager Pipeline

```
┌─────────────────┐     ┌─────────────────┐     ┌─────────────────────────┐
│  Deal Finder    │────▶│  Promote to     │────▶│  Deal Manager Workspace │
│  (Search/       │     │  Deal Manager   │     │                         │
│   Discover)     │     │  (data preserved│     │  ┌─ Overview            │
└─────────────────┘     └─────────────────┘     │  ├─ Details (research)  │
                               │                │  ├─ Documents           │
        ┌──────────────────────┤                │  ├─ AI Analysis         │
        ▼                      ▼                │  ├─ Notes               │
┌───────────────┐   ┌──────────────────┐        │  └─ Meetings           │
│ + New Deal    │   │ Auto AI Tasks:   │        └─────────────────────────┘
│ (manual       │──▶│ • Thumbnail      │
│  creation)    │   │ • Research       │
└───────────────┘   │ • Thesis Fit     │
                    │ • Investment     │
                    │   Analysis       │
                    └──────────────────┘
```

### Edge Functions Reference

| Function | Purpose | AI Model |
|----------|---------|----------|
| **Analytics & Chat** | | |
| `analytics-chat` | General analytics Q&A | GPT-4o-mini |
| `gp-analysis` | GP performance analysis | GPT-4o-mini |
| `gp-analysis-chat` | Interactive GP insights | GPT-4o-mini |
| `operators-chat` | Operators AI assistant | Gemini 2.5 Flash |
| `operational-metrics-summary` | OpCo metrics summarization | Gemini 2.5 Flash |
| **Deal Manager** | | |
| `deal-research` | Company research for Details tab | Gemini 2.5 Flash |
| `deal-ai-analysis` | Thesis fit & investment analysis | Gemini 2.5 Flash |
| `deal-ai-analysis-stream` | Streaming deal analysis | Gemini 2.5 Flash |
| `deal-manager-chat` | Deal workspace AI assistant | Gemini 2.5 Flash |
| `deal-analysis-chat` | Deal analysis chat | Gemini 2.5 Flash |
| `deal-qa-chat` | Deal Q&A from documents | Gemini 2.5 Flash |
| `deal-finder-search` | Deal sourcing API | Gemini 2.5 Flash |
| `generate-deal-thumbnail` | AI contextual thumbnail | Gemini 2.5 Flash Image |
| `process-deal-document` | Deal document processing | — |
| **Projects** | | |
| `project-chat` | Project AI assistant | Gemini 2.5 Flash |
| `project-analysis-chat` | Project analysis chat | Gemini 2.5 Flash |
| `project-scenario-analysis` | Scenario modeling | Gemini 2.5 Flash |
| `generate-project-thumbnail` | AI contextual thumbnail | Gemini 2.5 Flash Image |
| `process-project-document` | Project document processing | — |
| **Documents & RAG** | | |
| `process-document` | Document text extraction | — |
| `ingest-documents` | Embedding + vector storage | OpenAI Embeddings |
| `rag-query` | Semantic search + AI response | GPT-4o-mini |
| `summarize-pdf` | PDF summarization | Perplexity |
| `fetch-file-data` | File data retrieval | — |
| `parse-file` | File parsing utilities | — |
| **Upload & Data** | | |
| `ai-column-mapper` | AI-assisted column mapping | Gemini 2.5 Flash |
| `ai-data-parser` | AI data parsing | Gemini 2.5 Flash |
| `import-entities` | Bulk entity import | — |
| `parse-and-backfill` | Data backfill processing | — |
| `seed-dimensional-data` | Dimensional model seeding | — |
| `seed-daily-dimensional-facts` | Daily fact seeding | — |
| **Visualization** | | |
| `graph-generator` | AI chart generation | Gemini 2.5 Flash |
| `workspace-analysis` | Analytics workspace agent | Gemini 2.5 Flash |
| **News & Intelligence** | | |
| `fetch-news` | News aggregation | — |
| `fetch-intellizence-news` | Intellizence integration | — |
| `generate-portfolio-news-summary` | AI news summaries | Perplexity |
| **Admin & Integration** | | |
| `create-organization` | Organization provisioning | — |
| `invite-user` | User invitation | — |
| `setup-demo-account` | Demo account setup | — |
| `submit-demo-request` | Demo request handling | — |
| `outlook-auth` | Microsoft OAuth flow | — |
| `outlook-meetings` | Outlook calendar sync | — |

---

## Storage Buckets

| Bucket | Purpose |
|--------|---------|
| `uploaded-files` | User-uploaded data files (CSV, Excel) |
| `rag-documents` | Documents for RAG processing |
| `deal-documents` | Deal Manager document uploads |
| `project-documents` | Project document uploads |
| `reports` | Generated report files |

---

## Data Flow Patterns

### Investment Data Flow

```
User Action          Frontend              Backend              Database
    │                   │                     │                    │
    │──Create Investment─▶                    │                    │
    │                   │──Supabase Insert───▶│                    │
    │                   │                     │──RLS Check────────▶│
    │                   │                     │◀─────Allowed───────│
    │                   │                     │──Insert Row───────▶│
    │                   │◀──Success Response──│                    │
    │◀──TanStack Cache──│                     │                    │
    │   Invalidation    │                     │                    │
```

### RAG Query Flow

```
User Query           Frontend              Edge Function         External
    │                   │                     │                    │
    │──Ask Question────▶│                     │                    │
    │                   │──Invoke Function───▶│                    │
    │                   │                     │──Generate Embedding─▶OpenAI
    │                   │                     │◀─────Embedding──────│
    │                   │                     │──Vector Search─────▶Database
    │                   │                     │◀─────Documents──────│
    │                   │                     │──Generate Answer───▶OpenAI
    │                   │                     │◀─────Response───────│
    │                   │◀──Streaming Response│                    │
    │◀──Display Answer──│                     │                    │
```

### Deal Creation Flow

```
User Action          Frontend              Edge Functions        External
    │                   │                     │                    │
    │──Create Deal─────▶│                     │                    │
    │                   │──Insert Deal───────▶│ Database           │
    │                   │◀──Deal Created──────│                    │
    │                   │                     │                    │
    │                   │──(async, parallel)──▶│                    │
    │                   │  deal-research      │──Research─────────▶Gemini
    │                   │  deal-ai-analysis   │──Analysis─────────▶Gemini
    │                   │  generate-thumbnail │──Thumbnail────────▶Gemini
    │                   │                     │◀─────Results────────│
    │                   │                     │──Update Deal──────▶Database
    │◀──Cache Refresh───│                     │                    │
```

---

## Security Considerations

### Data Protection
- All API keys stored as Supabase secrets (not in code)
- RLS enforces data isolation between organizations
- JWT tokens for authenticated API access
- HTTPS for all communications
- AI policy governance for controlling AI usage per organization/feature

### Access Control Hierarchy
1. **Public Routes**: Landing page, Contact, Auth
2. **Authenticated Routes**: All dashboard pages (via `ProtectedRoute`)
3. **Feature-Gated Routes**: Controlled via `features` + `user_features` tables
4. **Admin Routes**: User management, system settings, AI policy management
5. **Organization-Scoped Data**: Funds, GPs, LPs, Operating Companies, Deals, Projects

### Storage Security
- Private buckets for uploaded files
- RLS policies on storage objects
- User-scoped file access

---

## Environment Configuration

### Required Secrets
| Secret | Purpose |
|--------|---------|
| `SUPABASE_URL` | Supabase project URL |
| `SUPABASE_ANON_KEY` | Public API key |
| `SUPABASE_SERVICE_ROLE_KEY` | Admin API key (Edge Functions) |
| `OPENAI_API_KEY` | AI/ML operations (chat, embeddings) |
| `LOVABLE_API_KEY` | Lovable AI gateway |
| `GEMINI_API_KEY` | Google Gemini (via gateway) |
| `INTELLIZENCE_API_KEY` | News intelligence |
| `PERPLEXITY_API_KEY` | Search and summarization |
| `NEWS_API_KEY` | News aggregation |

---

## Performance Optimizations

### Frontend
- **TanStack Query**: Automatic caching, background refetching
- **Code Splitting**: Route-based lazy loading
- **Memoization**: `useMemo`, `useCallback` for expensive computations

### Database
- **Indexes**: On frequently queried columns
- **pgvector HNSW Index**: For semantic search performance
- **RLS Function Optimization**: `SECURITY DEFINER` with `search_path`
- **Dimensional Model**: Star schema for efficient operating company analytics

### Edge Functions
- **Streaming Responses**: For AI-generated content
- **Connection Pooling**: Via Supabase client
- **Parallel AI Tasks**: Deal creation triggers concurrent background analysis

---

## Deployment

### Lovable Platform
- Automatic deployments on code changes
- Preview environments for branches
- Custom domain support

### Database Migrations
- Managed via Supabase migrations
- Version-controlled in `supabase/migrations/`
- Applied automatically on deployment

---

## Future Architecture Considerations

1. **Real-time Updates**: Supabase Realtime for live deal pipeline collaboration
2. **Background Jobs**: Scheduled reports, periodic deal re-analysis, news monitoring
3. **Multi-region**: For global performance
4. **Advanced RAG**: Hybrid search (vector + keyword), re-ranking, multi-modal embeddings
5. **Workflow Automation**: Configurable triggers for deal stage transitions

---

*Last Updated: March 2026*
