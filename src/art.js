// Every texture is generated at boot on a 2D canvas: no asset files, and the
// palette lives in one place. Everything is drawn at pixel scale and sampled
// with NearestFilter for a chunky top-down look.

import * as THREE from 'three/webgpu';
import { SPRITE_PX } from './config.js';

// Reference palette: zombies walk the low ground, survivors build on the concrete
// above. Everything else keys off these, so retheming the whole game is this one
// object. Cold and sick rather than the warm desert of the orc original: mossed
// asphalt below, bleached concrete above, and rust where the blood was gold.
export const PALETTE = {
  trench: '#3f4a3a',            // wet mossed ground the horde walks on
  trenchDark: '#333c30',
  trenchLight: '#4a5743',
  plateau: '#9aa39b',           // poured concrete the survivors hold
  plateauLip: '#c2c9c1',
  plateauEdge: '#232a24',
  scrub: '#55682f',             // weeds coming up through it
  blood: '#4a0f0f',
  gold: '#c8b45a',              // scavenged supplies, not treasure
  steel: '#c9cdd4',
  ui: '#dbe6d8',
};

const canvas = (w, h) => {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
};

// Deterministic noise so a rebuild of the ground never shimmers.
export function rng(seed) {
  let s = seed | 0 || 1;
  return () => {
    s ^= s << 13; s ^= s >>> 17; s ^= s << 5;
    return ((s >>> 0) % 100000) / 100000;
  };
}

const BODY = [
  [3, 6], [4, 10], [5, 12], [6, 12], [7, 12], [8, 12], [9, 10], [10, 8], [11, 6],
];

// At sixteen pixels seen from above there is no face to read, so the whole
// silhouette has to carry it. Two cues do the work: arms held out in front,
// which nothing alive walks like, and an asymmetric wound that breaks the
// left-right symmetry a marching soldier would have.
function drawZombie(ctx, ox, body, dark, light, wound) {
  const cx = SPRITE_PX / 2;
  // outline first, one pixel fatter all round
  ctx.fillStyle = dark;
  for (const [y, w] of BODY) ctx.fillRect(ox + cx - w / 2 - 1, y - 1, w + 2, 3);
  ctx.fillStyle = body;
  for (const [y, w] of BODY) ctx.fillRect(ox + cx - w / 2, y, w, 1);

  // outstretched arms. One reaches further than the other: a shambler does not
  // march in step, and the asymmetry is what sells it in a crowd of thousands.
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 7, 4, 3, 4);
  ctx.fillRect(ox + cx + 4, 5, 3, 3);
  ctx.fillStyle = body;
  ctx.fillRect(ox + cx - 6, 5, 2, 2);
  ctx.fillRect(ox + cx + 5, 6, 2, 1);

  // lit top edge, narrower than the orc's to read as hunched
  ctx.fillStyle = light;
  ctx.fillRect(ox + cx - 3, 4, 6, 1);
  ctx.fillRect(ox + cx - 4, 5, 8, 1);

  // one clouded eye, one dark socket
  ctx.fillStyle = '#0d1108';
  ctx.fillRect(ox + cx - 3, 7, 2, 2);
  ctx.fillRect(ox + cx + 1, 7, 2, 2);
  ctx.fillStyle = '#d8e8c0';
  ctx.fillRect(ox + cx + 1, 7, 1, 1);

  // open wound on the shoulder
  ctx.fillStyle = wound;
  ctx.fillRect(ox + cx + 2, 9, 2, 2);
  ctx.fillRect(ox + cx + 3, 10, 1, 1);

  // dragging feet, one trailing
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 4, 12, 3, 2);
  ctx.fillRect(ox + cx + 1, 12, 2, 3);
}

