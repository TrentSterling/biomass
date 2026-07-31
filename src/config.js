// BIOMASS - tuning constants. One grid cell = one world unit.

export const AUTHOR_W = 24;              // authored ASCII map width
export const AUTHOR_H = 14;              // authored ASCII map height
export const CELL_SCALE = 4;             // authored char -> 4x4 sim cells
export const GRID_W = AUTHOR_W * CELL_SCALE;   // 96
export const GRID_H = AUTHOR_H * CELL_SCALE;   // 56

// Finer grid than before: cells about one zombie wide, so it doubles as a spatial
// hash for exact pairwise separation instead of only a density field.
// Cells per world unit for the spatial hash. THIS IS A HARD CONSTRAINT, not a
// tuning knob: the cell must be at least one contact DIAMETER across, or a 3x3
// neighbourhood cannot reach far enough to see every touching body.
//
// At 4 the cell was 0.25 while a zombie diameter is 0.44, so a neighbour 0.44
// away landed two cells out and was invisible to the solver. Sparse crowds never
// noticed; a crowd packed against a beam lost most of its contacts and turned to
// treacle. At 2 the cell is 0.5, comfortably past the 0.44 it has to cover.
//
//   cell size = 1 / DENS_SCALE  >=  2 * ZOMBIE_RADIUS_MAX
//
// Bodies vary in size, so the cell must clear the LARGEST contact diameter or a
// big body cannot see the neighbour it is touching. The radius curve is capped
// precisely so that stays true at a half-unit cell: 0.47 against 0.5.
export const DENS_SCALE = 2;
export const DENS_W = GRID_W * DENS_SCALE;
export const DENS_H = GRID_H * DENS_SCALE;

// ?zombies=250000 raises the buffer capacity for benchmark runs. Guarded so the
// node tests can import this file.
const QUERY = typeof location !== 'undefined' ? new URLSearchParams(location.search) : new URLSearchParams();
export const PARAMS = QUERY;
// The GPU is nowhere near the limit at 100k (compute measured well under a
// millisecond), so the default cap is generous. Past the cap the spawn ring
// wraps and overwrites the oldest slots, so the headcount plateaus instead of
// climbing: the HUD flags that as recycling.
// Capacity comes from the saved setting unless a URL param overrides it. Read
// directly rather than importing save.js: config must stay importable by node.
function savedZombieCap() {
  try {
    if (typeof localStorage === 'undefined') return null;
    return JSON.parse(localStorage.getItem('biomass.save.v1'))?.settings?.zombieCap ?? null;
  } catch { return null; }
}
export const MAX_ZOMBIES = Math.max(2048, Math.min(2000000,
  Number(QUERY.get('zombies')) || savedZombieCap() || 500000));
export const SPAWN_BATCH = 2048;         // hard cap on zombies spawned in one frame
// Each bouncing beam spends one slot per leg, so this is a shape budget rather
// than a turret budget.
export const MAX_TURRETS = 256;
export const MAX_BLASTS = 48;
// Physics charges: acceleration fields abilities push into the crowd (bait
// attract, shockwave repel). A handful active at once is the realistic
// ceiling, so this is generous headroom, not a tuning knob.
export const MAX_CHARGES = 8;

// A round pierces until its life runs out, then detonates. Each hit costs life,
// so the pierce budget and the range are the same number.
export const BULLET_PIERCE_COST = 0.22;
export const BULLET_BLAST = 2.4;         // detonation radius at end of life
export const BULLET_BLAST_MULT = 2.2;    // detonation damage vs a direct hit

// Individual projectiles, on the GPU like everything else. One vec4 per bullet
// (x, y, angle, life) keeps this inside the 8-storage-buffer limit, with speed and
// damage as uniforms since there is one bullet type.
export const MAX_BULLETS = 60000;
export const MAX_MUZZLES = 16;           // guns that can fire in one frame
export const MUZZLE_BURST = 12;          // bullets one gun can emit per frame
export const BULLET_SPEED = 46;
export const BULLET_LIFE = 1.1;
// Corpses ARE the blood system, so they linger. A slot only comes back when the
// spawn ring wraps around to it anyway, and at half a million slots that is a
// very long time.
export const CORPSE_FADE = 80.0;

