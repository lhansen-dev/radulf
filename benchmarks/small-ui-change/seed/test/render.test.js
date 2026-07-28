"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { escapeHtml, renderItem, renderList, renderPage } = require("../src/render.js");

test("escapeHtml escapes markup characters", () => {
  assert.strictEqual(escapeHtml('<b>"&"</b>'), "&lt;b&gt;&quot;&amp;&quot;&lt;/b&gt;");
});

test("renderItem shows the title and a status class", () => {
  const html = renderItem({ id: 7, title: "Ship it", status: "open", priority: "normal" });
  assert.ok(html.includes('data-id="7"'));
  assert.ok(html.includes('<span class="title">Ship it</span>'));
  assert.ok(html.includes("status-open"));
});

test("renderItem escapes untrusted titles", () => {
  const html = renderItem({ id: 1, title: "<script>x</script>", status: "open", priority: "normal" });
  assert.ok(!html.includes("<script>"));
});

test("renderList shows the item count", () => {
  const items = [
    { id: 1, title: "a", status: "open", priority: "normal" },
    { id: 2, title: "b", status: "done", priority: "normal" },
  ];
  const html = renderList(items);
  assert.ok(html.includes("Tasks (2)"));
  assert.strictEqual(html.match(/<li /g).length, 2);
});

test("renderPage wraps the list in a document", () => {
  const html = renderPage([]);
  assert.ok(html.startsWith("<!doctype html>"));
  assert.ok(html.includes("Tasks (0)"));
});
