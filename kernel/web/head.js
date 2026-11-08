// The back control of every level header: one stroked chevron, the same box
// and hover in every view. The caller keeps its own class for placement.
export const BACK_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>';
export function backButton({ cls = "", tip = "Back", onclick }) {
  const b = document.createElement("button");
  b.type = "button"; b.className = `k-back ${cls}`.trim();
  b.dataset.tip = tip; b.setAttribute("aria-label", tip);
  b.innerHTML = BACK_SVG; b.onclick = onclick;
  return b;
}
