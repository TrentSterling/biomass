// Waves ramp headcount first and health second, because the count is the whole
// point of the game.

import {
  ZOMBIE_TYPES, SURVIVOR, SURVIVOR_TYPE, GRID_W, GRID_H, CELL_SCALE,
} from '../config.js';

// Build phase between waves, like the original: the wave does not start until
// the player says so. Calling it early pays a bounty, so there is a reason to
// press the button instead of idling.
const RUSH_BONUS_PER_SEC = 8;

// Two groups of survivors per wave, timed off the wave clock rather than the
// zombie drip: they show up whether or not that wave's composition has
// finished spawning.
const SURVIVOR_SCHEDULE = [6, 18];   // seconds into the wave
const SURVIVORS_PER_GROUP = 5;

// Random OPEN cell hugging the play area's border, on three of its four sides
// (left/top/bottom -- the reference layout keeps the right side clear for the
// camera's default framing). One authored cell in from the rock ring that
// wraps every map, so a survivor is never born a cell away from solid geometry
// -- it can still get nudged by horde.js's own spawn-guard (never hatch inside
// rock), but it should not need to.
function edgeCells(field) {
  const m = CELL_SCALE;
  const cells = [];
  const yTop = GRID_H - m - 1;
  const yBot = m;
  const xLeft = m;
  for (let x = m; x < GRID_W - m; x++) {
    if (!field.isWall(x, yTop)) cells.push({ x: x + 0.5, y: yTop + 0.5 });
    if (!field.isWall(x, yBot)) cells.push({ x: x + 0.5, y: yBot + 0.5 });
  }
  for (let y = m; y < GRID_H - m; y++) {
    if (!field.isWall(xLeft, y)) cells.push({ x: xLeft + 0.5, y: y + 0.5 });
  }
  return cells;
}

// The reference throws 100k+ zombies at you in its late waves, and difficulty comes
// from bodies rather than from health bars. So the count grows hard and health
// grows gently: wave 1 is about 1,100 zombies, wave 10 about 38,000, wave 16 about
// 81,000, wave 20 about 118,000 (crawlers join at wave 2, husks at wave 4).
export function composition(n) {
  const entries = [
    { type: 0, count: Math.round(300 + n * 600 + n * n * 220), dur: 11 },
  ];
  if (n >= 2) entries.push({ type: 2, count: Math.round(120 + n * 130), dur: 8 });
  if (n >= 3) entries.push({ type: 1, count: Math.round(10 + n * 14), dur: 10 });
  // Crawlers: cheap and fast, thrown in from wave 2 as a swarm alongside the
  // sprinters. Linear like the other secondary types (no n*n term) so they
  // do not compound against the shambler curve at high waves: about 30% of
  // wave 2's headcount, easing off in share as the shambler count takes over
  // the way sprinter's share already does.
  if (n >= 2) entries.push({ type: 4, count: Math.round(400 + n * 380), dur: 7 });
  // Husks: tougher squads, not a swarm, so a shorter drip window than the
  // crawlers. Held back to wave 4 so wave 1-3 stay a pure shambler/sprinter/
  // bloater ramp; linear count, about 20% of wave 4's headcount.
  if (n >= 4) entries.push({ type: 3, count: Math.round(1092 + n * 280), dur: 9 });
  return entries;
}

export class Waves {
  constructor(field, horde) {
    this.field = field;
    this.horde = horde;
    this.wave = 0;
    this.state = 'idle';         // idle | build | running
    this.timer = 0;
    this.active = [];
    this.portal = 0;
    this.hpScale = 1;
    this.speedScale = 1;
    // Survivor groups: timed independently of the zombie drip above, and of
    // build/running state, so 18s-in still lands even on a short early wave.
    this.waveTime = 0;
    this.survivorSchedule = [];
    this.survivorAnnounced = false;
    this.onSurvivors = null;    // () => void, wired by main.js for the toast
  }

  reset() {
    this.wave = 0;
    this.state = 'idle';
    this.timer = 0;
    this.active = [];
    this.portal = 0;
    this.hpScale = 1;
    this.speedScale = 1;
    this.waveTime = 0;
    this.survivorSchedule = [];
    this.survivorAnnounced = false;
  }

  get remaining() {
    return this.active.reduce((a, e) => a + Math.ceil(e.count), 0);
  }

