# Installing the concession agreement skill

This folder lets Claude Code draft a PPP concession agreement by filling the firm's standard
master. It is self-contained: the master template is inside `assets/`.

## 1. Put the folder in place

**macOS / Linux** — open Terminal in the folder you unzipped and run:

```bash
./install.sh
```

Or copy the folder by hand to `~/.claude/skills/concession-agreement/`.

**Windows** — copy the folder to `%USERPROFILE%\.claude\skills\concession-agreement\`.

## 2. Install the two Python libraries

```bash
pip3 install python-docx lxml
```

## 3. Use it

Open Claude Code in any folder and describe the deal in plain English, for example:

> Draft the concession agreement for the Karachi Port to Qayumabad Corridor. The Agency is the
> Karachi Development Authority, the Concessionaire is PTQ Expressway (Private) Limited, the Bid
> Submission Date was April 6, 2026, the concession is 25 years and Scheduled Substantial
> Completion is 30 months from Commencement.

Claude picks the skill up on its own. You do not need to name it. It will ask for the rest of the
facts in batches, tell you what it is about to fill, build the file, run its checks, and tell you
what is still open.

## What it will and will not do

It fills the master exactly as drafted, in the firm's formatting, and proves nothing else in the
document changed. It leaves every value you did not give it as `[●]` and lists them.

It will not invent a figure, choose an equity structure or arbitration forum for you, resolve the
firm's open policy notes in the master, or draft the Article 28 that the master is missing. It
will not run while the master has unresolved tracked changes; have those accepted or rejected
first.
