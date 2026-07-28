"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { listNotes, getNote, createNote } = require("../src/handlers.js");

const sample = [
  { id: 1, title: "groceries" },
  { id: 2, title: "call plumber" },
];

test("listNotes returns every note", () => {
  const r = listNotes(sample, {});
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.length, 2);
});

test("getNote finds a note by id", () => {
  const r = getNote(sample, "2");
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.title, "call plumber");
});

test("getNote 404s on unknown id", () => {
  const r = getNote(sample, "99");
  assert.strictEqual(r.status, 404);
});

test("createNote appends with the next id", () => {
  const r = createNote(sample, { title: "  water plants  " });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(r.body.id, 3);
  assert.strictEqual(r.body.title, "water plants");
  assert.strictEqual(r.notes.length, 3);
  assert.strictEqual(sample.length, 2, "input array must not be mutated");
});

test("createNote rejects a missing or empty title", () => {
  assert.strictEqual(createNote(sample, {}).status, 400);
  assert.strictEqual(createNote(sample, { title: "   " }).status, 400);
  assert.strictEqual(createNote(sample, { title: 7 }).status, 400);
});
