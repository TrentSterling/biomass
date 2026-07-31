// BIOMASS / "SIR, WE HAVE A FLOW FIELD"
// Boot, camera, input, frame loop. The CPU's whole job per frame is: advance the
// wave clock, spin turret aims, set uniforms, and draw.

import * as THREE from 'three/webgpu';
import { Field } from './field.js';
import { MAPS } from './maps.js';
import { Ground } from './ground.js';
import { Horde } from './gpu/horde.js';
import { Effects } from './effects.js';
import { FlowOverlay } from './debug.js';
import { Build } from './game/build.js';
import { Waves } from './game/waves.js';
import { Hud } from './hud.js';
import { makeZombieAtlas } from './art.js';
import { save } from './save.js';
import { effects as metaEffects, relicsFor } from './meta.js';
import { Menu } from './menu.js';
import { startAudio, resumeAudio, configureAudio, toggleMute, isMuted, sfx } from './audio.js';
import {
  GRID_W, GRID_H, MAX_ZOMBIES, BUILDS, BASE_HP, START_GOLD, ZOMBIE_TYPES, PARAMS, SPAWN_BATCH,
  DENS_W, DENS_H, DENS_SCALE, ABILITIES, SPEEDS, zombieRadius,
} from './config.js';

// No ?map= means the title screen: the game still boots and plays itself behind
// the menu, so the front of the game is never a static picture.
let attract = PARAMS.get('map') === null;
let mapIndex = Math.min(MAPS.length - 1, Math.max(0, Number(PARAMS.get('map')) || 0));
const BENCH = PARAMS.get('bench') === '1';
// A baseline bot plays the map so a run can be judged without a human holding
// the mouse. ?speed=N runs N sim substeps per frame so a full run takes seconds.
const AUTOPLAY_PARAM = PARAMS.get('autoplay') === '1';
const isAutoplay = () => AUTOPLAY_PARAM || attract;
const SPEED_PARAM = Math.max(0, Math.min(16, Number(PARAMS.get('speed')) || 0));
// Fast forward is a real feature, not just a test-harness knob.
let simSpeed = Math.max(1, Math.min(16, SPEED_PARAM || save.settings.speed || 1));
const WAVES_PARAM = Number(PARAMS.get('waves')) || 0;
let TARGET_WAVES = Math.max(1, WAVES_PARAM || MAPS[mapIndex].waves || 12);

const state = {
  hp: BASE_HP, hpMax: BASE_HP, gold: START_GOLD,
  selected: 1, paused: false, over: false, won: false, time: 1,
  // attract mode must never end, and never records a result

  // The stress tools spawn zombies on top of the base, which would end the run in
  // one frame. Anything that floods the board turns this on.
  sandbox: false,
};

configureAudio(save.settings);
if (attract) document.body.classList.add('attract');

const hud = new Hud({
  onSelect: (i) => { state.selected = i; },
  onSpeed: () => cycleSpeed(),
  onMute: () => { hud.toast(toggleMute() ? 'muted' : 'sound on'); },
  onStress: () => stress(10000),
  onFlood: () => flood(),
  onRestart: () => location.reload(),
});

if (!navigator.gpu) {
  hud.fail('This prototype needs <b>WebGPU</b>.<br>Firefox 141+ on Windows, Chrome, or Edge.');
  throw new Error('no WebGPU');
}

const field = new Field(MAPS[mapIndex]);
const scene = new THREE.Scene();
scene.background = new THREE.Color(0x3a2413);

const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
camera.position.set(GRID_W / 2, GRID_H / 2, 10);

