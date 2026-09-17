// Guided drafting: a document type's decision points, asked one at a time.
//
// The first message of a draft of such a type opens the firm's standard in
// the panel and asks the first question. Each answer is applied to the
// working copy as tracked changes, then the next question is asked. The
// order is chosen so that a question comes after the ones it depends on —
// whether a project is Qualified decides the approval chain and which forms
// of Government support can be offered; the revenue model decides whether
// revenue sharing arises; the financing source decides whether a benchmark
// rate or a financing mix is asked at all. A question an earlier answer
// settles is answered for the associate and applied with it; options an
// earlier answer rules out are not offered.
//
// The RFP questionnaire is AKLA's "Federal PPP RFP — Drafting Options
// Matrix" for Volume I (Tender Procedure) of the federal PPP standard.

const opt = (id, label, hint) => ({ id, label, ...(hint ? { hint } : {}) });
const is = (answers, questionId, ...optionIds) => (answers[questionId]?.optionIds ?? []).some((o) => optionIds.includes(o));
const answered = (answers, questionId) => !!answers[questionId] && !answers[questionId].skipped;

const RFP_FEDERAL_PPP = {
  key: "rfp_federal_ppp",
  name: "Federal PPP RFP — Volume I drafting decisions",
  closing:
    "That completes the drafting decisions. What remains are the project's own facts — Agency name and address, the Transaction Advisor, key dates (issue, pre-bid meeting, bid submission, openings, award, signing), submission addresses and portal links, and the numeric thresholds (net worth, average annual revenue, Bid Security %, Performance Security %, bid validity, litigation threshold, Consortium ownership caps). Give them to me in the chat, or point me at the project documents that hold them, and I will fill each [●].",
  questions: [
    // A. Structure
    {
      id: "modality", section: "Project structure", title: "PPP delivery modality",
      question: "Which PPP delivery modality will the Project use?",
      location: "Glossary \"Project\" definition (\"delivered under PPP mode on a [●] basis\"); General/Introduction (\"engage a private party on a PPP basis to [design, finance, build, operate and transfer / [●]] the Project\"); Bidding Forms T1 and F1 (\"Re: [Design, finance, build, operate and transfer / [●]] of … Project\")",
      basis: "Bracketed alternative in the RFP; modality menu per standard PPP taxonomy and ADB's Pakistan PPP Landscape note.",
      options: [
        opt("bot", "Build-Operate-Transfer (BOT)"),
        opt("boot", "Build-Own-Operate-Transfer (BOOT)"),
        opt("dbfot", "Design-Build-Finance-Operate-Transfer (DBFOT)", "The RFP's current default"),
        opt("dbfo", "Design-Build-Finance-Operate (DBFO)"),
        opt("dbfomt", "Design-Build-Finance-Operate-Maintain-Transfer (DBFOMT)"),
        opt("dbfm", "Design-Build-Finance-Maintain (DBFM)"),
      ],
    },
    {
      id: "term", section: "Project structure", title: "Term structure of the concession",
      question: "How is the concession term to be structured?",
      location: "\"Term\" clause — construction period of [●] and operating period of [●]",
      basis: "Numeric placeholders in the RFP; alternatives per standard concession drafting.",
      options: [
        opt("fixed", "Fixed term", "Fixed construction period + fixed operating period"),
        opt("performance", "Output/performance-linked term", "Extendable subject to KPI compliance"),
        opt("revenue", "Traffic/revenue-linked term", "Ends once a cumulative revenue/traffic target is reached — common for toll roads"),
        opt("rolling", "Rolling/renewable term", "Subject to periodic Agency review"),
      ],
    },

    // Status and approvals — decides the approval chain and the support on offer.
    {
      id: "qualified", section: "Status and approvals", title: "Qualified / non-Qualified Project",
      question: "Is this a Qualified Project under the P3A Act?",
      location: "\"Government Support\" section introduction; approval-chain references throughout",
      basis: "Section 2(v), P3A Act 2017.",
      options: [
        opt("qualified", "Qualified Project", "Support required (VGF / Sovereign Guarantee / PDF) or so designated by the P3WP — the full P3WP → P3A Board → CDWP → ECNEC chain applies"),
        opt("non_qualified", "Non-Qualified Project", "Procured solely under the PPRA Rules; no P3A approval chain"),
      ],
    },
    {
      id: "approval_chain", section: "Status and approvals", title: "Regulatory approval chain",
      question: "For a non-Qualified Project, what should happen to the \"Regulatory Approvals and Compliance\" approval chain?",
      location: "\"Regulatory Approvals and Compliance\" section; \"Qualified Project Approval Chain\"",
      basis: "Mandatory for Qualified Projects; removable with legal sign-off for a non-Qualified federal PPP procured solely under the PPRA Rules.",
      auto: (a) => (is(a, "qualified", "qualified") ? "retain" : null),
      options: [
        opt("delete", "Delete the approval chain", "With legal sign-off — procured solely under the PPRA Rules"),
        opt("retain", "Retain the full chain", "P3WP → P3A Board → CDWP → ECNEC"),
      ],
    },
    {
      id: "pcp_step", section: "Status and approvals", title: "Project Concept Proposal approval step",
      question: "Should the optional Project Concept Proposal approval step be kept in the approval chain?",
      location: "\"Qualified Project Approval Chain\", item (a): \"[Project Concept Proposal (optional) approved by the P3WP…]\"",
      basis: "Optional under section 13A(2)(a), P3A Act.",
      appliesWhen: (a) => !is(a, "approval_chain", "delete"),
      options: [
        opt("include", "Include it", "Keep the Project Concept Proposal as a discrete approval step"),
        opt("omit", "Omit it", "Proceed directly to the Project Qualification Proposal"),
      ],
    },

    // Procurement
    {
      id: "method", section: "Procurement", title: "Method of procurement",
      question: "Which method of procurement applies?",
      location: "\"Tender Procedure\" introductory clause",
      basis: "Rules 14 and 20, PPRA Rules 2004.",
      options: [
        opt("open", "Open competitive bidding", "Rule 20, PPRA Rules — the RFP's default"),
        opt("restricted", "Restricted / limited tendering", "Rule 14 exception — requires prior PPRA approval"),
        opt("direct", "Direct contracting", "Only for IFI transaction advisers under the 2023 Regulations — not for the main procurement"),
      ],
    },
    {
      id: "competition", section: "Procurement", title: "Competitive bidding basis",
      question: "Is the tender national or international? (This sets the minimum notice period.)",
      location: "Indicative Schedule footnote (\"not less than [thirty (30)] days … international competitive bidding … or not less than [fifteen (15)] days for a national competitive bidding\"); Publication and Advertisement clause",
      basis: "Rule 13(1), PPRA Rules.",
      options: [
        opt("icb", "International competitive bidding", "Minimum 30 days' notice; publication may extend to international platforms via MOFA / SIFC / BOI"),
        opt("ncb", "National competitive bidding", "Minimum 15 days' notice"),
        opt("hybrid", "National, with international outreach", "Where foreign private parties are to be invited"),
      ],
    },
    {
      id: "procedure", section: "Procurement", title: "Bidding procedure",
      question: "Which bidding procedure will be used?",
      location: "Data Sheet item 6: \"Bidding procedure [Single Stage Two Envelope / adopted [●]]\"",
      basis: "Rules 36 and 37(a), PPRA Rules.",
      options: [
        opt("ss1e", "Single-stage one-envelope"),
        opt("ss2e", "Single-stage two-envelope", "The firm's default for PPP concessions"),
        opt("ts", "Two-stage bidding"),
        opt("ts2e", "Two-stage two-envelope"),
      ],
    },
    {
      id: "submission", section: "Procurement", title: "Bid submission mechanism",
      question: "How will bids be submitted?",
      location: "\"Preparation of Bids\" clause (\"[simultaneously through [the PPRA/Agency e-procurement portal, where used] / by …]\"); Data Sheet item 10",
      basis: "Rule 22, PPRA Rules; PPRA e-procurement regulations.",
      options: [
        opt("physical", "Physical sealed bids", "Rule 22, PPRA Rules"),
        opt("eprocurement", "e-Procurement platform", "Cite the PPRA e-procurement regulation relied on"),
        opt("hybrid", "Electronic, with physical originals as backup"),
      ],
    },

    // Revenue
    {
      id: "revenue_model", section: "Revenue", title: "Revenue / compensation structure",
      question: "How will the Concessionaire be paid?",
      location: "\"Compensation of Concessionaire\" clause (\"structured on a [revenue/availability-payment/hybrid] model … [levy and collect Revenues from users / receive availability payments from the Agency / [●]]\")",
      basis: "Regulation 9(2)(b), Process Flow Regulations 2021.",
      options: [
        opt("user_pays", "User-pays / toll revenue"),
        opt("availability", "Availability payments", "Paid by the Agency regardless of usage"),
        opt("hybrid", "Hybrid", "Base availability payment + revenue/traffic-linked top-up"),
        opt("shadow_toll", "Shadow toll", "Agency pays per user/vehicle; users pay nothing"),
        opt("annuity", "Annuity / hybrid annuity model (HAM)"),
        opt("gpu", "Government payment for use / capacity charge"),
      ],
    },
    {
      id: "revenue_sharing", section: "Revenue", title: "Revenue-sharing mechanism",
      question: "Should the Government share in revenue above a threshold?",
      location: "\"Compensation of Concessionaire\" clause (\"thresholds and sharing ratios to be inserted as placeholders: [●]% / [●]%\")",
      basis: "Placeholder in the RFP; standard concession revenue-share drafting.",
      auto: (a) => (answered(a, "revenue_model") && !is(a, "revenue_model", "user_pays", "hybrid") ? "none" : null),
      options: [
        opt("none", "No revenue sharing"),
        opt("single", "Single threshold", "Revenue above a target shared at a fixed ratio"),
        opt("tiered", "Tiered / banded", "Several thresholds, rising Government share"),
        opt("guarantee_upside", "Minimum guaranteed return with upside sharing"),
      ],
    },
    {
      id: "escalation", section: "Revenue", title: "Tariff / payment escalation",
      question: "How should the tariff or payments escalate over the term?",
      location: "Terms of Reference (\"escalation percentages … O&M cost caps\")",
      basis: "Flagged as project-specific in the standard's AKLA comments.",
      options: [
        opt("fixed", "Fixed annual percentage"),
        opt("cpi", "CPI-indexed"),
        opt("wpi", "WPI-indexed"),
        opt("none", "No escalation", "Fixed tariff/payment for the term"),
      ],
    },

    // Support and financing
    {
      id: "support", section: "Government support and financing", title: "Federal Government support",
      question: "Which forms of Federal Government support are on offer? Select all that apply.",
      multi: true,
      location: "\"Government Support\" clause, items (a)–(d)",
      basis: "Sections 11 and 12, P3A Act; Chapter IV, Federal PPP Policy 2023–2028.",
      options: [
        opt("pdf", "Project Development Facility (PDF)", "Section 12, P3A Act"),
        opt("vgf", "Viability Gap Fund (VGF)", "Section 11, P3A Act"),
        opt("sovereign_guarantee", "Sovereign guarantee", "Per the Finance Division procedure"),
        opt("mrg", "Minimum revenue guarantee (MRG)"),
        opt("equity", "Government equity contribution", "e.g. Class B equity in the SPV"),
        opt("subdebt", "Subordinated debt from Government"),
        opt("assets", "Asset-based support", "Land, right of way"),
        opt("administrative", "Administrative support", "Licences, clearances, utility relocation"),
        opt("none", "No Government support", "Fully self-financed PPP"),
      ],
      // A non-Qualified Project takes none of the P3A instruments; a minimum
      // revenue guarantee only means something where the Concessionaire
      // carries revenue risk.
      filter: (o, a) =>
        !(is(a, "qualified", "non_qualified") && ["pdf", "vgf", "sovereign_guarantee"].includes(o.id)) &&
        !(o.id === "mrg" && answered(a, "revenue_model") && !is(a, "revenue_model", "user_pays", "hybrid")),
      exclusive: ["none"],
    },
    {
      id: "financing_source", section: "Government support and financing", title: "Primary source of financing",
      question: "How will the Project be financed?",
      location: "\"Financing\" clause (\"financed through a combination of [equity, [Federal Government support, if applicable,] and commercial debt]\")",
      basis: "Bracketed alternative in the RFP.",
      options: [
        opt("debt_only", "Commercial debt only", "No fresh sponsor equity — e.g. leveraged brownfield refinancing"),
        opt("equity_only", "Sponsor equity only", "No external debt"),
        opt("debt_equity", "Commercial debt + sponsor equity", "Standard project finance, e.g. 70:30 or 80:20"),
        opt("equity_support", "Sponsor equity + Government support", "Class B equity / sub-debt / MRG; little or no commercial debt"),
        opt("dfi_equity", "Multilateral/DFI debt + sponsor equity"),
        opt("none", "No external financing", "Government-funded; the private party contributes services only"),
      ],
      filter: (o, a) => !(o.id === "equity_support" && is(a, "support", "none")),
    },
    {
      id: "financing_mix", section: "Government support and financing", title: "Financing mix",
      question: "What is the composition of the blended financing?",
      location: "\"Financing\" clause (\"[equity, [Federal Government support, if applicable,] and commercial debt]\")",
      basis: "Bracketed alternative in the RFP.",
      appliesWhen: (a) => is(a, "financing_source", "debt_equity", "dfi_equity"),
      options: [
        opt("equity_debt", "Equity + commercial debt", "No Government support"),
        opt("equity_debt_support", "Equity + commercial debt + Government support", "Class B equity / sub-debt / MRG"),
        opt("equity_islamic_debt", "Equity + Islamic (Shariah-compliant) financing + commercial debt"),
        opt("equity_dfi_debt", "Equity + multilateral/DFI debt + commercial debt", "Blended finance"),
      ],
      filter: (o, a) => !(o.id === "equity_debt_support" && is(a, "support", "none")),
    },
    {
      id: "currency", section: "Government support and financing", title: "Currency of bid and payment",
      question: "Which currencies may the bid and payments be in?",
      location: "\"Currencies of Bid and Payment\" clause (\"state all monetary amounts in Pakistani Rupees (PKR), unless the Data Sheet permits a different currency …\")",
      basis: "Conditional wording in the RFP.",
      options: [
        opt("pkr", "PKR only"),
        opt("pkr_fx_items", "PKR, with foreign currency for specified line items", "e.g. imported plant, foreign debt service"),
        opt("dual", "Dual-currency bid", "PKR + one nominated foreign currency (e.g. USD) for the whole Financial Proposal"),
      ],
    },
    {
      id: "benchmark", section: "Government support and financing", title: "Benchmark interest rate",
      question: "What benchmark should the financial model's debt be priced on?",
      location: "Financial Proposal / Terms of Reference (\"KIBOR/benchmark rate … workings\")",
      basis: "Flagged as project-specific in the standard's AKLA comments.",
      appliesWhen: (a) => !is(a, "financing_source", "equity_only", "none"),
      options: [
        opt("kibor", "KIBOR + spread", "PKR debt"),
        opt("sofr", "SOFR + spread", "Foreign-currency debt"),
        opt("fixed", "Fixed rate"),
        opt("pkrv", "PKRV-linked"),
      ],
    },

    // Bidders and evaluation
    {
      id: "bidder_structure", section: "Bidders and evaluation", title: "Bidder structure",
      question: "Who may bid?",
      location: "\"Consortium / Consortium Member\" glossary entries; Eligibility Criteria",
      basis: "Structure in the RFP; carve-out flagged in the standard's AKLA comments.",
      options: [
        opt("single", "Single entities only", "No consortia"),
        opt("consortium", "Consortia permitted", "Lead Member + Members, with a cap on the number of Members"),
        opt("consortium_epc", "Consortia, with separate EPC Contractor qualification"),
        opt("consortium_soe", "Consortia, with a foreign/state-owned-enterprise carve-out", "From the conflict-of-interest rules"),
      ],
    },
    {
      id: "epc", section: "Bidders and evaluation", title: "EPC / delivery contractor",
      question: "Is a separate EPC or delivery contractor required?",
      location: "Annexure A: \"Eligibility Criteria for EPC Contractor / Delivery Partner Only (where the delivery model contemplates a separate EPC/delivery contractor)\"",
      basis: "Conditional bracket in Annexure A.",
      auto: (a) => (is(a, "bidder_structure", "consortium_epc") ? "required" : null),
      options: [
        opt("required", "Required", "Nominated within the Consortium, with its own eligibility criteria"),
        opt("self_perform", "Not required", "The Bidder / Lead Member self-performs construction"),
        opt("optional", "Permitted but optional", "At the Bidder's election"),
      ],
    },
    {
      id: "capability_label", section: "Bidders and evaluation", title: "Technical evaluation category",
      question: "How should the 60-mark capability category in the technical evaluation be labelled?",
      location: "Annexure B, Part 1 marking table: \"B) [Construction/Delivery] Capability — [60] marks\"",
      basis: "Bracketed alternative in the RFP.",
      options: [
        opt("construction", "Construction Capability", "Works-heavy infrastructure"),
        opt("delivery", "Delivery Capability", "Service or non-construction PPPs — digital, social infrastructure"),
        opt("technical", "Technical Capability", "Generic label covering both"),
      ],
    },
    {
      id: "revenue_basis", section: "Bidders and evaluation", title: "Net worth / average annual revenue basis",
      question: "Should the financial eligibility test use construction revenue or sector revenue?",
      location: "\"Net Worth and Average Annual [Construction/Sector] Revenue of not less than PKR [●]\"",
      basis: "Bracketed alternative in the RFP.",
      auto: (a) => (is(a, "capability_label", "construction") ? "construction" : is(a, "capability_label", "delivery") ? "sector" : null),
      options: [
        opt("construction", "Construction revenue", "Civil-works-heavy sectors"),
        opt("sector", "Sector-specific revenue", "e.g. IT/digital, social infrastructure, energy"),
      ],
    },
    {
      id: "scoring", section: "Bidders and evaluation", title: "Technical qualification scoring",
      question: "How should bidders be technically qualified?",
      location: "\"In order to be technically qualified, the Bidder must: (i) score at least [●]% in each category …; (ii) achieve an overall score of not less than [●] …\"",
      basis: "Bracketed thresholds in the RFP.",
      options: [
        opt("per_category", "Minimum per category + minimum overall score", "The RFP's current default"),
        opt("weighted", "Weighted scoring, no per-category minimum"),
        opt("pass_fail", "Pass/fail against a checklist", "No numerical scoring"),
        opt("combined", "Combined technical + financial score at a single stage"),
      ],
    },
    {
      id: "award", section: "Bidders and evaluation", title: "Bid award criterion",
      question: "On what basis is the winning bid chosen?",
      location: "Financial Evaluation Criteria (Annexure B, Part 2); Bidding Form F2",
      basis: "Flagged in the standard's AKLA comments.",
      auto: (a) => (is(a, "scoring", "combined") ? "combined" : null),
      options: [
        opt("lowest_cost", "Lowest pre-estimated project cost", "The PTQ precedent's legacy criterion"),
        opt("lowest_tariff", "Lowest tariff / toll to users"),
        opt("highest_share", "Highest revenue share to Government"),
        opt("combined", "Combined technical/financial weighted score"),
        opt("highest_npv", "Highest NPV of payments to Government"),
        opt("lowest_vgf", "Lowest subsidy / VGF requested"),
      ],
      filter: (o, a) =>
        !(o.id === "lowest_tariff" && answered(a, "revenue_model") && !is(a, "revenue_model", "user_pays", "hybrid", "shadow_toll")) &&
        !(o.id === "highest_share" && answered(a, "revenue_model") && !is(a, "revenue_model", "user_pays", "hybrid")) &&
        !(o.id === "lowest_vgf" && answered(a, "support") && !is(a, "support", "vgf")) &&
        !(o.id === "combined" && is(a, "scoring", "pass_fail")),
    },

    // Securities
    {
      id: "bid_security", section: "Securities", title: "Bid security",
      question: "What form of bid security is required?",
      location: "\"Bid Security\" clause",
      basis: "Rule 25 and its proviso, PPRA Rules.",
      options: [
        opt("bank_guarantee", "Unconditional bank guarantee", "Up to 5% of estimated Project value — Rule 25"),
        opt("declaration", "Bid-securing declaration", "No bank guarantee — proviso to Rule 25"),
        opt("insurance_bond", "Insurance-backed bid bond"),
        opt("cash", "Cash deposit / pay order"),
      ],
    },
    {
      id: "f4", section: "Securities", title: "Financing evidence at bid stage (Form F4)",
      question: "Should bidders provide evidence of financing (an indicative term sheet or letter of intent) with their bid?",
      location: "Bidding Form F4 — Indicative Term Sheet / Letter of Intent",
      basis: "Flagged in the standard's AKLA comments.",
      auto: (a) => (is(a, "financing_source", "none", "equity_only") ? "not_used" : null),
      options: [
        opt("required", "Required", "Keep Form F4 in template form"),
        opt("not_used", "Not required", "Mark Form F4 \"Not Used\""),
      ],
    },

    // Environment, land and utilities
    {
      id: "environment", section: "Environment, land and utilities", title: "Applicable environmental legislation",
      question: "Which environmental legislation applies?",
      location: "Site visit clause (\"Applicable Laws (including applicable federal or provincial environmental legislation)\"); Environmental and Social Matters clause",
      basis: "Flagged in the standard's AKLA comments.",
      options: [
        opt("federal", "Pakistan Environmental Protection Act, 1997", "Federal"),
        opt("provincial", "The relevant provincial Environmental Protection Act", "Sindh / Punjab / KP / Balochistan — per the Project's location"),
        opt("both", "Both federal and provincial"),
        opt("both_esms", "Statutory regime plus the P3A ESMS", "P3A Environmental and Social Management System"),
      ],
    },
    {
      id: "land_handover", section: "Environment, land and utilities", title: "Land handover",
      question: "How will the Project Site be handed over?",
      location: "\"Land Acquisition and Right of Way\" clause",
      basis: "Flagged in the standard's AKLA comments.",
      options: [
        opt("before_close", "Full vacant possession before Financial Close"),
        opt("phased", "Phased handover during construction"),
        opt("assisted", "Concessionaire-assisted acquisition, reimbursed by the Agency"),
      ],
    },
    {
      id: "resettlement", section: "Environment, land and utilities", title: "Resettlement Action Plan",
      question: "Is a Resettlement Action Plan required?",
      location: "\"Land Acquisition and Right of Way\" clause",
      basis: "Flagged in the standard's AKLA comments.",
      options: [
        opt("rap", "Yes — involuntary resettlement is involved"),
        opt("no_rap", "No — the site is vacant, unencumbered Government land"),
      ],
    },
    {
      id: "utilities", section: "Environment, land and utilities", title: "Utility relocation cost",
      question: "Who bears the cost of relocating utilities?",
      location: "\"Utility Relocation\" clause (\"confirmed in the Data Sheet: [●]\")",
      basis: "Placeholder in the RFP.",
      options: [
        opt("agency", "The Agency, in full"),
        opt("concessionaire", "The Concessionaire, in full"),
        opt("shared", "Shared / cost-reimbursable"),
      ],
    },

    // Performance
    {
      id: "kpis", section: "Performance monitoring", title: "Source of KPIs and penalties",
      question: "Where will the KPIs and performance penalties be set out?",
      location: "\"Key Performance Indicators\" clause (\"set out in the [O&M Manual / Service Level Agreement]\")",
      basis: "Bracketed alternative in the RFP.",
      options: [
        opt("om_manual", "O&M Manual", "Standalone technical document"),
        opt("sla", "Service Level Agreement", "A schedule to the Concession Agreement"),
        opt("both", "O&M Manual and SLA"),
        opt("in_ca", "A KPI schedule in the Concession Agreement itself"),
      ],
    },
  ],
};