export const TILE_PX = 16;               // ground texture pixels per cell
export const SPRITE_PX = 16;             // zombie sprite size in atlas
// Contact physics, not steering. Zombies are discs that push each other apart and
// cancel the closing part of their relative velocity, resolved twice a frame
// against the spatial hash. The flow field is the only thing that steers.
// The neighbour loops are unrolled at shader compile time, so this is a direct
// multiplier on shader size: 9 cells x BUCKET_K inlined bodies, twice over.
// Raising it to 20 to cope with a one-unit cell dropped the sim to five frames
// in eight seconds on register pressure alone. Keep the cell small instead.
// A half-unit cell holds 4.8 of the smallest body at hexagonal packing, so 10
// is roughly double headroom. Every extra slot is 18 more inlined bodies of
// shader across the two neighbour loops, so this is not free.
export const BUCKET_K = 10;
// Physics radius is DERIVED from the drawn scale, so a body collides at the size
// it appears. These were divorced before: a bloater drew at 0.80 and collided at
// 0.22 like everything else, so the big ones visibly overlapped each other.
// The size range is COMPRESSED on purpose. Radius is not proportional to the
// drawn scale, it is scale^0.6 against the largest body, which keeps a visible
// half-again difference between a sprinter and a bloater while holding the
// biggest contact diameter under the hash cell.
//
// That ceiling is the whole design: the cell must clear the largest diameter,
// and a larger cell holds more small bodies, and BUCKET_K is a direct
// multiplier on unrolled shader size. Letting a bloater collide at its full
// drawn size would have forced a one-unit cell and a shader that will not run.
export const RADIUS_AT_MAX_SCALE = 0.21;
export const MAX_TYPE_SCALE = 0.80;
export const zombieRadius = (scale) =>
  RADIUS_AT_MAX_SCALE * (scale / MAX_TYPE_SCALE) ** 0.6;

// Per-body jitter, from the body's own seed. Free variety: a crowd of identical
// circles reads as manufactured however good the motion is.
export const SIZE_JITTER = 0.12;            // +/- 12%

// Sprites draw proportional to the physics radius, so what collides is what you
// see, only with the range decompressed again for readability.
export const SPRITE_PER_RADIUS = 3.0;

// The extremes, which together set the hash cell and the bucket depth.
export const ZOMBIE_RADIUS_MAX = zombieRadius(MAX_TYPE_SCALE) * (1 + SIZE_JITTER);
export const ZOMBIE_RADIUS_MIN = zombieRadius(0.40) * (1 - SIZE_JITTER);
export const ZOMBIE_RADIUS = zombieRadius(0.46);
// Ceiling on the single steering force, as a fraction of top speed. The flow
// field always wins; this only decides how much a crowd may spread sideways to
// fill the space it is walking through.
// ---- crowd solver ----------------------------------------------------------
// Ported wholesale from the BALLPIT testbed, where these numbers were measured
// rather than guessed. The governing rule: contacts own position, and velocity
// is DERIVED from position at the end of every substep, never assigned.

// Goal-seeking acceleration, as a multiple of walking speed per second. At 20 a
// free zombie reaches full speed in a twentieth of a second, and one that a
// crowd just crushed to a standstill recovers just as fast.
//
// It has to be a constant acceleration rather than a (want - v) controller:
// contacts zero velocity every substep in a press, and a proportional controller
// would only ever restore its own gain, leaving the whole horde crawling.
//
// Lower means more momentum: at 7 a body takes about a seventh of a second to
// reach walking pace and roughly a third of a second to reverse, so it banks
// through turns instead of snapping to each new field direction. Push it much
// below this and a crowd that contacts keep stalling starts to look sluggish.
export const STEER_ACCEL = 7;

// A body may not travel further than this fraction of its radius in one
// substep, or it steps through the crowd in front of it before the solver ever
// sees the contact. Also a gauge: if the capped counter is large, SUBSTEPS is
// too low for the speed in play (fast-forward is when this bites).
export const TRAVEL_LIMIT = 0.9;

// XSPH velocity smoothing toward the neighbourhood average. The difference
// between a bag of marbles and a liquid. Smoothing, not assignment, so it still
// cannot overrule a contact.
export const VISCOSITY = 0.10;

