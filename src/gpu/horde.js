// The horde. Every zombie lives on the GPU for its whole life; the CPU only ever
// sets uniforms and reads back four counters.
//
// Passes, in dispatch order each frame:
//
//   spawn    up to SPAWN_BATCH threads, writes new zombies at a ring cursor
//   scatter  every zombie atomically bumps a coarse density cell
//   sim      steer down the flow field, push out of crowds, take damage, die
//   clear    zero the density grid for next frame
//
// Nothing is read back synchronously. Kills / gold / leaks are monotonic atomic
// counters that the CPU diffs from an async snapshot, and the density grid is
// snapshotted asynchronously so mortars can aim at the thickest part of the
// horde without the CPU ever knowing an individual zombie exists.

import * as THREE from 'three/webgpu';
import {
  Fn, If, Return, Loop, instancedArray, uniform, uniformArray, atomicAdd, atomicLoad,
  atomicStore, texture, textureLoad, instanceIndex, float, int, uint, vec2, vec3,
  vec4, ivec2, length, max, min, abs, floor, mix, step, clamp, dot, sin, cos,
  hash, positionGeometry, uv, mx_noise_float,
} from 'three/tsl';

import { TILE_COUNT } from '../art.js';

import {
  MAX_ZOMBIES, SPAWN_BATCH, MAX_TURRETS, MAX_BLASTS, MAX_CHARGES, GRID_W, GRID_H,
  DENS_W, DENS_H, DENS_SCALE, CORPSE_FADE, BOUNTY_FLOOR,
  BUCKET_K, ZOMBIE_RADIUS, ZOMBIE_RADIUS_MAX, SPRITE_PER_RADIUS, SIZE_JITTER, zombieRadius,
  STEER_ACCEL, TRAVEL_LIMIT,
  SWAY_RATE, SWAY_MAX, WANDER_SCALE, WANDER_DRIFT, WANDER_MAX, WANDER_CONE, VISCOSITY, SUBSTEPS, ITERATIONS,
  ZOMBIE_TYPES,
  BULLET_PIERCE_COST, BULLET_BLAST, BULLET_BLAST_MULT,
  MAX_BULLETS, MAX_MUZZLES, MUZZLE_BURST, BULLET_SPEED, BULLET_LIFE,
} from '../config.js';

// The quickest zombie in the table: what the substep count has to keep up with.
const MAX_SPEED_GUESS = Math.max(...ZOMBIE_TYPES.map((t) => t.speed));

export class Horde {
  constructor(renderer, flowTexture, atlasTexture, basePos) {
    this.renderer = renderer;
    this.capacity = MAX_ZOMBIES;
    this.cursor = 0;

    // Totals the CPU believes in, updated from async readbacks.
    this.stats = { kills: 0, leaks: 0, gold: 0, spawned: 0, alive: 0, recycled: 0 };
    this._lastCounters = [0, 0, 0, 0];
    this._lastStuck = 0;
    this._countersInFlight = false;
    this._generation = 0;
    this._densityInFlight = false;
    this.density = new Uint32Array(DENS_W * DENS_H);
    // density summed per world cell: what the turret AI actually queries
    this.coarse = new Uint32Array(GRID_W * GRID_H);
    this.pendingLeaks = 0;
    this.pendingGold = 0;
    // Runtime tunable so the solver budget can be swept against the jitter gauge
    // without a rebuild. Defaults come from config.
    this.substeps = SUBSTEPS;
    this.iterations = ITERATIONS;

    // ---- buffers -----------------------------------------------------------
    // pos: x, y, vx, vy
    // dat: hp, type, seed, deathTime      (deathTime 0 = still alive)
    // att: maxSpeed, goldValue, lastHitTime, scale
    const pos = instancedArray(MAX_ZOMBIES, 'vec4');
    const dat = instancedArray(MAX_ZOMBIES, 'vec4');
    const att = instancedArray(MAX_ZOMBIES, 'vec4');
    const dens = instancedArray(DENS_W * DENS_H, 'uint').toAtomic();
    // Position at the start of the substep, and the gathered contact correction.
    // Velocity is derived from prev, so this pair is what makes the crowd behave.
    const prev = instancedArray(MAX_ZOMBIES, 'vec2');
    const corr = instancedArray(MAX_ZOMBIES, 'vec2');
    // Spatial hash: up to BUCKET_K zombie indices per cell, written as index+1 so
    // zero means empty. Not atomic, only the counter is.
    const bucket = instancedArray(DENS_W * DENS_H * BUCKET_K, 'uint');
    // One vec4 per bullet: x, y, angle, life. Speed and damage are uniforms, which
    // is what keeps projectiles inside the 8-storage-buffer budget.
    const bullets = instancedArray(MAX_BULLETS, 'vec4');
    // One buffer for every counter: kills, leaks, gold, spare, then a per-weapon
    // hit budget refilled each frame (weapons first, blasts after them). Without
    // that budget, area damage grows with crowd density and a bigger horde just
    // feeds the turrets.
    // 0-3 monotonic, 4 stuck gauge, 5 travel-capped, 6 outside the world,
    // 7 still inside rock after resolution. 6 and 7 are the self-check: both must
    // be zero, and the HUD turns them red the moment they are not.
    const CNT_BUDGET = 9;   // 8 = neighbours the hash had to drop
    const cnt = instancedArray(CNT_BUDGET + MAX_TURRETS + MAX_BLASTS, 'uint').toAtomic();
    const budgetAt = (i) => i.add(int(CNT_BUDGET));
    this._buffers = { pos, dat, att, dens, bucket, bullets, cnt };

    // ---- uniforms ----------------------------------------------------------
    const u = {
      dt: uniform(0),
      h: uniform(1 / 120),            // substep length; movement uses this, damage uses dt
      time: uniform(1),               // starts at 1 so "deathTime 0" means alive
      basePos: uniform(new THREE.Vector2(basePos.x, basePos.y)),
      turretCount: uniform(0, 'int'),
      blastCount: uniform(0, 'int'),
      spawnCount: uniform(0, 'int'),
      spawnCursor: uniform(0, 'int'),
      spawnPos: uniform(new THREE.Vector2()),
      spawnSpread: uniform(1.6),
      spawnHp: uniform(10),
      spawnType: uniform(0),
      spawnSpeed: uniform(4),
      spawnGold: uniform(1),
      spawnScale: uniform(0.6),
      spawnSeed: uniform(0, 'int'),
      bulletCursor: uniform(0, 'int'),
      bulletDamage: uniform(25),
      bulletSpread: uniform(0.1),
      muzzleCount: uniform(0, 'int'),
      chargeCount: uniform(0, 'int'),
    };
    this.u = u;

    this.turretA = uniformArray(Array.from({ length: MAX_TURRETS }, () => new THREE.Vector4()), 'vec4');
    this.turretB = uniformArray(Array.from({ length: MAX_TURRETS }, () => new THREE.Vector4()), 'vec4');
    // x = how many zombies this weapon may damage this frame
    this.turretC = uniformArray(Array.from({ length: MAX_TURRETS }, () => new THREE.Vector4()), 'vec4');
    this.blastArr = uniformArray(Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4()), 'vec4');
    // x = hits this blast may land this frame
    this.blastCaps = uniformArray(Array.from({ length: MAX_BLASTS }, () => new THREE.Vector4()), 'vec4');
    // x, y, angle, rounds to emit this frame
    this.muzzles = uniformArray(Array.from({ length: MAX_MUZZLES }, () => new THREE.Vector4()), 'vec4');
    // x, y, accel, radius. Positive accel attracts (bait), negative repels
    // (shockwave / a bait detonation's throw). Uniforms, like every other
    // per-shape list here, so a handful of active charges cost nothing extra
    // against the 8-storage-buffer budget.
    this.chargeA = uniformArray(Array.from({ length: MAX_CHARGES }, () => new THREE.Vector4()), 'vec4');

    // ---- shared shader helpers --------------------------------------------
    const flowTex = texture(flowTexture);
    const gw = float(GRID_W), gh = float(GRID_H);

    // Compute shaders cannot use filtered sampling, so blend four loads by hand.
    // Rock cells store a direction pointing back out into open ground, which is
    // what keeps anything that clips into geometry from sticking.
    const flowAt = (p) => {
      const fp = p.sub(vec2(0.5)).toVar();
      const b = floor(fp).toVar();
      const fr = fp.sub(b).toVar();
      const at = (ox, oy) => {
        const cx = clamp(b.x.add(float(ox)), float(0), gw.sub(1));
        const cy = clamp(b.y.add(float(oy)), float(0), gh.sub(1));
        return textureLoad(flowTex, ivec2(cx, cy)).xy.mul(2).sub(1);
      };
      const blended = mix(
        mix(at(0, 0), at(1, 0), fr.x),
        mix(at(0, 1), at(1, 1), fr.x),
        fr.y,
      ).toVar();
      // Rock cells carry escape vectors pointing out of the slab, so next to
      // geometry the blend can cancel to nothing and the zombie simply stops. When
      // that happens, fall back to this cell's own unfiltered direction, which is
      // always a real heading.
      const len = length(blended).toVar();
      const raw = textureLoad(flowTex,
        ivec2(clamp(p.x, float(0), gw.sub(1)), clamp(p.y, float(0), gh.sub(1)))).xy.mul(2).sub(1);
      // max() on the divisor is load-bearing: mix evaluates BOTH operands, so a
      // divide by a zero-length blend produces NaN even when step() selects the
      // fallback. NaN then poisons direction, velocity and position, and an zombie
      // with a NaN position never moves again.
      return mix(raw, blended.div(max(len, float(1e-4))), step(float(0.35), len));
    };

