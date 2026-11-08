// Shared helper for views that frame raw files (images, text) next to the app:
// the framed page gets the app's dark background and scrollbars.
export function darkFrame(fr) {
  try {
    const d = fr.contentDocument; if (!d || d.getElementById("k-dark")) return;
    const s = d.createElement("style"); s.id = "k-dark";
    const tok = (n, f) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || f; // the app's theme
    const bg = tok("--bg", "#000"), line = tok("--line", "#333333");
    s.textContent = `:root{color-scheme:dark;scrollbar-color:${line} ${bg};background:${bg}!important}body{background:${bg}!important;margin:0}body>img:only-child{display:block;max-width:100%;height:auto;margin:0 auto;background:${bg}!important}`;
    (d.head || d.documentElement).appendChild(s);
  } catch { /* other origin: leave it */ }
}
