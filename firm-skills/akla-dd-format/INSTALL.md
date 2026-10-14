# Installing the AKLA DD format skill

This gives your Claude the firm's due diligence volume format: it can audit a draft
volume against the house standard, reformat it, and prove no wording was lost.

## 1. Put the folder in place

**macOS / Linux** — from the folder you unzipped:

```bash
mkdir -p ~/.claude/skills
cp -R akla-dd-format ~/.claude/skills/
```

Or just run `./install.sh` from inside the unzipped folder.

**Windows** — copy the `akla-dd-format` folder into:

```
C:\Users\<your name>\.claude\skills\
```

Create the `skills` folder if it is not there. When you are done the path
`…\.claude\skills\akla-dd-format\SKILL.md` must exist.

## 2. Install the two Python libraries

```bash
pip3 install python-docx pymupdf
```

`python-docx` is required. `pymupdf` is only needed to read PDFs; skip it if your
drafts are always Word files.

## 3. Use it

Restart Claude Code, then just ask in plain words:

- "Format this DD volume to our house standard" *(attach or point to the file)*
- "Check whether this volume matches our formatting"
- "Clean up Ahmed's draft Volume III before I circulate it"

Claude picks the skill up on its own. You do not need to name it.

## What it will and will not do

It fixes formatting: page geometry, Arial 11, the navy/gold tables, blue AKLA
Comments and red Action Items, headers, footers, table of contents, numbering.

It does not write your analysis. If the draft has no Important Note, Glossary or
Annexure A, it tells you they are missing rather than inventing them, because those
are records of what was actually reviewed.

Every reformat is verified sentence by sentence against the original. If anything
would be lost, it refuses to hand the file over.