    // Normalised distance to base, straight out of the flow texture's alpha.
    // 1 at the portal, 0 at the base.
    const pathDist = (q) => {
      const cx = clamp(q.x, float(0), gw.sub(1));
      const cy = clamp(q.y, float(0), gh.sub(1));
      return textureLoad(flowTex, ivec2(cx, cy)).w;
    };

    // How enclosed a spot is, 0 in open ground to 1 against rock. Bilinear on the
    // rock flag, which is already in the texture.
    // How enclosed a spot is: 0 in open ground, 1 against rock. Bilinear on the
    // rock flag that is already in the texture. Returns a SCALAR: an earlier patch
    // pasted the flow-direction fallback in here because both helpers ended with
    // an identical mix(), which made this return a vec2 and corrupted maxSpeed.
    const wallness = (p) => {
      const fp = p.sub(vec2(0.5)).toVar();
      const b = floor(fp).toVar();
      const fr = fp.sub(b).toVar();
      const at = (ox, oy) => {
        const cx = clamp(b.x.add(float(ox)), float(0), gw.sub(1));
        const cy = clamp(b.y.add(float(oy)), float(0), gh.sub(1));
        return textureLoad(flowTex, ivec2(cx, cy)).z;
      };
      return mix(
        mix(at(0, 0), at(1, 0), fr.x),
        mix(at(0, 1), at(1, 1), fr.x),
        fr.y,
      );
    };

    // Exact per-cell rock test, no interpolation.
    const isRock = (q) => {
      const cx = clamp(q.x, float(0), gw.sub(1));
      const cy = clamp(q.y, float(0), gh.sub(1));
      return textureLoad(flowTex, ivec2(cx, cy)).z.greaterThan(0.5);
    };

    // A body's physics radius comes straight from the scale it draws at, so the
    // circle that collides is the circle you can see. att.w carries the scale,
    // jittered per body at spawn, which means variety costs no storage at all.
    const radiusOf = (A) => A.w;

    // Nearest open cell centre within R cells. Returns the point unchanged when
    // the whole neighbourhood is solid, so callers must tolerate that.
    const nearestOpen = (q, R) => {
      const best = float(1e9).toVar();
      const ox = q.x.toVar();
      const oy = q.y.toVar();
      const bx = floor(q.x).toVar();
      const by = floor(q.y).toVar();
      for (let dy = -R; dy <= R; dy++) {
        for (let dx = -R; dx <= R; dx++) {
          const ccx = bx.add(float(dx)).add(0.5).toVar();
          const ccy = by.add(float(dy)).add(0.5).toVar();
          If(isRock(vec2(ccx, ccy)).not(), () => {
            const dd = length(vec2(ccx.sub(q.x), ccy.sub(q.y))).toVar();
            If(dd.lessThan(best), () => { best.assign(dd); ox.assign(ccx); oy.assign(ccy); });
          });
        }
      }
      return vec2(ox, oy);
    };

    // Project a body out of every rock cell its CIRCLE overlaps, rather than
    // asking whether its centre point happens to sit in one.
    //
    // A centre test ignores the body's radius entirely, so a zombie centred a
    // hair outside a wall had its whole 0.22 body buried in it: that is the neat
    // one-cell band of bodies lining the inside of every platform. It also lets
    // a body cut corners, because a per-axis test can pass on x and pass on y
    // while the diagonal destination it actually moves to is solid.
    //
    // Cells are unit squares on integer boundaries, so the closest point on a
    // cell is just a clamp, and circle-vs-box is exact.
    const pushOutOfRock = (p, r) => {
      const out = p.toVar();

      If(isRock(out), () => {
        // CENTRE INSIDE GEOMETRY. Resolve by ejection only, never by overlap.
        //
        // Running the overlap pushes in this case was actively harmful: the
        // solid cells all around shoved the body from several sides at once,
        // the pushes cancelled, and it sat pinned in place while the escape
        // field was trying to walk it out. Two systems fighting, and the body
        // never moved further than a twentieth of a unit a second.
        //
        // The search is wide because platforms are wide: a body at the middle
        // of the central slab on TWIN GATES is fifteen cells from daylight, and
        // a short search finds nothing but more rock and gives up.
        out.assign(nearestOpen(out, 8));
      }).Else(() => {
        // Centre is in the open, so every solid cell nearby is a genuine
        // circle-vs-box contact with a well defined normal. Cells are unit
        // squares on integer boundaries, so the closest point is a clamp.
        const bx = floor(out.x).toVar();
        const by = floor(out.y).toVar();
        for (let oy = -1; oy <= 1; oy++) {
          for (let ox = -1; ox <= 1; ox++) {
            const cx = bx.add(float(ox)).toVar();
            const cy = by.add(float(oy)).toVar();
            If(isRock(vec2(cx.add(0.5), cy.add(0.5))), () => {
              const qx = clamp(out.x, cx, cx.add(1)).toVar();
              const qy = clamp(out.y, cy, cy.add(1)).toVar();
              const d = vec2(out.x.sub(qx), out.y.sub(qy)).toVar();
              const dist = length(d).toVar();
              If(dist.greaterThan(float(1e-5)).and(dist.lessThan(r)), () => {
                out.addAssign(d.mul(r.sub(dist).div(dist)));
              });
            });
          }
        }
      });
      return out;
    };

    // Crowd separation from the coarse density grid: push down the gradient of
    // "how many neighbours are over there". Cheap stand-in for pair collisions
    // and it produces the nose-to-tail river look.
    // Fluid step from the density grid: a pressure gradient plus the local mean
    // velocity. Pressure only builds past a resting density, so the crowd packs
    // shoulder to shoulder and only spreads where it is actually squeezed, and
    // the velocity term makes neighbours agree, which is what reads as flow.
    // ---- pass: init --------------------------------------------------------
    // deathTime far in the past means "empty slot", so nothing renders at boot.
    this.bulletClearPass = Fn(() => {
      bullets.element(instanceIndex).assign(vec4(0, 0, 0, 0));
    })().compute(MAX_BULLETS);

    this.initPass = Fn(() => {
      pos.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      dat.element(instanceIndex).assign(vec4(0, 0, 0, -1000));
      att.element(instanceIndex).assign(vec4(1, 0, -1000, 0.5));
    })().compute(MAX_ZOMBIES);

    // Zeroes the monotonic counters, so a restart starts from a clean score
    // without the CPU having to track an offset.
    this.counterResetPass = Fn(() => {
      atomicStore(cnt.element(instanceIndex), uint(0));
    })().compute(4);

    // ---- pass: spawn -------------------------------------------------------
    this.spawnPass = Fn(() => {
      If(int(instanceIndex).lessThan(u.spawnCount), () => {
        const slot = u.spawnCursor.add(int(instanceIndex)).mod(int(MAX_ZOMBIES)).toVar();
        const s1 = hash(instanceIndex.add(uint(u.spawnSeed))).toVar();
        const s2 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(9871))).toVar();
        const s3 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(31337))).toVar();
        const off = vec2(s1.sub(0.5), s2.sub(0.5)).mul(u.spawnSpread.mul(2));

        // NEVER hatch a body inside rock.
        //
        // Bodies born inside a slab have no open face for the wall solver to
        // push them through, so they stay there for the entire run: they never
        // walked in, they were placed there and could not leave.
        //
        // Move to the nearest open cell, NOT back toward the spawn centre. The
        // centre is not guaranteed to be open: the flood tool spawns everything
        // at the middle of the map, and on a map with a central platform that
        // point is solid rock, so shrinking toward it stacked every rejected
        // body onto one buried spot. That is a tighter, more permanent clump
        // than the scatter it replaced.
        const at = vec2(
          clamp(u.spawnPos.x.add(off.x), float(ZOMBIE_RADIUS_MAX), float(GRID_W).sub(ZOMBIE_RADIUS_MAX)),
          clamp(u.spawnPos.y.add(off.y), float(ZOMBIE_RADIUS_MAX), float(GRID_H).sub(ZOMBIE_RADIUS_MAX)),
        ).toVar();
        If(isRock(at), () => { at.assign(nearestOpen(at, 6)); });

