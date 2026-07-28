Show a priority badge on the task board

The task board (`src/render.js`, served by `src/server.js`) renders each task
with a title and a status pill, but a task's `priority` field ("high" or
"normal") is currently invisible. Surface it:

### `renderItem`

- Tasks whose `priority` is `"high"` must render a badge element
  `<span class="badge badge-high">high</span>` immediately after the title
  span, inside the `<li>`.
- Tasks with any other priority must render **no** badge element at all — the
  markup for a normal task must not contain the string `badge`.

### `renderList`

- The `<h1>` header line must be followed by a summary element
  `<span class="high-count">N high</span>` where `N` is the number of items
  whose priority is `"high"` (render it even when `N` is 0).

### Tests

Extend `test/render.test.js` with tests covering:

- a high-priority item renders the `badge-high` badge;
- a normal-priority item renders no badge;
- `renderList` reports the correct high-priority count.

All tests must pass with `npm test` (`node --test`). Do not change
`src/server.js` or `data.json` — this is a rendering-only change.