// Husk: a shambler swollen past the point it can lift its arms far. Wider
// silhouette than any of the three original types, a bright plated band
// across the chest standing in for the lit top edge the others use, and a
// duller grey-green than the shambler so it still reads as one species.
const HUSK_BODY = [
  [2, 8], [3, 12], [4, 14], [5, 14], [6, 14], [7, 14], [8, 14], [9, 12], [10, 10], [11, 7],
];
function drawHusk(ctx, ox, body, dark, light, wound) {
  const cx = SPRITE_PX / 2;
  ctx.fillStyle = dark;
  for (const [y, w] of HUSK_BODY) ctx.fillRect(ox + cx - w / 2 - 1, y - 1, w + 2, 3);
  ctx.fillStyle = body;
  for (const [y, w] of HUSK_BODY) ctx.fillRect(ox + cx - w / 2, y, w, 1);

  // stub arms, thick and close: too swollen to reach far
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 8, 6, 3, 3);
  ctx.fillRect(ox + cx + 5, 6, 3, 3);
  ctx.fillStyle = body;
  ctx.fillRect(ox + cx - 7, 7, 2, 2);
  ctx.fillRect(ox + cx + 6, 7, 2, 2);

  // plated band across the chest, reads as armor plating rather than a lit edge
  ctx.fillStyle = light;
  ctx.fillRect(ox + cx - 6, 6, 12, 2);
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 6, 7, 12, 1);

  // single dark socket, sunken in the swollen face
  ctx.fillStyle = '#0d1108';
  ctx.fillRect(ox + cx - 2, 3, 3, 2);

  // wound low on the gut, where the swelling splits
  ctx.fillStyle = wound;
  ctx.fillRect(ox + cx - 2, 9, 3, 2);
  ctx.fillRect(ox + cx - 1, 11, 2, 1);

  // two heavy dragging feet, both trailing: too bloated to lift either
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 5, 13, 4, 2);
  ctx.fillRect(ox + cx + 1, 13, 4, 2);
}

// Crawler: low, wide and small, hauling itself forward on both arms with no
// feet at all. The silhouette sits in the bottom half of the tile rather than
// standing tall, which is the cue that reads "crawling" at sprite scale.
// Widest at the front (top) and tapering to a narrow trailing tail, the
// opposite of a standing zombie's silhouette: shoulders lead, everything
// else drags behind. The front row spans the full head/shoulder width so
// there is no gap at top-centre for the arm stubs to read as ears.
const CRAWL_BODY = [
  [7, 8], [8, 11], [9, 12], [10, 12], [11, 10], [12, 7], [13, 4],
];
function drawCrawler(ctx, ox, body, dark, light, wound) {
  const cx = SPRITE_PX / 2;
  ctx.fillStyle = dark;
  for (const [y, w] of CRAWL_BODY) ctx.fillRect(ox + cx - w / 2 - 1, y - 1, w + 2, 2);
  ctx.fillStyle = body;
  for (const [y, w] of CRAWL_BODY) ctx.fillRect(ox + cx - w / 2, y, w, 1);

  // short arm stubs flush against the front edge, reaching out and slightly
  // forward rather than standing tall above the body like ears
  ctx.fillStyle = dark;
  ctx.fillRect(ox + cx - 6, 5, 2, 3);
  ctx.fillRect(ox + cx + 4, 5, 2, 3);
  ctx.fillStyle = body;
  ctx.fillRect(ox + cx - 5, 6, 1, 2);
  ctx.fillRect(ox + cx + 5, 6, 1, 2);

  // clouded eyes, close together, set in the wide front of the body
  ctx.fillStyle = '#0d1108';
  ctx.fillRect(ox + cx - 3, 8, 1, 1);
  ctx.fillRect(ox + cx + 2, 8, 1, 1);

  // lit ridge along the spine, low and narrow since it hugs the ground
  ctx.fillStyle = light;
  ctx.fillRect(ox + cx - 2, 10, 4, 1);

  // wound on the tapering tail
  ctx.fillStyle = wound;
  ctx.fillRect(ox + cx - 1, 11, 2, 2);

  // deliberately no feet: it hauls itself by the arms, not the legs
}