const renderer = new THREE.WebGPURenderer({ antialias: false, trackTimestamp: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
document.body.appendChild(renderer.domElement);

try {
  await renderer.init();
} catch (err) {
  hud.fail(`WebGPU failed to start:<br><code>${err.message}</code>`);
  throw err;
}

// ---- world ------------------------------------------------------------------
const flowTex = new THREE.DataTexture(field.flow, GRID_W, GRID_H, THREE.RGBAFormat, THREE.UnsignedByteType);
flowTex.magFilter = THREE.NearestFilter;
flowTex.minFilter = THREE.NearestFilter;
flowTex.generateMipmaps = false;
flowTex.needsUpdate = true;

const ground = new Ground(field);
scene.add(ground.mesh);

const horde = new Horde(renderer, flowTex, makeZombieAtlas(), field.base);
await horde.init();
scene.add(horde.mesh);
scene.add(horde.bulletMesh);

const effects = new Effects(scene);
const flowDebug = new FlowOverlay(scene, field);
// Tree effects are read once at boot, so a run's numbers cannot change under you.
const meta = metaEffects();
const build = new Build(field, ground, horde, () => refreshField(), meta);
build.onRampartLost = () => { hud.toast('a rampart has fallen'); sfx.leak(); };
build.addCharge = addCharge;
const waves = new Waves(field, horde);

// A rebake rewrites field.flow in place, so the GPU just needs the upload flag.
const refreshField = () => {
  flowTex.needsUpdate = true;
  ap.cells = null;
  if (flowDebug.visible) flowDebug.rebuild();
};


const menu = new Menu({
  onStart: (i) => startMap(i),
  onResume: () => { state.paused = false; menu.hidePause(); },
  onRestart: () => startMap(mapIndex),
  onQuit: () => toTitle(),
  // Tree changes only take effect on the next run, which is why they are read
  // once at boot: no run can shift under the player mid-wave.
  onRespec: () => hud.toast('applies to your next run'),
  onSetting: (key, value) => {
    if (key === 'sfx' || key === 'music') configureAudio({ [key]: value });
    if (key === 'showBench') applyBenchVisibility();
  },
});
if (attract) { menu.show(); state.sandbox = true; }

function applyBenchVisibility() {
  const show = save.settings.showBench || BENCH || PARAMS.get('perf') === '1';
  document.getElementById('bench').style.display = show ? '' : 'none';
}
applyBenchVisibility();

document.getElementById('over-retry').onclick = () => startMap(mapIndex);
document.getElementById('over-next').onclick = () => startMap(mapIndex + 1);
document.getElementById('over-menu').onclick = () => toTitle();

// Every restart, map change and trip to the title happens in place. Reloading the
// page meant staring at "starting WebGPU" every single time.
async function resetRun() {
  state.paused = true;
  field.load(MAPS[mapIndex]);
  horde.setBase(field.base.x, field.base.y);
  ground.rebuild();
  refreshField();
  build.reset();
  waves.reset();
  charges.length = 0;
  horde.setCharges(charges);
  ap.cells = null;
  ap.cursor = 0;
  audioState.kills = 0;
  audioState.blasts = 0;
  audioState.wave = 0;
  await horde.reset();
  state.hp = BASE_HP;
  state.gold = START_GOLD;
  state.over = false;
  state.won = false;
  state.won = false;
  state.time = 1;
  state.sandbox = attract;
  state.selected = 1;
  document.getElementById('over').classList.remove('show');
  menu.hidePause();
  state.paused = false;
}

async function startMap(i) {
  mapIndex = ((i % MAPS.length) + MAPS.length) % MAPS.length;
  TARGET_WAVES = Math.max(1, WAVES_PARAM || MAPS[mapIndex].waves || 12);
  attract = false;
  document.body.classList.remove('attract');
  menu.hide();
  history.replaceState(null, '', `?map=${mapIndex}`);
  await resetRun();
}

async function toTitle() {
  attract = true;
  document.body.classList.add('attract');
  history.replaceState(null, '', location.pathname);
  await resetRun();
  menu.show();
}

// One place decides a run is finished, so saving and audio cannot drift apart.
function endRun(won) {
  if (state.over) return;
  state.over = true;
  state.won = won;
  // Sandbox makes the base invulnerable, so a sandboxed run must never count.
  // Otherwise G is a one-key "clear every map" button.
  if (!attract && !BENCH && !state.sandbox) {
    save.recordRun({
      map: mapIndex, wave: waves.wave, won, target: TARGET_WAVES,
      kills: horde.stats.kills, mapCount: MAPS.length,
    });
  }
  // Relics from every run, win or lose, scaled by how far you got. This is the
  // whole answer to "forced to replay earlier levels to farm currency".
  if (!attract && !BENCH && !state.sandbox) {
    state.lastRelics = relicsFor({
      wave: waves.wave, kills: horde.stats.kills, won, target: TARGET_WAVES,
    });
    save.addRelics(state.lastRelics);
  }
  if (won) sfx.win(); else sfx.lose();
  if (state.sandbox) hud.toast('sandbox run: not recorded');
  const kills = horde.stats.kills.toLocaleString();
  hud.gameOver(
    won ? `held all ${TARGET_WAVES} waves - ${kills} zombies killed` : `wave ${waves.wave} of ${TARGET_WAVES} - ${kills} zombies killed`,
    won ? 'HELD THE LINE' : 'OVERRUN',
  );
  if (state.lastRelics) hud.toast(`+${state.lastRelics} relics`);
  document.getElementById('over-next').style.display =
    won && mapIndex + 1 < MAPS.length ? '' : 'none';
}

// ---- camera fit -------------------------------------------------------------
let zoom = 1.25;          // the reference plays zoomed in, not fit to map
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h);
  const aspect = w / h;
  const worldAspect = GRID_W / GRID_H;
  let vw, vh;
  if (aspect > worldAspect) { vh = GRID_H; vw = vh * aspect; } else { vw = GRID_W; vh = vw / aspect; }
  camera.left = -vw / 2; camera.right = vw / 2;
  camera.top = vh / 2; camera.bottom = -vh / 2;
  camera.zoom = zoom;
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

// ---- input ------------------------------------------------------------------
const pointer = { x: 0, y: 0, world: null, panning: false, px: 0, py: 0 };

function toWorld(ev) {
  const r = renderer.domElement.getBoundingClientRect();
  const v = new THREE.Vector3(
    ((ev.clientX - r.left) / r.width) * 2 - 1,
    -((ev.clientY - r.top) / r.height) * 2 + 1,
    0,
  );
  v.unproject(camera);
  return { x: v.x, y: v.y };
}

renderer.domElement.addEventListener('pointermove', (ev) => {
  pointer.world = toWorld(ev);
  if (pointer.panning) {
    const k = (camera.right - camera.left) / camera.zoom / innerWidth;
    camera.position.x -= (ev.clientX - pointer.px) * k;
    camera.position.y += (ev.clientY - pointer.py) * k;
    pointer.px = ev.clientX; pointer.py = ev.clientY;
  }
});

addEventListener('pointerdown', () => { startAudio(); resumeAudio(); }, { once: false });
addEventListener('keydown', () => { startAudio(); resumeAudio(); }, { once: false });

renderer.domElement.addEventListener('pointerdown', (ev) => {
  if (ev.button === 2 || ev.button === 1) {
    pointer.panning = true; pointer.px = ev.clientX; pointer.py = ev.clientY;
    return;
  }
  if (ev.button !== 0 || state.over) return;
  const world = toWorld(ev);

  // Clicking a turret upgrades it. At the build cap that is the only way to keep
  // up with the wave curve, so it needs to be the obvious action.
  // shift-click sells whatever is under the cursor, turret or rampart
  if (ev.shiftKey) {
    const wall = build.rampartAt(world);
    if (wall && !build.turretAt(world)) {
      const refund = build.sellRampart(wall);
      state.gold += refund;
      refreshField();
      sfx.place();
      hud.toast(`rampart cleared, +${refund}g`);
      return;
    }
  }

  const existing = build.turretAt(world);
  if (existing && ev.shiftKey) {
    const refund = build.sell(existing);
    state.gold += refund;
    sfx.place();
    hud.toast(`sold for ${refund}g`);
    return;
  }
  if (existing) {
    const up = build.upgradeCost(existing);
    if (existing.level >= build.maxLevel()) { hud.toast('already max level'); sfx.denied(); return; }
    if (state.gold < up) { hud.toast(`upgrade costs ${up}g`); sfx.denied(); return; }
    build.upgrade(existing);
    state.gold -= up;
    sfx.place();
    hud.toast(`upgraded to level ${existing.level}`);
    return;
  }

  const b = BUILDS[state.selected];
  const price = build.costOf(b);
  if (state.gold < price) { hud.toast('not enough gold'); sfx.denied(); return; }
  const err = build.place(world, b);
  if (err) { hud.toast(err); sfx.denied(); return; }
  state.gold -= price;
  sfx.place();
  refreshField();
});

addEventListener('pointerup', () => { pointer.panning = false; });
renderer.domElement.addEventListener('contextmenu', (ev) => ev.preventDefault());

renderer.domElement.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const before = toWorld(ev);
  zoom = Math.min(6, Math.max(0.75, zoom * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
  camera.zoom = zoom;
  camera.updateProjectionMatrix();
  const after = toWorld(ev);
  camera.position.x += before.x - after.x;
  camera.position.y += before.y - after.y;
}, { passive: false });

addEventListener('keydown', (ev) => {
  const i = BUILDS.findIndex((b) => b.key === ev.key);
  if (i >= 0) { state.selected = i; return; }
  if (ev.code === 'Space') {
    ev.preventDefault();
    callWave();
  } else if (ev.key === 'Escape') {
    if (attract) return;
    state.paused = !state.paused;
    if (state.paused) menu.showPause(); else menu.hidePause();
  } else if (ev.key === 'p' || ev.key === 'P') {
    state.paused = !state.paused;
    if (state.paused) menu.showPause(); else menu.hidePause();
  } else if (ABILITIES.some((a) => a.key === ev.key.toLowerCase())) {
    fireAbility(ABILITIES.find((a) => a.key === ev.key.toLowerCase()));
  } else if (ev.key === 'f' || ev.key === 'F') {
    const on = flowDebug.toggle();
    hud.toast(on
      ? `flow field: ${flowDebug.degenerate} dead cells (red)`
      : 'flow field off');
  } else if (ev.key === 't' || ev.key === 'T') {
    cycleSpeed();
  } else if (ev.key === 'g' || ev.key === 'G') {
    if (state.sandbox) { state.sandbox = false; hud.toast('sandbox off'); }
    else { enterSandbox(); hud.toast('sandbox on: base invulnerable'); }
  } else if (ev.key === 'm' || ev.key === 'M') {
    hud.toast(toggleMute() ? 'muted' : 'sound on');
  } else if (ev.key === 'n' || ev.key === 'N') {
    startMap((mapIndex + 1) % MAPS.length);
  } else if (ev.key === 'r' || ev.key === 'R') {
    startMap(mapIndex);
  }
});

// ---- stress helpers ---------------------------------------------------------
// Benchmark spawns are not an attack on the player: they make the base
// invulnerable so a flood cannot instantly end the run.
function enterSandbox() {
  if (state.sandbox) return;
  state.sandbox = true;
  state.over = false;
  state.hp = state.hpMax;
  document.getElementById('over').classList.remove('show');
}

function stress(n) {
  enterSandbox();
  const t = ZOMBIE_TYPES[0];
  let left = n;
  while (left > 0) {
    const c = Math.min(SPAWN_BATCH, left);
    left -= c;
    // Spread scales with the head count. A fixed 2.4 put ten thousand bodies
    // into a patch of twenty-three square units that needs fifteen hundred:
    // sixty-seven times over-subscribed, which is not a stress test of the
    // solver so much as a demand it cannot satisfy. The pile overflowed the
    // spatial hash purely because nothing could fit.
    const need = n * Math.PI * zombieRadius(t.scale) ** 2;
    const half = Math.min(GRID_W, GRID_H) / 2 - 1;
    horde.spawn(c, {
      pos: field.spawns[0], hp: t.hp, type: 0, speed: t.speed,
      gold: t.gold, scale: t.scale,
      spread: Math.max(2.4, Math.min(half, Math.sqrt(need / 0.35) / 2)),
    });
  }
  hud.toast(horde.stats.spawned > MAX_ZOMBIES ? `+${n} (at capacity, recycling oldest)` : `+${n} zombies`);
}

// Fill the playfield rather than the portal, for a worst-case density test.
function flood(count = Math.floor(MAX_ZOMBIES / 2)) {
  enterSandbox();
  const t = ZOMBIE_TYPES[0];
  const centre = { x: GRID_W / 2, y: GRID_H / 2 };
  const batches = Math.max(1, Math.floor(Math.min(count, MAX_ZOMBIES) / SPAWN_BATCH));
  for (let i = 0; i < batches; i++) {
    horde.spawn(SPAWN_BATCH, {
      pos: centre, hp: t.hp * 4, type: 0, speed: t.speed,
      // Sized to the SHORTER axis. max() overshot the board by twenty units on
      // the short side, and every body it threw past the edge was gone for good.
      gold: t.gold, scale: t.scale, spread: Math.min(GRID_W, GRID_H) / 2 - 1,
    });
  }
  hud.toast(`flooding ${batches * SPAWN_BATCH} zombies`);
}

function cycleSpeed() {
  const i = SPEEDS.indexOf(simSpeed);
  simSpeed = SPEEDS[(i + 1) % SPEEDS.length] ?? 1;
  save.setSetting('speed', simSpeed);
  hud.toast(`${simSpeed}x speed`);
  sfx.click();
}

// The reference puts a prompt in the middle of the screen during the build phase.
// It doubles as the wave callout, which is the clearest place for both.
function bannerText() {
  if (attract || state.over) return '';
  if (state.paused) return '';
  if (waves.state === 'idle') return '<b>BUILD PHASE</b><span>press SPACE to start the battle</span>';
  if (waves.state === 'build') {
    return `<b>BUILD PHASE</b><span>SPACE for wave ${waves.wave + 1} of ${TARGET_WAVES}`
      + ` &middot; +${waves.rushBonus()}g if you rush it</span>`;
  }
  if (state.time - waveShownAt < 1.6) return `<b>WAVE ${waves.wave}</b><span>of ${TARGET_WAVES}</span>`;
  return '';
}
let waveShownAt = -9;

function callWave() {
  const bonus = waves.rushBonus();
  if (!waves.call()) return false;
  if (bonus > 0) { state.gold += bonus; hud.toast(`wave ${waves.wave}  +${bonus}g rushed`); }
  else hud.toast(`wave ${waves.wave}`);
  return true;
}

// ---- physics charges (bait / shockwave) --------------------------------------
// GPU acceleration fields abilities push into the crowd: an attract charge
// gathers zombies toward a point, a repel charge throws them away from it.
// Owned here, one array with one job (write the uniform snapshot each frame);
// build.js only ever calls addCharge() to enqueue one and never touches the
// list itself.
const charges = [];   // {x, y, accel, radius, until}

function addCharge(x, y, accel, radius, seconds) {
  charges.push({ x, y, accel, radius, until: state.time + seconds });
}

function updateCharges() {
  for (let i = charges.length - 1; i >= 0; i--) {
    if (state.time >= charges[i].until) charges.splice(i, 1);
  }
  horde.setCharges(charges);
}

// Abilities fire at the cursor, along the local flow so an airstrike lands down
// the lane the horde is walking rather than across it.
function fireAbility(a) {
  const at = pointer.world;
  if (!at || state.over || state.paused) return;
  if (!build.abilityReady(a)) { hud.toast(`${a.name} on cooldown`); sfx.denied(); return; }
  const cx = Math.max(0, Math.min(GRID_W - 1, Math.floor(at.x)));
  const cy = Math.max(0, Math.min(GRID_H - 1, Math.floor(at.y)));
  const o = (cy * GRID_W + cx) * 4;
  const dir = { x: field.flow[o] / 255 * 2 - 1, y: field.flow[o + 1] / 255 * 2 - 1 };
  build.fireAbility(a, at, dir);
  // Bait's own detonation blast plays sfx.blast() automatically through the
  // tick-based delta check below (build.blasts.length growing), so this only
  // needs to cover the sound of the ability actually landing.
  if (a.id === 'bait') sfx.ping();
  else if (a.id === 'shock') sfx.thump();
  else sfx.blast();
  hud.toast(a.name);
}

// ---- baseline bot -----------------------------------------------------------
// Not a good player, a *consistent* one: greedy spend, defend nearest the base
// first, spread outward. Enough to answer "is this map survivable at all".
const ap = { timer: 0, cursor: 0, cells: null };

// Candidate spots. Turrets go on rock, so the list is rock cells scored by the
// cheapest path cost nearby: that is "how close is this platform to the route".
function apCells() {
  if (ap.cells) return ap.cells;
  const cells = [];
  for (let y = 1; y < GRID_H - 1; y += 2) {
    for (let x = 1; x < GRID_W - 1; x += 2) {
      if (!field.isWall(x, y)) continue;
      let near = Infinity;
      for (let oy = -3; oy <= 3; oy++) {
        for (let ox = -3; ox <= 3; ox++) {
          const gx = Math.min(GRID_W - 1, Math.max(0, x + ox));
          const gy = Math.min(GRID_H - 1, Math.max(0, y + oy));
          const c = field.cost[field.idx(gx, gy)];
          if (Number.isFinite(c) && c < near) near = c;
        }
      }
      if (Number.isFinite(near)) cells.push({ x: x + 0.5, y: y + 0.5, c: near });
    }
  }
  cells.sort((a, b) => a.c - b.c);
  ap.cells = cells;
  return cells;
}

function apTraffic(x, y) {
  const d = horde.density;
  if (!d || !d.length) return 0;
  let sum = 0;
  const cx = Math.round(x * DENS_SCALE), cy = Math.round(y * DENS_SCALE);
  for (let oy = -3; oy <= 3; oy++) {
    const gy = cy + oy;
    if (gy < 0 || gy >= DENS_H) continue;
    for (let ox = -3; ox <= 3; ox++) {
      const gx = cx + ox;
      if (gx < 0 || gx >= DENS_W) continue;
      sum += d[gy * DENS_W + gx];
    }
  }
  return sum;
}

function autoplay(dt) {
  if (waves.state !== 'running') callWave();
  // Abilities at density spikes, which is what they are for.
  for (const a of ABILITIES) {
    if (!build.abilityReady(a)) continue;
    const t = horde.densestNear(field.base.x, field.base.y, 60);
    if (t && t.count > (a.id === 'nuke' ? 40 : 14)) {
      build.fireAbility(a, t, { x: 1, y: 0 });
      break;
    }
  }
  ap.timer -= dt;
  if (ap.timer > 0) return;
  ap.timer = 0.4;

  const cells = apCells();
  for (const i of [4, 3, 2, 1]) {              // most expensive affordable first
    const b = BUILDS[i];
    const price = build.costOf(b);
    if (state.gold < price) continue;
    // Pick the busiest legal spot, tie-broken toward the base. Placing on the
    // traffic is what a person does, and it is a far better balance signal than
    // filling the map from the base outward.
    let best = null, bestScore = -1;
    for (const cell of cells) {
      if (!build.valid(cell, b)) continue;
      const score = apTraffic(cell.x, cell.y) * 4 + 60 / (1 + cell.c * 0.05);
      if (score > bestScore) { bestScore = score; best = cell; }
    }
    if (!best) continue;
    if (build.place(best, b)) continue;
    state.gold -= price;
    return;
  }

  // Nothing left to place: pour gold into the busiest turret instead.
  let target = null, targetScore = -1;
  for (const t of build.turrets) {
    if (t.level >= build.maxLevel()) continue;
    if (state.gold < build.upgradeCost(t)) continue;
    const score = apTraffic(t.x, t.y) + 1 / (1 + t.level);
    if (score > targetScore) { targetScore = score; target = t; }
  }
  if (target) {
    state.gold -= build.upgradeCost(target);
    build.upgrade(target);
  }
}

// ---- scriptable benchmark entry points --------------------------------------
// ?spawn=N       flood N zombies at boot
// ?bench=1       keep ramping, no waves, base takes no damage
// ?rate=N        zombies added per ramp step (default 4000)
// ?autobuild=1   drop one of each turret on the path, for a damage-path run
// ?perf=1        log a frame-time distribution every 60 frames
const bench = { next: 2, step: 0, rate: Number(PARAMS.get('rate') ?? 4000) };

if (PARAMS.get('flow') === '1') flowDebug.toggle();
if (PARAMS.get('gold')) state.gold = Number(PARAMS.get('gold'));
if (PARAMS.get('autobuild') === '1') autobuild();
if (PARAMS.get('ramparts')) dropRamparts(Number(PARAMS.get('ramparts')));

// Paint ramparts along the path through the same code a click uses, so the
// placement + rebake + reachability guard all get exercised.
function dropRamparts(n) {
  const cells = [];
  for (let y = 2; y < GRID_H - 2; y += 2) {
    for (let x = 2; x < GRID_W - 2; x += 2) {
      const c = field.cost[field.idx(x, y)];
      if (Number.isFinite(c) && !field.isWall(x, y)) cells.push({ x: x + 0.5, y: y + 0.5, c });
    }
  }
  cells.sort((a, b) => a.c - b.c);
  let placed = 0, refused = 0;
  for (let i = 0; i < cells.length && placed < n; i += 3) {
    if (build.place(cells[i], BUILDS[0])) refused++; else placed++;
  }
  refreshField();
  console.log(`[ramparts] placed ${placed}, refused ${refused} (would have sealed the path)`);
}
if (PARAMS.get('spawn')) flood(Number(PARAMS.get('spawn')));
if (PARAMS.get('wave') === '1') waves.call();
// ?then=N switches to map N after 8s, which is how the map-change reset path gets
// exercised without a human clicking the menu.
if (PARAMS.get('then')) {
  setTimeout(() => startMap(Number(PARAMS.get('then'))), 8000);
}   // start the real game loop headlessly

// Drop turrets along the route on the platform list the bot uses. ?only=<id>
// restricts it to one weapon, which is how a single weapon gets tested in
// isolation, and ?gold=N gives it something to spend.
function autobuild() {
  const only = PARAMS.get('only');
  const defs = BUILDS.filter((b) => b.kind === 'turret' && (!only || b.id === only));
  const cells = apCells();
  let placed = 0;
  for (let pass = 0; pass < 12; pass++) {
    for (const def of defs) {
      const frac = (pass * 0.07 + defs.indexOf(def) * 0.17) % 0.9;
      for (let i = Math.floor(cells.length * frac); i < cells.length; i++) {
        const price = build.costOf(def);
        if (state.gold < price) break;
        if (build.place(cells[i], def)) continue;
        state.gold -= price;
        placed++;
        break;
      }
    }
  }
  console.log(`[autobuild] placed ${placed}${only ? ` (${only} only)` : ''}`);
  refreshField();
}

// ---- loop -------------------------------------------------------------------
let last = performance.now();
let fps = 60, msAvg = 16, frames = 0;
let computeMs = null, renderMs = null;
const window60 = [];

hud.ready();

// Heartbeat the smoke test can read back over CDP.
globalThis.__biomass = () => ({
  frames, time: state.time, alive: horde.stats.alive, spawned: horde.stats.spawned,
  kills: horde.stats.kills, leaks: horde.stats.leaks, gold: state.gold,
  turrets: build.turrets.length, blasts: build.blasts.length,
  muzzles: horde._muzzleCount ?? 0, bulletCursor: horde._bulletCursor ?? 0,
  bulletHits: horde.stats.hits ?? 0, stuck: horde.stats.stuck ?? -1,
  oob: horde.stats.oob ?? -1, inRock: horde.stats.inRock ?? -1,
  hashDrop: horde.stats.hashDrop ?? -1,
  baseSynced: Math.hypot(horde.u.basePos.value.x - field.base.x, horde.u.basePos.value.y - field.base.y) < 0.01,
  map: mapIndex,
  hp: state.hp, over: state.over, won: state.won, sandbox: state.sandbox,
  wave: waves.wave, waveState: waves.state, target: TARGET_WAVES, speed: simSpeed,
  queued: horde._spawnQueue.length, lastError: globalThis.__biomassError ?? null,
  charges: charges.length, chargeCount: horde.u.chargeCount.value,
  chargeSample: charges[0] ? { x: +charges[0].x.toFixed(2), y: +charges[0].y.toFixed(2), accel: charges[0].accel, radius: charges[0].radius } : null,
  beacons: build.beacons.length, rings: build.rings.length,
  spawnAt: { x: +field.spawns[0].x.toFixed(2), y: +field.spawns[0].y.toFixed(2) },
});

// Jitter gauge. Reads the crowd buffer twice a second apart and compares the
// speed each zombie CLAIMS with the distance it actually covered.
//
// A jiggling crowd reports high speed and goes nowhere, so the ratio between
// them is the number that matters: near 1 means every unit of speed turned into
// travel, and a large ratio means bodies are vibrating on the spot. The old
// solver could sit at 3-4 while looking completely stalled, because it assigned
// velocity from the flow field regardless of whether the zombie could move.
// Scale benchmark hooks: pour zombies in and read the cost back out.
globalThis.__biomassStress = (n) => { stress(n); return horde.stats.spawned; };
globalThis.__biomassPerf = () => ({
  alive: horde.stats.alive,
  drawn: horde.used ?? 0,
  fps: +fps.toFixed(1),
  frameMs: +msAvg.toFixed(2),
  computeMs: computeMs != null ? +computeMs.toFixed(3) : null,
  renderMs: renderMs != null ? +renderMs.toFixed(3) : null,
  substeps: horde.substeps, iterations: horde.iterations,
});

// How many living zombies have any part of their body inside rock.
//
// The number Salman asked for, and the one a centre-point wall test could never
// report honestly: a body centred just outside a wall passes a centre test while
// being visibly buried, which is what produced the band of zombies lining every
// platform edge. This measures circle-vs-cell overlap, the same way the solver
// now resolves it.
globalThis.__biomassEmbedded = async () => {
  const posBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.pos.value));
  const datBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.dat.value));
  // Bodies vary in size now, so the test has to read each one's actual radius.
  // A fixed value here would quietly pass big bodies that are buried and fail
  // small ones that are clear.
  const attBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.att.value));
  const n = Math.min(horde.used ?? 0, datBuf.length / 4);
  const { walls, w, h } = field;
  let alive = 0; let embedded = 0; let deep = 0;
  const deepAt = [];
  for (let i = 0; i < n; i++) {
    if (datBuf[i * 4] <= 0) continue;
    alive++;
    const x = posBuf[i * 4]; const y = posBuf[i * 4 + 1];
    const R = attBuf[i * 4 + 3] || 0.15;
    const bx = Math.floor(x); const by = Math.floor(y);
    let worst = 0;
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const cx = bx + ox; const cy = by + oy;
        if (cx < 0 || cy < 0 || cx >= w || cy >= h) continue;
        if (!walls[cy * w + cx]) continue;
        const qx = Math.min(Math.max(x, cx), cx + 1);
        const qy = Math.min(Math.max(y, cy), cy + 1);
        const d = Math.hypot(x - qx, y - qy);
        if (d < R) worst = Math.max(worst, R - d);
      }
    }
    if (worst > 0.01) embedded++;
    if (worst >= R) {
      deep++;                            // centre itself inside the slab
      if (deepAt.length < 400) deepAt.push({ x: +x.toFixed(2), y: +y.toFixed(2) });
    }
  }
  return {
    alive,
    embedded,
    embeddedPct: alive ? +((embedded / alive) * 100).toFixed(2) : 0,
    deep,
    // Where are they? A count alone cannot tell you whether these are bodies
    // that walked in or bodies that were placed there.
    samples: deepAt.slice(0, 8),
    nearSpawn: deepAt.filter((s2) => Math.hypot(s2.x - field.spawns[0].x, s2.y - field.spawns[0].y) < 4).length,
    nearBase: deepAt.filter((s2) => Math.hypot(s2.x - field.base.x, s2.y - field.base.y) < 4).length,
    spawn: { x: +field.spawns[0].x.toFixed(2), y: +field.spawns[0].y.toFixed(2) },
    spawnInRock: !!walls[Math.floor(field.spawns[0].y) * w + Math.floor(field.spawns[0].x)],
  };
};

