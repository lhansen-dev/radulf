Add tags to the notes API

The notes API (`src/handlers.js`, thin HTTP wiring in `src/server.js`) stores
notes as `{ id, title }`. Add support for tagging notes and filtering by tag.
The HTTP layer already parses query-string parameters into the object passed
to `listNotes`, so this is a handlers-and-tests change only — do not modify
`src/server.js` or `src/store.js`.

### `createNote`

- The payload may include an optional `tags` field. When present it must be
  an array of nonempty strings; anything else (a string, a number, an array
  containing an empty or non-string entry, …) is rejected with status 400 and
  an `error` message, and the notes array is left unchanged.
- Tag strings are stored trimmed. When `tags` is absent, the created note
  gets `tags: []`. The created note in `body` must carry the `tags` array.

### `listNotes`

- When the query object has a `tag` property, return only the notes whose
  `tags` array includes that exact tag. Notes without a `tags` field are
  treated as having none. Without a `tag` query param, behavior is unchanged.

### Tests

Extend `test/handlers.test.js` to cover: creating a note with valid tags,
rejecting invalid `tags` payloads with 400, defaulting to an empty `tags`
array, and filtering `listNotes` by tag (matching and non-matching).

All tests must pass with `npm test` (`node --test`).
