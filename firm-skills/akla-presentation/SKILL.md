---
name: akla-presentation
description: Build an AKLA house-style PowerPoint deck — navy header band, gold small-caps running header, navy titles over a rule, numbered cards, chips, bullet columns, tables and callout banners, the firm's footer — and check every slide for text overflow before it is circulated. Use whenever someone asks for a presentation, slides, a deck or a client briefing in the firm's format, or wants a memo, summary or set of findings turned into slides.
---

# AKLA presentation

The firm's decks are built in code against a small layout engine that
reproduces the visual grammar of the M6 due-diligence deck exactly, and are
then rendered with real font metrics to catch any text that does not fit. You
write a short Python script that composes the slides from the engine's
primitives; the engine does the geometry, the renderer does the checking.
Run every command from the skill's own directory.

## Workflow

1. **Agree the content first**: the audience, the slide titles, and three to
   five points per slide. A deck is not a memo; one idea per card.
2. **Write `deck.py`** from the pattern below, in the skill directory.
3. **Build and render**:

   ```bash
   python3 deck.py                                       # writes the .pptx
   python3 scripts/render.py "<file>.pptx" preview       # PNG per slide + overflow report
   ```

4. **Read the overflow report.** Any line reporting text taller than its box
   or wider than its column is a real defect that will show in PowerPoint:
   shorten the text, split the slide, or reduce the item count. Rebuild and
   render again until the report is clean. **Do not hand over a deck whose
   report is not clean.**
5. Name the file in house convention: `<Title> [AKLA][Month DD, YYYY].pptx`.

## The pattern

```python
import sys; sys.path.insert(0, "scripts")
from akla_deck import *          # primitives and the house constants
from akla_deck import _sp

HDR = "Running header – project – client"   # every slide's header band
slides = []
def page(shapes):
    slides.append((SLIDE_OPEN + "".join(shapes) + SLIDE_CLOSE, {"rId3": "image1.png"}))
def std(title, n):
    s = chrome(HDR, n); tb, y = title_block(title); return s + tb, y

# Title slide
s = chrome(HDR, 1)
s.append(textbox("TitleMain", 0.60, 1.30, 12.1333, 1.60, "Presentation On …", 26, TITLENAVY, bold=True, caps=True, align="c", line_pt=32))
s.append(_sp("Rule", 0.60, 3.00, 12.1333, 0, LINE, None, NAVY))
s.append(textbox("Sub", 0.60, 3.16, 12.1333, 0.30, "Prepared for …  |  October 14, 2026", 12, TITLENAVY, bold=True, align="c"))
page(s)

# A cards slide: label, then numbered cards filling the band down to the content bottom
s, y = std("Scope And Structure", 2)
lab, y = label("The Questions Put To The Firm", y); s.append(lab)
s += card_grid([(1, "Authority", "Whether the body may deal with the site, and on what terms."),
                (2, "Process", "The unsolicited-proposal route, with a competitive challenge.")],
               y, CONTENT_BOTTOM, cols=2)
page(s)

build(slides, "assets/base", "Deck [AKLA][October 14, 2026].pptx")
```

## Primitives (all sizes in inches; see `scripts/akla_deck.py`)

| Call | Returns | Use |
|---|---|---|
| `chrome(header, page_no)` | shapes | header band, running header, footer mark, URL, page number — start every slide with it |
| `title_block(title, pt=24)` | (shapes, y) | the slide title over its rule; `y` is where content starts |
| `label(text, y)` | (shape, y) | a 13pt navy small-caps section label |
| `textbox(name, x, y, w, h, text, pt, color, bold=False, caps=False, align="l", line_pt=None)` | shape | any text; measure height first with `text_h(text, w, pt, line_pt)` |
| `card_grid(items, y_top, y_bottom, cols=2)` | shapes | numbered cards, `items = [(n, heading, body), …]`, laid out to fill the band |
| `chip_grid(items, y_top, y_bottom, cols=2)` | shapes | short numbered chips, `items = [(n, label), …]` |
| `bullet_columns(left, right, y)` | (shapes, y) | two bullet columns from two lists of strings |
| `banner(x, y, w, h, title, text)` | shapes | a titled callout box; height from `banner_h(text, w)` |
| `table(x, y, col_w, headers, rows)` | shapes | navy header row, alternating body rows; `col_w` is a list of widths |

Constants: `MARGIN_L = 0.40`, `CONTENT_W = 12.53`, `CONTENT_BOTTOM = 6.78`;
colours `NAVY`, `TITLENAVY`, `GOLD`, `BODY`, `GREY`. A slide is 13.333 × 7.5 in,
Arial throughout (Liberation Sans stands in for measurement where Arial is
absent — the widths are identical).

## House rules

- One band block (cards, chips or table) per slide, finishing it; labels,
  text, bullets and banners stack above it from `y`.
- Three to five cards a slide; two columns unless the text is very short.
- Titles in small caps are set by the engine — write them in normal case.
- Nothing invented: every figure, name and date on a slide comes from the
  material supplied. A gap is a `[TO BE CONFIRMED]`, never a guess.
- `assets/base` is the firm's deck package (theme, master, logos); never
  edit it. Extra images go through `build(..., extra_media={src: "imageN.png"})`
  and a `picture(name, rId, x, y, w, h)` shape with the matching rel.