// Find bodies that are not making progress, and say WHY. A count of stalls tells
// you something is wrong; this tells you where they are, what the ground under
// them is, and what the flow field is asking them to do there.
globalThis.__biomassStuck = async (ms = 1500) => {
  const snap = async () => Float32Array.from(
    new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.pos.value)));
  const dat = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.dat.value));
  const a = await snap();
  await new Promise((r) => setTimeout(r, ms));
  const b = await snap();

  const n = Math.min(horde.used ?? 0, dat.length / 4);
  const { walls, w, h, cost, flow } = field;
  const stuck = [];
  let alive = 0;
  for (let i = 0; i < n; i++) {
    if (dat[i * 4] <= 0) continue;
    alive++;
    const x = b[i * 4]; const y = b[i * 4 + 1];
    const moved = Math.hypot(x - a[i * 4], y - a[i * 4 + 1]);
    if (moved > 0.35) continue;                        // making progress
    const cx = Math.floor(x); const cy = Math.floor(y);
    const ci = cy * w + cx;
    stuck.push({
      x: +x.toFixed(2), y: +y.toFixed(2), moved: +moved.toFixed(3),
      rock: !!walls[ci],
      cost: Number.isFinite(cost[ci]) ? +cost[ci].toFixed(1) : 'UNREACHABLE',
      // the baked heading at that cell, decoded from the texture
      dir: [+((flow[ci * 4] / 255) * 2 - 1).toFixed(2), +((flow[ci * 4 + 1] / 255) * 2 - 1).toFixed(2)],
      distToBase: +Math.hypot(x - field.base.x, y - field.base.y).toFixed(1),
    });
  }
  // group them so a clump reads as one entry rather than four hundred
  const clumps = [];
  for (const s2 of stuck) {
    const near = clumps.find((c) => Math.hypot(c.x - s2.x, c.y - s2.y) < 3);
    if (near) { near.count++; } else { clumps.push({ ...s2, count: 1 }); }
  }
  clumps.sort((p1, p2) => p2.count - p1.count);
  return {
    alive,
    stuck: stuck.length,
    stuckPct: alive ? +((stuck.length / alive) * 100).toFixed(2) : 0,
    clumps: clumps.slice(0, 6),
  };
};

