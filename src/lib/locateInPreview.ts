// Finds a review suggestion's text inside a rendered docx-preview and
// outlines it. The preview shows tracked changes, so the same stretch of
// the document exists in two readings: the original (everything except
// inserted text) and the proposed (everything except deleted text). A
// suggestion's original_text is looked for in the first, its suggested_text
// in the second.
//
// Matching ignores whitespace entirely. Paragraph and run boundaries in the
// rendered page carry no spaces, while the text the review was run on joined
// paragraphs with newlines, so comparing whitespace would miss most clauses
// that cross a line.

const OUTLINE_CLASS = "review-locate-outline";

// The review read the Word file through mammoth's HTML, so its quotes can
// carry markup and entities that the rendered page does not. Footnote
// markers are dropped on both sides: mammoth writes them as "[9]", the
// page draws a raised "9".
function plainText(value: string): string {
  const doc = new DOMParser().parseFromString(`<body>${value}</body>`, "text/html");
  doc.body.querySelectorAll("sup").forEach((el) => el.remove());
  return doc.body.textContent ?? "";
}

const squash = (value: string) =>
  value
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/\s+/g, "");

interface CharIndex {
  text: string;
  nodes: Text[];
  offsets: number[];
}

function indexText(root: HTMLElement, skip: "ins" | "del"): CharIndex {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(`${skip}, sup, .${OUTLINE_CLASS}, style, script`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  let text = "";
  const nodes: Text[] = [];
  const offsets: number[] = [];
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    const value = node.data;
    for (let i = 0; i < value.length; i++) {
      const ch = squash(value[i]);
      if (!ch) continue;
      text += ch;
      nodes.push(node);
      offsets.push(i);
    }
  }
  return { text, nodes, offsets };
}

function findRange(root: HTMLElement, wanted: string, skip: "ins" | "del"): Range | null {
  const needle = squash(plainText(wanted));
  if (needle.length < 3) return null;
  const index = indexText(root, skip);
  let start = index.text.indexOf(needle);
  let length = needle.length;
  // A long quote can differ from the page by one character somewhere; its
  // opening words are still enough to find the clause.
  if (start < 0 && needle.length > 80) {
    start = index.text.indexOf(needle.slice(0, 80));
    length = Math.min(needle.length, index.text.length - start);
  }
  if (start < 0) return null;
  const end = start + length - 1;
  const range = document.createRange();
  range.setStart(index.nodes[start], index.offsets[start]);
  range.setEnd(index.nodes[end], index.offsets[end] + 1);
  return range;
}

export function clearOutline(frame: HTMLElement) {
  frame.querySelectorAll(`.${OUTLINE_CLASS}`).forEach((el) => el.remove());
}

/** Outlines the suggestion in red and scrolls it into view. Returns false when it cannot be found. */
export function outlineSuggestion(
  frame: HTMLElement,
  originalText: string | null,
  suggestedText: string | null,
  { scroll = true }: { scroll?: boolean } = {},
): boolean {
  clearOutline(frame);
  const range =
    (originalText && findRange(frame, originalText, "ins")) ||
    (suggestedText && findRange(frame, suggestedText, "del")) ||
    null;
  if (!range) return false;

  const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
  if (!rects.length) return false;
  const frameRect = frame.getBoundingClientRect();
  const top = Math.min(...rects.map((r) => r.top));
  const bottom = Math.max(...rects.map((r) => r.bottom));
  const left = Math.min(...rects.map((r) => r.left));
  const right = Math.max(...rects.map((r) => r.right));
  const pad = 4;

  // Placed in the scrolling frame rather than inside the page, so it is in
  // screen pixels whatever the page has been scaled to.
  const box = document.createElement("div");
  box.className = OUTLINE_CLASS;
  Object.assign(box.style, {
    position: "absolute",
    top: `${top - frameRect.top + frame.scrollTop - pad}px`,
    left: `${left - frameRect.left + frame.scrollLeft - pad}px`,
    width: `${right - left + pad * 2}px`,
    height: `${bottom - top + pad * 2}px`,
    border: "2px solid rgb(220 38 38)",
    borderRadius: "4px",
    boxShadow: "0 0 0 4px rgb(220 38 38 / 0.15)",
    pointerEvents: "none",
    zIndex: "5",
  });
  frame.appendChild(box);
  if (scroll) box.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
