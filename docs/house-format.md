# House format

The firm's guidelines, for lawyers: https://claude.ai/artifact/3Aug7dUu3QEVtXZbFZAzkt
("AKLA House Format Guidelines", 27 October 2026).

They were measured from the Word files in the precedent library: 260
documents, of which 71 name the firm or one of its lawyers as author (34 of
them agreements), set against 114 drafted by other firms. What every firm
document shares: A4, Arial 11, justified, single-spaced, one-inch margins,
automatic 1. / 1.1. / 1.1.1. numbering with full stops, bold small caps for
every title and heading, defined terms in bold inside brackets without
quotation marks, "Page X of Y" centred. What differs by kind is the front:

| Kind | Layout | Built by |
|---|---|---|
| Agreements, deeds, term sheets, undertakings | cover page, contents, parties, lettered recitals, unnumbered definitions, no banner or emblem | `chat-service/akla/build_docx.py --layout agreement` |
| Memoranda, notes, reports, minutes, proposals | title on the navy banner, emblem in the header, nothing indented | `build_docx.py` (memo layout) |
| Letters, opinions, resolutions, consents, and every type with a pack | the firm's own Word file | the drafting packs (`fill_standard_to_project`) |

`aklaLayout()` in `chat-service/aklaRender.js` picks the layout: the
document type's category first, then the words of its title.

## Measuring again

The scripts are in `scripts/house_format/`. Download the precedent library's
.docx files to a folder `docs/` with an `index.json` (path, type, category,
file), then:

```bash
python3 -c "import json;[print(json.dumps({**r,'path_local':'docs/'+r['file']})) for r in json.load(open('index.json'))]" \
  | python3 -I measure.py > m.jsonl     # every formatting property, per file
python3 group.py                        # AKLA-written / other firm / unclear, by author metadata
python3 agg.py akla; python3 agg.py other   # what most of each group shares
python3 -I sc.py                        # small caps, cover pages, watermarks, defined-term style
```