// Test hook: fire a raw physics charge at a point, bypassing abilities and
// cooldowns entirely. Positive accel attracts, negative repels.
globalThis.__biomassCharge = (x, y, accel, radius, seconds) => {
  addCharge(x, y, accel, radius, seconds);
  return charges.length;
};

// Test hook: fire any ability at a point, ignoring its cooldown.
globalThis.__biomassAbility = (name, x, y) => {
  const a = ABILITIES.find((ab) => ab.id === name);
  if (!a) return false;
  build.cooldowns[a.id] = 0;
  return build.fireAbility(a, { x, y }, { x: 1, y: 0 });
};

// Test hook: mean distance from every currently-alive zombie to a point.
// Cheap and fine for a single reading, but NOT for comparing two readings
// taken seconds apart in sandbox/bench mode: zombies constantly leak into the
// base, and the ones that do are always the furthest-progressed (so the
// furthest from a point near the middle of the map), which drags the mean of
// whoever is left DOWN over time even with zero ability effect. See
// __biomassSnapshot for the cohort-tracked version that controls for that.
globalThis.__biomassMeanDist = async (x, y) => {
  const posBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.pos.value));
  const datBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.dat.value));
  const n = Math.min(horde.used ?? 0, datBuf.length / 4);
  let sum = 0, count = 0;
  for (let i = 0; i < n; i++) {
    if (datBuf[i * 4] <= 0) continue;
    sum += Math.hypot(posBuf[i * 4] - x, posBuf[i * 4 + 1] - y);
    count++;
  }
  return { count, mean: count ? sum / count : 0 };
};