export const QUESTIONNAIRES = { [RFP_FEDERAL_PPP.key]: RFP_FEDERAL_PPP };

/** The question as the associate sees it: only the options still open. */
function present(q, answers, index, total) {
  const options = q.filter ? q.options.filter((o) => q.filter(o, answers)) : q.options;
  return {
    id: q.id, section: q.section, title: q.title, question: q.question, multi: !!q.multi,
    exclusive: q.exclusive ?? [], options, index, total,
  };
}

/**
 * From the answers so far: the questions that settle themselves next (to be
 * applied with the answer just given) and the next question to ask, or
 * null when there is none left.
 */
export function advance(questionnaire, answers) {
  const next = { ...answers };
  const autos = [];
  const relevant = questionnaire.questions.filter((q) => !q.appliesWhen || q.appliesWhen(next));
  for (const q of questionnaire.questions) {
    if (next[q.id]) continue;
    if (q.appliesWhen && !q.appliesWhen(next)) continue;
    const auto = q.auto?.(next);
    if (auto) {
      const option = q.options.find((o) => o.id === auto);
      next[q.id] = { optionIds: [auto], labels: [option.label], auto: true };
      autos.push({ question: q, optionIds: [auto] });
      continue;
    }
    const position = relevant.findIndex((r) => r.id === q.id) + 1;
    return { answers: next, autos, pending: present(q, next, position, relevant.length) };
  }
  return { answers: next, autos, pending: null };
}

