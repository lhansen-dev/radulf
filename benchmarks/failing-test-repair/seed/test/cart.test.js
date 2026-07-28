"use strict";

const { test } = require("node:test");
const assert = require("node:assert");
const { computeTotals } = require("../src/cart.js");

test("subtotal sums price times quantity", () => {
  const t = computeTotals([
    { price: 10, quantity: 2 },
    { price: 5, quantity: 3 },
  ]);
  assert.strictEqual(t.subtotal, 35);
});

test("an item with no quantity counts as one", () => {
  const t = computeTotals([{ price: 20 }]);
  assert.strictEqual(t.subtotal, 20);
});

test("no discount below one hundred dollars", () => {
  const t = computeTotals([{ price: 99.99, quantity: 1 }]);
  assert.strictEqual(t.discount, 0);
});

test("ten percent discount at exactly one hundred dollars", () => {
  const t = computeTotals([{ price: 100, quantity: 1 }]);
  assert.strictEqual(t.discount, 10);
  assert.strictEqual(t.total, 90);
});

test("ten percent discount above one hundred dollars", () => {
  const t = computeTotals([{ price: 60, quantity: 2 }]);
  assert.strictEqual(t.discount, 12);
  assert.strictEqual(t.total, 108);
});

test("flat shipping under the free-shipping threshold", () => {
  const t = computeTotals([{ price: 10, quantity: 2 }]);
  assert.strictEqual(t.shipping, 7.5);
  assert.strictEqual(t.total, 27.5);
});

test("free shipping from fifty dollars discounted", () => {
  const t = computeTotals([{ price: 50, quantity: 1 }]);
  assert.strictEqual(t.shipping, 0);
  assert.strictEqual(t.total, 50);
});

test("empty cart is all zeros", () => {
  const t = computeTotals([]);
  assert.deepStrictEqual(t, { subtotal: 0, discount: 0, shipping: 0, total: 0 });
});