// Test hook: raw per-slot alive flag + position for every slot that has ever
// held a zombie. A caller wanting to measure a charge's effect on distance
// over TIME should intersect the alive flags across several snapshots first
// and only average over that fixed cohort -- comparing raw "mean distance of
// whoever is alive right now" between two snapshots seconds apart is
// dominated by leak-drain survivorship bias, not by the charge.
globalThis.__biomassSnapshot = async () => {
  const posBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.pos.value));
  const datBuf = new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.dat.value));
  const n = Math.min(horde.used ?? 0, datBuf.length / 4);
  const alive = new Array(n), x = new Array(n), y = new Array(n);
  for (let i = 0; i < n; i++) {
    alive[i] = datBuf[i * 4] > 0 ? 1 : 0;
    x[i] = posBuf[i * 4];
    y[i] = posBuf[i * 4 + 1];
  }
  return { n, alive, x, y };
};

globalThis.__biomassSolver = (substeps, iterations) => {
  if (substeps) horde.substeps = substeps;
  if (iterations) horde.iterations = iterations;
  return { substeps: horde.substeps, iterations: horde.iterations };
};

globalThis.__biomassJitter = async (ms = 1000) => {
  const snap = async () => Float32Array.from(
    new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.pos.value)));
  const live = Float32Array.from(
    new Float32Array(await horde.renderer.getArrayBufferAsync(horde._buffers.dat.value)));
  const a = await snap();
  const t0 = performance.now();
  await new Promise((r) => setTimeout(r, ms));
  const b = await snap();
  const dt = (performance.now() - t0) / 1000;

  const n = Math.min(horde.used ?? 0, live.length / 4);
  let speed = 0; let travel = 0; let alive = 0;
  for (let i = 0; i < n; i++) {
    if (live[i * 4] <= 0) continue;                 // dead or empty slot
    alive++;
    speed += Math.hypot(a[i * 4 + 2], a[i * 4 + 3]);
    travel += Math.hypot(b[i * 4] - a[i * 4], b[i * 4 + 1] - a[i * 4 + 1]);
  }
  if (!alive) return { alive: 0 };
  const meanSpeed = speed / alive;
  const meanTravel = travel / alive / dt;           // units per second actually covered
  return {
    alive,
    meanSpeed: +meanSpeed.toFixed(3),
    meanTravel: +meanTravel.toFixed(3),
    // >1 means claimed speed that never became travel: that is the jiggle
    jitterRatio: +(meanSpeed / Math.max(meanTravel, 1e-3)).toFixed(2),
  };
};

