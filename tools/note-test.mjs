import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { io } = require('../client/node_modules/socket.io-client');

const URL = process.env.URL || 'http://localhost:3199';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(query = {}) {
  return io(URL, { query, transports: ['websocket'], reconnection: false });
}

let pass = 0;
let fail = 0;
const check = (name, ok) => {
  console.log(`${ok ? '✓' : '✗'} ${name}`);
  ok ? pass++ : fail++;
};

const a = connect(); // game player A
const b = connect(); // game player B

const aExisting = new Promise((res) => a.on('note:existing', res));
const bNew = new Promise((res) => b.on('note:new', res));
const aNew = new Promise((res) => a.on('note:new', res));

await Promise.all([
  new Promise((r) => a.on('player:self', r)),
  new Promise((r) => b.on('player:self', r)),
]);

const existing = await aExisting;
check('note:existing is an array on connect', Array.isArray(existing));

// A sticks a note; both A (sender) and B should receive note:new.
a.emit('note:create', { x: 7000, y: 6000, text: '  hello vienna  ' });

const [gotA, gotB] = await Promise.all([aNew, bNew]);
check('sender receives note:new', !!gotA && gotA.text === 'hello vienna');
check('other player receives note:new', !!gotB && gotB.text === 'hello vienna');
check('server assigned id', typeof gotA.id === 'string' && gotA.id.length > 0);
check('server trimmed whitespace', gotA.text === 'hello vienna');
check('position preserved', gotA.x === 7000 && gotA.y === 6000);

// Empty/whitespace-only notes must be rejected (no broadcast).
let rejected = true;
b.on('note:new', (n) => { if (n.text === '') rejected = false; });
a.emit('note:create', { x: 100, y: 100, text: '   ' });
await sleep(300);
check('empty note rejected', rejected);

// A fresh client should now receive the note in its existing snapshot.
const c = connect();
const cExisting = await new Promise((res) => c.on('note:existing', res));
check('new client sees prior note in snapshot', cExisting.some((n) => n.text === 'hello vienna'));

const status = await fetch(`${URL}/api/status`).then((r) => r.json());
check('status reports note count ≥ 1', status.notes >= 1);

a.close();
b.close();
c.close();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
