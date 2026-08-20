import { useState } from "react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from "@/components/ui/accordion";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { supabase } from "@/integrations/supabase/client";
import { 
  Search, 
  Home, 
  TrendingUp, 
  Building2, 
  Database, 
  FileText, 
  Settings,
  Briefcase,
  Activity,
  Calendar,
  FolderKanban,
  HelpCircle,
  Lightbulb,
  MessageCircle,
  Sparkles,
  BookOpen
} from "lucide-react";

const HelpPage = () => {
  const [searchQuery, setSearchQuery] = useState("");
  const [activeTab, setActiveTab] = useState("getting-started");
  const [showConfirmDialog, setShowConfirmDialog] = useState(false);

  const helpSections = [
    {
      id: "getting-started",
      title: "Getting Started",
      icon: BookOpen,
      description: "Learn the basics of FactorIQ",
      content: [
        {
          question: "What is FactorIQ?",
          answer: "FactorIQ is a comprehensive private equity analytics platform designed to help you manage investments, track fund performance, monitor portfolio companies, and make data-driven decisions. The platform combines powerful data ingestion capabilities with AI-powered analytics across every stage of the investment lifecycle."
        },
        {
          question: "How do I navigate the platform?",
          answer: "Use the left sidebar to navigate between sections. The main areas follow your investment workflow: Home (dashboard overview), Organizational Settings (configuration), Deal Finder (sourcing), Deal Manager (pipeline), Portfolio Monitoring (tracking), Daily AI Review (fund-specific insights), Projects (strategic initiatives), Operators (operating company deep dives), Data Ingestion (uploads), Reports (fund performance, partners, portfolio companies, cash flow ledger, and forecasting), and Analytics / Charting (custom visualizations)."
        },
        {
          question: "What are the key features?",
          answer: "Key features include: Portfolio management with multi-fund tracking, Fund performance analytics with IRR/MOIC/TVPI metrics, AI-powered data ingestion with automatic column mapping, Dimensional analysis (by product, region, segment), Deal sourcing and pipeline management with AI analysis, Project workspaces with scenario modeling, Custom report generation with PDF/Excel export, News intelligence summaries, Cybersecurity posture monitoring, Operational KPI dashboards, and customizable AI prompts for tailored insights."
        },
        {
          question: "How is data organized?",
          answer: "Data follows a hierarchy: Organization → General Partner (GP) → Fund → Operating Company. Each organization can have multiple GPs, each GP manages multiple funds, and each fund invests in multiple operating companies. This structure is reflected throughout the platform — you can filter views by fund to see only relevant entities."
        },
        {
          question: "How do AI features work?",
          answer: "FactorIQ uses AI throughout the platform for data analysis, report generation, deal evaluation, and conversational insights. AI prompts for News, Company Research, and GP Analysis can be customized in Organizational Settings to align with your investment thesis. The AI uses your actual uploaded data as context, ensuring insights are specific to your portfolio."
        }
      ],
      faqs: [
        {
          question: "How do I get my data into FactorIQ?",
          answer: "There are multiple ways to get data into FactorIQ: (1) Data Ingestion — upload CSV or Excel files with AI-powered column mapping. (2) Deal Manager — upload documents (PDFs, spreadsheets, DOCX) directly to a deal workspace; spreadsheets are automatically processed for financial data. (3) Portfolio Monitoring — upload files via the unified Data Catalog, which also supports Google Drive imports. (4) Entity Import — bulk-create GPs, Funds, Operating Companies, or LPs via template spreadsheets in Organizational Settings. All upload paths share a unified processing pipeline that extracts text, vectorizes for AI search, and auto-ingests structured financial data."
        },
        {
          question: "What file formats are supported?",
          answer: "We support CSV files and Excel workbooks (.xlsx, .xls). Excel files can contain multiple sheets — you can select which sheet to import."
        },
        {
          question: "Can multiple users work on the same data?",
          answer: "Yes, FactorIQ supports multi-user collaboration. Data is shared within your organization, and changes are visible to all authorized users in real-time."
        }
      ]
    },
    {
      id: "home",
      title: "Home",
      icon: Home,
      description: "Overview of your portfolio and key metrics",
      content: [
        {
          question: "What information is shown on the Home page?",
          answer: "The Home dashboard displays Quick Access tiles linking to key sections, aggregate portfolio statistics (AUM, fund count, company count), a Portfolio News Summary with AI-generated insights, a News & Updates section with industry and company news tabs, and a Company Information research panel for deep-dive company analysis."
        },
        {
          question: "How does the Portfolio News Summary work?",
          answer: "The Portfolio News Summary uses AI to generate a consolidated overview of recent news relevant to your portfolio companies. Click the circular refresh icon to regenerate. The AI prompt used for news generation can be customized on the 'News Prompt' tab within Organizational Settings to focus on topics most relevant to your investment strategy."
        },
        {
          question: "How do I use Company Information research?",
          answer: "Enter a company name in the Company Information search panel and click the refresh icon to generate an AI-powered business intelligence report. You can add optional keywords to refine the research. Results appear in a scrollable panel, and you can click 'Ask AI' to open a side chat for follow-up questions about the company."
        },
        {
          question: "Can I customize the AI research prompts?",
          answer: "Yes. The system prompts that drive both the News Summary and Company Information research are fully customizable. Go to Organizational Settings and select the 'Company Prompt' or 'News Prompt' tab to view the default prompt, create your own custom version, or reset to system defaults. Custom prompts let you tailor AI output to focus on your specific investment criteria, sectors, or analytical preferences."
        },
        {
          question: "How do I use the Analytics Chat?",
          answer: "The Analytics Chat allows you to ask natural language questions about your portfolio data. Type questions like 'What is my total AUM?' or 'Show me the top performing funds' and the AI will analyze your data and provide insights."
        },
        {
          question: "What are the Quick Access tiles?",
          answer: "Quick Access tiles provide one-click navigation to the most commonly used sections: Organizational Settings, Deal Finder, Deal Manager, Portfolio Monitoring, Daily AI Review, Reports, Operators, and Data Ingestion. They are ordered to match the sidebar for consistency."
        }
      ],
      faqs: [
        {
          question: "Why is my Portfolio News Summary empty?",
          answer: "The news summary is generated based on your portfolio companies. Ensure you have portfolio companies set up and click the refresh button to generate a new summary."
        },
        {
          question: "How do I refresh the news?",
          answer: "Click the circular refresh icon next to each section header (Portfolio News Summary, News & Updates, or Company Information) to fetch the latest data."
        },
        {
          question: "Where do I edit the AI prompts for news and company research?",
          answer: "Go to Organizational Settings. The 'News Prompt' tab controls how portfolio news summaries are generated, and the 'Company Prompt' tab controls the Company Information research output. You can save custom prompts or reset to defaults."
        }
      ]
    },
    {
      id: "organizational-settings",
      title: "Organizational Settings",
      icon: Settings,
      description: "Configure your organization, users, entities, and AI prompts",
      content: [
        {
          question: "What can I configure in Organizational Settings?",
          answer: "Organizational Settings is your central configuration hub. It includes: Profile & Strategy (organization details, deal preferences, target sectors), User Management (invite users, assign roles), Entity Management (create/import GPs, Funds, Operating Companies, LPs), Feature Assignment (control module access per user), GP & Fund Management, AI Prompt customization (News, Company Research, GP Analysis), RAG Document management, and MFA security settings."
        },
        {
          question: "How do I create a General Partner (GP)?",
          answer: "Go to Organizational Settings and select the 'GP Management' tab. Click 'Add GP' and fill in the details including name, firm name, contact information, AUM, and other relevant fields. GPs are scoped to your active organization. Once created, you can associate funds with this GP."
        },
        {
          question: "How do I create a new Fund under a GP?",
          answer: "Go to Organizational Settings and select the 'Fund Management' tab, then click 'Add Fund'. Select the General Partner to associate with, then fill in: Fund Name, Fund Thesis, Committed Capital, Currency (USD, EUR, GBP, JPY, or custom), Inception Date, Management Fee (defaults to 2.0%), Carried Interest (defaults to 20.0%), and Target IRR (defaults to 25.0%). The fund is automatically scoped to your active organization."
        },
        {
          question: "How do Fund Economics work (fees, carry, hurdle)?",
          answer: "Each fund has a dedicated Fund Economics block in Fund Management covering everything the forecast engine and waterfall need:",
          bullets: [
            "Inception Date and Committed Capital — anchor the fee schedule and pacing.",
            "Fees Start At — choose Fund inception or First investment as the trigger for management fees.",
            "Fee Payment Timing — Quarterly in advance, Quarterly in arrears, or Annually in advance.",
            "Fee Schedule — multi-row editor for Investment Period, Post-Investment, and Wind-Down phases with their own fee % and year ranges. Changing the schedule automatically updates the implied investment / post-investment / wind-down year counts used in forecasting.",
            "Fee Offsets — Deal fees, monitoring fees, and other offsets that reduce management fees actually charged to LPs.",
            "Carry, Hurdle (preferred return), and Catch-up — drive the GP waterfall and the GP Forecast row in the Forecasting tab.",
            "Target IRR — used as the benchmark in fund performance comparisons."
          ]
        },
        {
          question: "How do I manage users and permissions?",
          answer: "In User Management, administrators can invite new users by email, assign organization roles, and control access. The Feature Assignment tab lets you enable or disable specific modules (Deal Manager, Investment Reports, Data Ingestion, etc.) for each user, ensuring team members only see what's relevant to their role."
        },
        {
          question: "How do I customize AI prompts?",
          answer: "Three types of AI prompts are customizable: (1) News Prompt — controls how Portfolio News Summaries are generated on the Home page. (2) Company Prompt — controls the Company Information research output. (3) GP Analysis Prompt — controls the AI analysis generated for General Partners. Each tab shows the system default prompt, and you can save a custom override or reset to defaults at any time."
        },
        {
          question: "What is Entity Import?",
          answer: "Entity Import allows bulk creation of funds, portfolio companies, GPs, and LPs using template spreadsheets. Download the template for the entity type you need, fill in your data, and upload to create multiple entities at once. The system validates data and reports any errors."
        },
        {
          question: "How do I configure Organization Profile & Strategy?",
          answer: "The Profile & Strategy section lets you set your organization's contact details (email, phone with auto-formatting), preferred deal types (displayed in a grid), target sectors (15+ technology verticals), and target financial parameters (Deal Size, Revenue, EBITDA, Fund Size, AUM) with real-time comma formatting for readability."
        },
        {
          question: "How do RAG Documents work?",
          answer: "RAG (Retrieval Augmented Generation) Documents are reference documents that enhance AI responses. Upload relevant documents (investment memos, policies, guidelines) and the AI will use them as context when answering questions across the platform."
        },
        {
          question: "How do I configure MFA?",
          answer: "Multi-Factor Authentication can be enabled in the Security/MFA section. Organization administrators can enforce MFA for all users or allow individual opt-in. Users enroll by scanning a QR code with an authenticator app."
        }
      ],
      faqs: [
        {
          question: "How do I invite a new user?",
          answer: "Go to User Management and click 'Invite User'. Enter their email address and assign appropriate feature access permissions."
        },
        {
          question: "Can I control which features users can access?",
          answer: "Yes, the Feature Assignment tab lets you enable or disable specific modules for each user, such as Deal Manager, Investment Reports, or Data Ingestion."
        },
        {
          question: "How do I switch between organizations?",
          answer: "Use the Organization Selector dropdown (typically in the header area) to switch your active organization context. All data views will update to reflect the selected organization."
        },
        {
          question: "Can I edit a GP or Fund after creation?",
          answer: "Yes, navigate to GP Management or Fund Management in Organizational Settings. Click on the entity to view and edit its details."
        }
      ]
    },
    {
      id: "deal-finder",
      title: "Deal Finder",
      icon: Search,
      description: "Search for and evaluate investment opportunities",
      content: [
        {
          question: "How does Deal Finder work?",
          answer: "Deal Finder runs a strategy-driven, multi-source search tailored to the type of deal you're looking for. You first pick a Deal Type, then refine the available filters for that deal type. When you run a search, the platform fans out to multiple data sources in parallel, scores each candidate against your fund thesis and filters, then returns a ranked, deduplicated list of opportunities."
        },
        {
          question: "What deal types are supported?",
          answer: "Six deal types are supported, each with its own filter set and source mix:",
          bullets: [
            "Early Stage VC — Pre-Seed through Series A, signal-driven (Form D, accelerator cohorts, GitHub, hiring spikes, university spinouts).",
            "Growth / Late Stage VC — Series B+, growth signals (revenue proxies, web traffic, app downloads, hiring velocity, co-investor activity).",
            "Growth Equity — profitable founder/family-owned businesses, business model + ownership filters, EBITDA-positive toggle.",
            "Buyout — control acquisitions with target EBITDA range, ownership structure, deal signals (take-privates, carve-outs, activist targets, CEO transitions).",
            "Distressed / Special Situations — situation type (Ch. 7/11, covenant violations, going concern), debt size range, court record sources.",
            "Real Assets — infrastructure / real estate / energy / natural resources, transaction type, deal size range, infrastructure-specific data sources (SAM.gov, CMBS/Trepp, county recorder, utility commission filings)."
          ]
        },
        {
          question: "What filters are available?",
          answer: "Filters are tailored to the deal type you select — there is no fixed 'standard' set, since not every deal type uses metrics like revenue. Common filters include Industry and Geography (multi-select), and deal-type specific filters such as Funding Stage for VC, EBITDA Range for Buyout, Situation Type for Distressed, Asset Type for Real Assets, and applicable size ranges (revenue, EBITDA, deal size, or debt size) where they make sense. You can also add a free-text 'custom description' to nudge the AI scoring toward specific traits."
        },
        {
          question: "Where does the data come from?",
          answer: "Deal Finder pulls from a tiered source catalog: Tier 1 — public / free APIs (SEC EDGAR, USPTO, SAM.gov, SBIR, GitHub, Hacker News, CourtListener, PR Wires, Accelerator Cohorts). Tier 2 — subscription databases (Crunchbase, PitchBook, CB Insights, Dealroom, S&P Capital IQ, Bloomberg, FactSet, Refinitiv, MSCI Real Estate). Tier 3 — alt-data and signal databases (SimilarWeb, Sensor Tower, G2, Revelio Labs, Coresignal, Second Measure, Earnest Research, ZoomInfo, Apollo, D&B Hoovers, Abrigo). Each deal type uses a curated subset of these sources. Tier 1 sources are always available; Tier 2 and Tier 3 require credentials configured in Organizational Settings → Data Source Credentials and appear locked in the UI until connected."
        },
        {
          question: "How does Real Assets sourcing surface infrastructure deals?",
          answer: "For Real Assets searches, SAM.gov queries are tuned to surface public-private partnership and concession opportunities rather than routine procurement — they target keywords like 'public private partnership', 'concession agreement', 'P3', 'long-term lease', and 'ground lease'. Results are also filtered to exclude NAICS codes that indicate routine services and supplies rather than infrastructure assets (Professional Services 541, Administrative Services 561, Healthcare Services 621–629, Arts and Entertainment 711–713, Food Services 722, Repair and Personal Services 811–812). Combined with CMBS / Trepp, county recorder, and utility commission filings, this surfaces infrastructure transactions instead of generic government contracts."
        },
        {
          question: "What is the Source Status panel?",
          answer: "The Source Status panel shows every data source the current deal type can use, whether it is connected (Tier 2/3 require credentials), and the result of the last fetch — including row counts, error messages, and free-tier quota state. It's the fastest way to see which sources contributed to a search and which were skipped because of missing credentials or hit a daily quota."
        },
        {
          question: "What are Network Signals?",
          answer: "Network Signals surface co-investor and LP-roster activity — when a company in your search results overlaps with funds, GPs, or LPs in your existing portfolio network. The Network Signals panel summarizes these matches and a Network Signals modal lets you drill into the underlying connections, helping you prioritize warm-introduction opportunities."
        },
        {
          question: "What information is shown in deal results?",
          answer: "Each deal opportunity card displays the company name, industry, geography, revenue range, business model, the source(s) it came from, a relevance score against your thesis and filters, any watchlist matches, and a brief AI-generated summary. Clicking a card opens a detail view with Overview (AI-generated company analysis), Company Data (financial and operational metrics), and Sources (links back to the underlying records so you can verify and explore further)."
        },
        {
          question: "How do I act on results?",
          answer: "On each result card, choose Dismiss (remove from view), Save (bookmark in Deal Finder), or Promote (push into Deal Manager as an active deal pre-populated with the company information). Click 'Apply Actions' to execute pending actions in bulk. Promoted deals enter the Screening stage of your pipeline; saved deals stay in Deal Finder for later review."
        },
        {
          question: "Can I save searches?",
          answer: "Yes. Save your current Deal Type + filter combination from the Saved Searches panel, then re-run it with one click later to monitor new opportunities matching the same criteria over time."
        },
        {
          question: "How are relevance scores calculated?",
          answer: "Each result is scored against your fund's investment thesis and your active filters. Industry and geography alignment, size fit, business model, deal-type-specific signals, and any custom description text all feed the score. Higher scores indicate tighter alignment with both your thesis and your search criteria. Numbers prefixed with 'Est.' indicate AI-derived estimates rather than confirmed figures."
        }
      ],
      faqs: [
        {
          question: "Why is a data source greyed out?",
          answer: "Tier 2 and Tier 3 sources require credentials. Connect them in Organizational Settings → Data Source Credentials. Once a provider is connected, the corresponding source becomes available the next time you run a search."
        },
        {
          question: "Why did SAM.gov return no results today?",
          answer: "The free SAM.gov tier has a daily quota. If you exhaust it, the Source Status panel will show a quota_exceeded message with the reset time (00:00 UTC). Either wait for the reset or configure a SAM.gov system account key to use a higher-volume tier."
        },
        {
          question: "What's the difference between Save and Promote?",
          answer: "Save bookmarks the opportunity for later review within Deal Finder. Promote moves it into Deal Manager as an active deal in your pipeline, where you can begin due diligence and track it through investment stages."
        },
        {
          question: "Can I convert a deal opportunity into a Deal Manager deal?",
          answer: "Yes — use the Promote action on a result card. This creates a new deal in Deal Manager with the company details pre-filled, placing it in the Screening stage of your pipeline."
        }
      ]
    },
    {
      id: "deal-manager",
      title: "Deal Manager",
      icon: Briefcase,
      description: "Manage your deal pipeline and due diligence",
      content: [
        {
          question: "How do I create a new deal?",
          answer: "Click the 'Create Deal' button in Deal Manager. Fill in the company name, description, industry, geography, deal type, deal source, and financial details (enterprise value, target revenue, target EBITDA). Deals can also be created automatically by promoting opportunities from Deal Finder."
        },
        {
          question: "What is the deal pipeline view?",
          answer: "The pipeline view organizes your deals by stage: Screening → Due Diligence → IC Review → Negotiation → Closed. Each stage shows deal cards with key metrics. You can move deals between stages to track progress through your investment process."
        },
        {
          question: "What tabs are available in a Deal Workspace?",
          answer: "Each deal has a dedicated workspace with tabs: (1) Overview — company details, financials, thesis fit score, and key metrics. (2) Documents — upload and manage deal documents with AI summarization. (3) Notes — add and organize deal notes by type (general, meeting, due diligence). (4) AI Analysis — comprehensive AI-generated analyses. (5) Pipeline — stage tracking and checklist management. (6) Deal Finder Details — original sourcing data if promoted from Deal Finder."
        },
        {
          question: "What AI analyses are available?",
          answer: "The AI Analysis tab can generate: Thesis Fit Analysis (scoring alignment with your fund's thesis), Investment Analysis (comprehensive evaluation), Financial Model (projected returns), DD Workplan (due diligence checklist), PIM (Preliminary Investment Memo), IOI/LOI (Indication/Letter of Interest drafts), Offer Letter, and Document Summary (synthesis of uploaded documents). You can run all analyses sequentially or individually."
        },
        {
          question: "What is Thesis Fit Analysis?",
          answer: "Thesis Fit Analysis uses AI to score how well a deal aligns with your fund's investment thesis. It evaluates sector fit, geography, size, growth profile, and strategic alignment, providing a numerical score and detailed breakdown of each dimension."
        },
        {
          question: "How do I manage deal documents?",
          answer: "In the Documents tab, drag-and-drop files or click to upload. The AI can automatically summarize uploaded documents. Supported types include PDFs, spreadsheets, and presentations. Document summaries feed into the overall deal analysis."
        },
        {
          question: "How do I move a deal to my portfolio?",
          answer: "When a deal reaches its final stage, use the 'Close Deal' option in the deal workspace. Closing a deal as 'Closed' (won) automatically moves the company from Deal Manager into Portfolio Monitoring, where it becomes a tracked investment. The deal is removed from the active pipeline view and appears in Portfolio Monitoring with its associated documents and data. Alternatively, closing as 'Passed' archives the deal without adding it to the portfolio."
        },
        {
          question: "How do I close or archive a deal?",
          answer: "Use the Close Deal option from the deal workspace to mark it as won (Closed) or lost (Passed). The Pipeline tab tracks the deal's progression through each stage with timestamps and notes. Closed deals move to Portfolio Monitoring; passed deals are archived with a reason for the outcome."
        },
        {
          question: "How does the Deal Manager AI Chat work?",
          answer: "Each deal workspace includes an AI chat that has context about the deal's documents, notes, and analysis. Ask questions like 'What are the key risks?' or 'Summarize the financial projections' for deal-specific insights."
        }
      ],
      faqs: [
        {
          question: "How do I move a deal between pipeline stages?",
          answer: "In the Pipeline tab of the deal workspace, click on the target stage to advance or move the deal. Each stage has an optional checklist to ensure key steps are completed before progressing."
        },
        {
          question: "Can I run all AI analyses at once?",
          answer: "Yes, click the 'Run All Analyses' button in the AI Analysis tab. The system will sequentially generate all analysis types, skipping any that have already been completed."
        },
        {
          question: "How do I upload documents to a deal?",
          answer: "Open the deal workspace, go to the Documents tab, and drag-and-drop files or click to upload. The AI can summarize uploaded documents automatically."
        }
      ]
    },
    {
      id: "portfolio-monitoring",
      title: "Portfolio Monitoring",
      icon: Activity,
      description: "Monitor portfolio company performance in real-time",
      content: [
        {
          question: "What does Portfolio Monitoring show?",
          answer: "Portfolio Monitoring is the home for every company that has been Closed (won) in Deal Manager. The landing page shows a fund-filterable grid of portfolio company cards with thumbnail, fund, industry, geography, deal type, enterprise value, EBITDA, and the date the deal was closed. Use the Fund selector to narrow to a single fund or search by company name / industry. Clicking a card opens that company's workspace."
        },
        {
          question: "What tabs are in a portfolio company workspace?",
          answer: "Each company opens into a workspace with five tabs, each focused on a different layer of monitoring:",
          bullets: [
            "Investment Overview — the cap-table-style ledger of every cash event for this investment (initial close, follow-ons, valuation updates, sales/exits).",
            "Analysis (Ask AI) — conversational AI grounded in the company's documents, financials, and transaction history.",
            "Dashboard — auto-generated KPI dashboard for this company (revenue, margins, headcount, operational metrics).",
            "Data Catalog — every uploaded file linked to this company with processing status and AI-extracted summaries.",
            "Financials — full financial statements view (income statement, dimensional breakdowns, trend charts)."
          ]
        },
        {
          question: "How do I use the Investment Overview tab?",
          answer: "Investment Overview is the source-of-truth ledger for this investment. It shows the Investment & Valuation History table — every transaction in chronological order with date, type (Investment, Follow-On, Valuation, Sale), amount, ownership %, implied EV, multiple, and notes — alongside summary cards for Total Invested, Current Value, Realized Proceeds, MOIC, and IRR (computed via XIRR across all dated cash flows). Click the pencil icon on any row to edit it; the summary metrics recompute immediately."
        },
        {
          question: "How do I enter a follow-on investment?",
          answer: "On the Investment Overview tab click 'New Investment'. The dialog captures: transaction date, amount invested, ownership acquired (or incremental ownership %), pre-/post-money valuation or implied enterprise value, security type, and an optional note. Saving appends a row to the Investment & Valuation History; ownership and cost basis roll forward, and MOIC / IRR recompute against the new cost basis. Follow-ons inherit the deal's fund and currency, so they automatically flow into Fund Performance, the Cash Flow Ledger, and the Forecasting tab."
        },
        {
          question: "How do I record a sale or full/partial exit?",
          answer: "Click 'Record Sale' on the Investment Overview tab. Enter the sale date, proceeds received, the percentage of holdings sold (partial) or mark as full exit, and any transaction notes. Partial sales reduce remaining ownership and remaining cost basis pro-rata; full exits zero out the position, mark the investment as Realized, and lock the final realized MOIC and IRR. Proceeds appear in the ledger as a Sale row and feed Realized Proceeds, DPI, and the Cash Flow Ledger."
        },
        {
          question: "How do I update a valuation without a cash event?",
          answer: "Use 'Valuation Update' on the Investment Overview tab to record a fair-value mark without changing cost basis — for example a quarterly mark or a new round at a different company that re-prices your stake. Enter the as-of date, new implied EV or per-share value, and rationale. The valuation flows into Current Value, unrealized MOIC, and TVPI but does not create a cash flow."
        },
        {
          question: "What is the Dashboard tab?",
          answer: "The Dashboard tab renders an auto-generated KPI dashboard for the selected portfolio company using the latest ingested data: revenue trend, gross / EBITDA margin, headcount, operational metrics (NPS, retention, OEE where available), and any pinned saved graphs for this entity. It's the fastest way to see company health at a glance without leaving Portfolio Monitoring."
        },
        {
          question: "What is the Data Catalog tab?",
          answer: "The Data Catalog tab is the unified inventory of every file linked to this portfolio company — files uploaded directly here, files promoted from the original deal, and files imported via Google Drive. Each row shows file name, type, ingestion status, row counts for tabular data, AI-extracted summary, and the entity it's linked to. From here you can upload new files (drag-and-drop), re-run ingestion, view summaries, or delete obsolete documents. All files in the catalog are indexed and available to the Analysis (Ask AI) tab."
        },
        {
          question: "What is the Financials tab?",
          answer: "The Financials tab renders the company's full financial statements view: income statement by period, dimensional breakdowns (product / region / segment when uploaded), margin analysis, and trend charts. Data comes from spreadsheets ingested through the Data Catalog tab — when you upload a new financial workbook here, columns are AI-mapped to the standard chart of accounts and the statements refresh automatically. Use the Reingest Financials button if you've fixed a source file and want to rebuild the statements."
        },
        {
          question: "How does fund filtering work?",
          answer: "The Fund selector on the Portfolio Monitoring landing page filters the company grid to a single fund. Selecting 'All Funds' shows every closed deal in the organization. The selection persists across the app via the global fund context."
        }
      ],
      faqs: [
        {
          question: "A deal I closed isn't showing up in Portfolio Monitoring — why?",
          answer: "Portfolio Monitoring only lists deals whose status is 'closed' (won) in Deal Manager. If you closed the deal as 'Passed' it's archived instead. Check the deal's status in Deal Manager and re-close as Won if needed."
        },
        {
          question: "Can I edit or delete a transaction after entering it?",
          answer: "Yes. On the Investment Overview tab, click the pencil icon on any row in the Investment & Valuation History to edit amount, date, ownership, or notes — or delete it. MOIC, IRR, and Realized Proceeds recompute on save."
        },
        {
          question: "How are MOIC and IRR calculated?",
          answer: "MOIC = (Realized Proceeds + Current Value) / Total Invested across every Investment, Follow-On, Sale, and Valuation row. IRR uses XIRR over the exact dated cash flows in the ledger, with the latest valuation treated as a terminal inflow until a full exit is recorded."
        },
        {
          question: "How often is monitoring data updated?",
          answer: "Financials and dashboard data refresh whenever new files are uploaded through the Data Catalog tab (or Data Ingestion). Investment Overview updates the moment you save a new transaction or valuation."
        },
        {
          question: "Can I drill down even deeper into operations?",
          answer: "Yes — open the Operators section for the same company to see AI Insights, deeper dimensional Financials, Operational Metrics, and the Cybersecurity dashboard."
        }
      ]
    },
    {
      id: "daily-ai-review",
      title: "Daily AI Review",
      icon: Calendar,
      description: "AI-generated daily portfolio insights",
      content: [
        {
          question: "What is the Daily AI Review?",
          answer: "The Daily AI Review generates an AI-powered briefing for a specific fund each day, highlighting key changes, risks, and opportunities across the portfolio companies in that fund. Reports are fund-scoped — switching funds shows a different briefing — and each generated report is saved per fund and per date."
        },
        {
          question: "How do I generate a daily report?",
          answer: "Select a fund from the fund dropdown at the top of the Daily AI Review page and click Generate. The AI builds a fresh report covering only that fund's portfolio companies, recent performance changes, news, and actionable insights. If you switch the fund selector, you'll see the latest report saved for that fund (or a prompt to generate one). Reports are also organization-scoped, so users in other organizations never see them."
        },
        {
          question: "What does the daily report cover?",
          answer: "Reports typically include: portfolio health summary for the selected fund, notable financial changes (revenue / margin shifts), operational KPI highlights, cybersecurity alerts if applicable, market news relevant to the fund's portfolio companies, and strategic recommendations."
        }
      ],
      faqs: [
        {
          question: "Can I view past daily reports?",
          answer: "Yes, previously generated reports are saved by date. Select a past date to view its report. This creates a historical record you can reference for trend analysis."
        },
        {
          question: "Is the daily report generated automatically?",
          answer: "Reports are generated on-demand when you click Generate. This ensures you get fresh analysis based on the latest available data."
        }
      ]
    },
    {
      id: "projects",
      title: "Projects",
      icon: FolderKanban,
      description: "Organize and collaborate on strategic initiatives",
      content: [
        {
          question: "How do I create a project?",
          answer: "Click 'Create Project' to start a new strategic initiative. Add a name, description, and relevant details. Projects have dedicated workspaces with documents, notes, scenarios, and AI chat — making them ideal for strategic planning, add-on acquisitions, or value creation initiatives."
        },
        {
          question: "What tabs are available in a Project Workspace?",
          answer: "Each project workspace includes: (1) Overview — project details, status, and key information. (2) Documents — upload and manage project files with AI processing. (3) Notes — add and organize project notes. (4) Scenarios — model different outcomes with distinct assumptions. (5) AI Chat — conversational AI with context from your project documents."
        },
        {
          question: "What are Project Scenarios?",
          answer: "Scenarios let you model different outcomes for a project — such as base case, upside, and downside. Each scenario can have its own assumptions, financial projections, and analysis. This helps evaluate risk/reward across different possibilities."
        },
        {
          question: "How does the Project AI Chat work?",
          answer: "The Project Chat uses your uploaded project documents as context to answer questions, generate summaries, and provide strategic insights specific to that project. It can reference document content, compare scenarios, and help with strategic analysis."
        }
      ],
      faqs: [
        {
          question: "Can I upload documents to a project?",
          answer: "Yes, each project workspace has a Documents tab where you can upload and manage relevant files. The AI chat can reference these documents for context-aware responses."
        },
        {
          question: "What types of scenarios can I create?",
          answer: "You can create any type of scenario — base case, upside, downside, or custom. Each scenario supports its own set of assumptions, projections, and notes, allowing side-by-side comparison."
        }
      ]
    },
    {
      id: "reports",
      title: "Reports",
      icon: FileText,
      description: "Unified investment analytics, document library, and report generation",
      content: [
        {
          question: "What is the Reports section?",
          answer: "Reports is the unified home for both interactive investment analytics and formal report generation. Portfolio analytics, fund performance, partner views, the cash flow ledger, forecasting, the document library, and PDF/Excel report generation all live behind a single sidebar entry. The 'Generate PDF Report' button in the upper-right opens the report builder no matter which tab you're on."
        },
        {
          question: "What tabs are available in Reports?",
          answer: "Reports is organized into tabs (the ones you see depend on your feature access):",
          bullets: [
            "Organization / GP — GP profiles, AUM, fund-level performance, balance sheet data, and configurable AI analysis.",
            "LPs — LP commitments across funds, funded vs. unfunded, capital call schedules, and distribution history.",
            "Fund — IRR, MOIC, DPI, RVPI, TVPI, NAV, management fees paid, and carried interest with historical trends.",
            "Portfolio Companies — current valuations, investment multiples, financial drill-downs, dimensional analysis, and the value creation bridge.",
            "Cash Flow Ledger — fund-level capital calls, distributions, and other cash movements with LP and operating-company position tables. Default sort is by date oldest → newest.",
            "Forecasting — the full forward-looking forecast for the selected fund (see the Forecasting section of this help center for details)."
          ]
        },
        {
          question: "How do I view portfolios and fund performance?",
          answer: "Open the Fund tab for IRR, MOIC, DPI, RVPI, TVPI, NAV, management fees paid, and carried interest with historical trend charts. Portfolio Companies shows all operating companies with current valuations, investment multiples, and drill-downs into financials, dimensional analysis, and value creation bridges."
        },
        {
          question: "How do I analyze General Partners?",
          answer: "The Organization / GP tab provides comprehensive GP profiles with AUM, fund performance metrics, balance sheet data, and AI-powered analysis. You can run custom AI analyses using configurable prompts (managed on the 'GP Analysis Prompt' tab within Organizational Settings), and engage in follow-up conversations via the AI chat."
        },
        {
          question: "How do I manage Limited Partners?",
          answer: "The LPs tab shows all LP relationships, their commitments across funds, funded amounts, and unfunded commitments. You can track capital call schedules and distribution history."
        },
        {
          question: "How do I generate and export a formal report?",
          answer: "Click 'Generate PDF Report' in the upper-right of the Reports page. The dialog defaults the report type based on which tab you're on (Marketing for Fund/GP, LP for LPs, Operating Company for Portfolio Companies). Pick entities, choose the attributes/metrics to include, preview, and export to PDF or Excel. Report types include Portfolio Summary, Fund Performance, Operating Company Analysis, LP Statements, and fully Custom Reports."
        },
        {
          question: "Can I customize report formatting and save templates?",
          answer: "Yes. You can select which attributes to include, choose date ranges, add filters, and configure how data is grouped and sorted — the preview shows exactly what the exported file will look like before you generate it. Custom report configurations can be saved as templates for reuse, making recurring reports consistent."
        },
        {
          question: "What is the Cash Flow Ledger?",
          answer: "The Cash Flow Ledger tracks fund-level capital calls, distributions, and other actual cash movements over time, with LP and operating-company position tables so you can reconcile fund cash flow against the underlying contributors and recipients. The default sort is by flow date from oldest to newest so you read the fund's history top-down."
        }
      ],
      faqs: [
        {
          question: "Why don't I see data in some charts?",
          answer: "Charts require data to be uploaded for the selected entity and time period. Check the Data Catalog tab on the Data Ingestion page to see what data is available."
        },
        {
          question: "How do I export data from tables?",
          answer: "Most tables throughout the platform have an export button (download icon) that exports the visible data to Excel. For formatted, presentation-ready outputs, click 'Generate PDF Report' in the upper-right of Reports to build a PDF or Excel deliverable."
        },
        {
          question: "What export formats are available?",
          answer: "Reports can be exported to PDF (formatted documents suitable for LP presentations) or Excel (spreadsheets for further analysis). Most data tables throughout the platform also support direct Excel export via the download icon."
        },
        {
          question: "What is the Value Creation Bridge?",
          answer: "The Value Creation Bridge chart breaks down the change in value for a portfolio investment, showing contributions from revenue growth, margin expansion, multiple expansion, and other factors."
        }
      ]
    },
    {
      id: "forecasting",
      title: "Forecasting",
      icon: TrendingUp,
      description: "Forward-looking fund cash flows, LP/GP distributions, and exit assumptions",
      content: [
        {
          question: "What is the Forecasting tab?",
          answer: "Forecasting lives inside Reports and projects every future capital call, distribution, fee, and carry payment for a fund. It combines actual cash flows already recorded in the Cash Flow Ledger with anticipated flows driven by per-OpCo exit assumptions, fund pacing, fee schedules, and the waterfall — then rolls everything up to LP-level and GP-level forecasts."
        },
        {
          question: "How do I choose what I'm forecasting?",
          answer: "At the top of the tab, pick a scope: 'This fund' shows a single fund (with a fund selector that persists across the app) or 'All funds' aggregates the LP and GP forecasts across every fund in the organization. Most of the per-OpCo tables and the cash-flow chart only render in single-fund mode because they are inherently fund-specific."
        },
        {
          question: "What do I see on the Forecasting tab?",
          answer: "In single-fund mode, the tab stacks the following views, each one drillable:",
          bullets: [
            "OpCo Cash Flow Table — investment and expected exit cash flow per portfolio company with the assumptions driving the projection.",
            "OpCo Net Cash Flow Table — net of cost basis, showing the projected gain/loss per investment.",
            "Fund Cash Flow Chart — actual + anticipated fund-level cash flow on a single timeline.",
            "LP Forecast Table — per-LP projected calls, distributions, net cash flow, DPI, and TVPI.",
            "GP Forecast Row — projected management fees, fee offsets, and carry over the fund life.",
            "Anticipated Ledger Table — line-by-line list of every projected flow, sorted by date oldest → newest."
          ]
        },
        {
          question: "How are exit assumptions set?",
          answer: "Open 'Investment Exit Assumptions' (top-right of the Forecasting tab, single-fund mode). For each portfolio company you can set the planned exit date, projected exit value or exit multiple, and any interim distributions. If a company has no explicit exit date configured, the engine defaults to the earliest investment date for that OpCo plus 5 years so the forecast still has a usable horizon — set an explicit date any time you want to override the default."
        },
        {
          question: "What is the Blind Pool Assumption?",
          answer: "The Blind Pool toggle (top-right of the Forecasting tab) controls whether the forecast also models capital that has been committed but is not yet deployed into named investments. With Blind Pool On, the engine pacing-deploys remaining commitment over the investment period using fund-level assumptions and applies the same exit and waterfall logic, giving you a fully-invested view. With Blind Pool Off, only known/named investments are projected."
        },
        {
          question: "How do fund economics flow into the forecast?",
          answer: "Management fees, fee offsets, hurdle, catch-up, and carry are read directly from Fund Management → Fund Economics. The Fee Schedule (Investment Period, Post-Investment, Wind-Down rows) drives the timing and amount of fees; Fees Start At and Fee Payment Timing decide when each fee is booked; Fee Offsets (deal fees, monitoring fees) reduce the LP-charged fee. Editing those settings instantly changes the GP forecast row and the LP net cash flow."
        },
        {
          question: "How does the LP forecast work?",
          answer: "Each LP's commitment is allocated pro-rata to the fund's capital calls and distributions. The LP Forecast Table shows historical (actual) flows already in the Cash Flow Ledger plus the LP's share of anticipated calls and distributions, ending with projected net cash flow, DPI, RVPI, and TVPI per LP. 'All funds' mode aggregates each LP across every fund they're committed to."
        },
        {
          question: "How does the GP forecast work?",
          answer: "The GP Forecast Row projects management fees collected (net of fee offsets), carried interest earned through the waterfall, and the resulting GP cash flow over time. It uses the same exit assumptions and pacing as the LP forecast so the two reconcile to the same fund cash flow chart."
        },
        {
          question: "What is the Anticipated Ledger?",
          answer: "The Anticipated Ledger is a line-level list of every projected flow the engine generated — capital calls, distributions, fees, and carry — with the OpCo, fund-level role, and date. It defaults to oldest → newest so you can read the forecast chronologically and double-click into any row to see why it was generated."
        },
        {
          question: "How does the Forecasting Cash Flow Ledger differ from the Reports Cash Flow Ledger?",
          answer: "The Cash Flow Ledger tab in Reports is the source-of-truth list of actual recorded fund cash flows. The Anticipated Ledger inside Forecasting is forward-looking projections built from exit assumptions, pacing, and fund economics. Both default to oldest → newest sort so they read in the same direction."
        }
      ],
      faqs: [
        {
          question: "An OpCo has no exit date — will it still appear in the forecast?",
          answer: "Yes. When 'Expected Exit Date' is blank, the forecast assumes an exit 5 years after that OpCo's earliest investment date. The projection is still generated end-to-end; set an explicit exit date in 'Investment Exit Assumptions' to override the default."
        },
        {
          question: "Why does turning Blind Pool on/off change my LP DPI?",
          answer: "Blind Pool On adds projected calls and distributions for not-yet-deployed commitment, which changes the LP's total projected cash flow and therefore DPI, RVPI, and TVPI. Toggle the assumption based on whether you want the as-invested view or the fully-deployed view."
        },
        {
          question: "I changed a fee in Fund Economics and the GP row didn't update.",
          answer: "Fund Economics changes are picked up on the next forecast recompute. Save the fund first, then return to Forecasting — the GP Forecast Row and the LP fee allocations will refresh against the new fee schedule and offsets."
        },
        {
          question: "Why don't the per-OpCo tables show in 'All funds' mode?",
          answer: "OpCo-level cash flows and the fund cash flow chart are inherently fund-specific. In 'All funds' mode the tab only renders the aggregated LP forecast and GP row — switch to 'This fund' to see OpCo and chart-level detail."
        }
      ]
    },
    {
      id: "operators",
      title: "Operators",
      icon: Building2,
      description: "Deep-dive into operating company performance across all dimensions",
      content: [
        {
          question: "What is the Operators section?",
          answer: "Operators provides a unified, company-focused view with four tabs: AI Insights, Financials, Operational Metrics, and Cybersecurity. Select a fund and operating company at the top — all tabs synchronize to show data for that company, eliminating redundant selections."
        },
        {
          question: "What are AI Insights?",
          answer: "AI Insights generates a comprehensive executive summary for the selected company, covering financial health, operational performance, cybersecurity posture, and actionable recommendations. Insights are persisted per company — they remain available when you return and only update when you click 'Regenerate'. A status badge indicates whether insights are up to date. An 'Ask AI' chat panel is available for follow-up questions."
        },
        {
          question: "What does the Financials tab show?",
          answer: "The Financials tab displays detailed financial analysis including revenue trends, margin analysis (gross margin, EBITDA margin), income statements, and dimensional breakdowns. If dimensional data is available (product, region, segment), you can analyze revenue contribution by each dimension."
        },
        {
          question: "What is Dimensional Analysis?",
          answer: "Dimensional Analysis breaks down financial metrics across dimensions such as Product, Region, and Segment. This helps you understand revenue drivers, identify top-performing products or regions, and spot underperformers at a granular level. Data is uploaded via the dimensional data upload feature in Data Ingestion."
        },
        {
          question: "What Operational Metrics are tracked?",
          answer: "Operational Metrics include: Customer metrics (NPS, retention rate, churn, customer feedback), Employee metrics (turnover, satisfaction, headcount), Supply chain metrics (on-time delivery, inventory turns, defect rate), Production metrics (OEE, system uptime), and ESG metrics (carbon emissions, energy usage, diversity). Trends are shown over time."
        },
        {
          question: "What is the Cybersecurity Dashboard?",
          answer: "The Cybersecurity Dashboard monitors security posture across portfolio companies, including: maturity scores, compliance scores, incident tracking (critical, high, medium, low), mean time to resolution (MTTR), vendor risk analysis, and historical trend charts. This helps assess and compare cyber risk exposure across the portfolio."
        }
      ],
      faqs: [
        {
          question: "How do I interpret the financial charts?",
          answer: "Revenue Trend displays total revenue progression over time. Margin Analysis compares gross margin and EBITDA margin percentages. Breakdown tables show contribution from each dimension (product, region, or segment)."
        },
        {
          question: "How does fund filtering work in Operators?",
          answer: "When you select a specific fund, the operating company dropdown filters to show only companies linked to that fund via fund investments. Select 'All Funds' to see all companies in your organization."
        },
        {
          question: "How do I link uploaded data to an entity?",
          answer: "When uploading files in Data Ingestion, you can select or create an entity. The AI will also suggest entity matches based on the file name and content."
        }
      ]
    },
    {
      id: "data-ingestion",
      title: "Data Ingestion",
      icon: Database,
      description: "Upload, process, and manage your data",
      content: [
        {
          question: "How do I upload files?",
          answer: "Navigate to Data Ingestion and select the 'Upload Agent' tab. Drag and drop files or click to browse. Supported formats include CSV and Excel (.xlsx, .xls). The system will automatically analyze your file structure, detect the data type, and map columns using AI."
        },
        {
          question: "What is AI Column Mapping?",
          answer: "When you upload a file, the AI analyzes column headers and sample data to automatically map your columns to the correct database fields (revenue, EBITDA, period dates, etc.). You can review and adjust the mappings before confirming. Confidence scores indicate how certain the AI is about each mapping."
        },
        {
          question: "What is the Data Catalog?",
          answer: "The Data Catalog shows all uploaded files, their processing status, linked entities, row counts, and metadata. You can track upload history, view AI-generated file summaries, filter by entity, and manage your data sources."
        },
        {
          question: "What is Data Quality monitoring?",
          answer: "The Data Quality section monitors data completeness, accuracy, and consistency. It flags potential issues like missing values, outliers, duplicate records, or inconsistent formats, helping you maintain clean and reliable data."
        },
        {
          question: "How does entity detection work?",
          answer: "The AI automatically detects what type of data you're uploading (portfolio company financials, fund performance, operational metrics, etc.) and suggests the appropriate entity to link it to. You can override the suggestion if needed."
        },
        {
          question: "Can I upload dimensional data?",
          answer: "Yes, you can upload financial data broken down by dimensions (product, region, segment). The system recognizes dimensional columns and maps them to the appropriate dimension tables, enabling drill-down analysis in the Operators section."
        }
      ],
      faqs: [
        {
          question: "What file formats are supported?",
          answer: "We support CSV files and Excel workbooks (.xlsx, .xls). Excel files can contain multiple sheets — you can select which sheet to import."
        },
        {
          question: "What happens if column mapping is incorrect?",
          answer: "You can review and manually adjust column mappings before confirming the upload. If data was imported incorrectly, you can re-upload with corrected mappings."
        }
      ]
    },
    
    {
      id: "analytics-charting",
      title: "Analytics / Charting",
      icon: Sparkles,
      description: "Generate custom charts and AI-powered analytics",
      content: [
        {
          question: "How do I generate a chart?",
          answer: "Use the Graph Generator to: (1) Select entities (companies, funds, GPs), (2) Choose data points/metrics, (3) Pick a chart type (bar, line, area, pie, etc.), (4) Set the time frame, and (5) Optionally add a style prompt to customize colors or styling. Click Generate to create your chart."
        },
        {
          question: "Can I save generated charts?",
          answer: "Yes, generated charts can be saved for future reference. Saved charts appear in the Saved Graphs section and can be pinned to specific pages (like Operators Financials or Operational Metrics) for quick access alongside your data."
        },
        {
          question: "What data points can I chart?",
          answer: "Data points are organized by category: Financial (revenue, EBITDA, margins, net income), Operational (NPS, retention, uptime, OEE), Fund Performance (IRR, MOIC, TVPI, NAV), and more. You can combine multiple data points in a single chart for comparison."
        },
        {
          question: "What AI features are available across the platform?",
          answer: "AI features include: Analytics Chat (natural language data queries), AI Column Mapping (file upload automation), GP Analysis (automated partner evaluation), Deal Analysis (thesis fit, investment memos), News Intelligence (portfolio company news monitoring), Company Research (business intelligence reports), Daily AI Review (portfolio summaries), Document Summarization, Project AI Chat, and Operators AI Insights. Many AI prompts are customizable in Organizational Settings."
        },
        {
          question: "Can I customize chart styling?",
          answer: "Yes, use the Style Prompt input to describe your desired styling — for example, 'Use dark blue and gold colors' or 'Minimalist design with rounded bars'. The AI will apply your styling preferences to the generated chart."
        }
      ],
      faqs: [
        {
          question: "How accurate is the AI analysis?",
          answer: "AI analyses are based on your actual data and use advanced language models. While highly accurate, always review AI suggestions and insights before making critical decisions. Confidence scores are provided where applicable."
        },
        {
          question: "Can I pin charts to other pages?",
          answer: "Yes, when saving a chart you can choose which page to pin it to (e.g., Operators Financials, Operational Metrics). Pinned charts appear in a Saved Graphs section on that page."
        }
      ]
    }
  ];

  const filteredSections = helpSections.filter(section => {
    if (!searchQuery) return true;
    const query = searchQuery.toLowerCase();
    return (
      section.title.toLowerCase().includes(query) ||
      section.description.toLowerCase().includes(query) ||
      section.content.some(item => 
        item.question.toLowerCase().includes(query) ||
        item.answer.toLowerCase().includes(query)
      ) ||
      section.faqs.some(faq =>
        faq.question.toLowerCase().includes(query) ||
        faq.answer.toLowerCase().includes(query)
      )
    );
  });

  const activeSection = helpSections.find(s => s.id === activeTab);

  return (
    <div className="container mx-auto py-6 space-y-6">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-3">
          <HelpCircle className="h-8 w-8 text-primary" />
          <div>
            <h1 className="text-3xl font-bold">Help Center</h1>
            <p className="text-muted-foreground">Learn how to use FactorIQ effectively</p>
          </div>
        </div>

        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="Search help topics..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-10"
          />
        </div>
      </div>

      {/* Tabbed Help Sections */}
      <Tabs value={activeTab} onValueChange={setActiveTab} className="w-full">
        <TabsList className="flex flex-col items-center w-full h-auto gap-0 bg-primary/10 p-1">
          {/* Row 1: Getting Started & FAQs */}
          <div className="flex justify-center w-full gap-1 mb-1">
            {filteredSections.filter(s => ["getting-started"].includes(s.id)).map((section) => (
              <TabsTrigger key={section.id} value={section.id} className="flex items-center gap-1.5 text-xs">
                <section.icon className="h-3.5 w-3.5" />
                {section.title}
              </TabsTrigger>
            ))}
            <TabsTrigger value="faqs" className="flex items-center gap-1.5 text-xs">
              <MessageCircle className="h-3.5 w-3.5" />
              FAQs
            </TabsTrigger>
          </div>
          {/* Row 2: Home through Daily AI Review */}
          <div className="flex justify-center w-full gap-1 mb-1">
            {filteredSections.filter(s => ["home", "organizational-settings", "deal-finder", "deal-manager", "portfolio-monitoring", "daily-ai-review"].includes(s.id)).map((section) => (
              <TabsTrigger key={section.id} value={section.id} className="flex items-center gap-1.5 text-xs">
                <section.icon className="h-3.5 w-3.5" />
                {section.title}
              </TabsTrigger>
            ))}
          </div>
          {/* Row 3: Projects through Analytics/Charting */}
          <div className="flex justify-center w-full gap-1">
            {filteredSections.filter(s => ["projects", "reports", "forecasting", "operators", "data-ingestion", "analytics-charting"].includes(s.id)).map((section) => (
              <TabsTrigger key={section.id} value={section.id} className="flex items-center gap-1.5 text-xs">
                <section.icon className="h-3.5 w-3.5" />
                {section.title}
              </TabsTrigger>
            ))}
          </div>
        </TabsList>

        {filteredSections.map((section) => (
          <TabsContent key={section.id} value={section.id}>
            <Card>
              <CardHeader>
                <div className="flex items-center gap-3">
                  <section.icon className="h-6 w-6 text-primary" />
                  <div>
                    <CardTitle>{section.title}</CardTitle>
                    <CardDescription>{section.description}</CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <Accordion type="single" collapsible className="w-full">
                  {section.content.map((item, index) => (
                    <AccordionItem key={index} value={`${section.id}-${index}`}>
                      <AccordionTrigger className="text-left hover:no-underline">
                        <span className="flex items-center gap-2">
                          <Lightbulb className="h-4 w-4 text-yellow-500 flex-shrink-0" />
                          {item.question}
                        </span>
                      </AccordionTrigger>
                      <AccordionContent className="text-muted-foreground pl-6">
                        {item.answer}
                        {(item as any).bullets && (
                          <ul className="list-disc pl-6 mt-2 space-y-1">
                            {(item as any).bullets.map((b: string, i: number) => (
                              <li key={i}>{b}</li>
                            ))}
                          </ul>
                        )}
                      </AccordionContent>
                    </AccordionItem>
                  ))}
                </Accordion>
              </CardContent>
            </Card>
          </TabsContent>
        ))}

        {/* FAQs Tab */}
        <TabsContent value="faqs">
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <MessageCircle className="h-6 w-6 text-primary" />
                <div>
                  <CardTitle>Frequently Asked Questions</CardTitle>
                  <CardDescription>Common questions organized by topic</CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-6">
              {helpSections.filter(s => s.faqs.length > 0).map((section) => (
                <div key={section.id}>
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3 flex items-center gap-2">
                    <section.icon className="h-4 w-4" />
                    {section.title}
                  </h3>
                  <Accordion type="single" collapsible className="w-full">
                    {section.faqs.map((faq, index) => (
                      <AccordionItem key={index} value={`faq-${section.id}-${index}`}>
                        <AccordionTrigger className="text-left hover:no-underline">
                          {faq.question}
                        </AccordionTrigger>
                        <AccordionContent className="text-muted-foreground">
                          {faq.answer}
                        </AccordionContent>
                      </AccordionItem>
                    ))}
                  </Accordion>
                </div>
              ))}
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Contact Support Form */}
      <Card>
        <CardContent className="p-6">
          <h3 className="text-lg font-semibold mb-1">Need more help?</h3>
          <p className="text-muted-foreground mb-4">
            Submit a question and our support team will get back to you.
          </p>
          <form onSubmit={async (e) => {
            e.preventDefault();
            const form = e.target as HTMLFormElement;
            const subject = (form.elements.namedItem('subject') as HTMLInputElement).value.trim();
            const message = (form.elements.namedItem('message') as HTMLTextAreaElement).value.trim();
            if (!subject || !message) return;
            
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) return;

            const { error } = await supabase.from('support_requests').insert({
              user_id: user.id,
              user_email: user.email || '',
              subject,
              message,
            });

            if (error) {
              setShowConfirmDialog(false);
              return;
            }
            
            form.reset();
            setShowConfirmDialog(true);
          }} className="space-y-3">
            <Input
              name="subject"
              placeholder="Subject"
              required
              maxLength={255}
            />
            <Textarea
              name="message"
              placeholder="Describe your question or issue..."
              required
              maxLength={2000}
              className="min-h-[100px]"
            />
            <Button type="submit" size="sm">
              Submit Question
            </Button>
          </form>
        </CardContent>
      </Card>

      <AlertDialog open={showConfirmDialog} onOpenChange={setShowConfirmDialog}>
        <AlertDialogContent className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle className="text-xl">You sent a question to Factor IQ</AlertDialogTitle>
            <AlertDialogDescription className="text-base">
              Someone on our team will address this as soon as possible.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogAction onClick={() => setShowConfirmDialog(false)}>OK</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
};

export default HelpPage;