function frame(now) {
  try {
    step(now);
  } catch (err) {
    globalThis.__biomassError = `${err.message}\n${err.stack}`;
    console.error('[frame]', err);
    return;                       // stop rather than spam once broken
  }
  requestAnimationFrame(frame);
}

function step(now) {
  const raw = (now - last) / 1000;
  last = now;
  const dt = Math.min(raw, 1 / 20);          // a hitch must not teleport the horde
  frames++;
  // Rolling window, so the readout is a real distribution and not an average
  // that a single hitch can poison.
  window60.push(raw * 1000);
  if (window60.length > 60) window60.shift();
  if (frames % 60 === 0) {
    const s = [...window60].sort((a, b) => a - b);
    msAvg = s[Math.floor(s.length / 2)];
    fps = 1000 / Math.max(msAvg, 0.01);
    if (PARAMS.get('perf') === '1') {
      console.log(`[perf] p50 ${msAvg.toFixed(2)}ms  p95 ${s[Math.floor(s.length * 0.95)].toFixed(2)}ms  max ${s[s.length - 1].toFixed(2)}ms  alive ${horde.stats.alive}  drawn ${horde.used ?? 0}  compute ${computeMs?.toFixed(2) ?? '?'}  render ${renderMs?.toFixed(2) ?? '?'}`);
    }
  }

  // Sim substeps rather than a bigger dt: a fat dt would tunnel zombies through
  // rock. At sub-millisecond compute, 8 substeps a frame is free, and it lets an
  // automated playtest finish a 12-wave run in well under a minute.
  for (let sub = 0; sub < simSpeed && !state.paused && !state.over; sub++) tick(dt);

  effects.sync(build.turrets, build.segments, build.blasts, state.time, build.muzzleFlashes, build.rings, build.beacons);
  const b = BUILDS[state.selected];
  effects.setGhost(pointer.world, b, pointer.world ? build.valid(pointer.world, b) : false);

  renderer.render(scene, camera);

  // GPU timings, resolved off the frame path. Not every device exposes
  // timestamp-query, hence the shrug.
  if (frames % 12 === 0) {
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.COMPUTE)
      .then(() => { computeMs = renderer.info.compute.timestamp ?? null; }).catch(() => {});
    renderer.resolveTimestampsAsync(THREE.TimestampQuery.RENDER)
      .then(() => { renderMs = renderer.info.render.timestamp ?? null; }).catch(() => {});
  }

  hud.update({
    hp: state.hp, hpMax: state.hpMax, gold: state.gold,
    alive: horde.stats.alive, kills: horde.stats.kills,
    wave: waves.wave, mapName: `${field.name}${BENCH ? '  [BENCH]' : ''}${isAutoplay() ? '  [AUTOPLAY]' : ''}`,
    waveText: waveText(),
    fps, ms: msAvg, computeMs, renderMs, speed: simSpeed, muted: isMuted(), banner: bannerText(),
    spawned: horde.stats.spawned, cap: MAX_ZOMBIES, selected: state.selected,
    stalls: horde.stats.stuck ?? 0,
    recycling: horde.stats.recycling === true,
    costs: BUILDS.map((b) => build.costOf(b)),
    built: Object.fromEntries(BUILDS.map((b) => [b.id, build.builtOf(b.id)])),
    towers: build.turrets.length, towerCap: build.maxBuilt,
    cooldowns: ABILITIES.map((a) => build.cooldowns[a.id] ?? 0),
  });
}

