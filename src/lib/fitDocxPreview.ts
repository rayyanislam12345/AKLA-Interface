// A Word page renders at its real width, about 800 pixels, which is wider
// than a side panel on most screens, so the page was cut off. The pages are
// scaled down to fit the frame instead, and follow it as it is resized.
// Returns a function that stops following.
export function fitDocxPreview(frame: HTMLElement): () => void {
  let pageWidth = 0;
  const fit = () => {
    const wrapper = frame.querySelector<HTMLElement>(".docx-wrapper");
    if (!wrapper) return;
    if (!pageWidth) {
      const pages = [...wrapper.querySelectorAll<HTMLElement>("section.docx")];
      if (!pages.length) return;
      const style = getComputedStyle(wrapper);
      pageWidth = Math.max(...pages.map((page) => page.offsetWidth)) + parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    }
    const available = frame.clientWidth - parseFloat(getComputedStyle(frame).paddingLeft) - parseFloat(getComputedStyle(frame).paddingRight);
    wrapper.style.setProperty("zoom", String(Math.min(1, available / pageWidth)));
  };
  fit();
  const observer = new ResizeObserver(fit);
  observer.observe(frame);
  return () => observer.disconnect();
}
