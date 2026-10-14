# Firm skills

The source of each firm skill registered in the Hub's AI Assistant (Manage
skills → Firm skills). A skill is a folder with a `SKILL.md` (name and
description in its front matter, instructions in its body), the scripts it
runs, and the assets it needs — the firm's masters, a base deck. The Hub
uploads the folder as a zip to the skills runtime, where the scripts genuinely
execute in a sandbox and the files they build come back as artifacts.

| Skill | Does | Origin |
|---|---|---|
| `concession-agreement` | Fills the firm's Standard Concession Agreement master from deal facts and proves nothing else moved; carries the firm's drafting rules | `~/.claude/skills/concession-agreement` + the MEW EPC project instructions |
| `rfp-volume-i` | Drafts Volume I (Instructions to Bidders) from the AKLA master | registered earlier from `~/.claude/skills/rfp-volume-i` (not copied here) |
| `legal-summary` | "Notes On…" memos; cites statutes and documents with verbatim excerpts attached as Word comments, checked against the source text | `~/.claude/skills/legal-summary` + PTQ's `build_memo.py` and `check_excerpts.py` |
| `akla-daily-agenda` | Daily Agenda and Timesheet in the firm's format | `~/.claude/skills/akla-daily-agenda` |
| `akla-dd-format` | Brings a due-diligence volume to the house format | `~/.claude/skills/akla-dd-format` |
| `akla-findings-pack` | Findings register (Excel) and a numbered-items deck from one findings list | KP Carbon Credits / MEW / PTQ `build_findings_register.py`, `build_deck.py` |
| `akla-presentation` | House-style decks from a short script over the firm's layout engine, with an overflow check | Presentation KPT BOT `tools/` (`akla_deck.py`, `arial.py`, `render.py`, base deck) |

## Packaging and registering

Zip a folder so the zip's top level is the folder itself, then either upload
it in the app (Manage skills → Upload skill) or register from the VM, where
the Anthropic key and the service-role key live:

```bash
zip -r akla-presentation.zip akla-presentation
scp register-skills.mjs akla-presentation.zip opc@140.245.26.184:/tmp/skillreg/
ssh opc@140.245.26.184 'cd /tmp/skillreg && ln -sfn /opt/chat-service/node_modules node_modules && set -a && . /opt/chat-service/.env && set +a && node register-skills.mjs akla-presentation.zip'
```

`register-skills.mjs` mirrors the Hub's own upload handler: it parses the
zip, publishes it to the skills runtime (a new version if the name is already
registered), and records the `ai_skills` row. The uploader renames files
whose names carry spaces or brackets and updates the mentions; keep names
plain where you can.

The sandbox has Python 3.11 with PIL, PyYAML, lxml, python-docx, python-pptx,
openpyxl, pdfplumber and pypdf, and Liberation Sans (metric-compatible with
Arial) for measurement. No LibreOffice, so nothing here depends on it.
