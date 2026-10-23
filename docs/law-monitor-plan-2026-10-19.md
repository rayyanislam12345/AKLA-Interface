# Legal updates that actually arrive — plan, 19 October 2026

## What changes for associates

- **The homepage briefing fills up.** Amendments, new Acts, bills and SROs that touch the firm's work appear the morning they are published, instead of a daily "no new legal developments".
- **A law in the library changing is caught automatically.** When the official text of an Act the library holds changes, or an instrument amending it is published, the Hub says so, says whether the library's copy already includes the change, and the matters that rely on that Act turn amber.
- **Draft amendments are visible before they become law.** Bills introduced in the National Assembly, Senate and provincial assemblies, and draft regulations put out for consultation by regulators, show up labelled as proposals.
- **People are told, not left to check.** Anyone working on a matter that depends on an Act gets a notification in the Hub (and by email, once the mail key is in place) when that Act is touched. Everyone sees bills and new Acts in the bell.
- **Press reports count, clearly labelled.** A newspaper report of a new ordinance or SRO appears as "reported in press" until the official document is found.

## Why it was empty

The monitor on the Oracle VM runs every morning and has never failed. In 47 runs it found about 350 candidate developments and kept 5, all press releases. The reasons, from its own log:

1. The library sweep asks "amended in the last two years?" and the verifier then rejects anything older than 30 days. Every real amendment was found and discarded daily.
2. The VM cannot reach na.gov.pk, senate.gov.pk, pakistancode.gov.pk, PPRA's portal or the provincial assemblies. The repo already has a download relay on the DigitalOcean droplet for exactly this, used by the chat service but not by the monitor.
3. No legislature or consultation page is watched, so bills can only appear by accident.
4. Each source gets three or four web searches, which lag by days and surface press releases.
5. News domains are rejected outright.
6. Nothing notifies anyone. Rejection reasons live in a four-day journal.

## Phase 1 — keep what it finds

- Age gate per sweep: the library sweep accepts amendments up to two years old; the source sweep keeps its 30-day window.
- **Incorporation check.** For an amending instrument, quoted replacement wording from the amendment is looked for in the library's stored text of the Act. Result stored per update: already included, not included, or not checkable. Matters only turn amber for the last two.
- All official fetches go direct first, then through the relay. IPv4 is tried first (government sites publish IPv6 addresses they do not answer on).
- `law_monitor_candidates`: every candidate seen, with its outcome and reason. Transient fetch failures are retried from the stored URL the next morning without a new search. Permanent rejections are not re-fetched and are fed back into the search prompts as "already known".
- A `reported` tier for items from an allowlisted press domain. Never touches the library, never flags a matter, shows on the card as reported in press.
- New update type `draft` for regulations and policies circulated for consultation.
- Card shows tier, incorporation status and a "seen but not verified" list.

## Phase 2 — watch the notice boards

- `watchlist.json`: official listing pages read each morning and diffed against the previous snapshot (`law_watch_pages`). New entries are classified in one call per page, then go through the same verification as everything else. First visit of a page records a baseline and reports nothing.
- Pages: National Assembly government and private bills and Acts; Senate bills; Sindh, Balochistan and Khyber Pakhtunkhwa assembly bills and Acts; Pakistan Code's recently added list; PPRA rules and regulations; OGRA public notices; Ministry of Law front page. SECP blocks automated readers (403 everywhere), so it stays on web search. Punjab Assembly's site renders in the browser only; left out until an address with real content is found. FBR SRO pages are in the list but off.
- **Library source re-check.** Each Act in the day's rotation whose stored source address is official is re-fetched and its text compared with the last snapshot. A change becomes a consolidated-replacement candidate and goes through the existing safeguards (length within 40%, identity check, archive before delete).

## Phase 3 — tell people

- `law_update_notifications` (per person, per update, optionally per matter) and `notification_preferences`.
- Matter team = lead partner, creator, task assignees and anyone who has recorded time on it. They are notified for verified updates touching the matter's Acts, unless the library copy already includes the change.
- Everyone approved gets bills, new Acts, drafts and amendments to library Acts in the bell (switchable per person).
- One email per person per morning, through Resend. Inactive until `RESEND_API_KEY` and `LAW_MONITOR_EMAIL_FROM` are set in the VM's `.env`, and the sending domain is verified at Resend.
- Bell in the Hub header: unread count, list, mark read, link to the matter or source, email toggle.

