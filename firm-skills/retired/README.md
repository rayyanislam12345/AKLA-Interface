# Retired skills

Retired on 22 October 2026 at the owner's request: the firm's drafting packs
replace them, and every draft now goes through the Hub (fill_standard_to_project
from claude.ai, the same packs in the Hub chat), so it is filed in the project
and checked against the firm's format and clause list.

- `concession-agreement`: the Concession Agreement pack and the CA standard.
  The skill's scripts stay in `firm-skills/concession-agreement/`, because the
  Hub's own drafting engine reads them (chat-service/agreement.js SKILL_DIR,
  copied to the server by chat-service/deploy.sh). It is no longer offered to
  Claude as a skill.
- `rfp-volume-i`: the RFP Volume I standard and its 30 drafting decisions.

Each `*.ai_skills-row.json` is the skill's row in the Hub's `ai_skills` table
as it stood before retirement (instructions and file list), kept so it can be
restored by inserting the row again.