export function startQuestionnaire(questionnaire) {
  const { answers, pending } = advance(questionnaire, {});
  return { key: questionnaire.key, answers, pending, done: !pending };
}

/** Checks an answer against the question asked; returns its labels or an error. */
export function readAnswer(questionnaire, state, answer) {
  const q = questionnaire.questions.find((x) => x.id === state?.pending?.id);
  if (!q || answer?.questionId !== q.id) return { error: "That question is no longer the one being asked. Reload the chat." };
  if (answer.skip) return { question: q, optionIds: [], labels: [], skip: true };
  const open = new Set((state.pending.options ?? []).map((o) => o.id));
  const ids = Array.isArray(answer.optionIds) ? [...new Set(answer.optionIds.map(String))] : [];
  if (!ids.length || ids.some((id) => !open.has(id))) return { error: "Choose one of the options offered." };
  if (!q.multi && ids.length > 1) return { error: "Choose one option." };
  if (q.exclusive?.some((x) => ids.includes(x)) && ids.length > 1) return { error: "That option cannot be combined with the others." };
  return { question: q, optionIds: ids, labels: ids.map((id) => q.options.find((o) => o.id === id).label) };
}

function describeChoice(question, optionIds) {
  const chosen = optionIds.map((id) => question.options.find((o) => o.id === id)).filter(Boolean);
  const rejected = question.options.filter((o) => !optionIds.includes(o.id));
  return [
    `DECISION: ${question.title}`,
    `WHERE IT SITS IN THE RFP: ${question.location}`,
    `CHOSEN: ${chosen.map((o) => `${o.label}${o.hint ? ` (${o.hint})` : ""}`).join("; ")}`,
    `NOT CHOSEN: ${rejected.map((o) => o.label).join("; ")}`,
    `BASIS: ${question.basis}`,
  ].join("\n");
}

