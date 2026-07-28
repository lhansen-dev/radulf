# Cart Pricing

A small cart-pricing module (`src/cart.js`) with its unit tests.

Pricing rules:

- **Subtotal** — sum of price × quantity; an item without a quantity counts
  as quantity 1.
- **Discount** — carts with a subtotal of $100 or more get 10% off.
- **Shipping** — free when the discounted subtotal is at least $50 (and for
  empty carts); otherwise a flat $7.50.
- **Total** — discounted subtotal plus shipping, rounded to cents.

Test: `npm test` (runs the built-in `node --test` runner, no dependencies).
