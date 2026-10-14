# Fill map

Every blank in the master, generated from `scripts/read_template.py`. Regenerate with
`python3 scripts/read_template.py <template> --inventory` after any change to the master.

Blanks are keyed by **variable**: one value fills every slot bound to it. The role says how
the build spells the value in that slot ("thirty (30)", "PKR 1,000,000 (Pakistani Rupees One
Million only)"). A slot with no variable is addressed by its id in the `slots:` section.

## Variables

| Variable | Zone | Slots | Roles | Context |
|---|---|---|---|---|
| `ia_contract_period` | Article: Conditions | 2 | text | Independent Auditor with the counterparties to such contract, within ␣ of the Ef |
| `ie_contract_period` | Article: Conditions | 2 | text | Independent Engineer with the counterparties to such contract, within ␣ of the E |
| `bid_submission_date` | Article: Definitions & Interpret | 1 | text | of the Sponsor with respect to the Project submitted to the Agency on ␣; |
| `sponsor_names` | Article: Definitions & Interpret | 1 | text | Sponsor(s) means␣; |
| `relief_costs_trigger` | Article: Relief Extensions & Rel | 1 | text | led to Relief Costs only for any delays that directly result from the ␣ and as a |
| `agency_name` | Preamble | 3 | text | By & Between ␣  (As The Agency) |
| `agency_office` | Preamble | 1 | text | [•] having its offices at ␣ for and on behalf of the [•] (the Agency); |
| `concessionaire_name` | Preamble | 3 | text | And ␣  (As The Concessionaire) |
| `concessionaire_office` | Preamble | 1 | text | Applicable Laws of Pakistan, having its registered office located at ␣ (the Conc |
| `cover_date` | Preamble | 1 | text | Dated: as of ␣ |
| `execution_day` | Preamble | 1 | text | This ‘Concession Agreement’ (this Agreement) is entered into on this ␣ of [Month |
| `execution_month` | Preamble | 1 | text | cession Agreement’ (this Agreement) is entered into on this [Date] of ␣, [Year]  |
| `execution_place` | Preamble | 1 | text | (this Agreement) is entered into on this [Date] of [Month], [Year] at ␣, Pakista |
| `execution_year` | Preamble | 1 | text | greement’ (this Agreement) is entered into on this [Date] of [Month], ␣ at [Loca |
| `government_name` | Preamble | 1 | text | [•] having its offices at [•] for and on behalf of the ␣ (the Agency); |
| `project_name` | Preamble | 1 | text | In Respect Of ␣ Dated: as of _________________ |
| `change_of_scope_advance_pct` | Schedule B (Specific Definitions | 2 | pct_numeral, pct_words | Change Of Scope Advance Percentage  means ␣ percent ([●]%) of the Additional Cos |
| `change_of_scope_limit_pct` | Schedule B (Specific Definitions | 1 | pct_numeral | Change Of Scope Limit means ␣% of the Total Project Cost, being the maximum aggr |
| `concession_years` | Schedule B (Specific Definitions | 2 | numeral, words | e date on which the Concession Period expires, being the date falling ␣ ([●]) ye |
| `daily_development_damages_pct` | Schedule B (Specific Definitions | 1 | pct_numeral | Daily Development Period Damages  means ␣% of the Development Performance Securi |
| `development_damages_cap_pct` | Schedule B (Specific Definitions | 1 | pct_numeral | Development Period Damages Cap means ␣% of the Total Project Cost, being the max |
| `development_reporting_frequency` | Schedule B (Specific Definitions | 2 | numeral, words | terval applicable during the Development Period, being a frequency of ␣ ([●]) [d |
| `dps_expiry_months` | Schedule B (Specific Definitions | 1 | numeral | Development Performance Security Expiry Date means the date falling ␣ months fol |
| `dps_pct_of_project_cost` | Schedule B (Specific Definitions | 2 | pct_numeral, pct_words | g) acceptable to the Agency, of an amount in Pakistani Rupee equal to ␣ per cent |
| `dps_pre_commencement_pkr` | Schedule B (Specific Definitions | 2 | money_numeral, money_words | y, of an amount, in Pakistani Rupee, equal to the bid security or PKR ␣ (Pakista |
| `environmental_agency` | Schedule B (Specific Definitions | 1 | text | e Project Site and the Project in the Project Jurisdiction, being the ␣, and any |
| `equity_irr_pct` | Schedule B (Specific Definitions | 1 | pct_full | Equity IRR means the post-tax internal rate of return, the same being ␣, on the  |
| `fy_end` | Schedule B (Specific Definitions | 1 | text | the period of twelve (12) months commencing on [1 July] and ending on ␣ of each  |
| `fy_start` | Schedule B (Specific Definitions | 1 | text | Concessionaire, being the period of twelve (12) months commencing on ␣ and endin |
| `indemnity_survival_years` | Schedule B (Specific Definitions | 2 | numeral, words | Indemnity Survival Period means the period of ␣ ([●]) years commencing from and  |
| `max_extension_years` | Schedule B (Specific Definitions | 2 | numeral, words | Maximum Extension Period  means an aggregate period not exceeding ␣ ([●]) years  |
| `min_credit_rating` | Schedule B (Specific Definitions | 1 | text | Minimum Credit Rating means a long-term credit rating of at least ␣ as rated by  |
| `min_indemnification_pkr` | Schedule B (Specific Definitions | 2 | money_numeral, money_words | Minimum Indemnification Amount  means PKR ␣ (Pakistani Rupees [●]), being the ag |
| `om_ps_escalation_pct` | Schedule B (Specific Definitions | 1 | pct_numeral | r an amount equal to PKR [•] (Pakistani Rupees [•] only) escalated at ␣% per ann |
| `om_ps_floor_pkr` | Schedule B (Specific Definitions | 2 | money_numeral, money_words | ) of the O&M Costs for the Operational Year or an amount equal to PKR ␣ (Pakista |
| `om_ps_pct_of_om_costs` | Schedule B (Specific Definitions | 2 | pct_numeral, pct_words | dit Rating) acceptable to the GoS Agency, being in an amount equal to ␣ ([•]%) o |
| `om_reporting_frequency` | Schedule B (Specific Definitions | 2 | numeral, words | nterval applicable during the Operations Period, being a frequency of ␣ ([●]) [d |
| `project_city` | Schedule B (Specific Definitions | 1 | text | Project Jurisdiction means [Karachi / ␣, Province of Sindh, Islamic Republic of  |
| `project_modality` | Schedule B (Specific Definitions | 1 | text | oject Modality means the specific project delivery framework, being a ␣ basis, u |
| `province_name` | Schedule B (Specific Definitions | 2 | text | Agency means the Government of ␣, its respective departments or any other author |
| `rating_agency_1` | Schedule B (Specific Definitions | 1 | text | Rating means a long-term credit rating of at least [AA-] as rated by ␣ or an equ |
| `rating_agency_2` | Schedule B (Specific Definitions | 1 | text | ng of at least [AA-] as rated by [JCR-VIS] or an equivalent rating by ␣; |
| `scheduled_commencement_days` | Schedule B (Specific Definitions | 1 | numeral | Scheduled Commencement Date  means the date falling ␣ days after the Effective D |
| `scheduled_completion_months` | Schedule B (Specific Definitions | 1 | numeral | Scheduled Substantial Completion Date  means the date falling ␣ months after the |
| `site_right_period` | Schedule B (Specific Definitions | 2 | numeral, words | Project Site Land Instrument Right Period  means a period of ␣ ([●]) [years/mont |
| `specific_undertaking` | Schedule B (Specific Definitions | 1 | text | Specific Concessionaire Undertaking  means ␣; |
| `specified_permits_qualifier` | Schedule B (Specific Definitions | 1 | text | the Concessionaire has obtained the Specified Concessionaire Permits ␣; and |
| `sponsor_base_equity_pkr` | Schedule B (Specific Definitions | 2 | money_numeral, money_words | ty Amount  means the amount set out in the Financial Model, being PKR ␣ (Pakista |
| `step_in_rights_text` | Schedule L (Financing Matters) | 1 | text | F.   Step In Rights ␣ Schedule M – Form Of O&M Performance Security |
| `agency_funding_amount_pkr` | Schedule P (Equity Matters) | 2 | money_numeral, money_words | Agency Funding Amount means an amount not exceeding PKR ␣/- (Pakistani Rupees [● |
| `band1_agency_pct` | Schedule R (Revenue Matters) | 1 | pct_sign | [●]% — insert from Financial Model ␣ Band 2: 120–150% of Base Revenue |
| `band1_concessionaire_pct` | Schedule R (Revenue Matters) | 1 | pct_sign | Band 1: 100–120% of Base Revenue ␣ [●]% — insert from Financial Model |
| `band2_agency_pct` | Schedule R (Revenue Matters) | 1 | pct_sign | [●]% — insert from Financial Model ␣ Band 3: >150% of Base Revenue |
| `band2_concessionaire_pct` | Schedule R (Revenue Matters) | 1 | pct_sign | Band 2: 120–150% of Base Revenue ␣ [●]% — insert from Financial Model |
| `band3_agency_pct` | Schedule R (Revenue Matters) | 1 | pct_sign | [●]% — insert from Financial Model ␣ Schedule S – Notices |
| `band3_concessionaire_pct` | Schedule R (Revenue Matters) | 1 | pct_sign | Band 3: >150% of Base Revenue ␣ [●]% — insert from Financial Model |
| `cp_failure_agency_pct` | Schedule T (Termination Payments | 1 | pct_full | Agency CP Failure Termination Amount ␣ of the Approved Pre-Commencement Costs |
| `cp_failure_concessionaire_pct` | Schedule T (Termination Payments | 1 | pct_full | Concessionaire CP Failure Termination Amount ␣ of the Approved Pre-Commencement  |
| `agency_instrument_extension_text` | Schedule W (Agency Financial Ins | 1 | text | Part B — Extension Mechanism ␣ Schedule X – Change In Control, Change In Complet |

## Blanks with no variable

- `s0120_448` in Article: Definitions & Interpretation: shall be paid and treated in such manner as is stipulated in Section ␣;  **(inside a tracked change)**

## Choices and optional blocks

Filled by slot id under `choices:` with the chosen limb, or the block's text without brackets.

- `s1302_520` in Article: Independent Engineer: `[ the consortium members shall be jointly and severally liable for the services under the Independen`
- `s1368_539` in Article: Independent Auditor: `[ the consortium members shall be jointly and severally liable for the services under the Independen`
- `s1398_087` in Article: Independent Auditor: `[the Parties shall appoint one of the State Approved Accounting Firms with mutual consent of the Par`
- `s2502_239` in Article: Insurances: `[single A/AA]`
- `s3240_149` in Schedule B (Specific Definitions): `[A or higher by PACRA, or A or higher by VIS]`
- `s3274_152` in Schedule B (Specific Definitions): `[days/weeks/months]`
- `s3284_000` in Schedule B (Specific Definitions): `[income tax applicable to the Concessionaire in accordance with the Income Tax Ordinance, 2001, as i`
- `s3318_141` in Schedule B (Specific Definitions): `[days/weeks/months]`
- `s3346_130` in Schedule B (Specific Definitions): `[investigate, study, procure, finance, develop, operate, maintain and transfer]`
- `s3362_035` in Schedule B (Specific Definitions): `[Lease Deed / Sub-Lease Agreement / License to Occupy / Right-of-Way Grant]`
- `s3372_071` in Schedule B (Specific Definitions): `[years/months]`
- `s3443_001` in Schedule B (Specific Definitions): `[the Concessionaire has obtained the SBP Approval;]`
- `s3459_098` in Schedule B (Specific Definitions): `[three (3) Accounting Years  falling immediately after the Termination Date]`
- `s3461_138` in Schedule B (Specific Definitions): `[straight-line basis from the Substantial Completion Date]`
- `s3512_000` in Schedule C (Development Works: Engineeri: `[insert project-specific list of required drawing types and categories, in accordance with the Desig`
- `s3758_268` in Schedule L (Financing Matters): `[Financiers' rights must be protected alongside Concessionaire's in EoD triggers]`
- `s3861_147` in Schedule P (Equity Matters): `[two classes of shares i.e. Class A Shares and Class B Shares]`
- `s3930_165` in Schedule R (Revenue Matters): `[Projected Revenue Threshold / Base Toll Revenue as set out in the Financial Model]`
- `s4046_137` in Schedule W (Agency Financial Instrument : `[the Financiers (where financing is present) / the Concessionaire (where no financing)]`
- `s4048_146` in Schedule W (Agency Financial Instrument : `[Projected Termination Payment / Maximum Financing Due]`
- `s4050_117` in Schedule W (Agency Financial Instrument : `[AA- as rated by JCR-VIS or an equivalent rating by PACRA]`

## Directives (must not survive into a draft)

- Schedule B (Specific Definitions): `[Option A:]`
- Schedule B (Specific Definitions): `[Option B:]`
- Schedule B (Specific Definitions): `[INCLUDE ONLY IF EQUITY FUNDING & UTILIZATION AGREEMENT APPLIES — see Schedule Y]`
- Schedule B (Specific Definitions): `[INCLUDE ONLY IF PRICE ESCALATION MECHANISM APPLIES — see Schedule Z]`

## Attachment stubs

- Article: Signature Page: `[List To Be Added]`
- Schedule A (Scope Of The Project): `[To Be Attached Hereto]`
- Schedule D (Project Facilities): `[To Be Attached Hereto]`
- Schedule E (Project Development Completion Schedule): `[To Be Attached Hereto]`
- Schedule F (Project Site): `[To Be Attached Hereto]`
- Schedule G (Completion Tests Matters): `[To Be Attached Hereto]`
- Schedule H (O&M Requirements): `[To Be Attached Hereto]`
- Schedule I (Insurance): `[To Be Attached Hereto]`
- Schedule K (Corporate Documents): `[To Be Attached Hereto]`
- Schedule M (Form Of O&M Performance Security): `[To Be Attached Hereto]`
- Schedule N (Part I (Indicative Independent Auditor Terms of Reference)): `[To Be Attached Hereto]`
- Schedule N (Part II (Indicative Independent Engineer Terms Of Reference)): `[To Be Attached Hereto]`
- Schedule O (Form Of Vesting Certificate): `[To Be Attached Hereto]`
- Schedule S (Notices): `[To Be Attached Hereto]`
- Schedule U (Financial Model): `[To Be Attached Hereto]`
- Schedule V (Illustrations): `[To Be Attached Hereto]`
- Schedule Y (Agency Specific Permits): `[To Be Attached Hereto]`

## Conditional amendments (from the template's footnotes)

- **If Financing Involved** (footnote 39): Lenders may require the Delayed Payment Rate to equal the weighted average cost of debt under the Financing Documents plus a margin, rather than KIBOR-based. Align with the Financing Term Sheet.
- **If Islamic Financing** (footnote 41): Replace "bank guarantee" with "Shariah-compliant bank guarantee or kafalah instrument" and add a Takaful-based performance bond as an alternative.
- **If Tax Regime Is Fixed In Bid** (footnote 46): Replace the tax exclusion bracket with the specific taxes (corporate income tax, WHT) fixed in the bid financial model, so that only changes to those specific tax heads qualify as Change in Law. A generic exclusion of "T
- **If No Financing** (footnote 65): Delete "(a) the Financial Close Date" from the list of Repetition Dates, as Financial Close will not occur. The remaining dates (b) through (d) continue to apply.
- **If No Agency Financial Instrument** (footnote 69): If the Agency is not providing a financial guarantee or Financial Instrument, delete item (a) entirely and cross-reference Section 17 to confirm the provision is removed. If the Equity Funding & Utilization Agreement doe
- **If No Financing** (footnote 71): If the project is entirely equity-funded, delete items (e), (f) and (g) relating to the Financing Term Sheet, Financing Documents, and Financial Close Achievement Notice. Amend Section 3 of the main Agreement accordingly
- **If Project Is Phased** (footnote 80): Where the Project is phased or segmented, add segment-specific references throughout Part B. Insert "in respect of each Phase/Segment" after each reference to " Construction Drawings " in  Clause 1  through  Clause  5   
- **If Non-Infrastructure Project** (footnote 81): The list of drawing types in Section 12.2A is drafted for a generic infrastructure project. For sector-specific projects (e.g., water treatment, energy, port infrastructure), replace the enumerated drawing types with the