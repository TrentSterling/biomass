// Field charges smoke test: bait bombs must gather the horde, then throw it.
//
//   node tools/baittest.mjs [url]
//
// Method: an A/B control, not a single absolute-threshold snapshot. Two tabs
// boot the identical scenario (flood()'s spawn PRNG is seeded deterministically
// from a counter, not wall-clock time, so both scatter the crowd the same way);
// tab A fires bait via __biomassAbility, tab B does nothing. Both are sampled
// at the same wall-clock offsets and both restrict to a FIXED COHORT: zombies
// alive in every snapshot AND within capture range of the bait point at t0.
//
// Two confounds make a single-tab absolute comparison worthless here, both
// confirmed by direct measurement while building this:
//   1. leak-drain survivorship bias -- zombies that reach the base are always
//      the furthest-progressed, so the mean of whoever is still alive drifts
//      DOWN over time with zero ability effect. Fixed by tracking the same
//      slot indices across snapshots instead of "whoever is alive now".
//   2. path-midpoint contamination -- flood()'s centre point sits almost
//      exactly on this map's spawn-to-base path midpoint, so zombies near it
//      are mid-transit and their distance-to-point keeps changing from
//      ordinary walking alone, independent of any charge.
// The A/B control cancels both: tab B experiences the identical background
// dynamics, so any DIFFERENCE from tab A is the ability's own effect.
//
// Also runs a screenshot mid-attract for visual sanity.
//
// Throwaway harness, pattern-matched off tools/smoke.mjs.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const BASE = resolveArg(process.argv[2], 'http://localhost:8101/');
// bench=1&rate=0 keeps the base invulnerable and stops the ramp from adding
// more zombies mid-test. No ?spawn= here -- flood() scatters across a
// ~27-unit-radius SQUARE covering nearly the whole map, so upwards of 90% of
// a flood crowd sits outside the bait charge's 7-8 unit radius from frame
// one, which drowns any real gather/throw signal in walking noise from
// zombies the ability never touches at all (confirmed by direct measurement
// while building this test). __biomassStress() below spawns a tight,
// density-appropriate cluster at the map's actual spawn portal instead --
// the "a dense pack pours out of the portal, so you bait it" scenario the
// ability actually exists for.
const URL_ = `${BASE}?map=0&bench=1&rate=0`;
const STRESS_COUNT = 250;
// A bit past the 7-unit attract radius: stress()'s own spread already puts
// most of the cluster within a similar range of the portal, so unlike
// flood() this doesn't need a tight capture net just to avoid dilution.
const CAPTURE = 9;
const OUT = join(import.meta.dirname, '..', 'shots');
if (!existsSync(OUT)) mkdirSync(OUT);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Two SEPARATE Chrome processes (own window each), not two tabs in one window:
// a background TAB (as opposed to an occluded window) gets its rAF throttled
// hard regardless of the occlusion flags below, which are a window-level
// fix only. Two windows means each has its own foreground tab, so neither
// one is the "other tab" being throttled.
function launchChrome(port, profileSuffix, x) {
  const profile = join(process.env.TEMP ?? '.', `biomass-baittest-${profileSuffix}`);
  return spawn(CHROME, [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check',
    '--enable-unsafe-webgpu',
    '--window-size=1000,700',
    `--window-position=${x},40`,
    '--disable-features=CalculateNativeWinOcclusion',
    '--disable-backgrounding-occluded-windows',
    '--disable-renderer-backgrounding',
    '--disable-background-timer-throttling',
    'about:blank',
  ], { stdio: 'ignore', detached: false });
}

async function waitForBrowser(port) {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${port}/json/version`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('browser never came up');
}

async function openTab(port, url) {
  const r = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
  const info = await r.json();
  const ws = new WebSocket(info.webSocketDebuggerUrl);
  await new Promise((res) => ws.addEventListener('open', res));
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
  // Wrapped in an async IIFE so callers can freely use `await` (needed for the
  // GPU readback hooks, which are async).
  const evalJS = async (expr) => {
    const r2 = await call('Runtime.evaluate', {
      expression: `(async () => { return ${expr}; })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r2?.exceptionDetails) throw new Error(r2.exceptionDetails.text ?? JSON.stringify(r2.exceptionDetails));
    return r2?.result?.value;
  };
  return {
    evalJS,
    async state() {
      const v = await evalJS('JSON.stringify(globalThis.__biomass ? globalThis.__biomass() : null)');
      try { return JSON.parse(v ?? 'null'); } catch { return null; }
    },
    async snapshot() {
      const v = await evalJS('JSON.stringify(await globalThis.__biomassSnapshot())');
      return JSON.parse(v ?? 'null');
    },
    async screenshot(file) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    async close() {
      ws.close();
      try { await fetch(`http://127.0.0.1:${port}/json/close/${info.id}`); } catch {}
    },
  };
}

