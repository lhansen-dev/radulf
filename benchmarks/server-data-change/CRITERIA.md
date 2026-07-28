# Acceptance criteria — Add tags to the notes API

Each line is a command that the runner executes inside the candidate's
worktree. A criterion passes when the command exits 0 (or `succeeds`).

- `node --test` exits 0
- `node -e "const {createNote}=require('./src/handlers.js');const r=createNote([],{title:'a',tags:[' x ','y']});if(r.status!==201||!Array.isArray(r.body.tags)||r.body.tags.length!==2||r.body.tags[0]!=='x')process.exit(1)"` exits 0
- `node -e "const {createNote}=require('./src/handlers.js');if(createNote([],{title:'a',tags:'x'}).status!==400||createNote([],{title:'a',tags:['']}).status!==400||createNote([],{title:'a',tags:[7]}).status!==400)process.exit(1)"` exits 0
- `node -e "const {createNote}=require('./src/handlers.js');const r=createNote([],{title:'a'});if(r.status!==201||!Array.isArray(r.body.tags)||r.body.tags.length!==0)process.exit(1)"` exits 0
- `node -e "const {listNotes}=require('./src/handlers.js');const notes=[{id:1,title:'a',tags:['x']},{id:2,title:'b',tags:['y']},{id:3,title:'c'}];const r=listNotes(notes,{tag:'x'});if(r.status!==200||r.body.length!==1||r.body[0].id!==1)process.exit(1)"` exits 0
- `node -e "const {listNotes}=require('./src/handlers.js');const notes=[{id:1,title:'a',tags:['x']}];const r=listNotes(notes,{});if(r.status!==200||r.body.length!==1)process.exit(1)"` exits 0
- `node -e "const t=require('fs').readFileSync('test/handlers.test.js','utf8');if(!/tag/.test(t))process.exit(1)"` exits 0
- `node -e "const c=require('crypto'),f=require('fs');const h=p=>c.createHash('sha256').update(f.readFileSync(p)).digest('hex');if(h('src/server.js')!=='676b53d7a36a58db044cef15de8ef178bdd226429d92db008dae0d26b102d85d'||h('src/store.js')!=='28efc640f70086f9cef1ceb26f75b854ecb5fc81a479fbfec800a3d7b3eee64d')process.exit(1)"` exits 0
