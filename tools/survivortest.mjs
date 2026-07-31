// Survivors: durable, edible, worth saving.
//
//   node tools/survivortest.mjs [url]
//
// Two scenarios, one Chrome window, sequential (each navigates a fresh tab so
// state never leaks between them):
//
//   1. DENSE HORDE  -- no turrets, a flood of zombies between the survivors'
//      spawn edge and the base. The lost counter must eventually rise (the
//      horde eats them), but not instantly: SURVIVOR_CHEW_DPS is a flat per-
//      contact rate against 320 hp, so death takes several seconds even
//      pressed against a packed crowd. The kills counter must never move --
//      there are no turrets to kill anything, hostile or survivor, so any
//      movement there means a survivor death got miscounted as a kill.
//
//   2. EMPTY MAP    -- bench=1&rate=0 with no flood: zero hostiles ever
//      spawn. All 5 survivors in the forced group must walk to the base
//      untouched: saved reaches 5, gold rises by exactly 5*SURVIVOR_REWARD,
//      leaks/lost/kills all stay at 0, base hp is unchanged.
//
// Pattern-matched off tools/baittest.mjs / tools/smoke.mjs.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const BASE = resolveArg(process.argv[2], 'http://localhost:8101/');
const SURVIVOR_REWARD = 15;   // config.js -- kept in sync by hand, this is a throwaway harness
const OUT = join(import.meta.dirname, '..', 'shots');
if (!existsSync(OUT)) mkdirSync(OUT);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9342;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'biomass-survivortest')}`,
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu',
  '--window-size=1200,800',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForBrowser() {
  for (let i = 0; i < 60; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/json/version`)).ok) return; } catch {}
    await sleep(250);
  }
  throw new Error('browser never came up');
}

async function openTab(url) {
  const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' });
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
    async screenshot(file) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    async close(info_ = info) {
      ws.close();
      try { await fetch(`http://127.0.0.1:${PORT}/json/close/${info_.id}`); } catch {}
    },
  };
}

async function bootReady(tab, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(300);
    const s = await tab.state();
    if (s) return s;
  }
  throw new Error(`${label}: no heartbeat -- page never booted`);
}

let ok = true;

// ---- scenario 1: dense horde --------------------------------------------
async function scenarioDenseHorde() {
  console.log('\n=== scenario 1: dense horde between spawn edge and base ===');
  const url = `${BASE}?map=0&bench=1&rate=0&spawn=120000`;
  const tab = await openTab(url);
  try {
    await bootReady(tab, 'dense-horde');
    // Let the flood settle across the map before dropping survivors into it.
    await sleep(4000);
    const before = await tab.state();
    console.log(`pre-spawn: alive=${before.alive} kills=${before.kills} lost=${before.lost} saved=${before.saved}`);
    if (before.lastError) throw new Error(`page error before test: ${before.lastError}`);

    const fired = await tab.evalJS('globalThis.__biomassSurvivors(5)');
    console.log(`fired __biomassSurvivors(5): ${fired}`);
    if (!fired) { console.log('FAIL: __biomassSurvivors returned falsy'); ok = false; }

    const t0 = Date.now();
    let firstLostAt = null, firstLostState = null;
    const killsBaseline = before.kills;
    let sawShot = false;
    while (Date.now() - t0 < 45000) {
      await sleep(1000);
      const s = await tab.state();
      if (s.lastError) { console.log(`FAIL: page error mid-test: ${s.lastError}`); ok = false; break; }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`t+${elapsed}s  alive=${s.alive} lost=${s.lost} saved=${s.saved} kills=${s.kills} hp=${s.hp}`);
      if (s.kills !== killsBaseline) {
        console.log(`FAIL: kills counter moved (${killsBaseline} -> ${s.kills}) with no turrets built`);
        ok = false;
      }
      if (!sawShot && Date.now() - t0 > 3000) {
        sawShot = true;
        const file = join(OUT, `survivortest-densehorde-${Date.now()}.png`);
        await tab.screenshot(file);
        console.log(`screenshot: ${file}`);
      }
      if (firstLostAt === null && s.lost > 0) { firstLostAt = Date.now(); firstLostState = s; }
      if (s.lost >= 5 || s.saved + s.lost >= 5) break;
    }

    if (firstLostAt === null) {
      console.log('FAIL: lost counter never rose -- survivors were never eaten by the dense horde');
      ok = false;
    } else {
      const deathSecs = (firstLostAt - t0) / 1000;
      console.log(`first survivor lost at t+${deathSecs.toFixed(1)}s (state: ${JSON.stringify(firstLostState)})`);
      // Chew is a flat DPS against 320 hp, not instadeath: even pinned by every
      // contact slot the hash can hold, death cannot happen in under a couple
      // of seconds. This is a generous floor, not a tuned number.
      if (deathSecs < 2) {
        console.log(`FAIL: first loss came at ${deathSecs.toFixed(1)}s -- reads like instant death, not a per-second chew`);
        ok = false;
      }
    }
  } finally {
    await tab.close();
  }
}