// Survivor: the one thing in the atlas that has to read as alive at a glance.
// Upright and narrow, no outstretched arms (the opposite cue from every
// rotting type here), warm tan/olive fatigues, a small backpack block, and a
// clear skin-tone head instead of a clouded socket.
const SURVIVOR_BODY = [
  [4, 6], [5, 7], [6, 7], [7, 7], [8, 7], [9, 7], [10, 6], [11, 5],
];
function drawSurvivor(ctx, ox) {
  const cx = SPRITE_PX / 2;
  const cloth = '#8a7a4a';
  const clothDark = '#332c1a';
  const clothLight = '#b0a06a';
  const skin = '#d9a878';
  const pack = '#4a5230';

  ctx.fillStyle = clothDark;
  for (const [y, w] of SURVIVOR_BODY) ctx.fillRect(ox + cx - w / 2 - 1, y - 1, w + 2, 3);
  ctx.fillStyle = cloth;
  for (const [y, w] of SURVIVOR_BODY) ctx.fillRect(ox + cx - w / 2, y, w, 1);

  // small backpack riding high on the back: the one equipment cue that says
  // "person" rather than "bare zombie" at a glance
  ctx.fillStyle = pack;
  ctx.fillRect(ox + cx - 3, 5, 6, 3);
  ctx.fillStyle = clothDark;
  ctx.fillRect(ox + cx - 3, 5, 6, 1);

  // lit shoulder line, narrow and tidy: no hunch, this one still stands straight
  ctx.fillStyle = clothLight;
  ctx.fillRect(ox + cx - 3, 4, 6, 1);

  // arms tucked at the sides, not reaching: the opposite cue from every
  // rotting thing in this atlas
  ctx.fillStyle = clothDark;
  ctx.fillRect(ox + cx - 4, 6, 1, 4);
  ctx.fillRect(ox + cx + 3, 6, 1, 4);

  // clear skin-tone head, unmistakably alive
  ctx.fillStyle = skin;
  ctx.fillRect(ox + cx - 2, 2, 4, 3);
  ctx.fillStyle = clothDark;
  ctx.fillRect(ox + cx - 2, 2, 4, 1);

  // feet together and even: no drag
  ctx.fillStyle = clothDark;
  ctx.fillRect(ox + cx - 3, 12, 2, 2);
  ctx.fillRect(ox + cx + 1, 12, 2, 2);
}

function drawGore(ctx, ox) {
  const r = rng(7331);
  ctx.fillStyle = PALETTE.blood;
  for (let i = 0; i < 26; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 6.2;
    const s = 1 + Math.floor(r() * 3);
    ctx.fillRect(ox + 8 + Math.cos(a) * d - s / 2, 8 + Math.sin(a) * d - s / 2, s, s);
  }
  ctx.fillStyle = '#7d1c14';
  for (let i = 0; i < 8; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * 3.2;
    ctx.fillRect(ox + 8 + Math.cos(a) * d, 8 + Math.sin(a) * d, 2, 2);
  }
}

// Tiles: 0 shambler, 1 bloater, 2 sprinter, 3 husk, 4 crawler, 5 survivor, 6 gore
//
// The first three read as one species at three stages of rot rather than as
// three unrelated monsters: pallid grey-green, swollen jaundiced, and a
// fresher, bloodier one that still has colour in it. 3-5 extend that same
// read (bulkier rot, low crawling rot, and the one living thing in the atlas)
// without disturbing the original three, which are byte-for-byte unchanged.
// Types 3-5 are not spawned yet; the tiles just need to exist and look right.
export const TILE_COUNT = 7;
export function makeZombieAtlas() {
  const c = canvas(SPRITE_PX * TILE_COUNT, SPRITE_PX);
  const ctx = c.getContext('2d');
  drawZombie(ctx, 0, '#6c7f5a', '#232b1d', '#93a67e', '#7a2018');
  drawZombie(ctx, SPRITE_PX, '#9a9a52', '#33320f', '#c2c179', '#8d3a1c');
  drawZombie(ctx, SPRITE_PX * 2, '#8a6a5c', '#2b1d18', '#b08d7c', '#a52a1e');
  drawHusk(ctx, SPRITE_PX * 3, '#5a6650', '#20261c', '#8a9a78', '#6a2c1c');
  drawCrawler(ctx, SPRITE_PX * 4, '#6e7a5c', '#242c1c', '#9aa87e', '#7a2018');
  drawSurvivor(ctx, SPRITE_PX * 5);
  drawGore(ctx, SPRITE_PX * 6);
  return pixelTexture(c);
}

