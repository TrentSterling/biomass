// Scale benchmark: how many zombies before the frame budget goes.
//
//   node tools/bench.mjs [baseUrl] [stepSize]
//
// Pours zombies in step by step with no turrets built, letting each population
// settle before sampling, and reports the curve rather than one number. The
// interesting output is where 60 fps breaks and where 30 does, because those are
// the two numbers a design decision actually rests on.

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Guard against a caller passing the literal string "undefined"/"null"
// instead of actually omitting the argument -- see flowtest.mjs for the
// failure mode that provoked this.
function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const BASE = resolveArg(process.argv[2], 'http://localhost:8101/');
const STEP = Number(process.argv[3]) || 25000;
const CAP = Number(process.argv[4]) || 1500000;
// The capacity cap is ours, not the hardware's: bench above it or you measure
// the buffer size instead of the GPU.
const URL_ = `${BASE}?map=0&bench=1&rate=0&perf=1&zombies=${CAP}`;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9339;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'biomass-bench')}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--window-size=1600,900',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (let i = 0; i < 60; i++) {
  try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) break; } catch {}
  await sleep(250);
}
const info = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' })).json();
const ws = new WebSocket(info.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (e) => {
  const m = JSON.parse(e.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const call = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res);
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalJS = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r?.result?.value;
};

await sleep(5000);
console.log('alive        fps    frame     compute    render');
const rows = [];
for (let n = 0; n < 40; n++) {
  await evalJS(`__biomassStress(${STEP})`);
  await sleep(4000);                       // let the population settle and the average catch up
  const p = JSON.parse(await evalJS('JSON.stringify(__biomassPerf())'));
  rows.push(p);
  console.log(
    `${String(p.alive).padStart(9)}  ${String(p.fps).padStart(5)}  ${String(p.frameMs).padStart(7)}ms`
    + `  ${String(p.computeMs ?? '?').padStart(8)}ms  ${String(p.renderMs ?? '?').padStart(7)}ms`,
  );
  if (p.fps < 20) break;
}

// The LARGEST population that held the rate, not the last one sampled at it.
// Late in a run the horde is draining, so the final qualifying row is a small
// population at 60 fps and reports a number far below what the GPU managed.
const under = (limit) => Math.max(0, ...rows.filter((r) => r.fps >= limit).map((r) => r.alive));
console.log(`\n60 fps up to ~${under(58).toLocaleString()} zombies`);
console.log(`30 fps up to ~${under(29).toLocaleString()} zombies`);
const peak = rows.reduce((a, b) => (b.alive > a.alive ? b : a), rows[0]);
console.log(`peak tested ${peak.alive.toLocaleString()} at ${peak.fps} fps (compute ${peak.computeMs}ms)`);

ws.close();
try { child.kill(); } catch {}
process.exit(0);