// Indices alive in EVERY snapshot passed AND within `capture` units of (x,y)
// in the FIRST snapshot: the fixed cohort to average over. Restricting to
// zombies actually near the point at t0 matters as much as alive-in-all --
// flood() scatters the crowd across a huge square while the charge's radius
// is 7-8, so most of the flood is outside the ability's reach from frame one.
function cohortIndices(snapshots, x, y, capture) {
  const n = Math.min(...snapshots.map((s) => s.n));
  const s0 = snapshots[0];
  const idx = [];
  for (let i = 0; i < n; i++) {
    if (!snapshots.every((s) => s.alive[i])) continue;
    if (Math.hypot(s0.x[i] - x, s0.y[i] - y) > capture) continue;
    idx.push(i);
  }
  return idx;
}

function meanDistFor(snapshot, idx, x, y) {
  let sum = 0;
  for (const i of idx) sum += Math.hypot(snapshot.x[i] - x, snapshot.y[i] - y);
  return idx.length ? sum / idx.length : 0;
}

async function bootReady(tab, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const s = await tab.state();
    if (s) return s;
  }
  throw new Error(`${label}: no heartbeat -- page never booted`);
}

async function settle(tab, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await tab.state();
    if (s && s.alive > STRESS_COUNT * 0.5) return s;
  }
  throw new Error(`${label}: crowd never settled`);
}