// Boss: a colossus, drawn at 32px because it renders 4x-6x the size of
// anything else and a 16px blowup reads as static. Same species cues as the
// horde (outstretched reach, asymmetry, one clouded eye) scaled to something
// that shoulders through a crowd: a swollen trunk, plated shoulder line,
// knuckles dragging at the sides, and a split down the gut.
const BOSS_PX = 32;
const BOSS_BODY = [
  [5, 12], [6, 18], [7, 22], [8, 24], [9, 26], [10, 26], [11, 26], [12, 26],
  [13, 26], [14, 26], [15, 24], [16, 24], [17, 22], [18, 22], [19, 20],
  [20, 18], [21, 16], [22, 14], [23, 10],
];
export function makeBossTexture() {
  const c = canvas(BOSS_PX, BOSS_PX);
  const ctx = c.getContext('2d');
  const cx = BOSS_PX / 2;
  const body = '#5c6b4e';
  const dark = '#1c231a';
  const light = '#8fa07a';
  const wound = '#7a2018';

  ctx.fillStyle = dark;
  for (const [y, w] of BOSS_BODY) ctx.fillRect(cx - w / 2 - 1, y - 1, w + 2, 3);
  ctx.fillStyle = body;
  for (const [y, w] of BOSS_BODY) ctx.fillRect(cx - w / 2, y, w, 1);

  // knuckle-dragging arms, wider than any zombie's reach and hanging low
  ctx.fillStyle = dark;
  ctx.fillRect(cx - 15, 9, 5, 9);
  ctx.fillRect(cx + 10, 10, 5, 8);
  ctx.fillStyle = body;
  ctx.fillRect(cx - 14, 10, 3, 7);
  ctx.fillRect(cx + 11, 11, 3, 6);

  // plated shoulder band, the husk cue scaled up
  ctx.fillStyle = light;
  ctx.fillRect(cx - 10, 7, 20, 3);
  ctx.fillStyle = dark;
  ctx.fillRect(cx - 10, 9, 20, 1);

  // skull: one clouded eye, one dark socket, both oversized
  ctx.fillStyle = '#0d1108';
  ctx.fillRect(cx - 6, 12, 4, 3);
  ctx.fillRect(cx + 2, 12, 4, 3);
  ctx.fillStyle = '#d8e8c0';
  ctx.fillRect(cx + 3, 12, 2, 2);

  // the gut split, ragged and off-centre
  ctx.fillStyle = wound;
  ctx.fillRect(cx + 1, 17, 4, 4);
  ctx.fillRect(cx + 3, 20, 3, 3);
  ctx.fillRect(cx - 1, 19, 2, 2);

  // two heavy feet, both dragging
  ctx.fillStyle = dark;
  ctx.fillRect(cx - 8, 26, 6, 3);
  ctx.fillRect(cx + 2, 26, 6, 4);
  return pixelTexture(c);
}

// Turret atlas: five behaviours x three tiers, so a turret's silhouette changes
// as it climbs. Tier is level 1-2, 3-4, 5-6. Everything is drawn barrel-along-+x
// so the sprite can simply be rotated to the aim angle.
//
// Column order: blades, beam, bounce, mortar, machine gun. 15 tiles.
export const TURRET_TIERS = 3;
export const TURRET_TILES = 15;

const CHASSIS = [
  { ring: '#2b2013', body: '#6b4f2e', core: '#3b2b18' },   // tier 0, timber
  { ring: '#232a33', body: '#5e6b78', core: '#2b333d' },   // tier 1, plated
  { ring: '#1d2733', body: '#7d8ea3', core: '#28394d' },   // tier 2, alloy
];

// tier -> accent colour (gold, violet, plasma), shared with beams/node
// flashes in effects.js so an upgraded turret's sprite and its weapon read as
// the same object.
export const ACCENT = ['#e8c33c', '#d770ff', '#7ef0ff'];

