---
name: akla-hub-first
description: Start every piece of AKLA (Ali Khan Law Associates) legal work from the firm's AKLA Project Hub connector. Use whenever the lawyer asks to draft, review, mark up, summarise, compare or check an agreement, contract, deed, term sheet, RFP, concession or PPP document, letter, memo, opinion or note; asks a question on Pakistani law, a statute, rule or regulation; names a client, deal, matter or project; or asks to file, save or upload a document. Loads the Hub's tools, takes the firm's rules, searches the firm's projects, precedents and law library before answering, and files every draft in the Hub.
---

# AKLA Hub first

AKLA's work lives in the AKLA Project Hub: its projects and their documents,
the precedent library, the law library of Pakistani statutes, the firm's
drafting standards and its rules. This skill does no work of its own. It sends
the task through the Hub's connector, so the answer rests on the firm's own
material and every document lands in the right project.

## Steps

1. **Load the Hub's tools.** If the AKLA Project Hub tools (get_firm_rules,
   list_projects, search_precedents, search_law_library and the rest) are not
   already in front of you, search your tools for "AKLA Hub" and load them. If
   no AKLA Project Hub connector is connected, tell the lawyer in one line to
   turn it on (Settings → Connectors → AKLA Project Hub → Connect, or the "+"
   menu under the message box → Connectors) and carry on only once it is.

2. **Take the firm's rules.** Call `get_firm_rules` once, with `task` set to
   draft, review or answer, and follow what it returns for the whole task.

3. **Find the project.** When the lawyer names a client, deal or project, find
   it with `list_projects` (or `find_document_by_title` for one document) and
   read it with `get_project_overview` before anything else; its standing
   instructions are facts and wishes from earlier work.

4. **Search before answering or drafting.** `search_project_documents` for the
   project, `search_precedents` for how the firm has drafted the point before,
   `search_law_library` (and `read_act_section`) for the law. Search before
   saying the firm lacks something, and never ask the lawyer to upload what the
   Hub may hold.

5. **Draft through the Hub.** `list_document_types` says whether the firm has a
   standard for the kind of document. With one, `open_standard_for_filling`,
   ask the drafting questions (`get_drafting_decisions`) one at a time, then
   `fill_standard_to_project`. Without one, `save_draft_to_project`. Never hand
   a firm document over only as a chat file or artifact.

6. **Review through the Hub.** For a document already in a project,
   `start_review`. For a file attached in the chat, `upload_file_to_project`
   first, then review the version that makes. If you review it yourself in the
   chat, file your changes with `apply_tracked_changes`.

7. **Give the address.** Every result carries an "Open in Hub:" address. Write
   it out in full on its own line, never behind link text.

Other skills still apply alongside this one (a memo's format, a due-diligence
volume's format, a deck): use them for the shape, and still file what they make
with `upload_file_to_project`.
