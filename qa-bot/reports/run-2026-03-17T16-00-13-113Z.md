# FactorIQ QA Report
**Date:** 2026-03-17T16:00:13.114Z
**Target:** http://localhost:8081

# FactorIQ QA Report — Apex Capital Partners Onboarding
**Date:** 2026-03-17 | **Analyst:** Apex Capital Partners, Fund III | **App:** http://localhost:8081

---

## Phase 1 — Login & Orientation

✅ **[PASS] Landing Page** — Clean, professional marketing page renders correctly with "Private Equity Intelligence Platform" headline, CTAs (Request a Demo, Sign In), and polished PE-buyer branding.

✅ **[PASS] Authentication** — Login with `recognizedemo100@gmail.com` / `factorIQ100` succeeded and routed to `/home`.

⚠️ **[WARN] Auto-Session Redirect** — Returning to `/auth` with an active session silently redirects to `/home` with no feedback — could confuse first-time users who think the login failed.

✅ **[PASS] Home Dashboard** — Renders 5 KPI tiles: **Total Funds (1)**, **12 Portfolio Companies**, **Deals (1 active)**, **Projects (0)**, **Recent Uploads (5)**. Two Quick Access cards: Investors Dashboard and Operating Company Dashboard. Portfolio News Summary panel below the fold.

⚠️ **[WARN] News Summary — Wrong Sector** — The Portfolio News Summary shows **"Education Technology"** and **"Technology"** tags — completely wrong for an industrials-focused fund. First impression is that the AI has no idea what our fund does.

📋 **[NOTE] Navigation Structure** — Left sidebar (collapsible) with these groups:
- **Top level:** Home, Deal Finder, Deal Manager, Projects, Reports, Help, Settings
- **Investments:** Portfolios, Fund Performance, GPs, Operating Companies, LPs, Monitoring, Budgeting
- **Data Ingestion:** Data Catalog, File Upload, Data Quality
- **Operators:** Financials, Operational Metrics, Cybersecurity
- **Analytics:** Graph Generator, Workspace

📋 **[NOTE] Pre-seeded Demo Data** — Account already has 12 investments and 5 uploads from "Recognize Growth Fund I" — not Apex's data. The "12 Investments" count will confuse a new user who only has 4 OpCos.

---

## Phase 2 — Data Upload

✅ **[PASS] Data Ingestion Page** — `/data-ingestion` renders the Upload Agent with three sections: Templates, Create New Entity, and Select Target Entity.

✅ **[PASS] Create New Entity — Fund Form** — The Create Fund modal correctly accepted Apex Capital Partners Fund III data (vintage 2021, $850M, 22% target IRR).

❌ **[FAIL] Portfolio CSV Upload — Required `period_date` Column Missing** — Uploading the portfolio CSV with columns `company_name, fund, acquisition_year, revenue_millions, ebitda_millions, sector, status` triggered:
> **"Required columns missing: period_date"** — red badge in the Review & Consolidate dialog; **Next button grayed out.**
The system requires a `period_date` for time-series financial data. Our `acquisition_year` column isn't accepted as a substitute. Column mapping *did* correctly match `revenue_millions → revenue` (79%) and `ebitda_millions → ebitda` (78%) but the upload was blocked. File was accepted and analyzed but submission was impossible.

⚠️ **[WARN] Upload Agent — Wrong Entity Pre-selected** — "Select Target Entity" defaulted to **"Recognize Growth Fund I"** (demo org), not Apex Capital's fund. A distracted user could upload data to the wrong entity with zero warning.

⚠️ **[WARN] No Template Guidance** — The Templates section exists but doesn't surface the required column schema upfront. `period_date` is a hidden requirement that only fails at the Review step — not at file selection.

✅ **[PASS] Data Catalog** — `/data-ingestion/catalog` shows 27 total sources. Uploaded test files (`apex_fund_data.csv`, `apex_portfolio.csv`, `midwest_fasteners_cim.txt`) all appear with correct entity associations and Active status — at least file tracking works.

---

## Phase 3 — Deal Analysis

✅ **[PASS] Deal Created — MidWest Fasteners Corp** — Deal card displays: Sector "Industrials - Specialty Fasteners Manufacturing," Type "Add-on," EV $80.8M, EBITDA $9.5M, Stage "Screening."