export function makeTurretAtlas() {
  const S = 32;
  const c = canvas(S * TURRET_TILES, S);
  const ctx = c.getContext('2d');

  const base = (ox, tier, r = 12) => {
    const k = CHASSIS[tier];
    ctx.fillStyle = k.ring;
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, r, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = k.body;
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, r - 2, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = k.core;
    ctx.beginPath(); ctx.arc(ox + S / 2, S / 2, r - 6, 0, Math.PI * 2); ctx.fill();
    if (tier === 2) {                       // alloy tier gets rivets
      ctx.fillStyle = k.ring;
      for (let i = 0; i < 8; i++) {
        const a = (i / 8) * Math.PI * 2;
        ctx.fillRect(ox + S / 2 + Math.cos(a) * (r - 3) - 1, S / 2 + Math.sin(a) * (r - 3) - 1, 2, 2);
      }
    }
  };

  // ---- blades: 2 -> 3 -> 4 arms, longer and brighter each tier
  for (let t = 0; t < 3; t++) {
    const ox = t * S;
    base(ox, t);
    const arms = 2 + t;
    const len = 13 + t * 1.5;
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    for (let i = 0; i < arms; i++) {
      ctx.save();
      ctx.rotate(0.4 + (i / arms) * Math.PI * 2);
      ctx.fillStyle = PALETTE.steel; ctx.fillRect(-len, -1.5 - t * 0.4, len * 2, 3 + t * 0.8);
      ctx.fillStyle = '#8f959e'; ctx.fillRect(-len, 0.5, len * 2, 1);
      ctx.restore();
    }
    ctx.fillStyle = ACCENT[t];
    ctx.beginPath(); ctx.arc(0, 0, 3 + t, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  // ---- beam: single lens -> shrouded dual -> spinning optic ring
  for (let t = 0; t < 3; t++) {
    const ox = (3 + t) * S;
    base(ox, t);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    const barrels = t === 0 ? [0] : (t === 1 ? [-2.5, 2.5] : [-3.5, 0, 3.5]);
    for (const off of barrels) {
      ctx.fillStyle = '#8e949c'; ctx.fillRect(0, off - 1.6, 15 + t, 3.2);
      ctx.fillStyle = '#d9dee6'; ctx.fillRect(0, off - 1.6, 15 + t, 1);
      ctx.fillStyle = ACCENT[t]; ctx.fillRect(13 + t, off - 1.2, 3, 2.4);
    }
    if (t >= 1) {                            // energy shroud
      ctx.strokeStyle = ACCENT[t]; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(2, 0, 7 + t, -1.1, 1.1); ctx.stroke();
    }
    ctx.restore();
  }

  // ---- bounce: prism emitter, facets multiply with tier
  for (let t = 0; t < 3; t++) {
    const ox = (6 + t) * S;
    base(ox, t);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    ctx.fillStyle = '#8e949c'; ctx.fillRect(0, -2, 12, 4);
    const facets = 3 + t * 2;
    ctx.fillStyle = ACCENT[t];
    for (let i = 0; i < facets; i++) {
      const a = (i / facets) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(Math.cos(a) * 8, Math.sin(a) * 8);
      ctx.lineTo(Math.cos(a + 0.5) * 5, Math.sin(a + 0.5) * 5);
      ctx.lineTo(0, 0);
      ctx.closePath(); ctx.fill();
    }
    ctx.restore();
  }

  // ---- mortar: single tube -> twin battery -> salvo pod
  for (let t = 0; t < 3; t++) {
    const ox = (9 + t) * S;
    base(ox, t, 13);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    const tubes = t === 0 ? [[0, 0]] : (t === 1 ? [[-4, 0], [4, 0]] : [[-4, -4], [4, -4], [-4, 4], [4, 4]]);
    for (const [tx, ty] of tubes) {
      ctx.fillStyle = '#4a4f57';
      ctx.beginPath(); ctx.arc(tx, ty, t === 2 ? 3.6 : 5.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#15181c';
      ctx.beginPath(); ctx.arc(tx, ty, t === 2 ? 2.2 : 3.4, 0, Math.PI * 2); ctx.fill();
    }
    ctx.fillStyle = ACCENT[t];
    ctx.fillRect(-1.5, -13, 3, 3);
    ctx.restore();
  }

  // ---- machine gun: single barrel -> twin rotary -> quad gatling
  for (let t = 0; t < 3; t++) {
    const ox = (12 + t) * S;
    base(ox, t);
    ctx.save();
    ctx.translate(ox + S / 2, S / 2);
    const rows = t === 0 ? [0] : (t === 1 ? [-2.6, 2.6] : [-4, -1.3, 1.3, 4]);
    for (const off of rows) {
      ctx.fillStyle = '#7c838d'; ctx.fillRect(0, off - 1.1, 14 + t * 2, 2.2);
      ctx.fillStyle = '#c9cdd4'; ctx.fillRect(0, off - 1.1, 14 + t * 2, 0.9);
    }
    ctx.fillStyle = CHASSIS[t].ring;         // ammo drum
    ctx.beginPath(); ctx.arc(-4, 0, 5 + t, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = ACCENT[t];
    ctx.beginPath(); ctx.arc(-4, 0, 2, 0, Math.PI * 2); ctx.fill();
    ctx.restore();
  }

  return pixelTexture(c);
}

// Level pips: one tile per turret level, so the exact level is readable at a
// glance even between tier changes.
export function makeLevelStrip(levels = 6) {
  const tw = 16, th = 5;
  const c = canvas(tw * levels, th);
  const ctx = c.getContext('2d');
  for (let lv = 1; lv <= levels; lv++) {
    const ox = (lv - 1) * tw;
    for (let i = 0; i < levels; i++) {
      const x = ox + 2 + i * ((tw - 4) / levels);
      const filled = i < lv;
      ctx.fillStyle = filled ? (lv === levels ? '#ffe98a' : PALETTE.gold) : 'rgba(0,0,0,0.55)';
      ctx.fillRect(x, 1, 1.6, 3);
    }
  }
  return pixelTexture(c);
}

// Soft additive blob for muzzle flashes, blasts and beam glow.
export function makeGlow() {
  const c = canvas(64, 64);
  const ctx = c.getContext('2d');
  const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(0.25, 'rgba(255,236,170,0.85)');
  g.addColorStop(0.6, 'rgba(255,150,60,0.28)');
  g.addColorStop(1, 'rgba(255,110,30,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Beam quad texture: hot core, soft edges, mapped along +x.
export function makeBeam() {
  const c = canvas(64, 16);
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 0, 16);
  g.addColorStop(0, 'rgba(255,170,60,0)');
  g.addColorStop(0.38, 'rgba(255,214,120,0.75)');
  g.addColorStop(0.5, 'rgba(255,255,240,1)');
  g.addColorStop(0.62, 'rgba(255,214,120,0.75)');
  g.addColorStop(1, 'rgba(255,170,60,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 64, 16);
  // No taper: a bounce leg is hot along its whole length, and the impact end
  // gets its own glow sprite instead.
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Top-down twin-prop gunship, nose pointing +x, chunky pixel style to match
// the rest of the art. Nothing consumes this yet; it exists so a future
// air-support ability has a sprite ready to go.
export function makePlaneTexture() {
  const W = 48, H = 24;
  const c = canvas(W, H);
  const ctx = c.getContext('2d');
  const cy = H / 2;
  const gun = '#4a4f57';        // gunmetal fuselage
  const gunDark = '#24272b';    // gunmetal shadow / outline
  const gunLight = '#7a828c';   // lit spine highlight
  const olive = '#5a6b3f';      // olive drab wing/tail panels
  const oliveDark = '#33401f';
  const glass = '#9ec8e8';      // cockpit glazing

  // wings, laid down first so the fuselage draws over them
  ctx.fillStyle = oliveDark;
  ctx.fillRect(16, 1, 14, H - 2);
  ctx.fillStyle = olive;
  ctx.fillRect(17, 2, 12, H - 4);
  ctx.fillStyle = oliveDark;
  ctx.beginPath(); ctx.moveTo(29, 2); ctx.lineTo(34, 5); ctx.lineTo(29, 8); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(29, H - 2); ctx.lineTo(34, H - 5); ctx.lineTo(29, H - 8); ctx.closePath(); ctx.fill();

  // tail stabilizer, narrower than the wing, at the tail end
  ctx.fillStyle = oliveDark;
  ctx.fillRect(2, 6, 8, H - 12);
  ctx.fillStyle = olive;
  ctx.fillRect(3, 7, 6, H - 14);

  // fuselage, nose pointing +x toward the right edge
  ctx.fillStyle = gunDark;
  ctx.fillRect(6, cy - 5, 38, 10);
  ctx.fillStyle = gun;
  ctx.fillRect(6, cy - 4, 37, 8);
  ctx.fillStyle = gunDark;
  ctx.beginPath(); ctx.moveTo(44, cy - 4); ctx.lineTo(W, cy); ctx.lineTo(44, cy + 4); ctx.closePath(); ctx.fill();
  ctx.fillStyle = gun;
  ctx.beginPath(); ctx.moveTo(43, cy - 3); ctx.lineTo(46, cy); ctx.lineTo(43, cy + 3); ctx.closePath(); ctx.fill();

  // lit spine down the centreline
  ctx.fillStyle = gunLight;
  ctx.fillRect(8, cy - 1, 34, 1);

  // cockpit glazing just aft of the nose
  ctx.fillStyle = glass;
  ctx.fillRect(38, cy - 2, 4, 4);

  // twin engine nacelles on the wings, each with a soft spinning-prop disc
  for (const oy of [-8, 8]) {
    ctx.fillStyle = gunDark;
    ctx.fillRect(20, cy + oy - 3, 9, 6);
    ctx.fillStyle = gun;
    ctx.fillRect(21, cy + oy - 2, 7, 4);
    ctx.fillStyle = 'rgba(210,214,220,0.35)';
    ctx.beginPath(); ctx.arc(24, cy + oy, 5, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#15181c';
    ctx.beginPath(); ctx.arc(24, cy + oy, 1.6, 0, Math.PI * 2); ctx.fill();
  }

  return pixelTexture(c);
}

export function pixelTexture(canvasEl) {
  const t = new THREE.CanvasTexture(canvasEl);
  t.magFilter = THREE.NearestFilter;
  t.minFilter = THREE.NearestFilter;
  t.generateMipmaps = false;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
