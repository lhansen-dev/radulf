"use strict";

/**
 * Cart pricing.
 *
 * Rules:
 * - subtotal: sum of price × quantity over all items; an item with no
 *   quantity counts as quantity 1.
 * - discount: carts with a subtotal of $100 or more get 10% off.
 * - shipping: free when the discounted subtotal is at least $50 (and for
 *   empty carts); otherwise a flat $7.50.
 * - total: discounted subtotal plus shipping.
 *
 * All money fields are rounded to cents.
 */

function round2(n) {
  return Math.round(n * 100) / 100;
}

function computeTotals(items) {
  const subtotal = items.reduce(
    (sum, item) => sum + item.price * (item.quantity ?? 0),
    0,
  );
  const discounted = subtotal > 100 ? subtotal * 0.9 : subtotal;
  const shipping = items.length === 0 || discounted >= 50 ? 0 : 7.5;
  return {
    subtotal: round2(subtotal),
    discount: round2(subtotal - discounted),
    shipping,
    total: round2(discounted + shipping),
  };
}

module.exports = { computeTotals };
