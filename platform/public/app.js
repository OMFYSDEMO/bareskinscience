// Small progressive enhancements. Every page works without this file.
document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-confirm]");
  if (t && !confirm(t.dataset.confirm)) e.preventDefault();
  const add = e.target.closest("[data-add-line]");
  if (add) {
    const body = document.querySelector(".lines tbody"), last = body.lastElementChild, row = last.cloneNode(true);
    row.querySelectorAll("input").forEach((i) => (i.value = ""));
    row.querySelectorAll("select").forEach((s) => (s.selectedIndex = 0));
    body.appendChild(row);
  }
  const pr = e.target.closest("[data-print]");
  if (pr) window.print();
});
// Prevent double submission.
document.addEventListener("submit", (e) => {
  const b = e.target.querySelector("button[type=submit],button:not([type])");
  if (e.defaultPrevented) return;
  if (b) setTimeout(() => (b.disabled = true), 0);
});
