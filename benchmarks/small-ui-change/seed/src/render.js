"use strict";

/** Escape a string for safe interpolation into HTML text content. */
function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** Render one task as a list item. */
function renderItem(item) {
  return [
    `<li class="item" data-id="${escapeHtml(item.id)}">`,
    `<span class="title">${escapeHtml(item.title)}</span>`,
    `<span class="status status-${escapeHtml(item.status)}">${escapeHtml(item.status)}</span>`,
    `</li>`,
  ].join("");
}

/** Render the full task list with a count header. */
function renderList(items) {
  const lis = items.map(renderItem).join("\n");
  return [
    `<section class="board">`,
    `<h1>Tasks (${items.length})</h1>`,
    `<ul class="items">`,
    lis,
    `</ul>`,
    `</section>`,
  ].join("\n");
}

/** Render the whole page document. */
function renderPage(items) {
  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head><meta charset="utf-8"><title>Task Board</title></head>`,
    `<body>`,
    renderList(items),
    `</body>`,
    `</html>`,
  ].join("\n");
}

module.exports = { escapeHtml, renderItem, renderList, renderPage };
