"""Worked example: the pattern from SKILL.md, as a runnable script.
    python3 scripts/example.py        # writes Example Deck [AKLA].pptx in the current directory
"""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from akla_deck import *          # noqa: F401,F403
from akla_deck import _sp

HDR = "Example Project – Example Client"
slides = []
def page(shapes):
    slides.append((SLIDE_OPEN + "".join(shapes) + SLIDE_CLOSE, {"rId3": "image1.png"}))
def std(title, n):
    s = chrome(HDR, n); tb, y = title_block(title); return s + tb, y

s = chrome(HDR, 1)
s.append(textbox("TitleMain", 0.60, 1.30, 12.1333, 1.60, "Presentation On The Example Proposal", 26, TITLENAVY, bold=True, caps=True, align="c", line_pt=32))
s.append(_sp("Rule", 0.60, 3.00, 12.1333, 0, LINE, None, NAVY))
s.append(textbox("Sub", 0.60, 3.16, 12.1333, 0.30, "Prepared for Example Client  |  October 14, 2026", 12, TITLENAVY, bold=True, align="c"))
page(s)

s, y = std("Scope And Structure", 2)
lab, y = label("The Questions Put To The Firm", y); s.append(lab)
s += card_grid([(1, "Authority", "Whether the body may deal with the site at all, and on what terms."),
                (2, "Process", "The unsolicited-proposal route, with a competitive challenge in which the proponent carries its statutory advantage."),
                (3, "Risk", "What should not be given at this stage: in-principle acceptance, designation as unique, or access to the site."),
                (4, "Outcome", "A concession rather than a lease, at the end of a staged route.")],
               y, CONTENT_BOTTOM, cols=2)
page(s)

s, y = std("Timeline", 3)
bc, y = bullet_columns(["Non-binding engagement now, at the proponent's cost", "Processing under the Act"],
                       ["Competitive challenge, months three to six", "Award of a concession"], y)
s += bc
page(s)

base = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "assets", "base")
out = "Example Deck [AKLA][October 14, 2026].pptx"
build(slides, base, out)
print("built", out)