// Measured on a settled pile in BALLPIT, residual overlap per diameter:
//   4 substeps x 2 iters 48%   8x2 31%   8x4 20%   16x2 6.6%   16x4 1.9%
// Substeps beat iterations every time. The crowd here moves far slower relative
// to its radius than a ball pit under gravity does, so it converges with much
// less; the frame loop scales SUBSTEPS up automatically on fast-forward.
export const SUBSTEPS = 3;
export const ITERATIONS = 2;
// Zombie archetypes. CPU writes these into the GPU buffers at spawn time,
// so adding a type never touches shader code.
export const ZOMBIE_TYPES = [
  { name: 'shambler', hp: 12,  speed: 4.2, gold: 1, scale: 0.46 },
  { name: 'bloater',  hp: 160, speed: 2.6, gold: 8, scale: 0.80 },
  { name: 'sprinter', hp: 7,   speed: 7.4, gold: 2, scale: 0.40 },
];

// Rampart footprint in sim cells: half an authored block, so a 4-cell corridor
// can be narrowed to 2 instead of only being sealed.
export const RAMPART = 2;

// Ramparts are destructible. The reference game has no player walls at all: the
// path is fixed and you defend it. Letting the player reroute the horde is more
// interesting than that, but only if a wall is a delaying action you have to
// defend rather than a permanent solve, so the zombies chew through it.
export const RAMPART_HP = 1100;
export const CHEW_DPS = 1.1;             // damage per zombie pressed against it, per second

// Turret footprint in sim cells, snapped to its own lattice like ramparts.
export const TURRET_SIZE = 2;

// Per-type limits, the way the reference does it (its hotbar reads 2/15, 8/10).
// A flat total was an arbitrary gate; a limit per weapon is a real decision about
// composition, and it is the only thing that can bound total throughput in a
// design where area damage scales with crowd density. Growth inside a run comes
// from upgrades, not from more turrets.
//
// MAX_BUILT is now only the technical ceiling: every weapon shape has to fit the
// uniform array the shader loops over, and a bouncing beam spends a slot per leg.
export const MAX_BUILT = 110;

// Nothing may be built within this radius of a portal. Camping the spawn made
// the rest of the map irrelevant: the horde never got anywhere.
export const NO_BUILD_RADIUS = 9.5;

// A kill pays the full bounty at your doorstep and this fraction at the portal,
// scaled by how far along the path the zombie actually got. Forward defence stops
// funding itself, so the whole route matters.
export const BOUNTY_FLOOR = 0.15;

export const BASE_HP = 90;
export const START_GOLD = 320;

// Turret behaviours (distinct from the two GPU damage shapes):
//   0 blades  spinning disc
//   1 beam    locks onto the thickest crowd and holds there, so it carves
//   2 bounce  zig-zag beam that reflects off rock, one segment per leg
//   3 mortar  lobs blasts at the thickest crowd
export const BUILDS = [
  { key: '1', id: 'wall',   name: 'RAMPART', cost: 8,   kind: 'wall', size: RAMPART, escalate: 1.04 },
// Throughput is dps x hitsPerSec. Keeping those products in the same ballpark is
// what makes the choice about *shape* (a disc, a line, a bouncing line, a shell)
// instead of one weapon quietly doing all the work: the beam used to be worth
// nine blades.
  { key: '2', id: 'blades', name: 'BLADES',  cost: 60,  kind: 'turret', type: 0, range: 5.5,  dps: 95,  hitsPerSec: 300, limit: 10 },
  // type 4: real projectiles. Each round is an entity that flies, can miss, and
  // dies on the first zombie it touches.
  { key: '3', id: 'gun',    name: 'MG NEST', cost: 95,  kind: 'turret', type: 4, range: 17.0, damage: 26, rpm: 660, spread: 0.10, limit: 10 },
  { key: '4', id: 'beam',   name: 'BEAM',    cost: 170, kind: 'turret', type: 1, range: 26.0, dps: 165, width: 1.4, dwell: 1.5, hitsPerSec: 240, limit: 5 },
  { key: '5', id: 'bounce', name: 'BOUNCE',  cost: 210, kind: 'turret', type: 2, range: 40.0, dps: 200, width: 1.0, bounces: 4, sweep: 0.5, hitsPerSec: 230, limit: 5 },
  { key: '6', id: 'mortar', name: 'MORTAR',  cost: 240, kind: 'turret', type: 3, range: 30.0, dps: 900, blast: 4.6, cooldown: 2.4, hitsPerSec: 300, limit: 5 },
];

