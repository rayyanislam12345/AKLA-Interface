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

function findRange(root: HTMLElement, wanted: string, skip: "ins" | "del", allowPrefix: boolean): Range | null {
  return rangeIn(indexText(root, skip), wanted, allowPrefix);
}

function rangeIn(index: CharIndex, wanted: string, allowPrefix: boolean): Range | null {
  const needle = squash(plainText(wanted));
  if (needle.length < 3) return null;
  let start = index.text.indexOf(needle);
  let length = needle.length;
  // A long quote can differ from the page by one character somewhere; its
  // opening words are still enough to find the clause.
  if (start < 0 && allowPrefix && needle.length > 80) {
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
  { scroll = true, accepted = false }: { scroll?: boolean; accepted?: boolean } = {},
): boolean {
  clearOutline(frame);
  // An accepted suggestion's new wording is what the page now shows, so it
  // is looked for first. Exact matches are all tried before the looser
  // opening-words match, which would otherwise find the old wording's first
  // line and box a stretch the length of the old wording.
  const readings: Array<[string | null, "ins" | "del"]> = accepted
    ? [[suggestedText, "del"], [originalText, "ins"]]
    : [[originalText, "ins"], [suggestedText, "del"]];
  let range: Range | null = null;
  for (const allowPrefix of [false, true]) {
    for (const [text, skip] of readings) {
      if (!range && text) range = findRange(frame, text, skip, allowPrefix);
    }
  }
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

interface Locatable {
  id: string;
  original_text: string | null;
  suggested_text: string | null;
}

function caretAt(x: number, y: number): { node: Node; offset: number } | null {
  const doc = document as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const position = doc.caretPositionFromPoint?.(x, y);
  if (position) return { node: position.offsetNode, offset: position.offset };
  const range = doc.caretRangeFromPoint?.(x, y);
  return range ? { node: range.startContainer, offset: range.startOffset } : null;
}

/**
 * The suggestion whose words were clicked in the preview, if any. Both
 * readings are checked, so a click on struck-out old words and a click on
 * underlined new ones both find it. Where passages nest, the smallest wins.
 */
export function suggestionAtPoint<T extends Locatable>(frame: HTMLElement, target: Node, x: number, y: number, suggestions: T[]): T | null {
  const withoutInserted = indexText(frame, "ins");
  const withoutDeleted = indexText(frame, "del");
  const caret = caretAt(x, y);
  const useCaret = caret && frame.contains(caret.node) && caret.node.nodeType === Node.TEXT_NODE;
  let best: { suggestion: T; length: number } | null = null;
  for (const suggestion of suggestions) {
    for (const allowPrefix of [false, true]) {
      const ranges = [
        suggestion.original_text ? rangeIn(withoutInserted, suggestion.original_text, allowPrefix) : null,
        suggestion.suggested_text ? rangeIn(withoutDeleted, suggestion.suggested_text, allowPrefix) : null,
      ].filter((r): r is Range => r !== null);
      if (!ranges.length) continue;
      const hit = ranges.find((r) => (useCaret ? r.comparePoint(caret.node, caret.offset) === 0 : r.intersectsNode(target)));
      if (hit) {
        const length = hit.toString().length;
        if (!best || length < best.length) best = { suggestion, length };
      }
      break;
    }
  }
  return best?.suggestion ?? null;
}
