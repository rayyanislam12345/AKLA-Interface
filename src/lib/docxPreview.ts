// What every docx-preview rendering needs after renderAsync so that it
// reads as Word shows the file. The CSS half is in index.css under
// "A Word file drawn by docx-preview".
//
// docx-preview draws a paragraph's number as ::before content followed by a
// tab, and the tab collapses to one space, so the first line's text starts
// right after the number rather than at the hanging indent where Word puts
// it. Each numbered paragraph gets its hanging indent as --docx-hang, and
// the ::before takes that as its minimum width.
export function applyDocxFixes(container: ParentNode): void {
  for (const p of container.querySelectorAll<HTMLElement>('p[class*="docx-num-"]')) {
    const hang = -parseFloat(getComputedStyle(p).textIndent);
    if (hang > 0) p.style.setProperty("--docx-hang", `${hang}px`);
  }
}
