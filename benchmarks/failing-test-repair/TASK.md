Repair the failing cart-pricing tests

The test suite in this repo is failing: `npm test` (`node --test`) reports 2
of 8 tests failing. The tests are correct — they encode the pricing rules
documented in `README.md` and in the header comment of `src/cart.js`:

- **Subtotal** — sum of price × quantity; an item without a quantity counts
  as quantity 1.
- **Discount** — carts with a subtotal of $100 or more get 10% off.
- **Shipping** — free when the discounted subtotal is at least $50 (and for
  empty carts); otherwise a flat $7.50.
- **Total** — discounted subtotal plus shipping, rounded to cents.

Diagnose the failures and fix the production code in `src/cart.js` so the
whole suite passes.

**Do not modify `test/cart.test.js` in any way** — the acceptance check
verifies the test file is byte-identical to its current state. Do not delete
or weaken tests; the fix belongs in the production module.
