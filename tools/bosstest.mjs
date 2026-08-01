// Bosses: stupidly big, one-way coupling, the horde parts around them.
//
//   node tools/bosstest.mjs [url]
//
// Three scenarios, one Chrome window, sequential (each navigates a fresh tab
// so state never leaks between them):
//
//   1. BOSS WALK    -- empty map (bench=1&rate=0), a forced boss group. They
//      must actually exist (bossAlive rises), steer down the same flow field
//      as everything else, and reach the base (bossLeaks rises). The sim's
//      own impossible-state gauges (oob, inRock) must stay 0 with only
//      bosses on the board: any movement there is a boss solver fault.
//
//   2. MIXED FLOOD  -- a dense zombie flood, then bosses dropped into the
//      middle of it. Coupling is one-way (bosses ignore zombie contacts) but
//      the zombie side must push out of boss circles, so after a settle the
//      fraction of living zombies whose centre sits DEEP inside a living
//      boss circle must be small. No coupling = the horde walks straight
//      through the giants and this reads tens of percent.
//
//   3. BOSS GUNS    -- autobuild beams with gold, then a boss group. Bosses
//      tally into hostileDens, so turrets can aim at them, and the weapon
//      shapes damage them boss-side: bossKills must rise.
//
// Pattern-matched off tools/survivortest.mjs / tools/smoke.mjs.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const BASE = resolveArg(process.argv[2], 'http://localhost:8101/');
const OUT = join(import.meta.dirname, '..', 'shots');
if (!existsSync(OUT)) mkdirSync(OUT);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9343;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'biomass-bosstest')}`,
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
const fail = (msg) => { console.log(`FAIL: ${msg}`); ok = false; };

// ---- scenario 1: boss walk ------------------------------------------------
async function scenarioBossWalk() {
  console.log('\n=== scenario 1: bosses walk the flow field and leak ===');
  const tab = await openTab(`${BASE}?map=0&bench=1&rate=0`);
  try {
    await bootReady(tab, 'boss-walk');
    const fired = await tab.evalJS('globalThis.__biomassBosses ? globalThis.__biomassBosses(300) : null');
    console.log(`fired __biomassBosses(300): ${fired}`);
    if (!fired) { fail('__biomassBosses hook missing or returned falsy'); return; }

    const t0 = Date.now();
    let last = null, sawShot = false;
    while (Date.now() - t0 < 60000) {
      await sleep(1000);
      const s = await tab.state();
      last = s;
      if (s.lastError) { fail(`page error mid-test: ${s.lastError}`); break; }
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`t+${el}s  bossAlive=${s.bossAlive} bossLeaks=${s.bossLeaks} oob=${s.oob} inRock=${s.inRock}`);
      if (!sawShot && Date.now() - t0 > 4000) {
        sawShot = true;
        const file = join(OUT, `bosstest-walk-${Date.now()}.png`);
        await tab.screenshot(file);
        console.log(`screenshot: ${file}`);
      }
      if (s.oob > 0) fail(`oob=${s.oob} with only bosses on the board`);
      if (s.inRock > 0) fail(`inRock=${s.inRock} with only bosses on the board`);
      if (!ok) break;
      if (s.bossLeaks >= 20) break;
    }
    if ((last?.bossAlive ?? 0) === 0 && (last?.bossLeaks ?? 0) === 0) {
      fail('bossAlive never rose -- the group was never spawned');
    }
    if ((last?.bossLeaks ?? 0) === 0) {
      fail('bossLeaks never rose -- bosses never walked home');
    } else {
      console.log(`bosses leaked: ${last.bossLeaks}`);
    }
  } finally {
    await tab.close();
  }
}

// ---- scenario 2: mixed flood, one-way coupling ---------------------------
async function scenarioMixedFlood() {
  console.log('\n=== scenario 2: horde parts around bosses (one-way coupling) ===');
  const tab = await openTab(`${BASE}?map=0&bench=1&rate=0&spawn=80000`);
  try {
    await bootReady(tab, 'mixed-flood');
    await sleep(4000);                        // let the flood settle
    const fired = await tab.evalJS('globalThis.__biomassBosses ? globalThis.__biomassBosses(150) : null');
    console.log(`fired __biomassBosses(150): ${fired}`);
    if (!fired) { fail('__biomassBosses hook missing or returned falsy'); return; }

    await sleep(12000);                       // bosses wade in, zombies get shoved
    const s = await tab.state();
    if (s.lastError) { fail(`page error mid-test: ${s.lastError}`); return; }
    const file = join(OUT, `bosstest-mixed-${Date.now()}.png`);
    await tab.screenshot(file);
    console.log(`screenshot: ${file}`);

    const probe = await tab.evalJS('globalThis.__biomassBossPush ? JSON.stringify(await globalThis.__biomassBossPush()) : null');
    if (!probe) { fail('__biomassBossPush hook missing'); return; }
    const push = JSON.parse(probe);
    console.log(`overlap probe: ${JSON.stringify(push)}`);
    // Deep = zombie centre inside 70% of a living boss radius. Transient edge
    // overlap while a boss plows through is expected; bodies parked deep
    // inside a giant means the push-out never ran.
    if (push.zombiesNearBosses < 50) {
      fail(`only ${push.zombiesNearBosses} zombies ever near a boss -- the probe saw nothing, scenario is not testing coupling`);
    }
    if (push.deepPct > 8) {
      fail(`${push.deepPct}% of zombies near bosses sit deep inside one -- zombie-side push-out is not working`);
    } else {
      console.log(`PASS: deep overlap ${push.deepPct}% across ${push.zombiesNearBosses} zombies near bosses`);
    }
  } finally {
    await tab.close();
  }
}

// ---- scenario 3: turrets can find and kill bosses ------------------------
async function scenarioBossGuns() {
  console.log('\n=== scenario 3: turrets aim at and kill bosses ===');
  const tab = await openTab(`${BASE}?map=0&bench=1&rate=0&gold=6000&autobuild=1&only=beam`);
  try {
    await bootReady(tab, 'boss-guns');
    const fired = await tab.evalJS('globalThis.__biomassBosses ? globalThis.__biomassBosses(120) : null');
    console.log(`fired __biomassBosses(120): ${fired}`);
    if (!fired) { fail('__biomassBosses hook missing or returned falsy'); return; }

    const t0 = Date.now();
    let last = null;
    while (Date.now() - t0 < 45000) {
      await sleep(1000);
      const s = await tab.state();
      last = s;
      if (s.lastError) { fail(`page error mid-test: ${s.lastError}`); break; }
      const el = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`t+${el}s  bossAlive=${s.bossAlive} bossKills=${s.bossKills} bossLeaks=${s.bossLeaks} gold=${s.gold}`);
      if (s.bossKills >= 5) break;
    }
    if ((last?.bossKills ?? 0) === 0) {
      fail('bossKills never rose -- turrets cannot find or cannot hurt bosses');
    } else {
      console.log(`PASS: ${last.bossKills} bosses killed by turrets`);
    }
  } finally {
    await tab.close();
  }
}

try {
  await waitForBrowser();
  await scenarioBossWalk();
  await scenarioMixedFlood();
  await scenarioBossGuns();
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  ok = false;
} finally {
  try { child.kill(); } catch {}
}

console.log(`\n${ok ? 'PASS' : 'FAIL'}`);
process.exit(ok ? 0 : 1);