const PORT_A = 9339, PORT_B = 9340;
const childA = launchChrome(PORT_A, 'a', 60);
const childB = launchChrome(PORT_B, 'b', 1100);
await Promise.all([waitForBrowser(PORT_A), waitForBrowser(PORT_B)]);
const tabA = await openTab(PORT_A, URL_);   // fires bait
const tabB = await openTab(PORT_B, URL_);   // control, untouched
let ok = true;
try {
  await Promise.all([bootReady(tabA, 'tab A'), bootReady(tabB, 'tab B')]);

  // Spawn the identical tight cluster in both tabs at the map's own portal.
  await Promise.all([
    tabA.evalJS(`globalThis.__biomassStress(${STRESS_COUNT})`),
    tabB.evalJS(`globalThis.__biomassStress(${STRESS_COUNT})`),
  ]);
  const bootA = await settle(tabA, 'tab A');
  await settle(tabB, 'tab B');
  const CX = bootA.spawnAt.x, CY = bootA.spawnAt.y;
  console.log(`bait point (map's spawn portal): (${CX}, ${CY})`);

  const snap0A = await tabA.snapshot();
  const snap0B = await tabB.snapshot();
  console.log(`t0 snapshots: A=${snap0A.n} slots, B=${snap0B.n} slots`);

  const fired = await tabA.evalJS(`globalThis.__biomassAbility('bait', ${CX}, ${CY})`);
  console.log(`fired bait in tab A: ${fired}`);
  if (!fired) { console.log('FAIL: __biomassAbility(bait) returned false'); ok = false; }

  // Poll tab A's informal heartbeat through gather -> detonate -> throw, and
  // grab a mid-attract screenshot, while both tabs keep running identically
  // otherwise (attractLife is 2.6s).
  let midShotTaken = false;
  let snap1A = null, snap1B = null, snap2A = null, snap2B = null;
  const t0 = Date.now();
  while (Date.now() - t0 < 3400) {
    await sleep(300);
    const st = await tabA.state();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`t+${elapsed}s  A: charges=${st.charges} chargeCount=${st.chargeCount} sample=${JSON.stringify(st.chargeSample)} beacons=${st.beacons} rings=${st.rings} blasts=${st.blasts}`);
    if (!midShotTaken && Date.now() - t0 > 1200) {
      midShotTaken = true;
      const midShot = join(OUT, `baittest-mid-attract-${Date.now()}.png`);
      await tabA.screenshot(midShot);
      console.log(`mid-attract screenshot: ${midShot}`);
    }
    if (!snap1A && Date.now() - t0 > 2000) { [snap1A, snap1B] = await Promise.all([tabA.snapshot(), tabB.snapshot()]); }
    if (!snap2A && Date.now() - t0 > 3300) { [snap2A, snap2B] = await Promise.all([tabA.snapshot(), tabB.snapshot()]); }
  }
  if (!snap1A) [snap1A, snap1B] = await Promise.all([tabA.snapshot(), tabB.snapshot()]);
  if (!snap2A) [snap2A, snap2B] = await Promise.all([tabA.snapshot(), tabB.snapshot()]);

  // Gather and throw need DIFFERENT cohorts, not one fixed across all three
  // snapshots: the detonation's damage kills the best-gathered zombies (that
  // is the ability doing its job), so requiring "alive at snap2" would
  // systematically exclude the success cases from the gather measurement --
  // survivorship bias again, just from the ability's own blast this time
  // instead of leak-drain. Gather compares snap0->snap1 (both pre-detonation,
  // nothing has died from the blast yet); throw compares snap0->snap2 among
  // whoever survived to be thrown at all.
  const idxGatherA = cohortIndices([snap0A, snap1A], CX, CY, CAPTURE);
  const idxGatherB = cohortIndices([snap0B, snap1B], CX, CY, CAPTURE);
  const idxThrowA = cohortIndices([snap0A, snap2A], CX, CY, CAPTURE);
  const idxThrowB = cohortIndices([snap0B, snap2B], CX, CY, CAPTURE);
  console.log(`gather cohorts (within ${CAPTURE}, alive at t0+2s): A=${idxGatherA.length}, B=${idxGatherB.length}`);
  console.log(`throw cohorts (within ${CAPTURE}, alive at t0+post-throw): A=${idxThrowA.length}, B=${idxThrowB.length}`);
  if (!idxGatherA.length || !idxGatherB.length || !idxThrowA.length || !idxThrowB.length) {
    console.log('FAIL: a cohort came up empty'); ok = false;
  }

  const a0g = meanDistFor(snap0A, idxGatherA, CX, CY);
  const a1 = meanDistFor(snap1A, idxGatherA, CX, CY);
  const b0g = meanDistFor(snap0B, idxGatherB, CX, CY);
  const b1 = meanDistFor(snap1B, idxGatherB, CX, CY);
  const a0t = meanDistFor(snap0A, idxThrowA, CX, CY);
  const a2 = meanDistFor(snap2A, idxThrowA, CX, CY);
  const b0t = meanDistFor(snap0B, idxThrowB, CX, CY);
  const b2 = meanDistFor(snap2B, idxThrowB, CX, CY);
  console.log(`tab A (bait)    t0=${a0g.toFixed(2)}  +2s=${a1.toFixed(2)}   |  t0=${a0t.toFixed(2)}  post-throw=${a2.toFixed(2)}`);
  console.log(`tab B (control) t0=${b0g.toFixed(2)}  +2s=${b1.toFixed(2)}   |  t0=${b0t.toFixed(2)}  post-throw=${b2.toFixed(2)}`);

  // Gather: bait's own drift (a1-a0g) must be more negative (more shrink) than
  // the control's background drift (b1-b0g) over the identical window.
  const gatherDelta = (a1 - a0g) - (b1 - b0g);
  console.log(`gather signal (bait drift minus control drift): ${gatherDelta.toFixed(2)}  (must be < 0)`);
  if (!(gatherDelta < 0)) { console.log('FAIL: bait did not shrink distance beyond background drift'); ok = false; }

  // Throw: at the same wall-clock moment, the bait tab's cohort must sit
  // further from the point than the untouched control's cohort does.
  const throwDelta = a2 - b2;
  console.log(`throw signal (bait mean minus control mean at same timestamp): ${throwDelta.toFixed(2)}  (must be > 0)`);
  if (!(throwDelta > 0)) { console.log('FAIL: bait did not throw distance beyond the control baseline'); ok = false; }

  const finalA = await tabA.state();
  console.log(`heartbeat after test (tab A): ${JSON.stringify(finalA)}`);
  if (finalA?.lastError) { console.log(`FAIL: tab A reported an error: ${finalA.lastError}`); ok = false; }
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  ok = false;
} finally {
  await tabA.close();
  await tabB.close();
  try { childA.kill(); } catch {}
  try { childB.kill(); } catch {}
}

console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
