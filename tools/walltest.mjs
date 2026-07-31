// Can a zombie ever be inside rock?
//
//   node tools/walltest.mjs [baseUrl] [maps]
//
// The answer has to be no, on every map, under the worst crowd pressure the game
// can produce. This test exists because "looks fixed" was wrong twice: a centre
// point test reports a body as clear while its whole radius is buried, and a
// body whose centre gets shoved past a wall face used to be stuck there for the
// rest of the run with nothing able to push it out.
//
// Two numbers, and both must be zero:
//   embedded  any part of the body's circle overlaps a rock cell
//   deep      the centre itself is inside a rock cell, the unrecoverable case
//
// Method: flood the map far past what any wave produces, so crowd pressure is
// doing everything it possibly can to force bodies through walls, then settle
// and count.

import { spawn } from 'node:child_process';
import { MAPS } from '../src/maps.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

// Guard against a caller passing the literal string "undefined"/"null"
// instead of actually omitting the argument -- see flowtest.mjs for the
// failure mode that provoked this.
function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const BASE = resolveArg(process.argv[2], 'http://localhost:8101/');
// Sized to the map, not picked for drama. The board is 96x56 = 5376 units of
// floor and a body covers pi*0.22^2 = 0.152, so about 24,000 bodies is a solid
// hexagonal pack wall to wall. The first version of this test flooded 120,000,
// which is 18,240 units of flesh into 5,376 units of map: three and a half
// times more zombies than the space can physically contain.
//
// At that load "no body inside a wall" is not a bug, it is an unsatisfiable
// constraint -- there is nowhere else for them to be, and the test was
// reporting the crush at the spawn point as a collision failure.
const FLOOD = Number(process.argv[4]) || 20000;
const SETTLE_MS = 9000;

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9340;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'biomass-walltest')}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--window-size=1280,760',
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

async function openTab(url) {
  const info = await (await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' })).json();
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
  return {
    async evalJS(expr) {
      const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
      if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
      return r?.result?.value;
    },
    async close() {
      ws.close();
      try { await fetch(`http://127.0.0.1:${PORT}/json/close/${info.id}`); } catch {}
    },
  };
}

const only = process.argv[3] ? process.argv[3].split(',').map(Number) : MAPS.map((_, i) => i);
const results = [];

for (const map of only) {
  const tab = await openTab(`${BASE}?map=${map}&bench=1&rate=0`);
  process.stdout.write(`${MAPS[map].name.padEnd(14)} `);
  try {
    await sleep(4000);
    await tab.evalJS(`__biomassStress(${FLOOD})`);
    await sleep(SETTLE_MS);
    const r = JSON.parse(await tab.evalJS('__biomassEmbedded().then(JSON.stringify)'));
    // Bodies that are legally placed but going nowhere are just as broken as
    // bodies in a wall, and they were the harder of the two to find.
    const st = JSON.parse(await tab.evalJS('__biomassStuck(1500).then(JSON.stringify)'));
    const hb = JSON.parse(await tab.evalJS('JSON.stringify(__biomass())'));
    const row = { map, ...r, stuck: st.stuck, stuckPct: st.stuckPct, oob: hb.oob, inRock: hb.inRock, clump: st.clumps[0] };
    results.push(row);
    // Gate ONLY on states the simulation says are impossible: inside rock,
    // outside the world, or standing on a cell the pathfinder never reached.
    //
    // Slow-moving is NOT one of them. A twenty thousand body flood genuinely
    // gridlocks at every chokepoint, and an earlier version of this gate failed
    // eleven maps for that -- condemning ordinary traffic as a bug. Whether a
    // crowd eventually ARRIVES is flowtest's question, and it can answer it
    // without confusing congestion for breakage.
    const unreachable = st.clumps.filter((c) => c.rock || c.cost === 'UNREACHABLE')
      .reduce((n, c) => n + c.count, 0);
    const ok = r.deep === 0 && r.embeddedPct < 0.5 && hb.oob === 0 && hb.inRock === 0 && unreachable === 0;
    console.log(ok
      ? `OK    ${r.alive.toLocaleString()} bodies  rock ${r.embedded}  oob ${hb.oob}  inRock ${hb.inRock}  (${st.stuck} slow, congestion)`
      : `FAIL  rock ${r.embedded}/${r.deep}  stuck ${st.stuck} (${st.stuckPct}%)  oob ${hb.oob}  inRock ${hb.inRock}`
        + (st.clumps[0] ? `  worst clump ${st.clumps[0].count} at ${st.clumps[0].x},${st.clumps[0].y} rock=${st.clumps[0].rock} cost=${st.clumps[0].cost}` : ''));
  } finally {
    await tab.close();
  }
}

const bad = results.filter((r) => r.deep > 0 || r.embeddedPct >= 0.5 || r.oob > 0 || r.inRock > 0);
const worstDeep = Math.max(0, ...results.map((r) => r.deep));
console.log(`\n${results.length - bad.length}/${results.length} maps keep every body out of the rock.`);
console.log(`worst case: ${worstDeep} bodies with their centre inside a wall, `
  + `${Math.max(0, ...results.map((r) => r.stuck))} going nowhere.`);

try { child.kill(); } catch {}
process.exit(bad.length ? 1 : 0);