// Active abilities, the thing the original uses to survive density spikes.
export const ABILITIES = [
  {
    key: 'q', id: 'strike', name: 'AIRSTRIKE', cooldown: 14,
    radius: 4.6, dps: 3200, life: 0.8, count: 9, spacing: 4.6, hitsPerSec: 900, stagger: 0.05,
  },
  {
    key: 'e', id: 'nuke', name: 'NUKE', cooldown: 55,
    radius: 15.0, dps: 9000, life: 1.1, count: 1, spacing: 0, hitsPerSec: 6000,
  },
  // Field-charge abilities: gather-then-throw and pure-throw. These push
  // acceleration into the crowd (see horde.js movePass) instead of firing the
  // strike/nuke blast-line shape above, so they carry their own field names
  // (attract*/repel*/blast*) rather than count/spacing/stagger.
  {
    key: 'b', id: 'bait', name: 'BAIT BOMB', cooldown: 25,
    // Gathers for attractLife seconds, then detonates: damage through the
    // shared blast system plus a hard repel charge that throws whatever it
    // gathered outward.
    // 70 was the initial number and measured out too weak to move the horde at
    // all against its own walking/spawn dynamics (confirmed with an A/B
    // control test: no detectable convergence over the whole attract window).
    // A raw charge test at accel 300 collapsed a cluster to near-zero spread
    // within 1s -- 150 sits well clear of ordinary steering (maxSpeed *
    // STEER_ACCEL tops out around 52 for the fastest type) while still taking
    // a visible couple of seconds to pull a crowd in, not teleporting it.
    attractAccel: 150, attractRadius: 7, attractLife: 2.6,
    blastRadius: 5.5, blastDamage: 240, blastLife: 0.35,
    repelAccel: -520, repelRadius: 8, repelLife: 0.15,
  },
  {
    key: 's', id: 'shock', name: 'SHOCKWAVE', cooldown: 12,
    // Instant repel, no gather phase: a physical blast, not a lure.
    repelAccel: -400, repelRadius: 7, repelLife: 0.18,
    blastRadius: 6, blastDamage: 35, blastLife: 0.25,
  },
];

// Speeds the player can pick. The sim runs N fixed substeps a frame rather than a
// fatter dt, so fast forward is exact rather than sloppy.
export const SPEEDS = [1, 2, 3, 5];
// unlocked by the TIME DILATION node
export const SPEEDS_FAST = [1, 2, 3, 5, 8, 12];

// Every upgrade level changes behaviour, not just a damage number, and the tier
// (levels 1-2, 3-4, 5-6) changes the silhouette and the effect colour.
//   blades  more arms, wider disc
//   mg      faster fire, tighter spread, hotter tracers
//   beam    thicker beam
//   bounce  an extra reflection leg at 3 and 5
//   mortar  an extra shell in the salvo at 3 and 5
export const UPGRADE = {
  dps: 1.55,
  hits: 1.45,
  range: 1.05,
  rpm: 1.22,
  spread: 0.86,
  width: 1.16,
  blast: 1.07,
  legsAt: [3, 5],
  salvoAt: [3, 5],
};

export const tierOf = (level) => (level <= 2 ? 0 : level <= 4 ? 1 : 2);

// Selling refunds this share of everything sunk into a turret.
export const SELL_REFUND = 0.6;

export const BLAST_LIFE = 0.45;          // seconds a mortar blast applies damage


// ---- heading perturbation ---------------------------------------------------
// All of this rotates the flow direction; none of it is ever added to it as a
// force. A rotation clamped to WANDER_CONE can never cancel the field, so the
// crowd is guaranteed to keep arriving no matter how organic it looks.

// Per-zombie sine wobble: the individual lurch of something that walks badly.
export const SWAY_RATE = 2.2;                // radians per second
export const SWAY_MAX = 0.20;                // ~11 degrees

// Smooth noise over position and time. Sampling by POSITION is what makes
// neighbours agree and the crowd break into drifting streams; noise per zombie
// would just be twitch.
export const WANDER_SCALE = 0.22;            // features about 4-5 world units across
export const WANDER_DRIFT = 0.15;            // how fast the streams migrate
export const WANDER_MAX = 0.34;              // ~19 degrees

// Hard ceiling on the total deviation from the way home.
export const WANDER_CONE = 0.45;             // ~26 degrees