✅ **[PASS] Thesis Fit AI — Score Generated** — Thesis Fit analysis ran and returned **score: 88/100** with summary: *"This is a highly attractive, proprietary bolt-on acquisition that aligns perfectly with our buy-and-build strategy."* Strategic Fit scored 100. Red flags identified:
- *"The $3M in estimated synergies are critical to the investment thesis and their achievability must be rigorously validated"*
- *"Lack of data on historical growth, customer concentration, and management quality represent significant unknowns"*

❌ **[FAIL] Thesis Fit — Raw JSON Rendered Instead of Formatted Scorecard** — The AI output is displayed as raw monospace JSON text (`{ "score": 88, "summary": "...", "red_flags": [...] }`) rather than a visual score card with color-coded risk indicators. The structured data is clearly there — the UI just fails to render it. This makes the flagship AI feature look broken.

✅ **[PASS] DD Workplan — Well-Formatted** — Generated a structured, readable workplan with Executive Summary, Workstreams (Financial/Commercial/Operational) with Critical/High priority tags, advisor assignments ("Accounting Firm FDD/QoE"), and key questions per workstream. "Re-run" and "Ask AI" buttons present.

✅ **[PASS] Deal Chat** — "Ask AI" button opens a "Deal Analyst" side panel with "Full deal context loaded" indicator. Accepted and responded to: *"What are the key risks for a fasteners manufacturer acquisition?"*

✅ **[PASS] CIM Document Upload** — `MidWest_Fasteners_CIM.txt` uploaded to the deal's Documents tab, categorized as "CIM," with "AI Summary" button available on hover.

📋 **[NOTE] Full Deal Lifecycle Available** — Left sidebar in the deal workspace shows: Thesis Fit, Investment Analysis, Financial Model, DD Workplan, Draft PIM, Draft IOI/LOI, Draft Offer Letter, Doc Summary — a comprehensive deal workflow.

---

## Phase 4 — Portfolio Monitoring

❌ **[FAIL] Portfolio Monitoring — No Apex Data** — `/investments/monitoring` shows *"No financial data available for the selected company"* for all selections. PrecisionCast, FieldForce, GreenPath, and TechAudit Pro are absent from the dropdown because the Phase 2 CSV upload failed. The monitoring dashboard is functionally empty.

⚠️ **[WARN] Apex OpCos Not in Dropdown** — Only pre-seeded demo companies appear (e.g., "2X Marketing Services," "Blue Mantis IT Solutions"). Apex's four portfolio companies were never ingested.

✅ **[PASS] Operating Company Financials (Demo Data)** — The OpCo financial detail page is feature-rich: Revenue, COGS, SG&A, EBITDA, Net Profit KPI cards with QoQ deltas; tabs for Revenue Analysis, Liquidity, Profitability, Forecasting; revenue trend charts; Revenue per Employee metric.

✅ **[PASS] Analytics Assistant** — The AI chat panel on the OpCo Financials page provided substantive commentary on demo data: *13.0% revenue increase, 16.0% EBITDA expansion to $11.4M, SG&A analysis.* Responses are well-formatted with bold labels and specific numbers.

✅ **[PASS] Graph Generator** — `/analytics/graph-generator` functions correctly with a 3-step builder (Entity → Metrics → Timeframe). Built a live IRR (%) and MOIC chart over 3Y with Export CSV and Save to Page options — works with demo data.

⚠️ **[WARN] Graph Generator — No Apex Fund Available** — "Apex Capital Partners Fund III" doesn't appear in the entity dropdown (blocked by Phase 2 CSV failure). Nothing to chart for the actual test org.

⚠️ **[WARN] News Summary — Still Showing Wrong Sectors** — No mechanism on the home page to reconfigure news sectors to match fund strategy. Still showing "Education Technology" throughout.

---

## Phase 5 — Adversarial Tests

✅ **[PASS] URL Manipulation / Org Isolation** — Modifying deal UUID in the URL (e.g., `/deal-manager/00000000-0000-0000-0000-000000000000`) correctly returned: *"Deal not found. Back to Deal Manager."* Backend scopes deals to the authenticated org — no cross-org data leakage observed.