/** The instruction for one answer turn: the decision given, and any it settled. */
export function answerInstruction(decisions, answers) {
  const earlier = Object.entries(answers)
    .filter(([, v]) => !v.skipped && v.labels?.length)
    .map(([id, v]) => `- ${id}: ${v.labels.join("; ")}`)
    .join("\n");
  return `APPLY ${decisions.length === 1 ? "THIS DRAFTING DECISION" : "THESE DRAFTING DECISIONS"} TO THE RFP. The associate is working through the firm's drafting options questionnaire one decision at a time; each answer is applied to the working copy as tracked changes.

${decisions.map((d) => describeChoice(d.question, d.optionIds)).join("\n\n")}

How to apply it:
- Make every change the choice requires, wherever it reaches — the clause named above, the Data Sheet, the Glossary, the Bidding Forms and annexures, and any other clause that depends on it. Search the document for the bracketed alternative and resolve it: keep the chosen wording, remove the brackets and the alternatives not chosen.
- Where the choice makes a clause, form or annexure inapplicable, delete it or mark it "Not Used" in the way the RFP already does for others.
- Where the choice needs wording the RFP does not yet have (a mechanism, a procedure, a cross-reference to the Rule or section it rests on), draft it in the RFP's own style, briefly.
- Where the choice needs a project-specific figure or date, leave [●].
- Put one AKLA comment on the main clause changed, stating the choice and its legal basis.
- Change nothing else: no restyling, no rewording of unrelated clauses, no changes that belong to other decisions.
- Keep consistent with the decisions already made:
${earlier || "- (none yet)"}

If the relevant paragraphs are not in the listing, request them with the read protocol before giving ops. Reply with one or two sentences saying what you changed and where, then the ops block.`;
}
