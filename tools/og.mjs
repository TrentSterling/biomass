// Renders og-image.png (1200x630) by photographing the LIVE sim: boots a
// flooded board with every turret already built, lets the horde stream and the
// guns open up, then hides the HUD, injects the title card, and screenshots the
// result. Real compute as cover art; no compositing pipeline to drift out of
// date. Ported from ballpit/tools/og.mjs.
//
//   node serve.mjs 8101      (in another terminal)
//   node tools/og.mjs
//
// Discord/Twitter/Slack read og:image out of index.html, which points at
// https://tront.xyz/biomass/og-image.png, so this file is committed.

import { spawn } from 'node:child_process';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

// A board already full of biomass, guns already placed and paid for, no wave
// pacing in the way. bench=1 keeps pouring so the crowd never thins mid-shot.
const URL_ = 'http://localhost:8101/?map=0&gold=9000&autobuild=1&bench=1&rate=6000&spawn=90000';
const OUT = join(import.meta.dirname, '..', 'og-image.png');
const SETTLE_MS = 2600;        // how far into the flow the shutter fires

const CHROME = [
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  `C:/Users/${process.env.USERNAME ?? ''}/AppData/Local/Google/Chrome/Application/chrome.exe`,
].find(existsSync);
if (!CHROME) { console.error('chrome not found'); process.exit(2); }

const PORT = 9337;
const child = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${join(process.env.TEMP ?? '.', 'biomass-og-profile')}`,
  '--no-first-run', '--no-default-browser-check', '--enable-unsafe-webgpu',
  '--window-size=1280,760',
  '--window-position=-32000,-32000',
  '--disable-features=CalculateNativeWinOcclusion',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  URL_,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let page;
for (let i = 0; i < 40 && !page; i++) {
  try {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/new?${encodeURIComponent(URL_)}`, { method: 'PUT' });
    if (r.ok) page = await r.json();
  } catch {}
  if (!page) await sleep(250);
}
if (!page) { console.error('no CDP target; is serve.mjs running on 8101?'); process.exit(2); }

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m.result); pending.delete(m.id); }
});
const call = (method, params = {}) => new Promise((res) => {
  const myId = ++id;
  pending.set(myId, res);
  ws.send(JSON.stringify({ id: myId, method, params }));
});
const evalJS = async (expr) => {
  const r = await call('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
  return r?.result?.value;
};

await call('Runtime.enable');
await call('Page.enable');
await call('Emulation.setDeviceMetricsOverride', {
  width: 1200, height: 630, deviceScaleFactor: 1, mobile: false,
});
await call('Page.reload', { ignoreCache: true });

for (let i = 0; i < 60; i++) {
  if (await evalJS('typeof globalThis.__biomass === "function"').catch(() => false)) break;
  await sleep(250);
}
// Warm past the pipeline-compile hitches behind the boot screen, or the shutter
// fires on a board that has barely started to move.
for (let i = 0; i < 60; i++) {
  if ((await evalJS('__biomass().frames').catch(() => 0)) > 60) break;
  await sleep(250);
}
// Giants get dropped mid-flow so they are on the board (and being parted
// around) by the time the shutter fires, since the subtitle claims them.
await sleep(SETTLE_MS);
await evalJS('__biomassBosses(70)');
await sleep(1400);

const stats = await evalJS('JSON.stringify({alive: __biomass().alive, turrets: __biomass().turrets, bosses: __biomass().bossAlive})');
console.log(`scene: ${stats}`);

// Dress the set: HUD off, gradient floor, title card.
await evalJS(`(() => {
  document.getElementById('hud').hidden = true;
  const boot = document.getElementById('boot');
  if (boot) boot.hidden = true;
  const o = document.createElement('div');
  o.innerHTML = \`
    <div style="position:fixed;inset:0;z-index:50;background:linear-gradient(to top,
      rgba(9,13,10,0.97) 0%, rgba(9,13,10,0.88) 26%, rgba(9,13,10,0.35) 50%, rgba(9,13,10,0) 74%)"></div>
    <div style="position:fixed;left:60px;bottom:52px;z-index:51;font-family:Consolas,'DejaVu Sans Mono',monospace">
      <div style="color:#8fdc5a;font-size:92px;letter-spacing:18px;line-height:1">BIOMASS</div>
      <div style="color:#dbe6d8;font-size:31px;margin-top:14px;letter-spacing:1px">the horde is a fluid</div>
      <div style="color:#8a978c;font-size:24px;margin-top:14px">100,000 zombies
        <span style="color:#8fdc5a;font-size:20px;vertical-align:2px">&#9679;</span> giants
        <span style="color:#e8c33c;font-size:20px;vertical-align:2px">&#9679;</span> WebGPU compute, right in the browser</div>
    </div>\`;
  document.body.appendChild(o);
  return true;
})()`);
await sleep(400);      // one settled render with the overlay in place

const shot = await call('Page.captureScreenshot', {
  format: 'png',
  clip: { x: 0, y: 0, width: 1200, height: 630, scale: 1 },
});
writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
console.log(`wrote ${OUT}`);

ws.close();
try { child.kill(); } catch {}
process.exit(0);