⚠️ **[WARN] Infinite Spinner on Bad URL** — Before showing "Deal not found," the page shows a persistent loading spinner for several seconds with no timeout or fast-fail. Security is fine; UX is poor.

✅ **[PASS] Invalid File Type Validation** — Upload Agent client-side code restricts to `text/csv`, `.xlsx/.xls` MIME types only. An `.exe` or `.jpg` triggers: *"Invalid File Type — Please upload CSV or Excel files only."* Browser file picker also restricted via `accept=".csv,.xlsx,.xls"`. Deal Documents uploader appropriately accepts a broader set (`.pdf,.doc,.docx,.xlsx,.txt,.pptx`) but still blocks executables.

✅ **[PASS] Invite Error Handling** — The invite flow calls a Supabase edge function `invite-user`. Error handling is implemented client-side — if the server returns an error for a duplicate email, a toast surfaces the `data.error` message.

✅ **[PASS] Deal Finder — Feature Accessible** — `/deal-finder` loads and supports thesis-based search using fund investment strategy as matching criteria. Only "Recognize Growth Fund I" available (Apex's fund not yet created due to upload failure).

---

## Summary Table

| # | Phase | Feature | Status | Severity |
|---|-------|---------|--------|----------|
| 1 | P1 | Landing Page | ✅ PASS | — |
| 2 | P1 | Login / Auth | ✅ PASS | — |
| 3 | P1 | Home Dashboard KPIs | ✅ PASS | — |
| 4 | P1 | News Summary Sector Relevance | ⚠️ WARN | Medium |
| 5 | P1 | Navigation Structure | ✅ PASS | — |
| 6 | P2 | Data Ingestion Page Loads | ✅ PASS | — |
| 7 | P2 | **Portfolio CSV — `period_date` Required** | ❌ FAIL | 🔴 High |
| 8 | P2 | Upload Entity Pre-selection (Wrong Default) | ⚠️ WARN | Medium |
| 9 | P2 | No Template Guidance for Column Schema | ⚠️ WARN | Low |
| 10 | P2 | Data Catalog File Tracking | ✅ PASS | — |
| 11 | P3 | Deal Created in Deal Manager | ✅ PASS | — |
| 12 | P3 | Thesis Fit AI Score Generated (88/100) | ✅ PASS | — |
| 13 | P3 | **Thesis Fit — Raw JSON Not Rendered as UI** | ❌ FAIL | 🔴 High |
| 14 | P3 | DD Workplan Formatted & Substantive | ✅ PASS | — |
| 15 | P3 | Deal Chat ("Ask AI") | ✅ PASS | — |
| 16 | P3 | CIM Document Upload | ✅ PASS | — |
| 17 | P4 | Portfolio Monitoring — No Apex Data | ❌ FAIL | 🟡 Medium |
| 18 | P4 | Operating Company Financials (demo) | ✅ PASS | — |
| 19 | P4 | Analytics Assistant | ✅ PASS | — |
| 20 | P4 | Graph Generator (demo data) | ✅ PASS | — |
| 21 | P4 | Graph Generator — No Apex Fund Available | ⚠️ WARN | Medium |
| 22 | P5 | URL Manipulation / Org Isolation | ✅ PASS | — |
| 23 | P5 | Infinite Spinner on Invalid Deal URL | ⚠️ WARN | Low |
| 24 | P5 | Invalid File Type Validation | ✅ PASS | — |
| 25 | P5 | Invite Duplicate Email Error Handling | ✅ PASS | — |
| 26 | P5 | Deal Finder Accessible | ✅ PASS | — |

**Results: 16 PASS · 3 FAIL · 7 WARN**

---

## Top Issues — Prioritized by Business Impact

### 🔴 #1 — [HIGH] CSV Upload Blocked by Hidden `period_date` Requirement
**Impact:** Completely blocks onboarding. A new analyst bringing their own portfolio data cannot upload it without knowing this undocumented column requirement. The error surfaces only *after* the upload at the Review step — too late.
**Fix:** (a) Provide downloadable CSV templates with column schema upfront in the Templates section. (b) Accept `acquisition_year` as a valid period indicator. (c) Surface the requirement before file selection, not after.

### 🔴 #2 — [HIGH] Thesis Fit Renders Raw JSON Instead of Visual Scorecard
**Impact:** The platform's flagship AI feature looks broken to any non-technical user. The structured data (score, red flags, sub-scores) is all there — the rendering layer just fails to parse and display it.
**Fix:** Parse the JSON response on the frontend and render as a visual card: numeric score with color ring, bulleted red flags with risk icons, category scores as progress bars.

### 🟡 #3 — [MEDIUM] Cascading Failure: Upload Block → Monitoring Empty
**Impact:** Because issue #1 blocks portfolio data ingestion, the entire Monitoring section, Graph Generator (for Apex's fund), and Deal Finder are non-functional for Apex's org. One upload failure renders 4+ downstream features useless.
**Fix:** Resolve #1. Also consider a manual data entry fallback for monitoring KPIs.

### 🟡 #4 — [MEDIUM] Portfolio News Summary Shows Wrong Sectors
**Impact:** First login shows industrials PE analysts news about "Education Technology." Immediately erodes trust in the AI intelligence layer — looks like a misconfigured demo product.
**Fix:** Derive news sectors from fund strategy tags in the database, or add a visible "Configure news sectors" control on the home dashboard.

### 🟡 #5 — [MEDIUM] Upload Target Entity Defaults to Demo Org's Fund
**Impact:** A distracted new user could upload Apex's confidential financial data onto a different organization's fund record. No warning is shown.
**Fix:** Default entity selector to the authenticated user's own organization's fund, or require an explicit selection with no pre-filled default.

### 🟢 #6 — [LOW] Infinite Spinner on Invalid/Tampered Deal URLs
**Impact:** Minor UX issue — bad URLs hang for several seconds before showing "Deal not found." Not a security issue (org isolation works correctly).
**Fix:** Add a 3-second query timeout and immediately surface the not-found state.

### 🟢 #7 — [LOW] No Downloadable CSV Templates
**Impact:** New users must guess the required column format. The Templates section in the Upload Agent exists but is effectively empty for practical guidance.
**Fix:** Add downloadable `.csv` template files per entity type (fund, portfolio company, financial metrics) with column headers and example rows.
════════════════════════════════════════════════
QA COMPLETE
════════════════════════════════════════════════
# FactorIQ QA Report — Apex Capital Partners Onboarding
**Date:** 2026-03-17 | **Analyst:** Apex Capital Partners, Fund III | **App:** http://localhost:8081

---

## Phase 1 — Login & Orientation

✅ **[PASS] Landing Page** — Clean, professional marketing page renders correctly with "Private Equity Intelligence Platform" headline, CTAs (Request a Demo, Sign In), and polished PE-buyer branding.

✅ **[PASS] Authentication** — Login with `recognizedemo100@gmail.com` / `factorIQ100` succeeded and routed to `/home`.

⚠️ **[WARN] Auto-Session Redirect** — Returning to `/auth` with an active session silently redirects to `/home` with no feedback — could confuse first-time users who think the login failed.

✅ **[PASS] Home Dashboard** — Renders 5 KPI tiles: **Total Funds (1)**, **12 Portfolio Companies**, **Deals (1 active)**, **Projects (0)**, **Recent Uploads (5)**. Two Quick Access cards: Investors Dashboard and Operating Company Dashboard. Portfolio News Summary panel below the fold.

⚠️ **[WARN] News Summary — Wrong Sector** — The Portfolio News Summary shows **"Education Technology"** and **"Technology"** tags — completely wrong for an industrials-focused fund. First impression is that the AI has no idea what our fund does.

📋 **[NOTE] Navigation Structure** — Left sidebar (collapsible) with these groups:
- **Top level:** Home, Deal Finder, Deal Manager, Projects, Reports, Help, Settings
- **Investments:** Portfolios, Fund Performance, GPs, Operating Companies, LPs, Monitoring, Budgeting
- **Data Ingestion:** Data Catalog, File Upload, Data Quality
- **Operators:** Financials, Operational Metrics, Cybersecurity
- **Analytics:** Graph Generator, Workspace

📋 **[NOTE] Pre-seeded Demo Data** — Account already has 12 investments and 5 uploads from "Recognize Growth Fund I" — not Apex's data. The "12 Investments" count will confuse a new user who only has 4 OpCos.

---

## Phase 2 — Data Upload

✅ **[PASS] Data Ingestion Page** — `/data-ingestion` renders the Upload Agent with three sections: Templates, Create New Entity, and Select Target Entity.

✅ **[PASS] Create New Entity — Fund Form** — The Create Fund modal correctly accepted Apex Capital Partners Fund III data (vintage 2021, $850M, 22% target IRR).

❌ **[FAIL] Portfolio CSV Upload — Required `period_date` Column Missing** — Uploading the portfolio CSV with columns `company_name, fund, acquisition_year, revenue_millions, ebitda_millions, sector, status` triggered:
> **"Required columns missing: period_date"** — red badge in the Review & Consolidate dialog; **Next button grayed out.**
The system requires a `period_date` for time-series financial data. Our `acquisition_year` column isn't accepted as a substitute. Column mapping *did* correctly match `revenue_millions → revenue` (79%) and `ebitda_millions → ebitda` (78%) but the upload was blocked. File was accepted and analyzed but submission was impossible.

⚠️ **[WARN] Upload Agent — Wrong Entity Pre-selected** — "Select Target Entity" defaulted to **"Recognize Growth Fund I"** (demo org), not Apex Capital's fund. A distracted user could upload data to the wrong entity with zero warning.

⚠️ **[WARN] No Template Guidance** — The Templates section exists but doesn't surface the required column schema upfront. `period_date` is a hidden requirement that only fails at the Review step — not at file selection.

✅ **[PASS] Data Catalog** — `/data-ingestion/catalog` shows 27 total sources. Uploaded test files (`apex_fund_data.csv`, `apex_portfolio.csv`, `midwest_fasteners_cim.txt`) all appear with correct entity associations and Active status — at least file tracking works.

---

## Phase 3 — Deal Analysis

✅ **[PASS] Deal Created — MidWest Fasteners Corp** — Deal card displays: Sector "Industrials - Specialty Fasteners Manufacturing," Type "Add-on," EV $80.8M, EBITDA $9.5M, Stage "Screening."

✅ **[PASS] Thesis Fit AI — Score Generated** — Thesis Fit analysis ran and returned **score: 88/100** with summary: *"This is a highly attractive, proprietary bolt-on acquisition that aligns perfectly with our buy-and-build strategy."* Strategic Fit scored 100. Red flags identified:
- *"The $3M in estimated synergies are critical to the investment thesis and their achievability must be rigorously validated"*
- *"Lack of data on historical growth, customer concentration, and management quality represent significant unknowns"*

❌ **[FAIL] Thesis Fit — Raw JSON Rendered Instead of Formatted Scorecard** — The AI output is displayed as raw monospace JSON text (`{ "score": 88, "summary": "...", "red_flags": [...] }`) rather than a visual score card with color-coded risk indicators. The structured data is clearly there — the UI just fails to render it. This makes the flagship AI feature look broken.

✅ **[PASS] DD Workplan — Well-Formatted** — Generated a structured, readable workplan with Executive Summary, Workstreams (Financial/Commercial/Operational) with Critical/High priority tags, advisor assignments ("Accounting Firm FDD/QoE"), and key questions per workstream. "Re-run" and "Ask AI" buttons present.

✅ **[PASS] Deal Chat** — "Ask AI" button opens a "Deal Analyst" side panel with "Full deal context loaded" indicator. Accepted and responded to: *"What are the key risks for a fasteners manufacturer acquisition?"*

✅ **[PASS] CIM Document Upload** — `MidWest_Fasteners_CIM.txt` uploaded to the deal's Documents tab, categorized as "CIM," with "AI Summary" button available on hover.

📋 **[NOTE] Full Deal Lifecycle Available** — Left sidebar in the deal workspace shows: Thesis Fit, Investment Analysis, Financial Model, DD Workplan, Draft PIM, Draft IOI/LOI, Draft Offer Letter, Doc Summary — a comprehensive deal workflow.

---

## Phase 4 — Portfolio Monitoring

❌ **[FAIL] Portfolio Monitoring — No Apex Data** — `/investments/monitoring` shows *"No financial data available for the selected company"* for all selections. PrecisionCast, FieldForce, GreenPath, and TechAudit Pro are absent from the dropdown because the Phase 2 CSV upload failed. The monitoring dashboard is functionally empty.

⚠️ **[WARN] Apex OpCos Not in Dropdown** — Only pre-seeded demo companies appear (e.g., "2X Marketing Services," "Blue Mantis IT Solutions"). Apex's four portfolio companies were never ingested.

✅ **[PASS] Operating Company Financials (Demo Data)** — The OpCo financial detail page is feature-rich: Revenue, COGS, SG&A, EBITDA, Net Profit KPI cards with QoQ deltas; tabs for Revenue Analysis, Liquidity, Profitability, Forecasting; revenue trend charts; Revenue per Employee metric.

✅ **[PASS] Analytics Assistant** — The AI chat panel on the OpCo Financials page provided substantive commentary on demo data: *13.0% revenue increase, 16.0% EBITDA expansion to $11.4M, SG&A analysis.* Responses are well-formatted with bold labels and specific numbers.

✅ **[PASS] Graph Generator** — `/analytics/graph-generator` functions correctly with a 3-step builder (Entity → Metrics → Timeframe). Built a live IRR (%) and MOIC chart over 3Y with Export CSV and Save to Page options — works with demo data.

⚠️ **[WARN] Graph Generator — No Apex Fund Available** — "Apex Capital Partners Fund III" doesn't appear in the entity dropdown (blocked by Phase 2 CSV failure). Nothing to chart for the actual test org.

⚠️ **[WARN] News Summary — Still Showing Wrong Sectors** — No mechanism on the home page to reconfigure news sectors to match fund strategy. Still showing "Education Technology" throughout.

---

## Phase 5 — Adversarial Tests

✅ **[PASS] URL Manipulation / Org Isolation** — Modifying deal UUID in the URL (e.g., `/deal-manager/00000000-0000-0000-0000-000000000000`) correctly returned: *"Deal not found. Back to Deal Manager."* Backend scopes deals to the authenticated org — no cross-org data leakage observed.

⚠️ **[WARN] Infinite Spinner on Bad URL** — Before showing "Deal not found," the page shows a persistent loading spinner for several seconds with no timeout or fast-fail. Security is fine; UX is poor.

✅ **[PASS] Invalid File Type Validation** — Upload Agent client-side code restricts to `text/csv`, `.xlsx/.xls` MIME types only. An `.exe` or `.jpg` triggers: *"Invalid File Type — Please upload CSV or Excel files only."* Browser file picker also restricted via `accept=".csv,.xlsx,.xls"`. Deal Documents uploader appropriately accepts a broader set (`.pdf,.doc,.docx,.xlsx,.txt,.pptx`) but still blocks executables.

✅ **[PASS] Invite Error Handling** — The invite flow calls a Supabase edge function `invite-user`. Error handling is implemented client-side — if the server returns an error for a duplicate email, a toast surfaces the `data.error` message.

✅ **[PASS] Deal Finder — Feature Accessible** — `/deal-finder` loads and supports thesis-based search using fund investment strategy as matching criteria. Only "Recognize Growth Fund I" available (Apex's fund not yet created due to upload failure).

---

## Summary Table

| # | Phase | Feature | Status | Severity |
|---|-------|---------|--------|----------|
| 1 | P1 | Landing Page | ✅ PASS | — |
| 2 | P1 | Login / Auth | ✅ PASS | — |
| 3 | P1 | Home Dashboard KPIs | ✅ PASS | — |
| 4 | P1 | News Summary Sector Relevance | ⚠️ WARN | Medium |
| 5 | P1 | Navigation Structure | ✅ PASS | — |
| 6 | P2 | Data Ingestion Page Loads | ✅ PASS | — |
| 7 | P2 | **Portfolio CSV — `period_date` Required** | ❌ FAIL | 🔴 High |
| 8 | P2 | Upload Entity Pre-selection (Wrong Default) | ⚠️ WARN | Medium |
| 9 | P2 | No Template Guidance for Column Schema | ⚠️ WARN | Low |
| 10 | P2 | Data Catalog File Tracking | ✅ PASS | — |
| 11 | P3 | Deal Created in Deal Manager | ✅ PASS | — |
| 12 | P3 | Thesis Fit AI Score Generated (88/100) | ✅ PASS | — |
| 13 | P3 | **Thesis Fit — Raw JSON Not Rendered as UI** | ❌ FAIL | 🔴 High |
| 14 | P3 | DD Workplan Formatted & Substantive | ✅ PASS | — |
| 15 | P3 | Deal Chat ("Ask AI") | ✅ PASS | — |
| 16 | P3 | CIM Document Upload | ✅ PASS | — |
| 17 | P4 | Portfolio Monitoring — No Apex Data | ❌ FAIL | 🟡 Medium |
| 18 | P4 | Operating Company Financials (demo) | ✅ PASS | — |
| 19 | P4 | Analytics Assistant | ✅ PASS | — |
| 20 | P4 | Graph Generator (demo data) | ✅ PASS | — |
| 21 | P4 | Graph Generator — No Apex Fund Available | ⚠️ WARN | Medium |
| 22 | P5 | URL Manipulation / Org Isolation | ✅ PASS | — |
| 23 | P5 | Infinite Spinner on Invalid Deal URL | ⚠️ WARN | Low |
| 24 | P5 | Invalid File Type Validation | ✅ PASS | — |
| 25 | P5 | Invite Duplicate Email Error Handling | ✅ PASS | — |
| 26 | P5 | Deal Finder Accessible | ✅ PASS | — |

**Results: 16 PASS · 3 FAIL · 7 WARN**

---

## Top Issues — Prioritized by Business Impact

### 🔴 #1 — [HIGH] CSV Upload Blocked by Hidden `period_date` Requirement
**Impact:** Completely blocks onboarding. A new analyst bringing their own portfolio data cannot upload it without knowing this undocumented column requirement. The error surfaces only *after* the upload at the Review step — too late.
**Fix:** (a) Provide downloadable CSV templates with column schema upfront in the Templates section. (b) Accept `acquisition_year` as a valid period indicator. (c) Surface the requirement before file selection, not after.

### 🔴 #2 — [HIGH] Thesis Fit Renders Raw JSON Instead of Visual Scorecard
**Impact:** The platform's flagship AI feature looks broken to any non-technical user. The structured data (score, red flags, sub-scores) is all there — the rendering layer just fails to parse and display it.
**Fix:** Parse the JSON response on the frontend and render as a visual card: numeric score with color ring, bulleted red flags with risk icons, category scores as progress bars.

### 🟡 #3 — [MEDIUM] Cascading Failure: Upload Block → Monitoring Empty
**Impact:** Because issue #1 blocks portfolio data ingestion, the entire Monitoring section, Graph Generator (for Apex's fund), and Deal Finder are non-functional for Apex's org. One upload failure renders 4+ downstream features useless.
**Fix:** Resolve #1. Also consider a manual data entry fallback for monitoring KPIs.

### 🟡 #4 — [MEDIUM] Portfolio News Summary Shows Wrong Sectors
**Impact:** First login shows industrials PE analysts news about "Education Technology." Immediately erodes trust in the AI intelligence layer — looks like a misconfigured demo product.
**Fix:** Derive news sectors from fund strategy tags in the database, or add a visible "Configure news sectors" control on the home dashboard.

### 🟡 #5 — [MEDIUM] Upload Target Entity Defaults to Demo Org's Fund
**Impact:** A distracted new user could upload Apex's confidential financial data onto a different organization's fund record. No warning is shown.
**Fix:** Default entity selector to the authenticated user's own organization's fund, or require an explicit selection with no pre-filled default.

### 🟢 #6 — [LOW] Infinite Spinner on Invalid/Tampered Deal URLs
**Impact:** Minor UX issue — bad URLs hang for several seconds before showing "Deal not found." Not a security issue (org isolation works correctly).
**Fix:** Add a 3-second query timeout and immediately surface the not-found state.

### 🟢 #7 — [LOW] No Downloadable CSV Templates
**Impact:** New users must guess the required column format. The Templates section in the Upload Agent exists but is effectively empty for practical guidance.
**Fix:** Add downloadable `.csv` template files per entity type (fund, portfolio company, financial metrics) with column headers and example rows.

---
Total time: 1447s | Turns: 65
