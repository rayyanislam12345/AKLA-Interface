# Retrieval evaluation

A fixed set of 60 questions an associate would ask, each with the passages
that answer it, and a runner that sends every question through a search path
and scores what comes back. Run it before and after any change to search
(chunking, embeddings, thresholds, reranking, tools) so the change is measured
before associates see it. It reads the live index and writes nothing to it.

## Files

| File | What it is |
|---|---|
| `gold.json` | the questions and their acceptable answers |
| `run.mjs` | the runner and the adapters (`baseline`, `tools`, `retrieve`, `fake`) |
| `time-retrieve.mjs` | where one search's time goes, stage by stage |
| `score.mjs` | the scoring rules; no network |
| `results/` | one JSON file per run, named `<label>-<timestamp>.json` (created on first run). It quotes client documents, so it is git-ignored. |

## Running it on the VM

The runner imports the chat service's own code and keys, so it runs on the
Oracle VM next to `/opt/chat-service`. The VM is not a git checkout; copy the
folder across (the same way `chat-service/deploy.sh` copies the service):

```bash
# from the repo, on your machine
ssh -i ~/.ssh/oracle-ocr.key opc@140.245.26.184 "mkdir -p /opt/chat-service/scripts"
scp -i ~/.ssh/oracle-ocr.key -r scripts/eval opc@140.245.26.184:/opt/chat-service/scripts/

# on the VM
cd /opt/chat-service
node scripts/eval/run.mjs --adapter baseline
node scripts/eval/run.mjs --adapter tools
```

It finds the chat-service code next to itself (or pass `--chat-service <dir>`)
and reads `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY` and `VOYAGE_API_KEY` from
the environment or from `/opt/chat-service/.env`. `ANTHROPIC_API_KEY` is used
for the precedent search's synonym step if present; `--no-synonyms` turns it
off. A full run makes about one Voyage call per question (a few more for
`tools`) and takes a few minutes.

Adapters:

- `baseline`: today's automatic search in the chat. One `voyage-law-2`
  embedding of the question, then the three `match_documents` calls
  `chat-service/server.js` makes: 6 project passages (inside a project),
  6 precedent passages and 4 statute passages (limited to the project's
  relevant laws when it has any), all at similarity 0.35 or above. Results are
  ranked by similarity. `--baseline-order server` keeps the order the prompt
  lists them in instead (project, then precedent, then statute).
- `tools`: the assistant's library tools from `chat-service/libraryTools.js`
  (`readActSection`, `searchLaw`, `searchPrecedentsTool`, `searchProject`),
  imported and called directly. By default the tools are chosen from the
  question's wording: `read_act_section` when it names an Act and a section,
  the law search when it reads like a legal question, precedents outside a
  project, project documents inside one. Their lists are interleaved after the
  section read. `--route kind` lets the question's kind choose the tool
  instead, which shows the best the tools can do when the assistant always
  picks the right one.
- `fake`: no network. It puts a correct answer at rank 1, 3 or 7 (or leaves it
  out) among deliberate near-misses: the wrong section, the right file without
  the phrase, a contents line. It then checks the scorer found each answer
  where it was put. Run it after any change to `score.mjs`.

- `retrieve`: the one search, `chat-service/retrieve.js`, routed like
  `tools`. Each question's line also shows `search … ms`: the slowest
  scope's `retrieve()` alone, without the runner's own placing of statute
  passages in their sections (recorded as `searchMs` in the result file).
  `--deadline MS` overrides RETRIEVE_DEADLINE_MS (`--deadline 0` measures
  the full search however long it takes; a search that returned the quick
  way is marked `fb:<scope>=<path>` — `fused` is the question's own search
  unreranked, `words` the search by words alone, `none` nothing in time —
  and `v<N>` is its Voyage calls). The result file's `retrieve` holds, per
  scope, `fellBack`, `reason`, `path`, `voyageCalls` and every stage's
  timing (`events`), so a capped run can be read question by question.
  `--rerank-pool N`, `--rerank-chars N` and `--rewrite-wait MS` override
  retrieve.js's `RERANK_POOL` (30), `RERANK_CHARS` (8,000) and
  `REWRITE_WAIT_MS` (2,500), to compare a setting's scores and speed.

Where a search's time goes: `time-retrieve.mjs` runs six of the questions
(two precedent, two statute concept, one project, one which-document; or
`--only …`) the way `--adapter retrieve` does and prints each stage's start
and length — rewrite, embeddings, each `search_passages` call, rerank, the
Acts read to place statute passages, a named section's read — then each
stage's average. Round 1 is a fresh process; round 2 keeps the law list and
rebuilt Acts, as the running service does.

```bash
node scripts/eval/time-retrieve.mjs --chat-service /opt/chat-service
```

Other useful options: `--only S01,C03`, `--kind precedent_clause`,
`--label after-reindex`, `--verbose` (prints each question's top 10, with `*`
on the passages that count as answers), and `--check-gold`, which confirms
every expected answer still exists in the live index. Run `--check-gold` after
re-indexing: if chunk paths or Act names change, the gold set has to follow.

## What the numbers mean

- **R@5 / R@10**: the share of questions with at least one acceptable answer
  among the first 5 / 10 passages returned.
- **MRR**: the average of 1 / (rank of the first acceptable answer), with 0
  when none is returned. 1.0 means every question's answer came first.
- Reported overall and for each kind: `statute_section` (the question names
  the section), `statute_concept` (it does not), `precedent_clause`,
  `project_fact`, `which_document`.

`expected` lists acceptable answers, and any one of them counts. A passage
matches an item when:

- `act_section`: the passage is from that Act (names compared by their words
  and year, so "Public Private Partnership Authority Act, 2017." matches
  "…Act, 2017") and covers that section. The runner places each statute
  passage in the rebuilt Act to find which sections it spans. If it cannot,
  the section's heading (not a contents line) must appear in the passage.
- `storage_path`: the passage comes from that exact file.
- `act_contains`: the passage is from that Act and contains the phrase.
- `contains`, on any item: the passage must also contain this phrase. Case,
  whitespace, curly quotes, dashes and HTML tags are ignored, and so are
  spaces lost in PDF extraction.

## Adding a question

1. Write the question the way an associate would type it, typos included.
   Use `"scope": "general"` for the law and precedent libraries, or a matter
   id to search inside one project.
2. Find the answer in the live index, read-only. For a statute, check the
   section exists in the library's copy (`read_act_section` finds it, or
   `--check-gold` after you add it). For a precedent or project document, find
   the chunk and copy a short phrase of 5 to 15 words that appears in it
   exactly and only near the answer. Take the `storage_path` from
   `documents.metadata`.
3. List every place that genuinely answers the question: copies of the same
   agreement at different paths, or the same clause in several precedents.
   Leave out passages that only mention the words, such as "headings are for
   convenience" for a termination-for-convenience question.
4. Say in `notes` how you checked it, then run:

```bash
node scripts/eval/run.mjs --check-gold --only <your id>
node scripts/eval/run.mjs --adapter fake          # the file still parses and scores
```

Production misses are the best source of new questions: when an associate
says the assistant could not find something that is in the library, add it
here.

Keep client names out of the questions. Inside a project the matter id is the
scope, so "the term sheet" or "the FSA" is enough.
