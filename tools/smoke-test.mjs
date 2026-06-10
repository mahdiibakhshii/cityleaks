// Smoke test for the server protocol: two game clients + one TD client.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { io } = require('../client/node_modules/socket.io-client');

const URL = 'http://localhost:3000';
const log = (...a) => console.log(...a);
let pass = 0;
const expect = (cond, msg) => {
  log(`${cond ? '✓' : '✗'} ${msg}`);
  if (cond) pass++;
};

const a = io(URL, { transports: ['websocket'] });
let aSelf = null;

a.on('player:self', (self) => {
  aSelf = self;
  expect(!!self.id && !!self.color, `A got player:self (color ${self.color})`);
});
a.on('player:existing', (list) => {
  expect(Array.isArray(list) && list.length >= 1, `A got player:existing (${list.length})`);
});

a.on('connect', () => {
  setTimeout(() => {
    const b = io(URL, { transports: ['websocket'] });
    let aSawJoin = false;
    a.on('player:join', (p) => {
      if (p.id === b.id) aSawJoin = true;
    });

    b.on('connect', () => {
      // Move B to a random spot to mark a (likely) fresh leak cell. The grid
      // persists across runs, so a fixed point would stop yielding deltas.
      const rx = Math.floor(Math.random() * 5000);
      const ry = Math.floor(Math.random() * 5000);
      setTimeout(() => b.emit('player:move', { x: rx, y: ry }), 100);
    });
    b.on('state:update', () => {});

    // TD client.
    const td = io(URL, { transports: ['websocket'], query: { role: 'td' } });
    let gotFull = false;
    let gotDelta = false;
    td.on('grid:full', (buf) => {
      gotFull = true;
      const len = buf?.byteLength ?? buf?.length;
      expect(len === 125000, `TD grid:full is 125000 bytes (got ${len})`);
    });
    td.on('grid:delta', (d) => {
      if (Array.isArray(d.cells) && d.cells.length > 0) gotDelta = true;
    });

    setTimeout(() => {
      expect(aSawJoin, 'A received player:join for B');
      expect(gotFull, 'TD received grid:full');
      expect(gotDelta, 'TD received grid:delta after B moved');

      // Disconnect B, expect A to see player:leave.
      const bId = b.id; // capture before close (socket.id clears on disconnect)
      let aSawLeave = false;
      a.on('player:leave', (d) => {
        if (d.id === bId) aSawLeave = true;
      });
      b.close();
      setTimeout(() => {
        expect(aSawLeave, 'A received player:leave for B');
        log(`\n${pass}/7 checks passed`);
        a.close();
        td.close();
        process.exit(pass === 7 ? 0 : 1);
      }, 400);
    }, 700);
  }, 200);
});

setTimeout(() => {
  log('Timed out');
  process.exit(1);
}, 8000);
