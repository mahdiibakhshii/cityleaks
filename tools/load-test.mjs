// Load test: spawn many fake players that random-walk and send player:move at
// 10 Hz, then watch the server's tick time via /api/status.
//
//   node tools/load-test.mjs                 # 100 bots, 20s
//   BOTS=150 DURATION=30 node tools/load-test.mjs
//
// Env: BOTS, DURATION (s), RATE (Hz), URL, MAP_SPAN, STEP, RAMP (s)
//
// Pass criteria (Phase 4): peak server tick < 50 ms, real browser clients stay
// smooth. Open a browser/monitor tab alongside this to eyeball client smoothness.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { io } = require('../client/node_modules/socket.io-client');

const URL = process.env.URL || 'http://localhost:3000';
const N = Number(process.env.BOTS || 100);
const DURATION = Number(process.env.DURATION || 20); // seconds of steady load
const RATE = Number(process.env.RATE || 10); // moves per second per bot
const SPAN = Number(process.env.MAP_SPAN || 17408); // map width/height (world units)
const STEP = Number(process.env.STEP || 15); // per-move walk distance (~speed/rate)
const RAMP = Number(process.env.RAMP || 3); // seconds to connect all bots over

const bots = [];
let connected = 0;
let rejected = 0;
let errors = 0;
let observerSU = 0; // state:update messages seen by bot #0 in the last second

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeBot(i) {
  const s = io(URL, { transports: ['websocket'], reconnection: false });
  const bot = { s, x: Math.random() * SPAN, y: Math.random() * SPAN, ready: false };

  s.on('connect', () => {
    connected++;
    bot.ready = true;
  });
  s.on('server:full', () => {
    rejected++;
  });
  s.on('connect_error', () => {
    errors++;
  });
  s.on('disconnect', () => {
    bot.ready = false;
  });
  if (i === 0) s.on('state:update', () => observerSU++); // sample broadcast health

  bots.push(bot);
}

function stepAll() {
  for (const bot of bots) {
    if (!bot.ready) continue;
    bot.x = clamp(bot.x + (Math.random() - 0.5) * 2 * STEP, 0, SPAN);
    bot.y = clamp(bot.y + (Math.random() - 0.5) * 2 * STEP, 0, SPAN);
    bot.s.emit('player:move', { x: bot.x, y: bot.y });
  }
}

async function fetchStatus() {
  try {
    const res = await fetch(`${URL}/api/status`);
    return await res.json();
  } catch {
    return null;
  }
}

async function main() {
  console.log(`Load test → ${URL}`);
  console.log(`  bots=${N}  rate=${RATE}Hz  ramp=${RAMP}s  steady=${DURATION}s\n`);

  // Ramp connections to avoid a thundering herd.
  const rampMs = RAMP * 1000;
  for (let i = 0; i < N; i++) {
    setTimeout(() => makeBot(i), Math.floor((i / N) * rampMs));
  }

  // Drive movement once the ramp begins.
  const moveTimer = setInterval(stepAll, 1000 / RATE);

  // Report every second.
  let peakTick = 0;
  const reportTimer = setInterval(async () => {
    const st = await fetchStatus();
    const su = observerSU;
    observerSU = 0;
    if (st) {
      peakTick = Math.max(peakTick, st.tickMs.max);
      console.log(
        `players=${String(st.players).padStart(3)}  ` +
          `tick last/avg/max = ${st.tickMs.last.toFixed(2)}/${st.tickMs.avg.toFixed(2)}/` +
          `${st.tickMs.max.toFixed(2)} ms  ` +
          `leaked=${st.leakedPercentage.toFixed(2)}%  ` +
          `bot0 state:update=${su}/s  (connected=${connected} rejected=${rejected} err=${errors})`
      );
    } else {
      console.log('(no /api/status response — is the server running?)');
    }
  }, 1000);

  // Run for ramp + steady duration, then tear down.
  await new Promise((r) => setTimeout(r, rampMs + DURATION * 1000));
  clearInterval(moveTimer);
  clearInterval(reportTimer);

  const final = await fetchStatus();
  console.log('\n──────── summary ────────');
  console.log(`connected:  ${connected}/${N}   rejected: ${rejected}   errors: ${errors}`);
  if (final) {
    console.log(`peak tick:  ${Math.max(peakTick, final.tickMs.max).toFixed(2)} ms`);
    console.log(`avg tick:   ${final.tickMs.avg.toFixed(2)} ms`);
    const peak = Math.max(peakTick, final.tickMs.max);
    console.log(peak < 50 ? '✓ PASS — peak tick under 50 ms' : '✗ FAIL — peak tick exceeded 50 ms');
  }

  for (const bot of bots) bot.s.close();
  setTimeout(() => process.exit(0), 300);
}

main();