// ---- scenario 2: empty map ----------------------------------------------
async function scenarioEmptyMap() {
  console.log('\n=== scenario 2: empty map, all survivors should arrive ===');
  const url = `${BASE}?map=0&bench=1&rate=0`;
  const tab = await openTab(url);
  try {
    const boot = await bootReady(tab, 'empty-map');
    await sleep(1500);
    const before = await tab.state();
    console.log(`pre-spawn: alive=${before.alive} gold=${before.gold} hp=${before.hp} leaks=${before.leaks}`);
    if (before.alive > 0) console.log(`note: bench ramp already spawned ${before.alive} (rate should be 0)`);

    const fired = await tab.evalJS('globalThis.__biomassSurvivors(5)');
    console.log(`fired __biomassSurvivors(5): ${fired}`);
    if (!fired) { console.log('FAIL: __biomassSurvivors returned falsy'); ok = false; }

    const t0 = Date.now();
    let last = before;
    while (Date.now() - t0 < 40000) {
      await sleep(1000);
      const s = await tab.state();
      last = s;
      if (s.lastError) { console.log(`FAIL: page error mid-test: ${s.lastError}`); ok = false; break; }
      const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`t+${elapsed}s  alive=${s.alive} saved=${s.saved} lost=${s.lost} gold=${s.gold} hp=${s.hp} leaks=${s.leaks} kills=${s.kills}`);
      if (s.saved >= 5) break;
    }

    console.log(`final: ${JSON.stringify(last)}`);
    if (last.saved !== 5) { console.log(`FAIL: expected saved=5, got ${last.saved}`); ok = false; }
    if (last.lost !== 0) { console.log(`FAIL: expected lost=0 on an empty map, got ${last.lost}`); ok = false; }
    if (last.leaks !== (before.leaks ?? 0)) { console.log(`FAIL: leaks moved (${before.leaks} -> ${last.leaks}) -- a survivor arrival must never count as a leak`); ok = false; }
    if (last.kills !== (before.kills ?? 0)) { console.log(`FAIL: kills moved (${before.kills} -> ${last.kills}) on an empty map`); ok = false; }
    const goldGain = last.gold - before.gold;
    const expectGold = 5 * SURVIVOR_REWARD;
    if (goldGain !== expectGold) { console.log(`FAIL: expected +${expectGold}g from saves, got +${goldGain}g`); ok = false; }
    if (Math.round(last.hp) !== Math.round(before.hp)) { console.log(`FAIL: base hp changed (${before.hp} -> ${last.hp}) from survivor arrivals`); ok = false; }
    if (last.saved === 5 && last.lost === 0 && goldGain === expectGold) console.log('PASS: all 5 saved, gold correct, zero leaks/lost/kills, hp unchanged');
  } finally {
    await tab.close();
  }
}

try {
  await waitForBrowser();
  await scenarioDenseHorde();
  await scenarioEmptyMap();
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  ok = false;
} finally {
  try { child.kill(); } catch {}
}

console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
