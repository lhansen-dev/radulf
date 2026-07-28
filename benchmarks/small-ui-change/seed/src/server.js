"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { renderPage } = require("./render.js");

const DATA_FILE = path.join(__dirname, "..", "data.json");
const PORT = process.env.PORT ? Number(process.env.PORT) : 3999;

const server = http.createServer((req, res) => {
  const items = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(renderPage(items));
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Task board listening on http://localhost:${PORT}`);
  });
}

module.exports = { server };