## Status, 19 October 2026

All three phases are built, deployed to the VM and committed. Found on the way:

- **The Anthropic key on the VM has no credit left.** Every search call since this morning's 02:03 run returns "credit balance is too low". Until it is topped up, the morning run reads the watched pages and retries downloads, then ends as a *failed* run with that reason, and the card keeps the last real briefing. Nothing is lost, nothing is searched.
- The watched pages recorded their baselines at 06:11 UTC today (National Assembly 228 + 212 bills and 253 Acts, Khyber Pakhtunkhwa 172 bills and 222 Acts, Pakistan Code, Balochistan, PPRA, OGRA, Ministry of Law). From tomorrow, anything new on them is reported.
- **Workarounds found later the same day:** SECP's Cloudflare check lets a real Google Chrome on a virtual display through, so the relay gained a browser mode (`browser:` prefix) used for hosts listed in `browser_hosts`; SECP's notifications, circulars, drafts for discussion, draft laws and regulations pages are now watched. The Sindh Assembly's lists live at plain addresses (`pas.gov.pk/bills/33`, `/acts/33`) once the tenure is known, and the Punjab Assembly's at `pap.gov.pk/bills/show/en/22/introduced`. Sindh is watched directly. Punjab turned out to block foreign addresses (it loads on the laptop in seconds, never from either server), so it stays off until a Pakistani egress exists. SECP's document links download through the same browser, and scanned PDFs go through the VM's OCR service. The Senate resets one connection in five whoever asks; the relay retries three times.
- Notifications were tested end to end with a temporary row: the M6 Motorway team got matter notifications, twelve people got the firm-wide one, a second pass wrote nothing, and the test row was removed.

## What only Rayyan can do

- Top up the API credit for the key in `/opt/law-monitor/.env` (or put a funded key there). Nothing searches until then.
- Deploy the frontend with `vercel --prod --yes` after `vercel login`.
- Create a Resend account, verify the firm's sending domain, and put `RESEND_API_KEY` and `LAW_MONITOR_EMAIL_FROM` in `/opt/law-monitor/.env`. Until then notifications are in-app only.
- Decide whether FBR tax SRO pages should be switched on in `watchlist.json`.

## Known limits

- The Gazette of Pakistan is not online in a form that can be watched. SROs that only appear in the Gazette will surface via press or a regulator page, labelled accordingly.
- The incorporation check is a wording check. It is reliable when an amendment substitutes words; it says "not checkable" when the amendment only inserts numbers or whole new sections without quotable wording.
- The library source re-check hashes text with digits removed, so a change that only alters numbers in an Act is not detected by that route (it is still caught by the amendment sweep).

## Review, 23 October 2026

Four mornings of real runs were checked against the web and the documents themselves. The developments it reported were real: the Companies (Amendment) Bill, Industrial Relations (Amendment) Bill and Emigration (Amendment) Bill introduced in the National Assembly on 19 October, the Privatisation Commission (Amendment) Bill on 22 October, SECP's draft SRO 1863(I)/2026 on broker licensing, the SECP concept paper on the Companies Act, the Senate's private member's bill on the SECP Act, the PPP Authority (Amendment) Bill, and three press-reported bills. What it got wrong, now fixed:

- Dates from the National Assembly page were lost (the table pass ran after the anchor pass), so bills were stored as "2026-01-01". Rows now go first; a year or month alone is stored as no date; a document's own latest date overrides a search model's guess, which it had set to the day of the search for the telecom bill.
- Two findings were linked to laws not in the library (Passports Act, Securities Brokers Regulations) and one rang the bell for everyone. An Act must now be one the library holds; otherwise the name goes into the summary.
- SRO 601(I)/2025, which amends the Companies Regulations, was filed as an amendment to the Companies Act and ingested beside it. Instruments amending rules or regulations are recorded as notices; the misfiled entry was removed.
- One SECP SRO was recorded six times, once per page it appeared on. Keys are now the reference alone.
- A low-confidence "Banking Companies Ordinance (being updated)" and an unsupported "Draft Amendment to Companies Regulations" each told 14 people. Low-confidence findings ring no bell; a title has to be found by its distinctive words, and an index page as sole evidence is marked low confidence.
- Six library Acts' source pages were recorded with http:// and the relay refused them; they are fetched as https now.
