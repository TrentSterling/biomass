// Airstrike-plane smoke test: a plane must fly in, drop its stick of bombs on
// a dense crowd, and the kill counter must move -- with a screenshot taken
// mid-flight so a human can eyeball the plane + landed bombs.
//
//   node tools/airstriketest.mjs [url]
//
// Throwaway harness, pattern-matched off tools/smoke.mjs and tools/baittest.mjs.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const BASE = resolveArg(process.argv[2], 'http://localhost:8101/');
// bench=1&rate=0: base invulnerable, no ramp adding more zombies mid-test.
const URL_ = `${BASE}?map=0&bench=1&rate=0`;
const STRESS_COUNT = 400;
const OUT = join(import.meta.dirname, '..', 'shots');
if (!existsSync(OUT)) mkdirSync(OUT);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9341;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const profile = join(process.env.TEMP ?? '.', 'biomass-airstriketest-profile');
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu',
  '--window-size=1200,800',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  'about:blank',
], { stdio: 'ignore', detached: false });

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
  const logs = [];
  await new Promise((res) => ws.addEventListener('open', res));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = m.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
      logs.push(`[${m.params.type}] ${text}`);
    } else if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      logs.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`);
    } else if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
  });
  const call = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res);
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  send('Runtime.enable'); send('Log.enable'); send('Page.enable');
  function send(method, params = {}) { ws.send(JSON.stringify({ id: ++id, method, params })); }
  const evalJS = async (expr) => {
    const r2 = await call('Runtime.evaluate', {
      expression: `(async () => { return ${expr}; })()`,
      awaitPromise: true, returnByValue: true,
    });
    if (r2?.exceptionDetails) throw new Error(r2.exceptionDetails.text ?? JSON.stringify(r2.exceptionDetails));
    return r2?.result?.value;
  };
  return {
    logs, evalJS,
    async state() {
      const v = await evalJS('JSON.stringify(globalThis.__biomass ? globalThis.__biomass() : null)');
      try { return JSON.parse(v ?? 'null'); } catch { return null; }
    },
    async screenshot(file) {
      const shot = await call('Page.captureScreenshot', { format: 'png' });
      writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    async close() {
      ws.close();
      try { await fetch(`http://127.0.0.1:${PORT}/json/close/${info.id}`); } catch {}
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

async function settle(tab, label) {
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await tab.state();
    if (s && s.alive > STRESS_COUNT * 0.5) return s;
  }
  throw new Error(`${label}: crowd never settled`);
}

let ok = true;
await waitForBrowser();
const tab = await openTab(URL_);
try {
  await bootReady(tab, 'tab');
  await tab.evalJS(`globalThis.__biomassStress(${STRESS_COUNT})`);
  const boot = await settle(tab, 'tab');
  const CX = boot.spawnAt.x, CY = boot.spawnAt.y;
  console.log(`strike target (map's spawn portal): (${CX}, ${CY})`);

  const killsBefore = boot.kills;
  const fired = await tab.evalJS(`globalThis.__biomassAbility('strike', ${CX}, ${CY})`);
  console.log(`fired strike: ${fired}`);
  if (!fired) { console.log('FAIL: __biomassAbility(strike) returned false'); ok = false; }

  // Poll through the flight: plane crosses off the left edge, drops its
  // stick, bombs fall for fallDelay before detonating. Grab a mid-flight
  // screenshot once at least one bomb should plausibly have landed.
  let midShotTaken = false;
  let sawPlane = false, sawFallingBomb = false, maxKillsSeen = killsBefore;
  const t0 = Date.now();
  while (Date.now() - t0 < 4500) {
    await sleep(200);
    const s = await tab.state();
    if (!s) continue;
    maxKillsSeen = Math.max(maxKillsSeen, s.kills);
    if (s.planes > 0) sawPlane = true;
    if (s.fallingBombs > 0) sawFallingBomb = true;
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
    console.log(`t+${elapsed}s  planes=${s.planes} fallingBombs=${s.fallingBombs} blasts=${s.blasts} charges=${s.charges} rings=${s.rings} kills=${s.kills} lastError=${s.lastError}`);
    if (s.lastError) { console.log(`FAIL: page reported an error: ${s.lastError}`); ok = false; break; }
    if (!midShotTaken && Date.now() - t0 > 1400) {
      midShotTaken = true;
      const midShot = join(OUT, `airstrike-mid-flight-${Date.now()}.png`);
      await tab.screenshot(midShot);
      console.log(`mid-flight screenshot: ${midShot}`);
    }
  }

  if (!sawPlane) { console.log('FAIL: plane never showed up in state (planes stayed 0)'); ok = false; }
  if (!sawFallingBomb) { console.log('FAIL: no falling bomb ever appeared'); ok = false; }
  if (!(maxKillsSeen > killsBefore)) { console.log(`FAIL: kills did not move (${killsBefore} -> ${maxKillsSeen})`); ok = false; }
  else console.log(`kills moved: ${killsBefore} -> ${maxKillsSeen}`);

  const finalState = await tab.state();
  console.log(`final heartbeat: ${JSON.stringify(finalState)}`);
  if (finalState?.lastError) { console.log(`FAIL: reported an error: ${finalState.lastError}`); ok = false; }

  const errs = tab.logs.filter((l) => /EXCEPTION|\[error\]|\[SEVERE\]/i.test(l));
  console.log(`--- ${tab.logs.length} log lines, ${errs.length} errors ---`);
  for (const l of tab.logs.slice(0, 60)) console.log(l);
  if (errs.length) ok = false;
} catch (err) {
  console.log(`FAIL: ${err.message}`);
  ok = false;
} finally {
  await tab.close();
  try { child.kill(); } catch {}
}

console.log(ok ? 'PASS' : 'FAIL');
process.exit(ok ? 0 : 1);