        pos.element(slot).assign(vec4(at, 0, 0));
        dat.element(slot).assign(vec4(u.spawnHp, u.spawnType, s3, 0));
        // Size jitter lives in the drawn scale, which the physics radius is
        // derived from, so one number varies both and they can never disagree.
        const s4 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(5501))).toVar();
        const jitter = float(1).add(s4.sub(0.5).mul(float(2 * SIZE_JITTER))).toVar();
        att.element(slot).assign(vec4(u.spawnSpeed, u.spawnGold, -1000, u.spawnScale.mul(jitter)));
      });
    })().compute(SPAWN_BATCH);

    // ---- pass: init --------------------------------------------------------
    // deathTime far in the past means "empty slot", so nothing renders at boot.
    this.bulletClearPass = Fn(() => {
      bullets.element(instanceIndex).assign(vec4(0, 0, 0, 0));
    })().compute(MAX_BULLETS);

    this.initPass = Fn(() => {
      pos.element(instanceIndex).assign(vec4(0, 0, 0, 0));
      dat.element(instanceIndex).assign(vec4(0, 0, 0, -1000));
      att.element(instanceIndex).assign(vec4(1, 0, -1000, 0.5));
    })().compute(MAX_ZOMBIES);

    // Zeroes the monotonic counters, so a restart starts from a clean score
    // without the CPU having to track an offset.
    this.counterResetPass = Fn(() => {
      atomicStore(cnt.element(instanceIndex), uint(0));
    })().compute(4);

    // ---- pass: spawn -------------------------------------------------------
    this.spawnPass = Fn(() => {
      If(int(instanceIndex).lessThan(u.spawnCount), () => {
        const slot = u.spawnCursor.add(int(instanceIndex)).mod(int(MAX_ZOMBIES)).toVar();
        const s1 = hash(instanceIndex.add(uint(u.spawnSeed))).toVar();
        const s2 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(9871))).toVar();
        const s3 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(31337))).toVar();
        const off = vec2(s1.sub(0.5), s2.sub(0.5)).mul(u.spawnSpread.mul(2));

        // NEVER hatch a body inside rock.
        //
        // Bodies born inside a slab have no open face for the wall solver to
        // push them through, so they stay there for the entire run: they never
        // walked in, they were placed there and could not leave.
        //
        // Move to the nearest open cell, NOT back toward the spawn centre. The
        // centre is not guaranteed to be open: the flood tool spawns everything
        // at the middle of the map, and on a map with a central platform that
        // point is solid rock, so shrinking toward it stacked every rejected
        // body onto one buried spot. That is a tighter, more permanent clump
        // than the scatter it replaced.
        const at = vec2(
          clamp(u.spawnPos.x.add(off.x), float(ZOMBIE_RADIUS_MAX), float(GRID_W).sub(ZOMBIE_RADIUS_MAX)),
          clamp(u.spawnPos.y.add(off.y), float(ZOMBIE_RADIUS_MAX), float(GRID_H).sub(ZOMBIE_RADIUS_MAX)),
        ).toVar();
        If(isRock(at), () => { at.assign(nearestOpen(at, 6)); });

        pos.element(slot).assign(vec4(at, 0, 0));
        dat.element(slot).assign(vec4(u.spawnHp, u.spawnType, s3, 0));
        // Size jitter lives in the drawn scale, which the physics radius is
        // derived from, so one number varies both and they can never disagree.
        const s4 = hash(instanceIndex.add(uint(u.spawnSeed)).add(uint(5501))).toVar();
        const jitter = float(1).add(s4.sub(0.5).mul(float(2 * SIZE_JITTER))).toVar();
        att.element(slot).assign(vec4(u.spawnSpeed, u.spawnGold, -1000, u.spawnScale.mul(jitter)));
      });
    })().compute(SPAWN_BATCH);

    // ---- pass: scatter -----------------------------------------------------
    this.scatterPass = Fn(() => {
      If(dat.element(instanceIndex).x.greaterThan(0), () => {
        const P = pos.element(instanceIndex).toVar();
        const p = P.xy.toVar();
        const cx = int(clamp(p.x.mul(DENS_SCALE), float(0), float(DENS_W - 1)));
        const cy = int(clamp(p.y.mul(DENS_SCALE), float(0), float(DENS_H - 1)));
        const cell = cy.mul(int(DENS_W)).add(cx).toVar();
        const slot = atomicAdd(dens.element(cell), uint(1)).toVar();
        // first few zombies in a cell get a bucket slot for the pairwise pass
        If(slot.lessThan(uint(BUCKET_K)), () => {
          bucket.element(cell.mul(int(BUCKET_K)).add(int(slot))).assign(instanceIndex.add(uint(1)));
        }).Else(() => {
          // Past BUCKET_K a body is invisible to every neighbour this substep.
          // Mixed sizes made this reachable: the cell had to grow to fit the
          // biggest body, and a cell that size holds about a dozen of the
          // smallest. Silent until the crowd interpenetrates, so it is counted.
          atomicAdd(cnt.element(8), uint(1));
        });
      });
    })().compute(MAX_ZOMBIES);

    // ---- contact solve, ported from BALLPIT --------------------------------
    // Two dispatches, never one. Reading neighbour positions out of the same
    // buffer you are writing is a data race: every zombie would see a different
    // mix of old and new neighbours depending on scheduling. relax only gathers,
    // apply only writes.
    this.relaxPass = Fn(() => {
      const i = instanceIndex;
      If(dat.element(i).x.lessThanEqual(0), () => {
        corr.element(i).assign(vec2(0));
        Return();
      });
      const p = pos.element(i).xy.toVar();
      const ri = radiusOf(att.element(i)).toVar();
      const push = vec2(0).toVar();
      const hits = float(0).toVar();
      const cx = int(clamp(p.x.mul(DENS_SCALE), float(1), float(DENS_W - 2))).toVar();
      const cy = int(clamp(p.y.mul(DENS_SCALE), float(1), float(DENS_H - 2))).toVar();

      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cell = cy.add(int(oy)).mul(int(DENS_W)).add(cx.add(int(ox))).toVar();
          for (let k = 0; k < BUCKET_K; k++) {
            const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
            If(raw.greaterThan(uint(0)), () => {
              const other = raw.sub(uint(1)).toVar();
              // Alive check on the NEIGHBOUR, not just on self. Without it the
              // living collide with the dead: a corpse keeps its slot in the
              // hash, never moves again, and becomes a permanent invisible
              // bollard exactly where it fell. A beam that kills a rank was
              // therefore building a wall out of the bodies, and the horde
              // behind it genuinely could not push through.
              If(other.notEqual(i).and(dat.element(other).x.greaterThan(0)), () => {
                const q = pos.element(other).xy.toVar();
                const delta = p.sub(q).toVar();
                const dist = length(delta).toVar();
                // Reject on the widest possible contact FIRST, using a constant,
                // so the neighbour's attributes are only fetched for candidates
                // that might actually touch. Reading them for every slot in the
                // bucket cost a random access per candidate per iteration and
                // took the ceiling from 964k bodies to 270k.
                If(dist.lessThan(ri.add(float(ZOMBIE_RADIUS_MAX))), () => {
                const rj = radiusOf(att.element(other)).toVar();
                const minDist = ri.add(rj).toVar();
                If(dist.lessThan(minDist), () => {
                  // Coincident pairs give a garbage normal. A stable per-pair
                  // direction separates them; noise just jitters them in place.
                  const degenerate = step(dist, float(1e-5));
                  const ang = hash(i.add(other).add(uint(7331))).mul(6.2831853).toVar();
                  const n = mix(delta.div(max(dist, float(1e-5))),
                    vec2(cos(ang), sin(ang)), degenerate).toVar();
                  // Split the overlap by inverse mass, and take mass from AREA:
                  // a body twice the radius is four times the mass and yields a
                  // quarter as much. Physically right, and it costs nothing to
                  // store because it falls out of the radius.
                  //
                  //   share_i = (1/ri^2) / (1/ri^2 + 1/rj^2) = rj^2 / (ri^2 + rj^2)
                  //
                  // Equal sizes give half each, exactly as before.
                  const ri2 = ri.mul(ri).toVar();
                  const rj2 = rj.mul(rj).toVar();
                  const share = rj2.div(max(ri2.add(rj2), float(1e-6))).toVar();
                  push.addAssign(n.mul(minDist.sub(dist).mul(share)));
                  hits.addAssign(1);
                });
                });
              });
            });
          }
        }
      }
      // Averaged, not summed. A body with eight neighbours pushing on it must
      // move once, not eight times.
      corr.element(i).assign(push.div(max(hits, float(1))));
    })().compute(MAX_ZOMBIES);

    this.applyPass = Fn(() => {
      const i = instanceIndex;
      If(dat.element(i).x.lessThanEqual(0), () => { Return(); });
      const P = pos.element(i).toVar();
      const to = P.xy.add(corr.element(i)).toVar();
      // Contacts first, then geometry: a body squeezed by the crowd ends the
      // step outside the wall rather than inside it.
      const rSelf = radiusOf(att.element(i)).toVar();
      const fixed = pushOutOfRock(to, rSelf).toVar();

      // HARD WORLD BOUNDS. Nothing may exist off the board.
      //
      // isRock and flowAt both CLAMP their texture lookups, so a body outside
      // the map reads the edge cell's data for ever: it is outside physics and
      // outside pathing at once, and nothing can tell it to come back. The flood
      // tool was scattering bodies to y = -17 on a board that starts at 0, and
      // they simply stayed there for the rest of the run.
      const lim = rSelf.toVar();
      const bounded = vec2(
        clamp(fixed.x, lim, float(GRID_W).sub(lim)),
        clamp(fixed.y, lim, float(GRID_H).sub(lim)),
      ).toVar();

      // Self-check. These are the two states the sim claims are impossible, so
      // they get counted rather than assumed.
      If(length(bounded.sub(fixed)).greaterThan(float(1e-4)), () => {
        atomicAdd(cnt.element(6), uint(1));
      });
      If(isRock(bounded), () => { atomicAdd(cnt.element(7), uint(1)); });

      pos.element(i).assign(vec4(bounded, P.z, P.w));
    })().compute(MAX_ZOMBIES);

    // ---- pass: finish ------------------------------------------------------
    // THE LINE THIS WHOLE PORT EXISTS FOR.
    //
    // Velocity is read off the displacement the body actually achieved, never
    // assigned from the flow field. A zombie crushed at the back of a press has
    // moved nowhere, so it HAS no velocity, with no damping term and no special
    // case for "stuck".
    //
    // The old code did the opposite: it drove velocity to maxSpeed toward the
    // goal every frame, contacts shoved the position back, and the motor drove
    // it forward again next frame. That oscillation was the jitter, and no
    // amount of contact tuning could ever have removed it.
    this.finishPass = Fn(() => {
      const i = instanceIndex;
      If(dat.element(i).x.lessThanEqual(0), () => { Return(); });
      const p = pos.element(i).xy.toVar();
      const v = p.sub(prev.element(i)).div(u.h).toVar();

      // XSPH viscosity: drift toward the neighbourhood average. This is the
      // difference between marbles and water. It smooths velocity rather than
      // assigning it, so it still cannot overrule a contact.
      const sum = vec2(0).toVar();
      const n = float(0).toVar();
      const ri = radiusOf(att.element(i)).toVar();
      const cx = int(clamp(p.x.mul(DENS_SCALE), float(1), float(DENS_W - 2))).toVar();
      const cy = int(clamp(p.y.mul(DENS_SCALE), float(1), float(DENS_H - 2))).toVar();
      for (let oy = -1; oy <= 1; oy++) {
        for (let ox = -1; ox <= 1; ox++) {
          const cell = cy.add(int(oy)).mul(int(DENS_W)).add(cx.add(int(ox))).toVar();
          for (let k = 0; k < BUCKET_K; k++) {
            const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
            If(raw.greaterThan(uint(0)), () => {
              const other = raw.sub(uint(1)).toVar();
              // Dead neighbours are excluded here too: a corpse has zero
              // velocity forever, and averaging toward it drags the living to a
              // standstill.
              If(other.notEqual(i).and(dat.element(other).x.greaterThan(0)), () => {
                const Q = pos.element(other).toVar();
                const d2 = length(p.sub(Q.xy)).toVar();
                If(d2.lessThan(ri.add(float(ZOMBIE_RADIUS_MAX)).mul(1.2)), () => {
                const rad = ri.add(radiusOf(att.element(other))).mul(1.2).toVar();
                If(d2.lessThan(rad), () => {
                  sum.addAssign(Q.zw);
                  n.addAssign(1);
                });
                });
              });
            });
          }
        }
      }
      If(n.greaterThan(float(0)), () => {
        v.addAssign(sum.div(n).sub(v).mul(float(VISCOSITY)));
      });

      pos.element(i).assign(vec4(p, v));
    })().compute(MAX_ZOMBIES);

    // ---- pass: move --------------------------------------------------------
    // Steering gets to PROPOSE a motion and nothing more. It runs once per
    // substep, writes prev, and then the contact solver is free to overrule it
    // completely.
    this.movePass = Fn(() => {
      const i = instanceIndex;
      const d = dat.element(i).toVar();
      If(d.x.lessThanEqual(0), () => { Return(); });

      const P = pos.element(i).toVar();
      const A = att.element(i).toVar();
      const p = P.xy.toVar();
      const v = P.zw.toVar();
      const maxSpeed = A.x.toVar();

      // The flow field is the ONLY thing that steers a zombie. There used to be
      // six steering terms here (cohesion, alignment, a pressure gradient, curl
      // noise, jam slowdown, wall drag) and they spent their time fighting each
      // other and the field, which is what made the crowd twitch.
      const f = flowAt(p).toVar();

      // Heading perturbation, applied as a bounded ROTATION of the field
      // direction rather than as a force added to it. This is the whole trick:
      // an added force competes with the field and can cancel it, so a crowd
      // stops arriving; a rotation clamped to WANDER_MAX cannot. A zombie always
      // walks within that cone of the way home, so no amount of wander can stop
      // it getting there, and pathing stays provably intact.
      //
      //   sway    per-zombie sine, phase from its seed. The individual wobble of
      //           something that does not walk well.
      //   wander  smooth noise over position AND time, so neighbours agree and
      //           the crowd forms drifting streams rather than each body
      //           twitching independently. Spatial coherence is what separates
      //           this from just adding noise per zombie.
      const phase = d.z.mul(6.2831853).toVar();
      const sway = sin(u.time.mul(float(SWAY_RATE)).add(phase)).mul(float(SWAY_MAX)).toVar();
      const wander = mx_noise_float(
        vec3(p.mul(float(WANDER_SCALE)), u.time.mul(float(WANDER_DRIFT))),
      ).mul(float(WANDER_MAX)).toVar();
      const ang = clamp(sway.add(wander), float(-WANDER_CONE), float(WANDER_CONE)).toVar();

      const cs = cos(ang).toVar(), sn = sin(ang).toVar();
      const dir = vec2(
        f.x.mul(cs).sub(f.y.mul(sn)),
        f.x.mul(sn).add(f.y.mul(cs)),
      ).toVar();

      // A CONSTANT-MAGNITUDE acceleration toward the goal, exactly like gravity
      // in the testbed. Deliberately not a velocity-matching controller.
      //
      // Velocity is derived from displacement, so in a dense crowd contacts zero
      // a body's velocity every single substep. A controller proportional to
      // (want - v) then only ever hands back its gain -- a few percent of
      // walking speed -- and the entire horde crawls at a fraction of its speed
      // while looking like it is refusing to push. A constant acceleration does
      // not care that it was zeroed: the instant a body is free, it accelerates
      // at full strength again.
      //
      // Contacts still win, because they own position and this only ever
      // proposes. The speed clamp below is what keeps it walking rather than
      // launching.
      v.addAssign(dir.mul(maxSpeed.mul(float(STEER_ACCEL))).mul(u.h));

      const sp = length(v).add(1e-5).toVar();
      If(sp.greaterThan(maxSpeed), () => { v.mulAssign(maxSpeed.div(sp)); });

      // ---- field charges: bait / shockwave ---------------------------------
      // Deliberate exception to "the flow field always wins" above: a charge is
      // a player VERB whose entire job is to out-shout the field for a moment,
      // bounded in both radius and time so it can never become a second,
      // permanent router. Landing here -- after the walk-speed clamp but
      // before the travel-limit cap below -- is the whole trick: a detonation
      // can throw a body faster than it could ever walk on its own, while the
      // travel cap still stops that throw from tunnelling it through the crowd
      // or a wall in one substep.
      Loop(u.chargeCount, ({ i: ci }) => {
        const C = this.chargeA.element(ci).toVar();     // x, y, accel, radius
        const delta = C.xy.sub(p).toVar();
        const dist = length(delta).toVar();
        If(dist.lessThan(C.w), () => {
          // Repel (accel < 0) is a physical blast: it throws everyone. Attract
          // (accel > 0) is a lure, and bait does not fool a human -- gate it to
          // types below 4.5 so the survivors arriving in a later stage walk
          // past a beacon untouched.
          const allowed = C.z.lessThanEqual(0).or(d.y.lessThan(4.5));
          If(allowed, () => {
            const falloff = float(1).sub(dist.div(max(C.w, float(0.001))));
            const cdir = delta.div(max(dist, float(0.3)));
            v.addAssign(cdir.mul(C.z).mul(falloff).mul(u.h));
          });
        });
      });

      // Discretisation speed limit: never travel more than a fraction of a body
      // radius in one substep, or a body steps through the crowd in front of it
      // before the solver ever sees the contact.
      const vmax = radiusOf(A).mul(float(TRAVEL_LIMIT)).div(u.h).toVar();
      const sp2 = length(v).add(1e-5).toVar();
      If(sp2.greaterThan(vmax), () => {
        v.mulAssign(vmax.div(sp2));
        atomicAdd(cnt.element(5), uint(1));
      });

      prev.element(i).assign(p);

      // Integrate, rejecting each axis separately so zombies slide along rock
      // instead of stopping dead against it. A zombie already buried (a rampart
      // landed on it) skips the check, otherwise it could never walk back out
      // along the escape field.
      //
      // No bounce term on rejection any more: velocity is derived downstream
      // from how far the body actually got, so a blocked axis produces zero
      // speed on its own.
      // Prevention as well as resolution. applyPass can now dig a body out of a
      // wall it ended up inside, but not letting it in is cheaper and steadier,
      // and the margin is thin: travel is capped near 0.9 of a radius while the
      // wall standoff is one radius, so a single crowd shove on top of a normal
      // step is enough to put a centre through a face.
      //
      // The DIAGONAL destination is tested, not just each axis on its own. Two
      // per-axis tests can both pass while the corner they move through is
      // solid, which is how bodies used to appear inside platforms with no path
      // in.
      const nx = p.x.add(v.x.mul(u.h)).toVar();
      const ny = p.y.add(v.y.mul(u.h)).toVar();
      If(isRock(p), () => {
        // already buried: follow the escape field out, unimpeded
      }).Else(() => {
        If(isRock(vec2(nx, ny)), () => {
          // slide along whichever axis stays in open ground
          If(isRock(vec2(nx, p.y)), () => { nx.assign(p.x); });
          If(isRock(vec2(p.x, ny)), () => { ny.assign(p.y); });
          // both blocked: the corner itself. Stay put and let contacts sort it.
          If(isRock(vec2(nx, ny)), () => { nx.assign(p.x); ny.assign(p.y); });
        });
      });
      pos.element(i).assign(vec4(nx, ny, v));
    })().compute(MAX_ZOMBIES);

    // ---- pass: combat ------------------------------------------------------
    // Damage, death, bounty and leaks. Runs ONCE per frame, not per substep, so
    // raising the substep count never changes how much damage a turret does.
    this.simPass = Fn(() => {
      const d = dat.element(instanceIndex).toVar();

      If(d.x.greaterThan(0), () => {
        const P = pos.element(instanceIndex).toVar();
        const A = att.element(instanceIndex).toVar();
        const p = P.xy.toVar();
        const v = P.zw.toVar();
        const hp = d.x.toVar();

        // ---- weapons. Two shapes only, both area based, which is what lets
        // damage be evaluated zombie-side with no target-selection pass:
        //   kind 0  disc   centre A.xy, radius B.w
        //   kind 1  segment A.xy -> B.xy, half-width B.z
        // A bouncing beam is just several segments in a row, so the shader
        // needs no idea that reflection exists.
        const dmg = float(0).toVar();
        const touched = float(0).toVar();
        Loop(u.turretCount, ({ i }) => {
          const A = this.turretA.element(i).toVar();   // x0, y0, kind, dps
          const B = this.turretB.element(i).toVar();   // x1, y1, halfWidth, radius
          const inside = float(0).toVar();
          If(A.z.lessThan(0.5), () => {
            If(length(p.sub(A.xy)).lessThan(B.w), () => { inside.assign(1); });
          }).Else(() => {
            const ab = B.xy.sub(A.xy).toVar();
            const t = clamp(dot(p.sub(A.xy), ab).div(dot(ab, ab).add(1e-4)), 0, 1).toVar();
            const close = A.xy.add(ab.mul(t)).toVar();
            If(length(p.sub(close)).lessThan(B.z), () => { inside.assign(1); });
          });
          // Everything the shape touches flashes; only what fits the budget takes
          // damage. Tying the flash to the damage meant a beam over a thousand zombies
          // lit up the four it happened to hit that frame, which read as the beam
          // doing nothing at all.
          If(inside.greaterThan(0.5), () => {
            touched.assign(1);
            const slot = atomicAdd(cnt.element(budgetAt(i)), uint(1));
            If(float(slot).lessThan(this.turretC.element(i).x), () => { dmg.addAssign(A.w); });
          });
        });
        Loop(u.blastCount, ({ i }) => {
          const B = this.blastArr.element(i).toVar();  // x, y, radius, dps
          If(length(p.sub(B.xy)).lessThan(B.z), () => {
            touched.assign(1);
            const slot = atomicAdd(cnt.element(budgetAt(i.add(int(MAX_TURRETS)))), uint(1));
            If(float(slot).lessThan(this.blastCaps.element(i).x), () => { dmg.addAssign(B.w); });
          });
        });
        If(dmg.greaterThan(0), () => { hp.subAssign(dmg.mul(u.dt)); });
        If(touched.greaterThan(0.5), () => { A.z.assign(u.time); });   // flash

        // ---- reached the base: counts as a leak, not a kill
        // Two tests on purpose. The distance one is precise; the field one cannot
        // desync from the map, because it reads the same bake the zombie is walking
        // down. A stale base uniform used to leave zombies jiggling on top of the
        // base forever: never leaking, never counted, only dying if a weapon
        // happened to cover that exact spot.
        const atBase = length(p.sub(u.basePos)).lessThan(1.7)
          .or(pathDist(p).lessThan(0.004));
        If(atBase, () => {
          hp.assign(-1);
          d.w.assign(u.time);
          atomicAdd(cnt.element(1), uint(1));
        });

        // Monotonic count of zombie-frames spent inside rock. Goal-ward speed is
        // guaranteed below, so "moving too slowly" is no longer possible and
        // measuring it would be tautological; being buried in a platform still
        // is possible, and it is the failure mode worth watching. The CPU diffs
        // this like kills, because clearing it each frame raced the readback.
        If(isRock(p), () => { atomicAdd(cnt.element(4), uint(1)); });

        d.x.assign(max(hp, 0));
        att.element(instanceIndex).assign(A);
        pos.element(instanceIndex).assign(vec4(p, v));
      });

      // Death accounting sits OUTSIDE the alive branch on purpose. Bullets write
      // health directly, so an zombie can arrive here already at zero without the
      // block above ever running; when the check lived inside it, those zombies
      // vanished silently with no kill, no bounty and no corpse.
      If(d.x.lessThanEqual(0).and(d.w.equal(0)), () => {
        d.w.assign(u.time);
        atomicAdd(cnt.element(0), uint(1));
        // Bounty by progress: killed leaving the portal pays a fraction, killed
        // at the gate pays in full.
        const here = pos.element(instanceIndex).xy.toVar();
        const progress = float(1).sub(pathDist(here)).toVar();
        const worth = att.element(instanceIndex).y
          .mul(float(BOUNTY_FLOOR).add(progress.mul(1 - BOUNTY_FLOOR)));
        atomicAdd(cnt.element(2), uint(max(worth, 1)));
      });
      dat.element(instanceIndex).assign(d);
    })().compute(MAX_ZOMBIES);

    // ---- pass: bullet spawn ------------------------------------------------
    // Thread t maps to muzzle t/BURST, round t%BURST. Bounded, and the ring
    // cursor means no free-list bookkeeping.
    this.bulletSpawnPass = Fn(() => {
      const t = int(instanceIndex).toVar();
      const m = t.div(int(MUZZLE_BURST)).toVar();
      const k = t.mod(int(MUZZLE_BURST)).toVar();
      If(m.lessThan(u.muzzleCount), () => {
        const M = this.muzzles.element(m).toVar();       // x, y, angle, rounds
        If(float(k).lessThan(M.w), () => {
          const slot = u.bulletCursor.add(t).mod(int(MAX_BULLETS)).toVar();
          const r1 = hash(instanceIndex.add(uint(u.spawnSeed))).sub(0.5).toVar();
          const jitter = r1.mul(u.bulletSpread);
          // start at the muzzle, clear of the platform the gun stands on
          const aim = M.z.add(jitter).toVar();
          const muzzle = M.xy.add(vec2(cos(aim), sin(aim)).mul(1.7)).toVar();
          bullets.element(slot).assign(vec4(muzzle, aim, float(BULLET_LIFE)));
        });
      });
    })().compute(MAX_MUZZLES * MUZZLE_BURST);

    // ---- pass: bullets ----------------------------------------------------
    // Each round steps forward, samples four points along its path so it cannot
    // tunnel through a crowd, and dies on the first zombie it touches. Damage is
    // written straight into the zombie's health; the sim pass notices the death on
    // its next tick and does the counting.
    this.bulletPass = Fn(() => {
      const B = bullets.element(instanceIndex).toVar();
      If(B.w.greaterThan(0), () => {
        const dir = vec2(cos(B.z), sin(B.z)).toVar();
        const p0 = B.xy.toVar();
        const p1 = p0.add(dir.mul(float(BULLET_SPEED).mul(u.dt))).toVar();
        const life = B.w.sub(u.dt).toVar();

        // Guns stand on rock, so a round is born inside solid geometry. Comparing
        // both ends means it only dies on rock it has actually flown into: while
        // still inside its own platform, p0 is rock and nothing happens. No extra
        // per-bullet state needed, which matters when a bullet is one vec4.
        If(isRock(p0).not().and(isRock(p1)), () => { life.assign(0); });

        const hit = float(0).toVar();
        for (let step = 0; step < 4; step++) {
          const sp = mix(p0, p1, float((step + 0.5) / 4)).toVar();
          const cx = int(clamp(sp.x.mul(DENS_SCALE), float(0), float(DENS_W - 1))).toVar();
          const cy = int(clamp(sp.y.mul(DENS_SCALE), float(0), float(DENS_H - 1))).toVar();
          const cell = cy.mul(int(DENS_W)).add(cx).toVar();
          for (let k = 0; k < BUCKET_K; k++) {
            const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
            If(hit.lessThan(0.5).and(raw.greaterThan(uint(0))), () => {
              const other = raw.sub(uint(1)).toVar();
              const target = dat.element(other).toVar();
              If(target.x.greaterThan(0), () => {
                const q = pos.element(other).xy.toVar();
                If(length(sp.sub(q)).lessThan(float(ZOMBIE_RADIUS * 2.2)), () => {
                  // Read, modify, write the whole vec4: assigning a single
                  // component straight into a storage element does not generate a
                  // write, which is why the first version of this did no damage.
                  target.x.assign(max(target.x.sub(u.bulletDamage), float(0)));
                  dat.element(other).assign(target);
                  const A2 = att.element(other).toVar();
                  A2.z.assign(u.time);                      // hit flash
                  att.element(other).assign(A2);
                  // Pierce: a hit costs life rather than ending the round, so the
                  // pierce budget and the range are the same number.
                  life.subAssign(float(BULLET_PIERCE_COST));
                  hit.assign(1);
                  atomicAdd(cnt.element(3), uint(1));       // bullet hits, for the HUD
                });
              });
            });
          }
        }

        // End of life is a detonation, so every round is two weapons: a line of
        // pierced zombies and a blast where it stops.
        If(life.lessThanEqual(0), () => {
          const r = float(BULLET_BLAST);
          const blastDmg = u.bulletDamage.mul(float(BULLET_BLAST_MULT));
          const bcx = int(clamp(p1.x.mul(DENS_SCALE), float(2), float(DENS_W - 3))).toVar();
          const bcy = int(clamp(p1.y.mul(DENS_SCALE), float(2), float(DENS_H - 3))).toVar();
          for (let oy = -2; oy <= 2; oy++) {
            for (let ox = -2; ox <= 2; ox++) {
              const cell = bcy.add(int(oy)).mul(int(DENS_W)).add(bcx.add(int(ox))).toVar();
              for (let k = 0; k < BUCKET_K; k++) {
                const raw = bucket.element(cell.mul(int(BUCKET_K)).add(int(k))).toVar();
                If(raw.greaterThan(uint(0)), () => {
                  const idx = raw.sub(uint(1)).toVar();
                  const tv = dat.element(idx).toVar();
                  If(tv.x.greaterThan(0), () => {
                    If(length(pos.element(idx).xy.sub(p1)).lessThan(r), () => {
                      tv.x.assign(max(tv.x.sub(blastDmg), float(0)));
                      dat.element(idx).assign(tv);
                      const A3 = att.element(idx).toVar();
                      A3.z.assign(u.time);
                      att.element(idx).assign(A3);
                    });
                  });
                });
              }
            }
          }
        });

        // A dead round keeps its vec4 slot (no free-list, same as everywhere
        // else in the horde) but repurposes it: the angle in .z is dead weight
        // once nothing is steering, so it becomes the death timestamp, and .w
        // swaps from "life remaining" (always >= 0 while flying) to a negative
        // kind flag so the render side can tell "resting here, draw the death
        // fx" apart from "still flying" apart from "never fired" (0,0,0,0).
        //   -1 : died on a hit this frame (pierce budget ran out mid-shot)
        //   -2 : died from time/range alone, no hit this frame (a clean
        //        end-of-life detonation - drawn bigger, with a ring)
        const deadF = step(life, float(0));
        const kind = mix(float(-2), float(-1), hit);
        bullets.element(instanceIndex).assign(
          mix(vec4(p1, B.z, max(life, float(0))), vec4(p1, u.time, kind), deadF),
        );
      });
    })().compute(MAX_BULLETS);

    // ---- pass: clear density ----------------------------------------------
    this.clearPass = Fn(() => {
      atomicStore(dens.element(instanceIndex), uint(0));
      // The bucket has to be wiped as well, not just the counter that indexes
      // it. Scatter only overwrites the slots it actually fills, so any slot a
      // sparser frame does not reach keeps last frame's zombie index forever.
      // The contact pass reads all BUCKET_K slots, so those ghosts stayed in the
      // simulation indefinitely, and the ones that pointed at a corpse pinned an
      // obstacle in place that nothing could ever clear.
      const base = instanceIndex.mul(uint(BUCKET_K));
      for (let k = 0; k < BUCKET_K; k++) {
        bucket.element(base.add(uint(k))).assign(uint(0));
      }
      If(instanceIndex.lessThan(uint(3)), () => {
        atomicStore(cnt.element(instanceIndex.add(uint(6))), uint(0));
      });
      If(instanceIndex.lessThan(uint(MAX_TURRETS + MAX_BLASTS)), () => {
        atomicStore(cnt.element(instanceIndex.add(uint(CNT_BUDGET))), uint(0));
      });
    })().compute(DENS_W * DENS_H);

    // ---- render ------------------------------------------------------------
    // Plain Mesh + InstancedBufferGeometry rather than InstancedMesh: an
    // InstancedMesh would multiply positionLocal by its (default zeroed)
    // instanceMatrix and collapse everything to the origin.
    const src = new THREE.PlaneGeometry(1, 1);
    const geo = new THREE.InstancedBufferGeometry();
    geo.setAttribute('position', src.getAttribute('position'));
    geo.setAttribute('uv', src.getAttribute('uv'));
    geo.setIndex(src.getIndex());
    geo.instanceCount = MAX_ZOMBIES;

    const posA = pos.toAttribute();
    const datA = dat.toAttribute();
    const attA = att.toAttribute();

    const aliveF = step(0.001, datA.x);
    const age = u.time.sub(datA.w);
    // Hold the splat at full strength almost all its life and fade only in the
    // last fifth, so a battlefield stays covered instead of dissolving.
    const fade = clamp(float(CORPSE_FADE).sub(age).div(float(CORPSE_FADE * 0.2)), 0, 1);
    // Fresh blood dries to dark maroon in a couple of seconds, then stays put.
    const wet = clamp(float(1).sub(age.div(2.5)), 0, 1);
    // The instant of death is white hot, which is what makes a beam sweeping a
    // crowd read as shredding rather than as a light show.
    const spark = clamp(float(1).sub(age.mul(9)), 0, 1).mul(float(1).sub(aliveF));
    const vis = mix(fade, float(1), aliveF);
    const live = step(0.001, vis);                    // empty slots collapse to zero area
    const hitPop = clamp(float(1).sub(u.time.sub(attA.z).mul(5)), 0, 1).mul(aliveF);
    const size = attA.w.mul(float(SPRITE_PER_RADIUS))
      .mul(mix(float(1.5), float(1), aliveF))
      .mul(float(1).add(hitPop.mul(0.4)).add(spark.mul(0.8)))
      .mul(live);

    const mat = new THREE.MeshBasicNodeMaterial();
    mat.positionNode = vec3(
      posA.xy.add(positionGeometry.xy.mul(size)),
      mix(float(0.02), float(0.10), aliveF),          // corpses sit under the living
    );

    const tile = mix(float(TILE_COUNT - 1), datA.y, aliveF);   // last tile of the atlas is gore
    const tex = texture(atlasTexture, vec2(uv().x.add(tile).div(TILE_COUNT), uv().y));
    const dry = mix(vec3(0.34, 0.07, 0.06), vec3(1), wet);
    const flash = hitPop;
    mat.colorNode = tex.rgb.mul(mix(dry, vec3(1), aliveF))
      .add(vec3(flash.mul(1.1), flash.mul(0.25), flash.mul(0.05)))
      .add(vec3(spark.mul(1.6), spark.mul(1.3), spark.mul(0.8)));
    mat.opacityNode = tex.a;
    mat.transparent = false;
    mat.alphaTest = 0.5;                              // cutout keeps depth sorting honest

    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 2;

    // ---- bullet render: tiny additive tracers, positions read straight from the
    // same buffer the compute pass writes.
    const bGeo = new THREE.InstancedBufferGeometry();
    bGeo.setAttribute('position', src.getAttribute('position'));
    bGeo.setAttribute('uv', src.getAttribute('uv'));
    bGeo.setIndex(src.getIndex());
    bGeo.instanceCount = MAX_BULLETS;

    const bA = bullets.toAttribute();
    const bFlying = step(0.001, bA.w);              // w > 0: still in flight
    const bDead = step(0.001, bA.w.negate());       // w < 0: resting at a death
    // kind -2 (end-of-life) is more negative than kind -1 (died-on-hit)
    const bDeton = bDead.mul(step(1.5, bA.w.negate()));
    // time since death; z is the death timestamp once dead, garbage (an angle)
    // while flying, but every term below is multiplied by bDead/bFlying so the
    // garbage never reaches colorNode/opacityNode.
    const bDeathAge = max(u.time.sub(bA.z), float(0));

    const bMat = new THREE.MeshBasicNodeMaterial();

    // rounds swell just before they detonate, which is the only warning you get
    const bFlare = clamp(float(0.28).sub(bA.w).mul(6), 0, 1);
    const flySize = float(0.42).add(bFlare.mul(1.4)).mul(bFlying);

    // dead: a hot core for the first ~0.1s, then dust drifting out to ~1.1
    // world units (~1.8x for an end-of-life detonation) over ~0.55s.
    const flashT = clamp(float(1).sub(bDeathAge.div(0.1)), 0, 1);
    const dustT = clamp(bDeathAge.div(0.55), 0, 1);
    const dustFade = clamp(float(1).sub(dustT), 0, 1);
    const throwMul = mix(float(1), float(1.8), bDeton);      // detonations throw debris further
    const deadSize = mix(float(0.55), mix(float(3.2), float(5.2), bDeton), dustT);

    const bSize = flySize.add(deadSize.mul(bDead));
    bMat.positionNode = vec3(bA.xy.add(positionGeometry.xy.mul(bSize)), 0.55);

    // uv-space glow: the flying tracer's core and the death flash's core both
    // want a bright centre fading to the quad's edge, independent of bSize.
    const bd = length(uv().sub(vec2(0.5)));
    const bGlow = clamp(float(1).sub(bd.mul(2.2)), 0, 1);
    // world-space offset from centre, scaled by the quad's own current extent
    // so dust puffs read at a roughly constant world size as bSize animates.
    const worldOff = uv().sub(vec2(0.5)).mul(deadSize);

    // 4 hash-offset soft blobs, each drifting outward from the death point as
    // dustT ramps 0 -> 1; combined with max() rather than summed so overlap
    // reads as one cloud instead of blowing out additive brightness.
    let dustDensity = float(0);
    for (let k = 0; k < 4; k++) {
      const seed = uint(abs(bA.x.mul(1013.0).add(bA.y.mul(731.0)).add(float(k * 197))));
      const ang = hash(seed).mul(6.2831853);
      const rad = mix(float(0.4), float(1.0), hash(seed.add(uint(53))));
      const dist = rad.mul(dustT).mul(1.1).mul(throwMul);
      const center = vec2(cos(ang), sin(ang)).mul(dist);
      const blobR = max(mix(float(0.55), float(0.32), dustT), 0.001);
      const d = length(worldOff.sub(center));
      dustDensity = max(dustDensity, clamp(float(1).sub(d.div(blobR)), 0, 1));
    }

    // detonation-only: a thin ring expanding out and gone within ~0.25s
    const ringT = clamp(bDeathAge.div(0.25), 0, 1);
    const ringR = ringT.mul(1.4).mul(throwMul);
    const ringD = abs(length(worldOff).sub(ringR));
    const ring = clamp(float(1).sub(ringD.div(0.18)), 0, 1)
      .mul(clamp(float(1).sub(ringT), 0, 1)).mul(bDeton);

    const tracerCol = vec3(1.7, 1.25, 0.6);
    const flashCol = vec3(1.7, 1.55, 1.05);
    const dustCol = vec3(0.4, 0.44, 0.36);          // moss grey
    const ringCol = vec3(1.4, 1.05, 0.7);

    bMat.colorNode = tracerCol.mul(bGlow).mul(bFlying)
      .add(flashCol.mul(flashT).mul(bGlow).mul(bDead))
      .add(dustCol.mul(dustDensity).mul(dustFade).mul(bDead))
      .add(ringCol.mul(ring).mul(bDead));
    bMat.opacityNode = clamp(
      bGlow.mul(bFlying)
        .add(flashT.mul(bGlow).mul(bDead))
        .add(dustDensity.mul(dustFade).mul(0.85).mul(bDead))
        .add(ring.mul(bDead)),
      0, 1,
    );
    bMat.transparent = true;
    bMat.depthWrite = false;
    bMat.blending = THREE.AdditiveBlending;

    this.bulletMesh = new THREE.Mesh(bGeo, bMat);
    this.bulletMesh.frustumCulled = false;
    this.bulletMesh.renderOrder = 3;

    this._spawnQueue = [];
    this._seed = 1;
  }

  // Must be called whenever the map changes: this uniform is what decides a leak.
  setBase(x, y) {
    this.u.basePos.value.set(x, y);
  }

  async init() {
    await this.renderer.computeAsync(this.initPass);
    await this.renderer.computeAsync(this.bulletClearPass);
  }

  // Muzzle events for this frame: {x, y, angle, rounds}. Rounds are clamped to
  // MUZZLE_BURST because the spawn dispatch is a fixed size.
  setMuzzles(list, damage, spread) {
    const n = Math.min(list.length, MAX_MUZZLES);
    let total = 0;
    for (let i = 0; i < n; i++) {
      const m = list[i];
      const rounds = Math.min(MUZZLE_BURST, Math.max(0, m.rounds));
      this.muzzles.array[i].set(m.x, m.y, m.angle, rounds);
      total += rounds;
    }
    this.u.muzzleCount.value = n;
    this.u.bulletDamage.value = damage;
    this.u.bulletSpread.value = spread;
    this.u.bulletCursor.value = this._bulletCursor ?? 0;
    this._muzzleCount = n;
    this._bulletCursor = ((this._bulletCursor ?? 0) + MAX_MUZZLES * MUZZLE_BURST) % MAX_BULLETS;
    return total;
  }

  // Full wipe for a restart: every slot emptied, every counter zeroed.
  async reset() {
    this._generation++;                 // discard any readback still in flight
    this.cursor = 0;
    this._spawnQueue.length = 0;
    this.stats = { kills: 0, leaks: 0, gold: 0, spawned: 0, alive: 0, recycled: 0, recycling: false };
    this._lastCounters = [0, 0, 0, 0];
    this._lastStuck = 0;
    this.pendingGold = 0;
    this.pendingLeaks = 0;
    this.density = new Uint32Array(DENS_W * DENS_H);
    this.u.turretCount.value = 0;
    this.u.blastCount.value = 0;
    this.u.chargeCount.value = 0;
    this.initPass.count = MAX_ZOMBIES;
    this._muzzleCount = 0;
    this._bulletCursor = 0;
    this.u.muzzleCount.value = 0;
    await this.renderer.computeAsync(this.counterResetPass);
    await this.renderer.computeAsync(this.initPass);
    await this.renderer.computeAsync(this.bulletClearPass);
  }

  // Queued rather than dispatched immediately so a wave can ask for several
  // archetypes in one tick without fighting over the spawn uniforms.
  spawn(count, { pos, hp, type, speed, gold, scale, spread = 1.6 }) {
    if (count <= 0) return;
    this._spawnQueue.push({ count: Math.min(count, SPAWN_BATCH), pos, hp, type, speed, gold, scale, spread });
  }

  update(dt, time) {
    const { renderer, u } = this;
    u.dt.value = dt;
    u.time.value = time;

    // Up to four spawn dispatches per frame; each is its own tiny dispatch so
    // the uniforms can differ between them.
    let bursts = 0;
    while (this._spawnQueue.length && bursts < 4) {
      const s = this._spawnQueue.shift();
      u.spawnCount.value = s.count;
      u.spawnCursor.value = this.cursor;
      u.spawnPos.value.set(s.pos.x, s.pos.y);
      u.spawnSpread.value = s.spread;
      u.spawnHp.value = s.hp;
      u.spawnType.value = s.type;
      u.spawnSpeed.value = s.speed;
      u.spawnGold.value = s.gold;
      // att.w carries the physics radius, not the drawn scale: the sprite is
      // sized from it, so the circle that collides and the circle you see are
      // the same number and can never drift apart again.
      u.spawnScale.value = zombieRadius(s.scale);
      u.spawnSeed.value = (this._seed = (this._seed * 1664525 + 1013904223) & 0x7fffffff);
      renderer.compute(this.spawnPass);
      this.cursor = (this.cursor + s.count) % MAX_ZOMBIES;
      this.stats.spawned += s.count;
      bursts++;
    }

    // Only dispatch over slots that have ever held an zombie. Early waves cost a
    // few thousand threads instead of the full capacity, and the same window
    // bounds the draw call.
    const used = Math.min(MAX_ZOMBIES, this.stats.spawned);
    this.used = used;
    this.mesh.geometry.instanceCount = Math.max(1, used);
    if (used > 0) {
      // Substeps scale with how far a body would travel this frame. At 1x the
      // crowd barely moves half a radius per frame and needs almost nothing; at
      // 5x fast-forward it would cross several bodies in a single step, which is
      // exactly when a crowd tunnels through itself.
      const reach = dt * MAX_SPEED_GUESS;
      const S = Math.max(this.substeps, Math.min(12, Math.ceil(reach / (ZOMBIE_RADIUS * 0.5))));
      this.u.h.value = dt / S;

      for (const pass of [this.scatterPass, this.movePass, this.relaxPass,
        this.applyPass, this.finishPass, this.simPass]) pass.count = used;

      for (let s = 0; s < S; s++) {
        renderer.compute(this.clearPass);      // hash must be rebuilt every substep
        renderer.compute(this.movePass);
        renderer.compute(this.scatterPass);
        for (let k = 0; k < this.iterations; k++) {
          renderer.compute(this.relaxPass);
          renderer.compute(this.applyPass);
        }
        renderer.compute(this.finishPass);
      }

      // Damage, death and leaks run ONCE, after the crowd has finished moving,
      // so turret DPS does not scale with the substep count.
      renderer.compute(this.simPass);

      // bullets after the last scatter, so the hash they test against is current
      if (this._muzzleCount > 0) renderer.compute(this.bulletSpawnPass);
      renderer.compute(this.bulletPass);
      // Density snapshot is taken from the final substep's scatter. The clear at
      // the top of the next substep is what wipes it now.
      this._pollDensity();
      this._pollCounters();
    }
  }

  // Async staging readback, one in flight at most, never awaited by the frame.
  _pollCounters() {
    if (this._countersInFlight) return;
    this._countersInFlight = true;
    const gen = this._generation;
    this.renderer.getArrayBufferAsync(this._buffers.cnt.value).then((buf) => {
      if (gen !== this._generation) { this._countersInFlight = false; return; }
      const c = new Uint32Array(buf);
      const dKills = c[0] - this._lastCounters[0];
      const dLeaks = c[1] - this._lastCounters[1];
      const dGold = c[2] - this._lastCounters[2];
      this._lastCounters = [c[0], c[1], c[2], c[3]];
      this.stats.kills = c[0];
      this.stats.leaks = c[1];
      this.stats.gold = c[2];
      this.stats.hits = c[3];
      // stuck zombie-frames since the last readback, so it reads as a rate
      this.stats.stuck = Math.max(0, c[4] - this._lastStuck);
      // Not monotonic: these are a census of the last substep, so they read
      // directly. Either being nonzero means a body is somewhere the sim says
      // is impossible.
      this.stats.oob = c[6] ?? 0;
      this.stats.inRock = c[7] ?? 0;
      this.stats.hashDrop = c[8] ?? 0;
      this._lastStuck = c[4];
      this.pendingGold += dGold;
      this.pendingLeaks += dLeaks;
      // Zombies overwritten by the spawn ring never report a death, so the derived
      // headcount would drift above capacity. Clamp it.
      this.stats.recycling = this.stats.spawned > this.capacity;
      // alive comes from the density sum in _pollDensity, which is exact.
      this._countersInFlight = false;
    this._generation = 0;
    }).catch((err) => {
      this._countersInFlight = false;
      if (!this._loggedCounterError) {
        this._loggedCounterError = true;
        console.error('[horde] counter readback failed:', err);
      }
    });
  }

  _pollDensity() {
    if (this._densityInFlight) return;
    if ((this._densityTick = (this._densityTick ?? 0) + 1) % 10 !== 0) return;
    this._densityInFlight = true;
    const gen = this._generation;
    // No reuse target here: that argument wants a three.js ReadbackBuffer, and
    // passing a plain ArrayBuffer made the readback throw into the catch below,
    // which silently blinded every turret that aims at the crowd.
    this.renderer.getArrayBufferAsync(this._buffers.dens.value).then((buf) => {
      if (gen !== this._generation) { this._densityInFlight = false; return; }
      this.density = new Uint32Array(buf);
      // Every living zombie scatters exactly once, so this sum is the exact head
      // count. The derived spawned-minus-kills estimate drifts upward once the
      // spawn ring starts overwriting live zombies.
      // One pass builds both the exact head count and a coarse per-world-cell
      // map. The fine grid is now about one zombie per cell, so anything asking
      // "where is the crowd" has to read a neighbourhood, not a cell.
      let sum = 0;
      const coarse = this.coarse;
      coarse.fill(0);
      for (let cy = 0; cy < DENS_H; cy++) {
        const row = cy * DENS_W;
        const wy = (cy / DENS_SCALE) | 0;
        for (let cx = 0; cx < DENS_W; cx++) {
          const n = this.density[row + cx];
          if (n === 0) continue;
          sum += n;
          coarse[wy * GRID_W + ((cx / DENS_SCALE) | 0)] += n;
        }
      }
      this.stats.alive = sum;
      this._densityInFlight = false;
    }).catch((err) => {
      this._densityInFlight = false;
      if (!this._loggedDensityError) {
        this._loggedDensityError = true;
        console.error('[horde] density readback failed, crowd aiming is blind:', err);
      }
    });
  }

  // How many zombies are within `r` world units of a point, from the async snapshot.
  crowdAround(x, y, r) {
    const c = this.coarse;
    const rc = Math.ceil(r);
    const cx = Math.round(x), cy = Math.round(y);
    let sum = 0;
    for (let oy = -rc; oy <= rc; oy++) {
      const gy = cy + oy;
      if (gy < 0 || gy >= GRID_H) continue;
      for (let ox = -rc; ox <= rc; ox++) {
        const gx = cx + ox;
        if (gx < 0 || gx >= GRID_W) continue;
        sum += c[gy * GRID_W + gx];
      }
    }
    return sum;
  }

  // Thickest part of the crowd within range, in world units, read off the coarse
  // per-world-cell map. Beams, mortars and machine guns all aim with this.
  densestNear(x, y, range) {
    const c = this.coarse;
    const r = Math.ceil(range);
    const cx = Math.round(x), cy = Math.round(y);
    let best = 0, bx = 0, by = 0;
    for (let oy = -r; oy <= r; oy++) {
      const gy = cy + oy;
      if (gy < 1 || gy >= GRID_H - 1) continue;
      for (let ox = -r; ox <= r; ox++) {
        const gx = cx + ox;
        if (gx < 1 || gx >= GRID_W - 1) continue;
        if (ox * ox + oy * oy > r * r) continue;
        const n = c[gy * GRID_W + gx];
        if (n > best) { best = n; bx = gx; by = gy; }
      }
    }
    if (best < 2) return null;
    return { x: bx + 0.5, y: by + 0.5, count: best };
  }

  takeGold() { const g = this.pendingGold; this.pendingGold = 0; return g; }
  takeLeaks() { const l = this.pendingLeaks; this.pendingLeaks = 0; return l; }

  // Weapons are flat shapes, not turrets: one turret can contribute several
  // (a bouncing beam sends one segment per leg).
  setWeapons(list) {
    const n = Math.min(list.length, MAX_TURRETS);
    for (let i = 0; i < n; i++) {
      const w = list[i];
      this.turretA.array[i].set(w.x0, w.y0, w.kind, w.dps);
      this.turretB.array[i].set(w.x1 ?? 0, w.y1 ?? 0, w.width ?? 0, w.radius ?? 0);
      this.turretC.array[i].set(w.cap ?? 1e9, 0, 0, 0);
    }
    this.u.turretCount.value = n;
  }

  setBlasts(list) {
    const n = Math.min(list.length, MAX_BLASTS);
    for (let i = 0; i < n; i++) {
      const b = list[i];
      this.blastArr.array[i].set(b.x, b.y, b.radius, b.dps);
      this.blastCaps.array[i].set(b.cap ?? 1e9, 0, 0, 0);
    }
    this.u.blastCount.value = n;
  }

  // Physics charges: {x, y, accel, radius}. Positive accel attracts (bait),
  // negative repels (shockwave, and a bait detonation's throw). Owned
  // frame-to-frame by main.js's charge manager; this just uploads the
  // uniform snapshot, same shape as setWeapons/setBlasts above.
  setCharges(list) {
    const n = Math.min(list.length, MAX_CHARGES);
    for (let i = 0; i < n; i++) {
      const c = list[i];
      this.chargeA.array[i].set(c.x, c.y, c.accel, c.radius);
    }
    this.u.chargeCount.value = n;
  }
}
