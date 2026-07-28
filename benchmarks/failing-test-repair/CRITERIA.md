# Acceptance criteria — Repair the failing cart-pricing tests

Each line is a command that the runner executes inside the candidate's
worktree. A criterion passes when the command exits 0 (or `succeeds`).

- `node --test` exits 0
- `node -e "const c=require('crypto'),f=require('fs');const h=c.createHash('sha256').update(f.readFileSync('test/cart.test.js')).digest('hex');if(h!=='82a37b7e930755c4497e8425424f9bbdb2d220eb17ad3513e46f8e83ee246f79')process.exit(1)"` exits 0
- `node -e "const {computeTotals}=require('./src/cart.js');const t=computeTotals([{price:100,quantity:1}]);if(t.discount!==10||t.total!==90)process.exit(1)"` exits 0
- `node -e "const {computeTotals}=require('./src/cart.js');const t=computeTotals([{price:20}]);if(t.subtotal!==20)process.exit(1)"` exits 0
- `node -e "const {computeTotals}=require('./src/cart.js');const t=computeTotals([{price:10,quantity:2}]);if(t.shipping!==7.5||t.total!==27.5)process.exit(1)"` exits 0
