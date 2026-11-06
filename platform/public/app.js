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
// On phones, list tables show as one card per row: give every cell its column heading as a label.
// The tax invoice and the invoice line editor have their own layouts.
document.querySelectorAll("table").forEach((table) => {
  if (table.closest(".invoice") || table.classList.contains("lines")) return;
  const head = table.querySelector("thead tr");
  if (!head) return;
  const labels = [];
  for (const th of head.children) for (let i = 0; i < (th.colSpan || 1); i++) labels.push(th.textContent.trim());
  table.querySelectorAll("tbody tr, tfoot tr").forEach((tr) => {
    let col = 0;
    for (const td of tr.children) {
      if (!td.hasAttribute("data-label")) td.setAttribute("data-label", (td.colSpan || 1) > 1 ? "" : labels[col] ?? "");
      col += td.colSpan || 1;
    }
  });
  table.classList.add("stack-sm");
});
