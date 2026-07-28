"use strict";

const fs = require("node:fs");

/** Read the notes array from a JSON file; missing file means no notes. */
function readNotes(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
}

/** Persist the notes array to a JSON file. */
function writeNotes(file, notes) {
  fs.writeFileSync(file, JSON.stringify(notes, null, 2) + "\n");
}

module.exports = { readNotes, writeNotes };
