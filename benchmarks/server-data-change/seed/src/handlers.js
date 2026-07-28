"use strict";

/**
 * Pure request handlers. Each takes the current notes array (never mutated)
 * plus request data, and returns { status, body } — createNote also returns
 * the next notes array as `notes`.
 */

/** GET /notes — list notes. `query` holds the parsed query-string params. */
function listNotes(notes, query = {}) {
  return { status: 200, body: notes };
}

/** GET /notes/:id */
function getNote(notes, id) {
  const note = notes.find((n) => n.id === Number(id));
  if (!note) return { status: 404, body: { error: "note not found" } };
  return { status: 200, body: note };
}

/** POST /notes — payload must have a nonempty string title. */
function createNote(notes, payload) {
  const title = payload && payload.title;
  if (typeof title !== "string" || title.trim() === "") {
    return { status: 400, body: { error: "title must be a nonempty string" }, notes };
  }
  const id = notes.reduce((max, n) => Math.max(max, n.id), 0) + 1;
  const note = { id, title: title.trim() };
  return { status: 201, body: note, notes: [...notes, note] };
}

module.exports = { listNotes, getNote, createNote };
