# Task Board

A small server-rendered task board. Pure render functions in `src/render.js`
produce HTML strings; `src/server.js` is a thin `node:http` wrapper that
serves `data.json` through them.

- Run: `npm start` (or `node src/server.js`), then open http://localhost:3999
- Test: `npm test` (runs the built-in `node --test` runner, no dependencies)
