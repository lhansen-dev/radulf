# Acceptance criteria — Show a priority badge on the task board

Each line is a command that the runner executes inside the candidate's
worktree. A criterion passes when the command exits 0 (or `succeeds`).

- `node --test` exits 0
- `node -e "const {renderItem}=require('./src/render.js');const h=renderItem({id:1,title:'t',status:'open',priority:'high'});if(!h.includes('badge-high'))process.exit(1)"` exits 0
- `node -e "const {renderItem}=require('./src/render.js');const h=renderItem({id:1,title:'t',status:'open',priority:'normal'});if(h.includes('badge'))process.exit(1)"` exits 0
- `node -e "const {renderList}=require('./src/render.js');const h=renderList([{id:1,title:'a',status:'open',priority:'high'},{id:2,title:'b',status:'open',priority:'normal'}]);const m=h.match(/high-count[^>]*>([^<]*)/);if(!m||!/\b1\b/.test(m[1]))process.exit(1)"` exits 0
- `node -e "const {renderList}=require('./src/render.js');const h=renderList([{id:1,title:'a',status:'open',priority:'normal'}]);const m=h.match(/high-count[^>]*>([^<]*)/);if(!m||!/\b0\b/.test(m[1]))process.exit(1)"` exits 0
- `node -e "const t=require('fs').readFileSync('test/render.test.js','utf8');if(!/badge/.test(t))process.exit(1)"` exits 0
- `node -e "const c=require('crypto'),f=require('fs');const h=p=>c.createHash('sha256').update(f.readFileSync(p)).digest('hex');if(h('src/server.js')!=='2e0f27ff18ccea3a6a1c879bf2602850af672aa1987c26a9556862765c0b1a3a'||h('data.json')!=='cac7284ff6b60c96b88e4bdd7bf11c37a74317bc8ca94e19f147e75a6e54fa84')process.exit(1)"` exits 0
