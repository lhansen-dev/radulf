"use strict";

const http = require("node:http");
const path = require("node:path");
const { readNotes, writeNotes } = require("./store.js");
const { listNotes, getNote, createNote } = require("./handlers.js");

const DATA_FILE = process.env.NOTES_FILE || path.join(__dirname, "..", "notes.json");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3998;

function send(res, { status, body }) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const notes = readNotes(DATA_FILE);
  const idMatch = url.pathname.match(/^\/notes\/(\d+)$/);

  if (req.method === "GET" && url.pathname === "/notes") {
    return send(res, listNotes(notes, Object.fromEntries(url.searchParams)));
  }
  if (req.method === "GET" && idMatch) {
    return send(res, getNote(notes, idMatch[1]));
  }
  if (req.method === "POST" && url.pathname === "/notes") {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      let payload;
      try {
        payload = JSON.parse(raw || "{}");
      } catch {
        return send(res, { status: 400, body: { error: "invalid JSON" } });
      }
      const result = createNote(notes, payload);
      if (result.status === 201) writeNotes(DATA_FILE, result.notes);
      send(res, result);
    });
    return;
  }
  send(res, { status: 404, body: { error: "not found" } });
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Notes API listening on http://localhost:${PORT}`);
  });
}

module.exports = { server };