  call() {
    if (this.state === 'running') return false;
    // rushBonus pays MORE the sooner this is called after entering 'build',
    // and composition()'s shortest wave reaches 'build' well before the 18s
    // survivor mark -- so a player following the game's own incentive would
    // otherwise call() straight through a still-pending group and wipe it the
    // instant survivorSchedule is replaced below, with no toast, no gold, no
    // record it ever existed. Flush anything still owed from the outgoing
    // wave first: rushing makes it land right now instead of at its original
    // timestamp, never makes it vanish.
    for (const s of this.survivorSchedule) {
      this.#spawnSurvivors(s.count);
      if (!this.survivorAnnounced) {
        this.survivorAnnounced = true;
        this.onSurvivors?.();
      }
    }
    this.wave++;
    // Multiplicative, not linear. A fixed line of turrets has a fixed damage
    // throughput, so linear health means the defence always wins eventually.
    // Compounding health is what makes late waves genuinely threatening.
    // Gentle: the bodies are the threat, not the health bars.
    this.hpScale = Math.pow(1.09, this.wave - 1);
    this.speedScale = 1 + (this.wave - 1) * 0.035;
    this.active = composition(this.wave).map((e) => ({ ...e, acc: 0 }));
    this.state = 'running';
    this.waveTime = 0;
    this.survivorSchedule = SURVIVOR_SCHEDULE.map((at) => ({ at, count: SURVIVORS_PER_GROUP }));
    this.survivorAnnounced = false;
    return true;
  }

  // Gold for calling the next wave early, paid from the build phase you skipped.
  rushBonus() {
    return this.state === 'build' ? Math.round(Math.max(0, this.timer) * RUSH_BONUS_PER_SEC) : 0;
  }

  // Test/debug hook: drop a survivor group right now, bypassing wave timing
  // entirely. tools/*.mjs uses this so a CDP scenario does not have to wait on
  // the natural 6s/18s schedule to get a deterministic read on saved/lost.
  spawnSurvivorsNow(count = SURVIVORS_PER_GROUP) {
    this.#spawnSurvivors(count);
  }

  #spawnSurvivors(count) {
    const cells = edgeCells(this.field);
    if (!cells.length) return;          // degenerate map: nothing to do
    const c = cells[Math.floor(Math.random() * cells.length)];
    this.horde.spawn(count, {
      pos: c, hp: SURVIVOR.hp, type: SURVIVOR_TYPE, speed: SURVIVOR.speed,
      gold: SURVIVOR.gold, scale: SURVIVOR.scale, spread: 1.4,
    });
  }

  update(dt) {
    // Survivor groups tick regardless of build/running state: a group timed
    // for 18s into the wave must still land even if that wave's own zombie
    // drip (composition()'s dur) already finished and flipped state to
    // 'build'.
    if (this.wave > 0) {
      this.waveTime += dt;
      for (let i = this.survivorSchedule.length - 1; i >= 0; i--) {
        const s = this.survivorSchedule[i];
        if (this.waveTime < s.at) continue;
        this.survivorSchedule.splice(i, 1);
        this.#spawnSurvivors(s.count);
        if (!this.survivorAnnounced) {
          this.survivorAnnounced = true;
          this.onSurvivors?.();
        }
      }
    }

    if (this.state === 'build') {
      this.timer -= dt;                 // counts down for the rush bonus only
      return;
    }
    if (this.state !== 'running') return;

    for (const e of this.active) {
      if (e.count <= 0) continue;
      e.acc += (e.count0 ?? (e.count0 = e.count)) / e.dur * dt;
      const n = Math.min(Math.floor(e.acc), Math.ceil(e.count));
      if (n <= 0) continue;
      e.acc -= n;
      e.count -= n;
      const t = ZOMBIE_TYPES[e.type];
      const portal = this.field.spawns[this.portal++ % this.field.spawns.length];
      this.horde.spawn(n, {
        pos: portal,
        hp: t.hp * this.hpScale,
        type: e.type,
        speed: t.speed * this.speedScale,
        gold: t.gold,
        scale: t.scale,
        spread: 1.7,
      });
    }

    if (this.active.every((e) => e.count <= 0)) {
      this.state = 'build';
      this.timer = 20;                  // full rush bonus if called immediately
    }
  }
}
