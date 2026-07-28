# Notes API

A small JSON-file-backed notes service. Pure request handlers in
`src/handlers.js` (fully testable without a socket), JSON persistence in
`src/store.js`, and a thin `node:http` wrapper in `src/server.js`.

- Run: `npm start` (or `node src/server.js`), then `curl localhost:3998/notes`
- Test: `npm test` (runs the built-in `node --test` runner, no dependencies)

Endpoints: `GET /notes`, `GET /notes/:id`, `POST /notes {"title": "..."}`.
