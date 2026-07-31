// Turret sprites, sweeping beams, blast flashes and the build ghost. All plain
// three.js meshes: there are at most a few dozen of them, so the CPU can own
// them without ever touching the horde.

import * as THREE from 'three/webgpu';
import { texture, uv, vec2 } from 'three/tsl';
import { makeTurretAtlas, makeGlow, makeBeam, makeLevelStrip, TURRET_TILES, ACCENT } from './art.js';

const TURRET_SIZE = 2.7;
// turret behaviour -> atlas tile (blades, emitter, emitter, mortar)
// behaviour -> atlas column group; each group holds three tiers
const GROUP_FOR_TYPE = [0, 1, 2, 3, 4];   // blades, beam, bounce, mortar, mg
// tier -> beam/glow colour: the same accent ramp the turret sprites use, so a
// beam and the turret firing it always agree on tier colour.
const TIER_BEAM = ACCENT;

export class Effects {
  constructor(scene) {
    this.scene = scene;
    this.atlas = makeTurretAtlas();
    this.glowTex = makeGlow();
    this.beamTex = makeBeam();

    // One cutout material per atlas tile.
    this.turretMats = Array.from({ length: TURRET_TILES }, (_, tile) => {
      const m = new THREE.MeshBasicNodeMaterial();
      const uvNode = vec2(uv().x.add(tile).div(TURRET_TILES), uv().y);
      m.colorNode = texture(this.atlas, uvNode);
      m.opacityNode = texture(this.atlas, uvNode).a;
      m.alphaTest = 0.5;
      return m;
    });

    // Additive layers stack: with dozens of turrets firing, full-strength quads
    // blow the screen out, so every layer gets an opacity budget.
    // one beam and core material per tier, so an upgraded beam is a new colour
    this.beamMats = TIER_BEAM.map((color) => new THREE.MeshBasicNodeMaterial({
      map: this.beamTex, color, transparent: true, depthWrite: false, opacity: 0.42,
      blending: THREE.AdditiveBlending,
    }));
    this.coreMats = TIER_BEAM.map((color) => new THREE.MeshBasicNodeMaterial({
      map: this.beamTex, color, transparent: true, depthWrite: false, opacity: 0.8,
      blending: THREE.AdditiveBlending,
    }));
    this.glowMat = new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, opacity: 0.5,
      blending: THREE.AdditiveBlending,
    });
    // Node flash: the round bloom drawn at a beam/bounce segment's landing
    // point. Tier-tinted and sized off the beam's own width (see sync()) so a
    // bounce turret's bend reads as one continuous hot joint, not a beam that
    // stops and a differently-coloured glow that starts.
    this.nodeMats = TIER_BEAM.map((color) => new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, color, transparent: true, depthWrite: false, opacity: 0.6,
      blending: THREE.AdditiveBlending,
    }));
    // Muzzle flash: a tiny flick at the barrel on frames a gun turret emits
    // rounds. Reuses the generic glow texture untinted (rounds have no tier
    // colour of their own).
    this.muzzleMat = new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, opacity: 0.85,
      blending: THREE.AdditiveBlending,
    });
    // Bait beacon: a pulsing lure marker, tinted apart from the warm
    // blast/turret palette so "gathering" reads differently from "damage".
    this.beaconMat = new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, color: 0xc9a6ff, transparent: true, depthWrite: false, opacity: 0.6,
      blending: THREE.AdditiveBlending,
    });
    // Dim wash drawn at the true damage diameter, so the blade turret's kill
    // zone is the thing you see rather than a small glow inside a big radius.
    this.zoneMat = new THREE.MeshBasicNodeMaterial({
      map: this.glowTex, transparent: true, depthWrite: false, opacity: 0.13,
      blending: THREE.AdditiveBlending,
    });

    // one cutout material per level, same trick as the turret tiles
    this.levelTex = makeLevelStrip(6);
    this.levelMats = Array.from({ length: 6 }, (_, i) => {
      const m = new THREE.MeshBasicNodeMaterial();
      const uvNode = vec2(uv().x.add(i).div(6), uv().y);
      m.colorNode = texture(this.levelTex, uvNode);
      m.opacityNode = texture(this.levelTex, uvNode).a;
      m.alphaTest = 0.3;
      m.transparent = false;
      return m;
    });
    this.levelPool = [];

    this.quad = new THREE.PlaneGeometry(1, 1);
    this.turretPool = [];
    this.beamPool = [];
    this.glowPool = [];
    this.zonePool = [];
    this.muzzlePool = [];
    this.beaconPool = [];

    // Reusable expanding-ring geometry: bait's detonation and the shockwave
    // both push {x,y,radius,life,life0} through the same pool below, so a
    // repel always reads on screen the same way regardless of which ability
    // threw it.
    this.ringGeo = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 49 }, (_, i) => {
        const a = (i / 48) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      }),
    );
    this.shockRingPool = [];

    // build ghost: a tinted block plus a range ring
    this.ghost = new THREE.Mesh(this.quad, new THREE.MeshBasicNodeMaterial({
      color: 0x8fdc5a, transparent: true, opacity: 0.4, depthWrite: false,
    }));
    this.ghost.position.z = 0.5;
    this.ghost.visible = false;
    scene.add(this.ghost);

    const ring = new THREE.BufferGeometry().setFromPoints(
      Array.from({ length: 65 }, (_, i) => {
        const a = (i / 64) * Math.PI * 2;
        return new THREE.Vector3(Math.cos(a), Math.sin(a), 0);
      }),
    );
    this.ring = new THREE.Line(ring, new THREE.LineBasicMaterial({
      color: 0xffe08a, transparent: true, opacity: 0.55,
    }));
    this.ring.position.z = 0.5;
    this.ring.visible = false;
    scene.add(this.ring);
  }

  // Index-addressed pools: slot i is always the same mesh, so a frame can never
  // hand the same mesh out twice.
  #at(pool, i, mat) {
    let mesh = pool[i];
    if (!mesh) {
      mesh = new THREE.Mesh(this.quad, mat);
      mesh.frustumCulled = false;
      pool[i] = mesh;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  #hideFrom(pool, n) { for (let i = n; i < pool.length; i++) pool[i].visible = false; }

  // A Line, not a Mesh, so it needs its own tiny pool helper: #at() above
  // assumes a shared material per slot, but every ring fades independently.
  #ringAt(i) {
    let mesh = this.shockRingPool[i];
    if (!mesh) {
      mesh = new THREE.Line(this.ringGeo, new THREE.LineBasicMaterial({
        color: 0xbfe6ff, transparent: true, opacity: 0, depthWrite: false,
        blending: THREE.AdditiveBlending,
      }));
      mesh.frustumCulled = false;
      this.shockRingPool[i] = mesh;
      this.scene.add(mesh);
    }
    mesh.visible = true;
    return mesh;
  }

  // `segments` are flat {x0,y0,x1,y1,width,hot,tier} beams: one for a locked
  // beam, one per leg for a bouncing one. The renderer does not care which.
  // `muzzles` is optional: {x,y,angle} for every gun turret that emitted a
  // round this frame. `rings` is optional: {x,y,radius,life,life0} expanding
  // shockwave rings. `beacons` is optional: {x,y,radius,until} pulsing bait
  // markers.
  sync(turrets, segments, blasts, time, muzzles = [], rings = [], beacons = []) {
    let ti = 0, bi = 0, gi = 0, zi = 0, li = 0, mi = 0;

    for (const t of turrets) {
      const tier = Math.min(2, t.tier ?? 0);
      const tile = (GROUP_FOR_TYPE[t.type] ?? 0) * 3 + tier;
      const mesh = this.#at(this.turretPool, ti, this.turretMats[tile]);
      mesh.material = this.turretMats[tile];
      mesh.position.set(t.x, t.y, 0.4);
      // Every turret is the size of its platform; the kill zone is shown by the
      // wash underneath instead of by inflating the sprite. Levels add a little
      // heft on top of that, so upgrades are visible in the silhouette too.
      const lv = t.level ?? 1;
      const grow = TURRET_SIZE * (1 + (lv - 1) * 0.06);
      mesh.scale.set(grow, grow, 1);
      // blades spin, emitters point where they aim, mortars sit still
      mesh.rotation.z = t.type === 0 ? time * 5.5 : (t.type === 3 ? 0 : t.angle);
      ti++;

      // pip strip under the turret
      const pips = this.#at(this.levelPool, li, this.levelMats[Math.min(5, lv - 1)]);
      pips.material = this.levelMats[Math.min(5, lv - 1)];
      pips.position.set(t.x, t.y - TURRET_SIZE * 0.62, 0.45);
      pips.scale.set(TURRET_SIZE * 0.95, TURRET_SIZE * 0.3, 1);
      li++;

      if (t.type === 0) {
        // wash at the real damage diameter
        const zone = this.#at(this.zonePool, zi, this.zoneMat);
        zone.position.set(t.x, t.y, 0.3);
        const zs = t.range * 2;
        zone.scale.set(zs, zs, 1);
        zi++;
        const pulse = 0.55 + 0.45 * Math.abs(Math.sin(time * 22 + t.x));
        const flash = this.#at(this.glowPool, gi, this.glowMat);
        flash.position.set(t.x, t.y, 0.55);
        const s = t.range * 0.55 * pulse;
        flash.scale.set(s, s, 1);
        gi++;
      }
    }

    for (const s of segments) {
      const dx = s.x1 - s.x0, dy = s.y1 - s.y0;
      const len = Math.hypot(dx, dy);
      if (len < 0.02) continue;
      const hot = s.hot ?? 1;
      const ang = Math.atan2(dy, dx);
      // wide soft body plus a thin hot core, so a beam looks like it is cutting
      const st = Math.min(2, s.tier ?? 0);
      const bodyW = Math.max(1.2, s.width * 3.6 * hot);
      const body = this.#at(this.beamPool, bi, this.beamMats[st]);
      body.position.set(s.x0 + dx / 2, s.y0 + dy / 2, 0.6);
      body.material = this.beamMats[st];
      body.scale.set(len, bodyW, 1);
      body.rotation.z = ang;
      bi++;
      const core = this.#at(this.beamPool, bi, this.coreMats[st]);
      core.material = this.coreMats[st];
      core.position.set(s.x0 + dx / 2, s.y0 + dy / 2, 0.62);
      core.scale.set(len, Math.max(0.5, s.width * 1.5) * (0.85 + Math.sin(time * 30 + s.x0) * 0.15), 1);
      core.rotation.z = ang;
      bi++;
      // bloom where the leg lands, sized off the beam's own full body width and
      // tier-tinted to match it, so a bounce turret's bend reads as one
      // continuous hot joint rather than a beam handing off to a generic flash.
      const impact = this.#at(this.glowPool, gi, this.nodeMats[st]);
      impact.material = this.nodeMats[st];
      impact.position.set(s.x1, s.y1, 0.66);
      const ns = bodyW * 1.6 * (0.9 + Math.sin(time * 26 + s.x0) * 0.12) * hot;
      impact.scale.set(ns, ns, 1);
      gi++;
    }

    for (const b of blasts) {
      const g = this.#at(this.glowPool, gi, this.glowMat);
      g.position.set(b.x, b.y, 0.7);
      const s = b.radius * 2.6;
      g.scale.set(s, s, 1);
      gi++;
    }

    // Muzzle flash: a small flick at the barrel, only present on frames a gun
    // actually emitted rounds - the caller already only sends live entries.
    for (const m of muzzles) {
      const flash = this.#at(this.muzzlePool, mi, this.muzzleMat);
      flash.position.set(m.x + Math.cos(m.angle) * 1.7, m.y + Math.sin(m.angle) * 1.7, 0.68);
      flash.scale.set(0.9, 0.9, 1);
      mi++;
    }

    // Bait beacons: a pulsing lure marker for as long as the gather charge is
    // live. Purely cosmetic -- the GPU charge is already running the instant
    // the beacon is pushed.
    let ki = 0;
    for (const b of beacons) {
      const mesh = this.#at(this.beaconPool, ki, this.beaconMat);
      mesh.position.set(b.x, b.y, 0.58);
      const pulse = 0.7 + 0.3 * Math.abs(Math.sin(time * 9 + b.x));
      const s = b.radius * 0.7 * pulse;
      mesh.scale.set(s, s, 1);
      ki++;
    }

    // Expanding shockwave rings: shared by bait's detonation and the instant
    // shockwave. life counts down from life0, so k runs 0 (just fired) -> 1
    // (about to be culled).
    let ri = 0;
    for (const r of rings) {
      const k = 1 - Math.max(0, r.life) / (r.life0 || 0.5);
      const mesh = this.#ringAt(ri);
      mesh.position.set(r.x, r.y, 0.72);
      const s = Math.max(0.05, r.radius * (0.15 + 0.85 * k));
      mesh.scale.set(s, s, 1);
      mesh.material.opacity = 0.7 * (1 - k);
      ri++;
    }

    this.#hideFrom(this.levelPool, li);
    this.#hideFrom(this.turretPool, ti);
    this.#hideFrom(this.beamPool, bi);
    this.#hideFrom(this.glowPool, gi);
    this.#hideFrom(this.zonePool, zi);
    this.#hideFrom(this.muzzlePool, mi);
    this.#hideFrom(this.beaconPool, ki);
    this.#hideFrom(this.shockRingPool, ri);
  }

  setGhost(world, build, valid) {
    if (!world || !build) { this.ghost.visible = false; this.ring.visible = false; return; }
    const size = build.size ?? 3.0;
    this.ghost.visible = true;
    this.ghost.position.set(world.x, world.y, 0.5);
    this.ghost.scale.set(size, size, 1);
    this.ghost.material.color.set(valid ? 0x8fdc5a : 0xdc4a3a);
    if (build.kind === 'turret') {
      this.ring.visible = true;
      this.ring.position.set(world.x, world.y, 0.5);
      this.ring.scale.set(build.range, build.range, 1);
    } else {
      this.ring.visible = false;
    }
  }
}
