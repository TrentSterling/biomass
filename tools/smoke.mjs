// Boot the page in a real browser over CDP, collect console output and
// exceptions, then screenshot. Headless WebGPU is unreliable, so this drives a
// visible window.
//
//   node tools/smoke.mjs [url] [seconds]

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// A caller (orchestrator, shell wrapper, whatever) can pass the literal string
// "undefined" or "null" instead of actually omitting the argument -- that used
// to sail straight into Chrome as a nav target, load nothing, and still exit 0.
// Treat those placeholder strings the same as "not given".
function resolveArg(raw, fallback) {
  return (!raw || raw === 'undefined' || raw === 'null') ? fallback : raw;
}

const URL_ = resolveArg(process.argv[2], 'http://localhost:8101/');
const SECONDS = Number(resolveArg(process.argv[3], '9')) || 9;
const OUT = join(import.meta.dirname, '..', 'shots');
if (!existsSync(OUT)) mkdirSync(OUT);

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Users/' + (process.env.USERNAME ?? '') + '/AppData/Local/Google/Chrome/Application/chrome.exe',
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9333;
const profile = join(process.env.TEMP ?? '.', 'biomass-cdp-profile');
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--no-first-run', '--no-default-browser-check',
  '--enable-unsafe-webgpu',
  '--window-size=1600,900',
  // Without these, Chrome treats the window as occluded the moment anything
  // covers it and stops requestAnimationFrame entirely: zero frames, no error.
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  URL_,
], { stdio: 'ignore', detached: false });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Always open our OWN tab and attach to exactly that target. Never adopt a tab
// that was already there: someone may be playing in it.
async function ownTab() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' });
      if (r.ok) return await r.json();
    } catch {}
    await sleep(250);
  }
  throw new Error('could not open a CDP tab');
}

const page = await ownTab();
const ws = new WebSocket(page.webSocketDebuggerUrl);
const logs = [];
let id = 0;
const send = (method, params = {}) => ws.send(JSON.stringify({ id: ++id, method, params }));

await new Promise((r) => ws.addEventListener('open', r));
send('Runtime.enable');
send('Log.enable');
send('Page.enable');

const pending = new Map();
ws.addEventListener('message', (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.method === 'Runtime.consoleAPICalled') {
    const text = msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ');
    logs.push(`[${msg.params.type}] ${text}`);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    logs.push(`[EXCEPTION] ${d.exception?.description ?? d.text}`);
  } else if (msg.method === 'Log.entryAdded') {
    logs.push(`[${msg.params.entry.level}] ${msg.params.entry.text}`);
  } else if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg.result);
    pending.delete(msg.id);
  }
});

const call = (method, params = {}) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});

// Reload so nothing that fired before we attached is missed.
await call('Page.reload', { ignoreCache: true });
await sleep(SECONDS * 1000);

const probe = await call('Runtime.evaluate', {
  expression: 'JSON.stringify(globalThis.__biomass ? globalThis.__biomass() : "no heartbeat")',
  returnByValue: true,
});
console.log(`heartbeat: ${probe?.result?.value ?? '(none)'}`);

// A page that never loaded (bad nav target, crash before init, etc.) produces
// zero console errors and a blank screenshot -- exit 0 was a false green.
// __biomass missing is itself a failure, not just something to log.
let heartbeatOk = false;
try {
  const parsed = JSON.parse(probe?.result?.value ?? 'null');
  heartbeatOk = parsed !== null && parsed !== 'no heartbeat';
} catch {}

const shot = await call('Page.captureScreenshot', { format: 'png' });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const file = join(OUT, `smoke-${stamp}.png`);
writeFileSync(file, Buffer.from(shot.data, 'base64'));

const errs = logs.filter((l) => /EXCEPTION|\[error\]|\[SEVERE\]/i.test(l));
console.log(`--- ${logs.length} log lines, ${errs.length} errors ---`);
for (const l of logs.slice(0, 60)) console.log(l);
console.log(`screenshot: ${file}`);
if (!heartbeatOk) console.log('FAIL: no __biomass heartbeat -- page never loaded / never initialized');

ws.close();
// Only ever tear down the throwaway profile's own process tree. Never a broad
// taskkill: the user's normal Chrome windows are not ours to close.
try { child.kill(); } catch {}
process.exit(errs.length || !heartbeatOk ? 1 : 0);