function tick(dt) {
  {
    state.time += dt;
    if (isAutoplay()) autoplay(dt);
    if (BENCH) {
      if (state.time > bench.next) {
        bench.next += 2;
        bench.step++;
        stress(bench.rate);
        console.log(`[bench] step ${bench.step}  alive ${horde.stats.alive}  ${fps.toFixed(1)} fps  frame ${msAvg.toFixed(2)}ms  compute ${computeMs?.toFixed(2) ?? '?'}ms`);
      }
    } else {
      waves.update(dt);
    }
    build.update(dt, state.time);
    updateCharges();
    horde.update(dt, state.time);

    state.gold += horde.takeGold();
    const leaked = horde.takeLeaks();
    if (leaked && !BENCH && !state.sandbox) {
      state.hp -= leaked;
      sfx.leak();
      if (state.hp <= 0) endRun(false);
    }

    // Held every wave up to the target: that is a win.
    if (!BENCH && !attract && waves.wave >= TARGET_WAVES && waves.state === 'build') endRun(true);

    // Audio is driven off deltas, never per zombie: tens of thousands die per wave.
    const dk = horde.stats.kills - audioState.kills;
    audioState.kills = horde.stats.kills;
    sfx.crowdKills(dk, state.time);
    sfx.turretFire(build.turrets.length, state.time);
    if (build.blasts.length > audioState.blasts) sfx.blast();
    audioState.blasts = build.blasts.length;
    if (waves.wave !== audioState.wave) {
      audioState.wave = waves.wave;
      waveShownAt = state.time;
      if (waves.wave > 0) sfx.waveHorn();
    }
  }
}

const audioState = { kills: 0, blasts: 0, wave: 0 };

function waveText() {
  if (state.sandbox && !BENCH) return 'SANDBOX (G to arm base)';
  if (BENCH) return `ramp step ${bench.step}`;
  if (state.paused) return 'paused';
  if (waves.state === 'running') return `${waves.remaining} left to spawn`;
  if (waves.state === 'build') return `BUILD PHASE - SPACE for wave ${waves.wave + 1} (+${waves.rushBonus()}g)`;
  return 'press SPACE to begin';
}

requestAnimationFrame(frame);
