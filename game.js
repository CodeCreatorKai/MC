/* ============================================================================
   MINECRAFT PHYSICS WARS  -  Version 0.1  (sandbox foundation)

   Plain WebGL, no dependencies. Load with <script src="game.js"></script>.

   Sections (search for the banner names):
     1. CONFIG            tuning constants
     2. BLOCK REGISTRY    every block's properties in one place
     3. UTILS / MATH      noise, mat4 helpers
     4. WORLD             voxel storage, raycast
     5. MAP GENERATOR     terrain, spawn pads, centre vault
     6. MESHER            chunk geometry (face culling + ambient occlusion)
     7. PLAYER + PHYSICS  AABB-vs-voxel collision, arcade movement
     8. INVENTORY
     9. GAME SERVER       authoritative rules for block changes (multiplayer seam)
    10. TEXTURES          procedural pixel-art atlas (all original)
    11. RENDERER          WebGL chunks, outline, particles
    12. PARTICLES / AUDIO / INPUT / STORAGE
    13. UI                menus, HUD, hotbar, inventory
    14. GAME              main loop that wires everything together

   Architecture note: the client NEVER edits the world directly. It sends
   requests ({type:'break'|'place', ...}) to GameServer.handle(), which validates
   them, mutates the World and emits events. Today the "server" runs in the same
   page; later it can move behind a WebSocket without touching gameplay code.
   ============================================================================ */
(function (root) {
'use strict';

/* ============================== 1. CONFIG ============================== */
const CONFIG = {
  WORLD: { SIZE_X: 100, SIZE_Y: 40, SIZE_Z: 100, CHUNK: 16 },
  PLAYER: {
    WIDTH: 0.6, HEIGHT: 1.8, EYE: 1.62, EYE_CROUCH: 1.32,
    WALK: 6.0, CROUCH: 2.4,
    GROUND_ACCEL: 80, GROUND_FRICTION: 70, AIR_ACCEL: 22,
    JUMP: 9.0, GRAVITY: 28, TERMINAL: 50, REACH: 6,
  },
  STEP: 1 / 60,                 // fixed physics timestep (seconds)
  MOUSE_SENS: 0.0022,           // radians per pixel at sensitivity 1.0
  MINE: { TIME_PER_HARDNESS: 0.12, MIN_TIME: 0.08, PLACE_COOLDOWN: 0.2 },
  RENDER: { FOG_START: 50, FOG_END: 140, SKY: [0.55, 0.78, 0.95], REBUILD_BUDGET: 4 },
  ATLAS: { TILES: 4, TILE_PX: 16 },
};

/* ========================== 2. BLOCK REGISTRY ========================== */
// Tile indices inside the 4x4 procedural texture atlas.
const TILE = { GRASS_TOP: 0, GRASS_SIDE: 1, DIRT: 2, STONE: 3, WOOD: 4, GLASS: 5, SAND: 6, GRAVEL: 7, BEDROCK: 8 };

const BlockRegistry = (() => {
  const list = [];
  const byType = {};
  function define(def) {
    const block = Object.assign({
      hardness: 1, blastResistance: 1, weight: 1,
      gravityAffected: false, flammable: false, transparent: false,
      solid: true, breakable: true, placeable: true,
      sound: 'soft', color: [0.5, 0.5, 0.5],
      tiles: { top: 0, side: 0, bottom: 0 },
    }, def, { id: list.length });
    list.push(block);
    byType[block.type] = block;
    return block;
  }
  // id 0 must stay air: world arrays are zero-filled.
  define({ type: 'air', solid: false, transparent: true, breakable: false, placeable: false, hardness: 0, blastResistance: 0, weight: 0, tiles: null });
  define({ type: 'grass',   hardness: 1,   blastResistance: 1.5, weight: 3,   sound: 'soft',  color: [0.38, 0.66, 0.27], tiles: { top: TILE.GRASS_TOP, side: TILE.GRASS_SIDE, bottom: TILE.DIRT } });
  define({ type: 'dirt',    hardness: 1,   blastResistance: 1.5, weight: 3,   sound: 'soft',  color: [0.52, 0.38, 0.26], tiles: { top: TILE.DIRT, side: TILE.DIRT, bottom: TILE.DIRT } });
  define({ type: 'stone',   hardness: 5,   blastResistance: 8,   weight: 5,   sound: 'stone', color: [0.49, 0.49, 0.51], tiles: { top: TILE.STONE, side: TILE.STONE, bottom: TILE.STONE } });
  define({ type: 'wood',    hardness: 2.5, blastResistance: 3,   weight: 3,   sound: 'wood',  color: [0.69, 0.54, 0.33], flammable: true, tiles: { top: TILE.WOOD, side: TILE.WOOD, bottom: TILE.WOOD } });
  define({ type: 'glass',   hardness: 0.3, blastResistance: 0.3, weight: 1,   sound: 'glass', color: [0.78, 0.92, 1.0],  transparent: true, tiles: { top: TILE.GLASS, side: TILE.GLASS, bottom: TILE.GLASS } });
  define({ type: 'sand',    hardness: 0.8, blastResistance: 1,   weight: 3,   sound: 'soft',  color: [0.86, 0.80, 0.59], gravityAffected: true, tiles: { top: TILE.SAND, side: TILE.SAND, bottom: TILE.SAND } });
  define({ type: 'gravel',  hardness: 1,   blastResistance: 1.5, weight: 3.5, sound: 'stone', color: [0.52, 0.5, 0.5],   gravityAffected: true, tiles: { top: TILE.GRAVEL, side: TILE.GRAVEL, bottom: TILE.GRAVEL } });
  define({ type: 'bedrock', hardness: Infinity, blastResistance: Infinity, weight: 99, sound: 'stone', color: [0.2, 0.2, 0.22], breakable: false, placeable: false, tiles: { top: TILE.BEDROCK, side: TILE.BEDROCK, bottom: TILE.BEDROCK } });
  return {
    list,
    byType: (t) => byType[t],
    byId: (id) => list[id],
    placeable: () => list.filter((b) => b.placeable),
  };
})();
const AIR = 0;
const B = (type) => BlockRegistry.byType(type).id;

/* ========================== 3. UTILS / MATH ============================ */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const approach = (v, target, maxDelta) => (v < target ? Math.min(v + maxDelta, target) : Math.max(v - maxDelta, target));

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hashNoise(ix, iz, seed) {
  let h = Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263) ^ Math.imul(seed, 1274126177);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}
function valueNoise(x, z, seed) {
  const x0 = Math.floor(x), z0 = Math.floor(z);
  const fx = x - x0, fz = z - z0;
  const sx = fx * fx * (3 - 2 * fx), sz = fz * fz * (3 - 2 * fz);
  const a = hashNoise(x0, z0, seed), b = hashNoise(x0 + 1, z0, seed);
  const c = hashNoise(x0, z0 + 1, seed), d = hashNoise(x0 + 1, z0 + 1, seed);
  return lerp(lerp(a, b, sx), lerp(c, d, sx), sz);
}
function fbm(x, z, seed) {
  let value = 0, amp = 0.5, freq = 1, norm = 0;
  for (let o = 0; o < 3; o++) {
    value += amp * valueNoise(x * freq, z * freq, seed + o * 101);
    norm += amp; amp *= 0.5; freq *= 2;
  }
  return value / norm;
}

// 4x4 column-major matrices (WebGL convention).
const Mat4 = {
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(ex, ey, ez, cx, cy, cz) {
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    // x = up(0,1,0) x z
    let xx = zz, xy = 0, xz = -zx;
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez), -(yx * ex + yy * ey + yz * ez), -(zx * ex + zy * ey + zz * ez), 1,
    ]);
  },
  multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        let s = 0;
        for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
        out[c * 4 + r] = s;
      }
    }
    return out;
  },
};

/* ============================== 4. WORLD =============================== */
class World {
  constructor(sx = CONFIG.WORLD.SIZE_X, sy = CONFIG.WORLD.SIZE_Y, sz = CONFIG.WORLD.SIZE_Z) {
    this.sizeX = sx; this.sizeY = sy; this.sizeZ = sz;
    this.blocks = new Uint8Array(sx * sy * sz);
    this.listeners = [];   // (x, y, z, oldId, newId) => void
  }
  index(x, y, z) { return x + z * this.sizeX + y * this.sizeX * this.sizeZ; }
  inBounds(x, y, z) { return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY && z >= 0 && z < this.sizeZ; }
  get(x, y, z) { return this.inBounds(x, y, z) ? this.blocks[this.index(x, y, z)] : AIR; }
  /** Collision solidity. Side walls and the floor are solid; open sky above is not. */
  isSolid(x, y, z) {
    if (y >= this.sizeY) return false;
    if (x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ || y < 0) return true;
    return BlockRegistry.list[this.blocks[this.index(x, y, z)]].solid;
  }
  set(x, y, z, id, silent = false) {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    const old = this.blocks[i];
    if (old === id) return false;
    this.blocks[i] = id;
    if (!silent) for (const fn of this.listeners) fn(x, y, z, old, id);
    return true;
  }
  /** Y of the highest non-air block in a column, or -1. */
  getHeight(x, z) {
    for (let y = this.sizeY - 1; y >= 0; y--) if (this.blocks[this.index(x, y, z)] !== AIR) return y;
    return -1;
  }
  /**
   * Voxel raycast (Amanatides & Woo DDA). `o` and `d` are {x,y,z}; d must be normalised.
   * Returns {x,y,z, nx,ny,nz, dist} for the first block hit (n* = face normal) or null.
   */
  raycast(o, d, maxDist) {
    let x = Math.floor(o.x), y = Math.floor(o.y), z = Math.floor(o.z);
    const sx = d.x > 0 ? 1 : -1, sy = d.y > 0 ? 1 : -1, sz = d.z > 0 ? 1 : -1;
    const tdx = d.x !== 0 ? Math.abs(1 / d.x) : Infinity;
    const tdy = d.y !== 0 ? Math.abs(1 / d.y) : Infinity;
    const tdz = d.z !== 0 ? Math.abs(1 / d.z) : Infinity;
    let tx = d.x > 0 ? (x + 1 - o.x) * tdx : d.x < 0 ? (o.x - x) * tdx : Infinity;
    let ty = d.y > 0 ? (y + 1 - o.y) * tdy : d.y < 0 ? (o.y - y) * tdy : Infinity;
    let tz = d.z > 0 ? (z + 1 - o.z) * tdz : d.z < 0 ? (o.z - z) * tdz : Infinity;
    let t = 0, nx = 0, ny = 0, nz = 0;
    for (let i = 0; i < 512; i++) {
      if (this.inBounds(x, y, z) && this.blocks[this.index(x, y, z)] !== AIR) return { x, y, z, nx, ny, nz, dist: t };
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (ty < tz)        { y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0; }
      else                     { z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz; }
      if (t > maxDist) break;
    }
    return null;
  }
}

/* ========================= 5. MAP GENERATOR ============================ */
const MapGenerator = {
  PAD_HEIGHT: 14,
  CENTER_HEIGHT: 15,
  /** Spawn positions for up to 6 players on a ring around the map centre. */
  computeSpawns(world) {
    const angles = [180, 0, 120, 300, 240, 60];
    const cx = world.sizeX / 2, cz = world.sizeZ / 2, R = 36;
    return angles.map((deg, i) => ({
      index: i,
      x: Math.floor(cx + R * Math.cos(deg * Math.PI / 180)) + 0.5,
      z: Math.floor(cz + R * Math.sin(deg * Math.PI / 180)) + 0.5,
      y: 0,
    }));
  },
  /** Fills `world` and returns { spawns, center }. Deterministic for a given seed. */
  generate(world, mapName = 'plains', seed = 1337) {
    const { sizeX: sx, sizeY: sy, sizeZ: sz } = world;
    const rng = mulberry32(seed);
    const spawns = this.computeSpawns(world);
    const cx = Math.floor(sx / 2), cz = Math.floor(sz / 2);
    const PAD = this.PAD_HEIGHT, CENTER = this.CENTER_HEIGHT;

    const stone = B('stone'), dirt = B('dirt'), grass = B('grass'), sand = B('sand'),
          gravel = B('gravel'), bedrock = B('bedrock'), wood = B('wood'), glass = B('glass');
    const heights = new Int16Array(sx * sz);

    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        let h = 13 + (fbm(x / 28, z / 28, seed) - 0.5) * 14;
        for (const s of spawns) h = lerp(PAD, h, smoothstep(9, 15, Math.hypot(x - s.x, z - s.z)));
        h = lerp(CENTER, h, smoothstep(11, 17, Math.hypot(x - cx, z - cz)));
        h = clamp(Math.round(h), 4, sy - 12);
        heights[x + z * sx] = h;
        const beach = h <= 11;
        const patchy = fbm(x / 9 + 50, z / 9 + 50, seed + 7) > 0.68;
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = bedrock;
          else if (y === h) id = beach ? sand : patchy ? gravel : grass;
          else if (y >= h - 3) id = beach ? sand : dirt;
          else id = stone;
          world.set(x, y, z, id, true);
        }
      }
    }

    // Spawn pads: stone floor with four wooden corner posts.
    for (const s of spawns) {
      const px = Math.floor(s.x), pz = Math.floor(s.z);
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) world.set(px + dx, PAD, pz + dz, stone, true);
      for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
        for (let k = 1; k <= 3; k++) world.set(px + dx, PAD + k, pz + dz, wood, true);
        world.set(px + dx, PAD + 4, pz + dz, glass, true);
      }
    }

    // Centre vault: hollow stone building with doors, windows and a glass roof.
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const edge = Math.max(Math.abs(dx), Math.abs(dz)) === 4;
        world.set(cx + dx, CENTER, cz + dz, stone, true);
        for (let k = 1; k <= 4; k++) world.set(cx + dx, CENTER + k, cz + dz, AIR, true);
        if (edge) {
          for (let k = 1; k <= 4; k++) world.set(cx + dx, CENTER + k, cz + dz, stone, true);
          const along = Math.abs(dx) === 4 ? dz : dx;           // position along this wall
          if (along === 0) { world.set(cx + dx, CENTER + 1, cz + dz, AIR, true); world.set(cx + dx, CENTER + 2, cz + dz, AIR, true); }
          if (Math.abs(along) === 2) world.set(cx + dx, CENTER + 3, cz + dz, glass, true);
        }
        world.set(cx + dx, CENTER + 5, cz + dz, glass, true);
      }
    }
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) world.set(cx + dx, CENTER + 1, cz + dz, stone, true);
    world.set(cx, CENTER + 2, cz, sand, true);

    // Boulders for cover and something to blow up later.
    for (let n = 0; n < 16; n++) {
      const bx = 6 + Math.floor(rng() * (sx - 12)), bz = 6 + Math.floor(rng() * (sz - 12));
      const nearBase = spawns.some((s) => Math.hypot(bx - s.x, bz - s.z) < 14);
      if (nearBase || Math.hypot(bx - cx, bz - cz) < 17) continue;
      const r = 1.3 + rng() * 1.5, top = heights[bx + bz * sx];
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 3; dy++) {
        if (Math.hypot(dx, dy, dz) <= r) world.set(bx + dx, top + dy, bz + dz, stone, true);
      }
    }

    for (const s of spawns) s.y = world.getHeight(Math.floor(s.x), Math.floor(s.z)) + 1;
    return { spawns, center: { x: cx + 0.5, z: cz + 0.5 }, name: mapName };
  },
};

/* =============================== 6. MESHER ============================== */
// Vertex layout (floats): x, y, z, u, v, shade  ->  stride 24 bytes.
const VERTEX_FLOATS = 6;
const AO_LEVELS = [0.5, 0.68, 0.84, 1.0];
// Triangles per quad, in terms of corner indices. Corner order is CCW seen from
// outside for a +axis face; -axis faces use the reversed tables.
const TRI_POS = [0, 1, 2, 0, 2, 3], TRI_POS_FLIP = [1, 2, 3, 1, 3, 0];
const TRI_NEG = [0, 2, 1, 0, 3, 2], TRI_NEG_FLIP = [1, 3, 2, 1, 0, 3];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const ATLAS_INSET = 0.0006;

/**
 * Builds the triangle list for one chunk column (all heights). Only faces that
 * touch air/transparent neighbours are emitted; each vertex gets ambient occlusion
 * from the three blocks around its corner.
 */
function buildChunkMesh(world, cx, cz) {
  const C = CONFIG.WORLD.CHUNK, T = CONFIG.ATLAS.TILES, list = BlockRegistry.list;
  const x0 = cx * C, z0 = cz * C;
  const x1 = Math.min(x0 + C, world.sizeX), z1 = Math.min(z0 + C, world.sizeZ);
  const out = [];
  const opaque = (x, y, z) => { const id = world.get(x, y, z); return id !== AIR && !list[id].transparent ? 1 : 0; };
  const p = [0, 0, 0], q = [0, 0, 0], ao = [0, 0, 0, 0];
  const verts = [[0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0], [0, 0, 0, 0, 0]];

  for (let y = 0; y < world.sizeY; y++) {
    for (let z = z0; z < z1; z++) {
      for (let x = x0; x < x1; x++) {
        const id = world.blocks[world.index(x, y, z)];
        if (id === AIR) continue;
        const def = list[id];
        for (let a = 0; a < 3; a++) {
          for (let s = -1; s <= 1; s += 2) {
            q[0] = x; q[1] = y; q[2] = z; q[a] += s;               // neighbour across this face
            const nId = world.get(q[0], q[1], q[2]);
            if (nId !== AIR && (!list[nId].transparent || nId === id)) continue;

            const t1 = (a + 1) % 3, t2 = (a + 2) % 3;
            const tile = a === 1 ? (s > 0 ? def.tiles.top : def.tiles.bottom) : def.tiles.side;
            const shade = a === 1 ? (s > 0 ? 1.0 : 0.5) : (a === 0 ? 0.8 : 0.66);
            const tu = (tile % T) / T, tv = Math.floor(tile / T) / T, ts = 1 / T;

            for (let i = 0; i < 4; i++) {
              const c1 = CORNERS[i][0], c2 = CORNERS[i][1];
              const o1 = c1 ? 1 : -1, o2 = c2 ? 1 : -1;
              // ambient occlusion: the two side blocks and the diagonal one
              q[t1] += o1; const sA = opaque(q[0], q[1], q[2]); q[t1] -= o1;
              q[t2] += o2; const sB = opaque(q[0], q[1], q[2]); q[t2] -= o2;
              q[t1] += o1; q[t2] += o2; const sC = opaque(q[0], q[1], q[2]); q[t1] -= o1; q[t2] -= o2;
              ao[i] = sA && sB ? 0 : 3 - (sA + sB + sC);

              p[0] = x; p[1] = y; p[2] = z;
              p[a] += s > 0 ? 1 : 0; p[t1] += c1; p[t2] += c2;
              let u, v;
              if (a === 1) { u = c1; v = c2; }
              else if (a === 0) { u = c2; v = 1 - c1; }              // t1 = y (vertical)
              else { u = c1; v = 1 - c2; }                           // t2 = y (vertical)
              const vt = verts[i];
              vt[0] = p[0]; vt[1] = p[1]; vt[2] = p[2];
              vt[3] = tu + (ATLAS_INSET + u * (1 - 2 * ATLAS_INSET)) * ts;
              vt[4] = tv + (ATLAS_INSET + v * (1 - 2 * ATLAS_INSET)) * ts;
            }
            const flip = ao[1] + ao[3] > ao[0] + ao[2];
            const tris = s > 0 ? (flip ? TRI_POS_FLIP : TRI_POS) : (flip ? TRI_NEG_FLIP : TRI_NEG);
            for (let k = 0; k < 6; k++) {
              const vi = tris[k], vt = verts[vi];
              out.push(vt[0], vt[1], vt[2], vt[3], vt[4], shade * AO_LEVELS[ao[vi]]);
            }
          }
        }
      }
    }
  }
  return { data: new Float32Array(out), vertexCount: out.length / VERTEX_FLOATS };
}

/* ======================== 7. PLAYER + PHYSICS =========================== */
const EPS = 1e-4;

class Player {
  constructor(id, name) {
    this.id = id; this.name = name;
    this.pos = { x: 0, y: 0, z: 0 };       // feet centre
    this.prev = { x: 0, y: 0, z: 0 };      // previous physics step (for render interpolation)
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0; this.pitch = 0;
    this.onGround = false; this.crouching = false;
    this.eyeHeight = CONFIG.PLAYER.EYE;
    this.impactSpeed = 0;                   // set on landing (fall damage hooks in later)
    this.jumped = false;
    this.stepDistance = 0;
  }
  get halfWidth() { return CONFIG.PLAYER.WIDTH / 2; }
  get height() { return CONFIG.PLAYER.HEIGHT; }
  teleport(x, y, z) {
    this.pos.x = this.prev.x = x; this.pos.y = this.prev.y = y; this.pos.z = this.prev.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
  }
  eyePosition(alpha = 1) {
    return {
      x: lerp(this.prev.x, this.pos.x, alpha),
      y: lerp(this.prev.y, this.pos.y, alpha) + this.eyeHeight,
      z: lerp(this.prev.z, this.pos.z, alpha),
    };
  }
  lookDirection() {
    const cp = Math.cos(this.pitch);
    return { x: -Math.sin(this.yaw) * cp, y: Math.sin(this.pitch), z: -Math.cos(this.yaw) * cp };
  }

  /** One fixed physics step. controls: {forward, back, left, right, jump, crouch} booleans. */
  update(dt, controls, world) {
    const P = CONFIG.PLAYER;
    this.prev.x = this.pos.x; this.prev.y = this.pos.y; this.prev.z = this.pos.z;
    this.jumped = false; this.impactSpeed = 0;
    this.crouching = !!controls.crouch;

    // Wish direction from keys, relative to where we look (yaw 0 faces -Z).
    const f = (controls.forward ? 1 : 0) - (controls.back ? 1 : 0);
    const s = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
    let wx = f * -Math.sin(this.yaw) + s * Math.cos(this.yaw);
    let wz = f * -Math.cos(this.yaw) + s * -Math.sin(this.yaw);
    const len = Math.hypot(wx, wz);
    const speed = this.crouching ? P.CROUCH : P.WALK;

    if (len > 0) {
      wx /= len; wz /= len;
      const accel = (this.onGround ? P.GROUND_ACCEL : P.AIR_ACCEL) * dt;
      this.vel.x = approach(this.vel.x, wx * speed, accel);
      this.vel.z = approach(this.vel.z, wz * speed, accel);
    } else if (this.onGround) {
      const fr = P.GROUND_FRICTION * dt;                           // snappy stop, no ice-skating
      this.vel.x = approach(this.vel.x, 0, fr);
      this.vel.z = approach(this.vel.z, 0, fr);
    }                                                              // in the air with no input: keep momentum

    if (controls.jump && this.onGround) { this.vel.y = P.JUMP; this.onGround = false; this.jumped = true; }
    this.vel.y = Math.max(this.vel.y - P.GRAVITY * dt, -P.TERMINAL);

    this.onGround = false;
    this.moveAxis(world, 'y', this.vel.y * dt);
    this.moveAxis(world, 'x', this.vel.x * dt);
    this.moveAxis(world, 'z', this.vel.z * dt);

    this.eyeHeight = approach(this.eyeHeight, this.crouching ? P.EYE_CROUCH : P.EYE, 6 * dt);
    if (this.onGround) this.stepDistance += Math.hypot(this.pos.x - this.prev.x, this.pos.z - this.prev.z);
  }

  /** Move along one axis in <=0.25 block increments so fast bodies can't tunnel through walls. */
  moveAxis(world, axis, delta) {
    if (delta === 0) return;
    const n = Math.ceil(Math.abs(delta) / 0.25), step = delta / n;
    for (let i = 0; i < n; i++) if (!this.stepAxis(world, axis, step)) break;
  }

  /** Move by `d` on one axis; if that overlaps a solid voxel, snap flush against it. Returns false on collision. */
  stepAxis(world, axis, d) {
    this.pos[axis] += d;
    const hw = this.halfWidth, h = this.height;
    const minX = Math.floor(this.pos.x - hw + EPS), maxX = Math.floor(this.pos.x + hw - EPS);
    const minY = Math.floor(this.pos.y + EPS),      maxY = Math.floor(this.pos.y + h - EPS);
    const minZ = Math.floor(this.pos.z - hw + EPS), maxZ = Math.floor(this.pos.z + hw - EPS);
    let hit = false, best = d > 0 ? Infinity : -Infinity;
    for (let y = minY; y <= maxY; y++) for (let z = minZ; z <= maxZ; z++) for (let x = minX; x <= maxX; x++) {
      if (!world.isSolid(x, y, z)) continue;
      hit = true;
      const c = axis === 'x' ? x : axis === 'y' ? y : z;
      best = d > 0 ? Math.min(best, c) : Math.max(best, c);        // nearest blocking face wins
    }
    if (!hit) return true;
    if (axis === 'x') { this.pos.x = d > 0 ? best - hw - EPS : best + 1 + hw + EPS; this.vel.x = 0; }
    else if (axis === 'z') { this.pos.z = d > 0 ? best - hw - EPS : best + 1 + hw + EPS; this.vel.z = 0; }
    else {
      if (d > 0) this.pos.y = best - h - EPS;
      else { this.pos.y = best + 1; this.onGround = true; this.impactSpeed = -this.vel.y; }
      this.vel.y = 0;
    }
    return false;
  }

  /** Axis-aligned bounding box as {minX,minY,minZ,maxX,maxY,maxZ}. */
  aabb() {
    const hw = this.halfWidth;
    return { minX: this.pos.x - hw, maxX: this.pos.x + hw, minY: this.pos.y, maxY: this.pos.y + this.height, minZ: this.pos.z - hw, maxZ: this.pos.z + hw };
  }
}

/* ============================ 8. INVENTORY ============================= */
class Inventory {
  constructor(size = 9) { this.slots = new Array(size).fill(null); this.selected = 0; }
  /** quantity Infinity = unlimited (sandbox). Real matches will use finite counts. */
  setSlot(i, item, quantity = Infinity) { this.slots[i] = item ? { item, quantity } : null; }
  get selectedSlot() { return this.slots[this.selected]; }
  select(i) { this.selected = ((i % this.slots.length) + this.slots.length) % this.slots.length; }
  consume(i) {
    const s = this.slots[i];
    if (!s) return false;
    if (s.quantity !== Infinity) { s.quantity--; if (s.quantity <= 0) this.slots[i] = null; }
    return true;
  }
}

/* =========================== 9. GAME SERVER ============================ */
/**
 * Authoritative rules for the world. In this prototype it lives in the page; for
 * multiplayer the same class runs on a Node server and `handle()` is fed by sockets.
 * The client only ever *asks*; the server decides.
 */
class GameServer {
  constructor(world) {
    this.world = world;
    this.players = new Map();       // id -> Player (server's copy)
    this.listeners = [];
    this.phase = 'sandbox';         // later: lobby | build | war | chaos | winner
  }
  subscribe(fn) { this.listeners.push(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }
  addPlayer(player) { this.players.set(player.id, player); }

  /** Hook for territory ownership / phase limits. Sandbox: everything is allowed. */
  canModify(playerId, x, y, z, action) { return true; }

  withinReach(player, x, y, z) {
    const e = player.eyePosition();
    return Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y, z + 0.5 - e.z) <= CONFIG.PLAYER.REACH + 1.0;
  }

  handle(playerId, msg) {
    const player = this.players.get(playerId);
    if (!player) return { ok: false, reason: 'unknown-player' };
    if (msg.type === 'break') return this.breakBlock(player, msg);
    if (msg.type === 'place') return this.placeBlock(player, msg);
    return { ok: false, reason: 'unknown-action' };
  }

  breakBlock(player, { x, y, z }) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return { ok: false, reason: 'out-of-bounds' };
    const id = w.get(x, y, z);
    if (id === AIR) return { ok: false, reason: 'empty' };
    const def = BlockRegistry.byId(id);
    if (!def.breakable) return { ok: false, reason: 'unbreakable' };
    if (!this.withinReach(player, x, y, z)) return { ok: false, reason: 'too-far' };
    if (!this.canModify(player.id, x, y, z, 'break')) return { ok: false, reason: 'not-allowed' };
    w.set(x, y, z, AIR);
    this.emit({ type: 'blockBroken', x, y, z, block: def, by: player.id });
    return { ok: true };
  }

  placeBlock(player, { x, y, z, block }) {
    const w = this.world;
    const def = BlockRegistry.byType(block);
    if (!def || !def.placeable) return { ok: false, reason: 'bad-block' };
    if (!w.inBounds(x, y, z)) return { ok: false, reason: 'out-of-bounds' };
    if (w.get(x, y, z) !== AIR) return { ok: false, reason: 'occupied' };
    if (!this.withinReach(player, x, y, z)) return { ok: false, reason: 'too-far' };
    if (!this.canModify(player.id, x, y, z, 'place')) return { ok: false, reason: 'not-allowed' };
    if (def.solid) {                                            // never entomb a player (self included)
      for (const p of this.players.values()) {
        const b = p.aabb();
        if (b.maxX > x + 1e-3 && b.minX < x + 1 - 1e-3 && b.maxY > y + 1e-3 && b.minY < y + 1 - 1e-3 && b.maxZ > z + 1e-3 && b.minZ < z + 1 - 1e-3) {
          return { ok: false, reason: 'player-in-way' };
        }
      }
    }
    w.set(x, y, z, def.id);
    this.emit({ type: 'blockPlaced', x, y, z, block: def, by: player.id });
    return { ok: true };
  }
}

/* ============================ 10. TEXTURES ============================= */
/** Procedural 16x16 pixel-art tiles packed in a 4x4 atlas. Everything here is original. */
function generateAtlas() {
  const { TILES, TILE_PX } = CONFIG.ATLAS;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILES * TILE_PX;
  const ctx = canvas.getContext('2d');

  function paint(tile, seed, fn) {
    const rng = mulberry32(seed);
    const img = ctx.createImageData(TILE_PX, TILE_PX);
    const put = (x, y, r, g, b, a = 255) => {
      const i = (y * TILE_PX + x) * 4;
      img.data[i] = clamp(r, 0, 255); img.data[i + 1] = clamp(g, 0, 255); img.data[i + 2] = clamp(b, 0, 255); img.data[i + 3] = a;
    };
    fn(put, rng);
    ctx.putImageData(img, (tile % TILES) * TILE_PX, Math.floor(tile / TILES) * TILE_PX);
  }
  const noisy = (put, rng, x, y, r, g, b, v) => { const n = (rng() - 0.5) * v; put(x, y, r + n, g + n, b + n); };
  const dirtPx = (put, rng, x, y) => {
    noisy(put, rng, x, y, 134, 96, 67, 28);
    if (rng() < 0.07) put(x, y, 96, 66, 44);
  };

  paint(TILE.GRASS_TOP, 11, (put, rng) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) noisy(put, rng, x, y, 98, 172, 70, 34); });
  paint(TILE.GRASS_SIDE, 12, (put, rng) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) dirtPx(put, rng, x, y);
    for (let x = 0; x < 16; x++) { const depth = 3 + (rng() < 0.45 ? 1 : 0) + (rng() < 0.2 ? 1 : 0); for (let y = 0; y < depth; y++) noisy(put, rng, x, y, 98, 172, 70, 34); }
  });
  paint(TILE.DIRT, 13, (put, rng) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) dirtPx(put, rng, x, y); });
  paint(TILE.STONE, 14, (put, rng) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { noisy(put, rng, x, y, 126, 126, 132, 22); if (rng() < 0.09) put(x, y, 96, 96, 102); }
  });
  paint(TILE.WOOD, 15, (put, rng) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const seam = y % 4 === 3, joint = ((y >> 2) % 2 === 0 ? x === 5 : x === 12);
      if (seam || joint) put(x, y, 128, 94, 52); else noisy(put, rng, x, y, 182, 142, 86, 14);
    }
  });
  paint(TILE.GLASS, 16, (put) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
      const edge = x === 0 || y === 0 || x === 15 || y === 15;
      const glint = (x === y && x >= 3 && x <= 6) || (x === y + 1 && x >= 4 && x <= 6);
      if (edge) put(x, y, 190, 230, 255, 255); else if (glint) put(x, y, 255, 255, 255, 255); else put(x, y, 200, 235, 255, 0);
    }
  });
  paint(TILE.SAND, 17, (put, rng) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) noisy(put, rng, x, y, 221, 207, 152, 18); });
  paint(TILE.GRAVEL, 18, (put, rng) => {
    for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) { const n = (rng() - 0.5) * 64; put(x, y, 128 + n, 124 + n, 122 + n); }
  });
  paint(TILE.BEDROCK, 19, (put, rng) => { for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) noisy(put, rng, x, y, 54, 54, 60, 44); });
  return canvas;
}

/* ============================ 11. RENDERER ============================= */
const WORLD_VS = `
attribute vec3 aPos; attribute vec2 aUV; attribute float aShade;
uniform mat4 uVP; uniform vec3 uCam;
varying vec2 vUV; varying float vShade; varying float vDist;
void main(){ vUV = aUV; vShade = aShade; vDist = length(aPos - uCam); gl_Position = uVP * vec4(aPos, 1.0); }`;
const WORLD_FS = `
precision mediump float;
uniform sampler2D uTex; uniform vec3 uFogColor; uniform float uFogStart; uniform float uFogEnd;
varying vec2 vUV; varying float vShade; varying float vDist;
void main(){
  vec4 c = texture2D(uTex, vUV);
  if (c.a < 0.5) discard;
  float f = clamp((vDist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  gl_FragColor = vec4(mix(c.rgb * vShade, uFogColor, f), 1.0);
}`;
const SOLID_VS = `
attribute vec3 aPos; uniform mat4 uVP; uniform vec3 uOffset; uniform float uScale;
void main(){ gl_Position = uVP * vec4(uOffset + aPos * uScale, 1.0); }`;
const SOLID_FS = `
precision mediump float; uniform vec4 uColor;
void main(){ gl_FragColor = uColor; }`;

// Unit cube centred on the origin: 36 triangle vertices and 24 line vertices.
const CUBE_TRIS = (() => {
  const v = [];
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const n of faces) {
    const a = n[0] ? 0 : n[1] ? 1 : 2, t1 = (a + 1) % 3, t2 = (a + 2) % 3, s = n[a];
    const c = CORNERS.map(([c1, c2]) => { const p = [0, 0, 0]; p[a] = s * 0.5; p[t1] = c1 - 0.5; p[t2] = c2 - 0.5; return p; });
    for (const i of (s > 0 ? TRI_POS : TRI_NEG)) v.push(...c[i]);
  }
  return new Float32Array(v);
})();
const CUBE_LINES = (() => {
  const v = [];
  for (let i = 0; i < 8; i++) {
    const p = [(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5];
    for (let a = 0; a < 3; a++) if (!((i >> a) & 1)) { const q = p.slice(); q[a] += 1; v.push(...p, ...q); }
  }
  return new Float32Array(v);
})();

class Renderer {
  constructor(canvas, world, atlasCanvas) {
    this.canvas = canvas; this.world = world;
    const gl = canvas.getContext('webgl', { antialias: true, alpha: false, powerPreference: 'high-performance' })
            || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.worldProg = this.makeProgram(WORLD_VS, WORLD_FS, ['aPos', 'aUV', 'aShade'], ['uVP', 'uCam', 'uTex', 'uFogColor', 'uFogStart', 'uFogEnd']);
    this.solidProg = this.makeProgram(SOLID_VS, SOLID_FS, ['aPos'], ['uVP', 'uOffset', 'uScale', 'uColor']);
    this.cubeTris = this.makeBuffer(CUBE_TRIS);
    this.cubeLines = this.makeBuffer(CUBE_LINES);

    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);

    const C = CONFIG.WORLD.CHUNK;
    this.chunksX = Math.ceil(world.sizeX / C);
    this.chunksZ = Math.ceil(world.sizeZ / C);
    this.chunks = new Array(this.chunksX * this.chunksZ).fill(null).map(() => ({ buffer: null, count: 0, dirty: true }));
    world.listeners.push((x, y, z) => this.markDirty(x, z));
    this.stats = { drawnChunks: 0, triangles: 0 };
    this.resize();
  }

  makeProgram(vsSrc, fsSrc, attribs, uniforms) {
    const gl = this.gl;
    const compile = (type, src) => {
      const s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error('Shader error: ' + gl.getShaderInfoLog(s));
      return s;
    };
    const prog = gl.createProgram();
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    attribs.forEach((name, i) => gl.bindAttribLocation(prog, i, name));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    const u = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u, attribCount: attribs.length };
  }
  makeBuffer(data) {
    const gl = this.gl, b = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, b);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    return b;
  }
  useProgram(p) {
    const gl = this.gl;
    gl.useProgram(p.prog);
    for (let i = 0; i < 3; i++) { if (i < p.attribCount) gl.enableVertexAttribArray(i); else gl.disableVertexAttribArray(i); }
  }

  resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(1, Math.floor(this.canvas.clientWidth * dpr)), h = Math.max(1, Math.floor(this.canvas.clientHeight * dpr));
    if (this.canvas.width !== w || this.canvas.height !== h) { this.canvas.width = w; this.canvas.height = h; }
  }

  markDirty(x, z) {
    const C = CONFIG.WORLD.CHUNK, cx = Math.floor(x / C), cz = Math.floor(z / C);
    const mark = (a, b) => { if (a >= 0 && b >= 0 && a < this.chunksX && b < this.chunksZ) this.chunks[b * this.chunksX + a].dirty = true; };
    mark(cx, cz);
    if (x % C === 0) mark(cx - 1, cz);                 // edits on a chunk border also change the neighbour's faces + AO
    if (x % C === C - 1) mark(cx + 1, cz);
    if (z % C === 0) mark(cx, cz - 1);
    if (z % C === C - 1) mark(cx, cz + 1);
    if (x % C === 0 && z % C === 0) mark(cx - 1, cz - 1);
    if (x % C === C - 1 && z % C === 0) mark(cx + 1, cz - 1);
    if (x % C === 0 && z % C === C - 1) mark(cx - 1, cz + 1);
    if (x % C === C - 1 && z % C === C - 1) mark(cx + 1, cz + 1);
  }

  rebuildChunk(cx, cz) {
    const gl = this.gl, chunk = this.chunks[cz * this.chunksX + cx];
    const mesh = buildChunkMesh(this.world, cx, cz);
    if (!chunk.buffer) chunk.buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
    gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.DYNAMIC_DRAW);
    chunk.count = mesh.vertexCount;
    chunk.dirty = false;
  }
  /** Rebuild up to `budget` dirty chunks (nearest-to-camera first would be a later optimisation). */
  rebuildDirty(budget = CONFIG.RENDER.REBUILD_BUDGET) {
    let n = 0;
    for (let i = 0; i < this.chunks.length && n < budget; i++) {
      if (this.chunks[i].dirty) { this.rebuildChunk(i % this.chunksX, Math.floor(i / this.chunksX)); n++; }
    }
    return n;
  }
  buildAll() { for (let i = 0; i < this.chunks.length; i++) this.rebuildChunk(i % this.chunksX, Math.floor(i / this.chunksX)); }

  drawSolid(buffer, count, mode, x, y, z, scale, color) {
    const gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 12, 0);
    gl.uniform3f(this.solidProg.u.uOffset, x, y, z);
    gl.uniform1f(this.solidProg.u.uScale, scale);
    gl.uniform4f(this.solidProg.u.uColor, color[0], color[1], color[2], color[3]);
    gl.drawArrays(mode, 0, count);
  }

  render(cam, target, miningProgress, particles) {
    const gl = this.gl, R = CONFIG.RENDER;
    this.resize();
    gl.viewport(0, 0, this.canvas.width, this.canvas.height);
    gl.clearColor(R.SKY[0], R.SKY[1], R.SKY[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);

    const proj = Mat4.perspective(cam.fov * Math.PI / 180, this.canvas.width / this.canvas.height, 0.05, 300);
    const view = Mat4.lookAt(cam.x, cam.y, cam.z, cam.x + cam.dir.x, cam.y + cam.dir.y, cam.z + cam.dir.z);
    const vp = Mat4.multiply(proj, view);

    // --- terrain ---
    const wp = this.worldProg;
    this.useProgram(wp);
    gl.uniformMatrix4fv(wp.u.uVP, false, vp);
    gl.uniform3f(wp.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform3f(wp.u.uFogColor, R.SKY[0], R.SKY[1], R.SKY[2]);
    gl.uniform1f(wp.u.uFogStart, R.FOG_START);
    gl.uniform1f(wp.u.uFogEnd, R.FOG_END);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.uniform1i(wp.u.uTex, 0);

    const C = CONFIG.WORLD.CHUNK, stride = VERTEX_FLOATS * 4;
    let drawn = 0, tris = 0;
    for (let i = 0; i < this.chunks.length; i++) {
      const chunk = this.chunks[i];
      if (!chunk.count) continue;
      // cheap cull: skip chunks wholly behind the camera
      const ccx = (i % this.chunksX) * C + C / 2 - cam.x, ccz = Math.floor(i / this.chunksX) * C + C / 2 - cam.z;
      if (ccx * cam.dir.x + ccz * cam.dir.z < -26 * Math.hypot(cam.dir.x, cam.dir.z) - 12 && Math.hypot(ccx, ccz) > 30) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, chunk.buffer);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0);
      gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
      gl.drawArrays(gl.TRIANGLES, 0, chunk.count);
      drawn++; tris += chunk.count / 3;
    }
    this.stats.drawnChunks = drawn; this.stats.triangles = tris;

    // --- particles, target outline, crack overlay ---
    const sp = this.solidProg;
    this.useProgram(sp);
    gl.uniformMatrix4fv(sp.u.uVP, false, vp);
    if (particles) {
      for (const p of particles.items) this.drawSolid(this.cubeTris, 36, gl.TRIANGLES, p.x, p.y, p.z, p.size, p.color);
    }
    if (target) {
      const cx = target.x + 0.5, cy = target.y + 0.5, cz = target.z + 0.5;
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      if (miningProgress > 0) {
        gl.depthMask(false);
        this.drawSolid(this.cubeTris, 36, gl.TRIANGLES, cx, cy, cz, 1.003, [0, 0, 0, 0.12 + 0.55 * miningProgress]);
        gl.depthMask(true);
      }
      this.drawSolid(this.cubeLines, 24, gl.LINES, cx, cy, cz, 1.004, [0, 0, 0, 0.95]);
      gl.disable(gl.BLEND);
    }
  }
}

/* ===================== 12. PARTICLES / AUDIO / INPUT / STORAGE ===================== */
class ParticleSystem {
  constructor(max = 320) { this.items = []; this.max = max; }
  burst(x, y, z, color, count, speed = 3.2, size = 0.14) {
    for (let i = 0; i < count; i++) {
      if (this.items.length >= this.max) this.items.shift();   // hard cap keeps explosions cheap
      const shade = 0.75 + Math.random() * 0.4;
      this.items.push({
        x: x + (Math.random() - 0.5) * 0.7, y: y + (Math.random() - 0.5) * 0.7, z: z + (Math.random() - 0.5) * 0.7,
        vx: (Math.random() - 0.5) * speed * 2, vy: Math.random() * speed + 1, vz: (Math.random() - 0.5) * speed * 2,
        life: 0.5 + Math.random() * 0.5, size: size * (0.6 + Math.random() * 0.7),
        color: [clamp(color[0] * shade, 0, 1), clamp(color[1] * shade, 0, 1), clamp(color[2] * shade, 0, 1), 1],
      });
    }
  }
  update(dt, world) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) { this.items[i] = this.items[this.items.length - 1]; this.items.pop(); continue; }
      p.vy -= 20 * dt;
      p.x += p.vx * dt; p.z += p.vz * dt;
      const ny = p.y + p.vy * dt;
      if (world.isSolid(Math.floor(p.x), Math.floor(ny - p.size / 2), Math.floor(p.z))) { p.vy = -p.vy * 0.25; p.vx *= 0.6; p.vz *= 0.6; }
      else p.y = ny;
    }
  }
}

/** Tiny WebAudio synth: every sound is generated, nothing is downloaded. */
class AudioEngine {
  constructor() { this.ctx = null; this.master = null; this.volume = 0.7; this.muted = false; }
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      try { this.ctx = new AC(); this.master = this.ctx.createGain(); this.master.connect(this.ctx.destination); this.apply(); } catch (e) { this.ctx = null; }
    }
    if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume();
  }
  apply() { if (this.master) this.master.gain.value = this.muted ? 0 : this.volume; }
  setVolume(v) { this.volume = v; this.apply(); }
  toggleMute() { this.muted = !this.muted; this.apply(); return this.muted; }

  noise(duration, type, freq, gain, q = 1) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, n = Math.floor(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.value = freq; filter.Q.value = q;
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter); filter.connect(g); g.connect(this.master); src.start(t);
  }
  tone(f0, f1, duration, gain, wave = 'square') {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime;
    const osc = ctx.createOscillator(); osc.type = wave;
    osc.frequency.setValueAtTime(f0, t); osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 1), t + duration);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    osc.connect(g); g.connect(this.master); osc.start(t); osc.stop(t + duration);
  }
  surface(sound) {
    switch (sound) {
      case 'stone': return ['lowpass', 1600, 1];
      case 'wood': return ['bandpass', 700, 2];
      case 'glass': return ['highpass', 3200, 1];
      default: return ['lowpass', 750, 1];
    }
  }
  play(name, block) {
    if (!this.ctx || this.muted) return;
    const [ft, ff, fq] = this.surface(block ? block.sound : 'soft');
    switch (name) {
      case 'break': this.noise(0.18, ft, ff, 0.55, fq); this.tone(140, 60, 0.12, 0.12, 'triangle'); break;
      case 'place': this.noise(0.07, ft, ff, 0.3, fq); this.tone(190, 110, 0.08, 0.14, 'triangle'); break;
      case 'step': this.noise(0.05, 'lowpass', 520, 0.14); break;
      case 'jump': this.tone(260, 430, 0.1, 0.07, 'sine'); break;
      case 'land': this.noise(0.12, 'lowpass', 340, 0.35); break;
      case 'click': this.tone(520, 420, 0.05, 0.08, 'square'); break;
    }
  }
}

class Input {
  constructor() {
    this.keys = new Set();
    this.mouse = { left: false, right: false };
    this.dx = 0; this.dy = 0; this.wheel = 0;
    this.locked = false;
    this.keyHandlers = [];
  }
  attach(canvas) {
    window.addEventListener('keydown', (e) => {
      if (this.locked && (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'F3')) e.preventDefault();
      if (e.code === 'F3') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      for (const fn of this.keyHandlers) fn(e);
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.code));
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    window.addEventListener('mousemove', (e) => { if (this.locked) { this.dx += e.movementX || 0; this.dy += e.movementY || 0; } });
    window.addEventListener('mousedown', (e) => { if (!this.locked) return; if (e.button === 0) this.mouse.left = true; if (e.button === 2) this.mouse.right = true; e.preventDefault(); });
    window.addEventListener('mouseup', (e) => { if (e.button === 0) this.mouse.left = false; if (e.button === 2) this.mouse.right = false; });
    window.addEventListener('wheel', (e) => { if (this.locked) { this.wheel += Math.sign(e.deltaY); e.preventDefault(); } }, { passive: false });
    window.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  releaseAll() { this.keys.clear(); this.mouse.left = this.mouse.right = false; this.dx = this.dy = this.wheel = 0; }
  controls() {
    const k = this.keys;
    return { forward: k.has('KeyW'), back: k.has('KeyS'), left: k.has('KeyA'), right: k.has('KeyD'), jump: k.has('Space'), crouch: k.has('ShiftLeft') || k.has('ShiftRight') };
  }
}

const Storage = {
  load(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? Object.assign({}, fallback, JSON.parse(raw)) : Object.assign({}, fallback); }
    catch (e) { return Object.assign({}, fallback); }
  },
  save(key, value) { try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* private mode etc. */ } },
};

/* ================================ 13. UI ================================ */
class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.el = {
      overlay: $('overlay'), hud: $('hud'), hotbar: $('hotbar'), debug: $('debug'),
      inventory: $('inventory'), invGrid: $('invGrid'), btnPlay: $('btnPlay'), title: $('title'),
      panels: { main: $('panelMain'), how: $('panelHow'), settings: $('panelSettings'), stats: $('panelStats') },
      statsTable: $('statsTable'), error: $('errorBox'), footer: $('footer'),
    };
    this.slotEls = [];
  }
  showPanel(name) { for (const [k, el] of Object.entries(this.el.panels)) el.classList.toggle('hidden', k !== name); }
  showOverlay(paused) {
    this.el.overlay.classList.remove('hidden');
    this.el.hud.classList.add('hidden');
    this.el.btnPlay.textContent = paused ? 'RESUME' : 'PLAY';
    this.showPanel('main');
  }
  hideOverlay() { this.el.overlay.classList.add('hidden'); this.el.hud.classList.remove('hidden'); }
  showError(msg) { this.el.error.textContent = msg; this.el.error.classList.remove('hidden'); this.el.btnPlay.disabled = true; }

  setAtlas(canvas) { document.documentElement.style.setProperty('--atlas', 'url(' + canvas.toDataURL() + ')'); }
  iconStyle(el, block) {
    const T = CONFIG.ATLAS.TILES, tile = block.tiles.side, S = 36;
    el.style.backgroundPosition = `${-(tile % T) * S}px ${-Math.floor(tile / T) * S}px`;
  }
  buildHotbar(inv, onSelect) {
    this.el.hotbar.innerHTML = ''; this.slotEls = [];
    for (let i = 0; i < inv.slots.length; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="key">${i + 1}</span><div class="icon"></div><span class="qty"></span>`;
      el.addEventListener('click', () => onSelect(i));
      this.el.hotbar.appendChild(el); this.slotEls.push(el);
    }
  }
  refreshHotbar(inv) {
    this.slotEls.forEach((el, i) => {
      const slot = inv.slots[i], icon = el.querySelector('.icon');
      icon.style.display = slot ? 'block' : 'none';
      if (slot) this.iconStyle(icon, BlockRegistry.byType(slot.item));
      el.querySelector('.qty').textContent = slot && isFinite(slot.quantity) ? slot.quantity : '';
      el.classList.toggle('selected', i === inv.selected);
    });
  }
  buildInventoryGrid(onPick) {
    this.el.invGrid.innerHTML = '';
    for (const block of BlockRegistry.placeable()) {
      const b = document.createElement('button');
      b.className = 'invItem';
      b.innerHTML = `<div class="icon"></div><span>${block.type}</span>`;
      this.iconStyle(b.querySelector('.icon'), block);
      b.addEventListener('click', () => onPick(block.type));
      this.el.invGrid.appendChild(b);
    }
  }
  setInventoryOpen(open) {
    this.el.inventory.classList.toggle('hidden', !open);
    document.body.classList.toggle('inv-open', open);
  }
  setDebugVisible(v) { this.el.debug.classList.toggle('hidden', !v); }
  setDebugText(t) { this.el.debug.textContent = t; }
  renderStats(stats) {
    const mins = Math.floor(stats.playSeconds / 60), secs = Math.floor(stats.playSeconds % 60);
    const rows = [['Blocks broken', stats.blocksBroken], ['Blocks placed', stats.blocksPlaced], ['Jumps', stats.jumps], ['Time played', `${mins}m ${String(secs).padStart(2, '0')}s`]];
    this.el.statsTable.innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  }
}

/* ============================== 14. GAME =============================== */
class Game {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.ui = new UI();
    this.audio = new AudioEngine();
    this.input = new Input();
    this.particles = new ParticleSystem();
    this.settings = Storage.load('mpw.settings', { sens: 1, fov: 75, vol: 0.7 });
    this.stats = Storage.load('mpw.stats', { blocksBroken: 0, blocksPlaced: 0, jumps: 0, playSeconds: 0 });
    this.state = 'menu';            // menu | playing | paused | inventory
    this.inventoryOpen = false;
    this.target = null; this.mining = null; this.placeCooldown = 0;
    this.accumulator = 0; this.lastTime = 0; this.fps = 0; this.fpsFrames = 0; this.fpsClock = 0;
    this.debugVisible = true;

    // World + server (authoritative) + local player
    this.world = new World();
    this.map = MapGenerator.generate(this.world, 'plains');
    this.server = new GameServer(this.world);
    this.player = new Player('p1', 'Player');
    this.respawn();
    this.server.addPlayer(this.player);
    this.server.subscribe((e) => this.onServerEvent(e));

    this.inventory = new Inventory(9);
    ['stone', 'wood', 'glass', 'sand', 'gravel', 'dirt', 'grass'].forEach((t, i) => this.inventory.setSlot(i, t));

    this.atlas = generateAtlas();
    this.ui.setAtlas(this.atlas);
    try {
      this.renderer = new Renderer(this.canvas, this.world, this.atlas);
      this.renderer.buildAll();
    } catch (err) {
      this.ui.showError(err.message + ' Try a recent version of Chrome, Edge or Firefox with hardware acceleration enabled.');
      this.renderer = null;
    }
    this.bindUI();
    this.input.attach(this.canvas);
    this.input.keyHandlers.push((e) => this.onKey(e));
    this.audio.setVolume(this.settings.vol);
    this.ui.setDebugVisible(this.debugVisible);
    this.ui.showOverlay(false);
    requestAnimationFrame((t) => { this.lastTime = t; this.frame(t); });
    window.addEventListener('beforeunload', () => Storage.save('mpw.stats', this.stats));
  }

  respawn() {
    const s = this.map.spawns[0];
    this.player.teleport(s.x, s.y, s.z);
    this.player.yaw = -Math.PI / 2;     // face the centre of the map (+X)
    this.player.pitch = -0.12;
  }

  /* ----- menu / pointer lock wiring ----- */
  bindUI() {
    const ui = this.ui;
    ui.buildHotbar(this.inventory, (i) => { this.inventory.select(i); ui.refreshHotbar(this.inventory); });
    ui.buildInventoryGrid((type) => { this.inventory.setSlot(this.inventory.selected, type); ui.refreshHotbar(this.inventory); this.audio.play('click'); });
    ui.refreshHotbar(this.inventory);

    document.getElementById('btnPlay').addEventListener('click', () => this.startPlay());
    document.getElementById('btnHow').addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); ui.showPanel('how'); });
    document.getElementById('btnSettings').addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); ui.showPanel('settings'); });
    document.getElementById('btnStats').addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); ui.renderStats(this.stats); ui.showPanel('stats'); });
    document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => { this.audio.play('click'); ui.showPanel('main'); Storage.save('mpw.settings', this.settings); }));
    document.getElementById('invClose').addEventListener('click', () => this.toggleInventory(false));

    const bindSlider = (id, outId, key, fmt, apply) => {
      const input = document.getElementById(id), out = document.getElementById(outId);
      input.value = this.settings[key]; out.textContent = fmt(this.settings[key]);
      input.addEventListener('input', () => { this.settings[key] = parseFloat(input.value); out.textContent = fmt(this.settings[key]); if (apply) apply(this.settings[key]); });
    };
    bindSlider('setSens', 'outSens', 'sens', (v) => v.toFixed(2) + 'x');
    bindSlider('setFov', 'outFov', 'fov', (v) => Math.round(v) + '°');
    bindSlider('setVol', 'outVol', 'vol', (v) => Math.round(v * 100) + '%', (v) => this.audio.setVolume(v));

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      this.input.locked = locked;
      if (locked) { this.state = 'playing'; ui.hideOverlay(); ui.setInventoryOpen(false); this.inventoryOpen = false; this.lastTime = performance.now(); this.accumulator = 0; }
      else {
        this.input.releaseAll();
        Storage.save('mpw.stats', this.stats);
        if (this.inventoryOpen) { this.state = 'inventory'; ui.setInventoryOpen(true); }
        else if (this.state === 'playing') { this.state = 'paused'; ui.showOverlay(true); }
      }
    });
    document.addEventListener('pointerlockerror', () => { if (this.state !== 'playing') ui.showOverlay(this.state === 'paused'); });
    window.addEventListener('resize', () => this.renderer && this.renderer.resize());
    this.canvas.addEventListener('click', () => { if (this.state === 'paused' && !this.inventoryOpen) this.startPlay(); });
  }

  startPlay() {
    this.audio.unlock(); this.audio.play('click');
    Storage.save('mpw.settings', this.settings);
    try { const p = this.canvas.requestPointerLock(); if (p && p.catch) p.catch(() => {}); } catch (e) { /* handled by pointerlockerror */ }
  }

  toggleInventory(open = !this.inventoryOpen) {
    if (open === this.inventoryOpen) return;
    this.inventoryOpen = open;
    if (open) { this.state = 'inventory'; this.ui.setInventoryOpen(true); document.exitPointerLock(); }
    else { this.ui.setInventoryOpen(false); this.startPlay(); }
  }

  onKey(e) {
    if (e.code === 'Escape' && this.inventoryOpen) { this.inventoryOpen = false; this.state = 'paused'; this.ui.setInventoryOpen(false); this.ui.showOverlay(true); return; }
    if (e.code === 'KeyE' && (this.state === 'playing' || this.state === 'inventory')) { this.toggleInventory(); return; }
    if (this.state !== 'playing') return;
    if (e.code.startsWith('Digit')) {
      const n = parseInt(e.code.slice(5), 10);
      if (n >= 1 && n <= 9) { this.inventory.select(n - 1); this.ui.refreshHotbar(this.inventory); }
    } else if (e.code === 'KeyR') this.respawn();
    else if (e.code === 'KeyM') this.audio.toggleMute();
    else if (e.code === 'F3') { this.debugVisible = !this.debugVisible; this.ui.setDebugVisible(this.debugVisible); }
  }

  /* ----- server events (what the world tells clients happened) ----- */
  onServerEvent(e) {
    const cx = e.x + 0.5, cy = e.y + 0.5, cz = e.z + 0.5;
    if (e.type === 'blockBroken') {
      this.particles.burst(cx, cy, cz, e.block.color, 16);
      this.audio.play('break', e.block);
      if (e.by === this.player.id) this.stats.blocksBroken++;
    } else if (e.type === 'blockPlaced') {
      this.particles.burst(cx, cy, cz, e.block.color, 5, 1.6, 0.09);
      this.audio.play('place', e.block);
      if (e.by === this.player.id) { this.stats.blocksPlaced++; }
    }
  }

  /* ----- one fixed physics + gameplay step ----- */
  tick(dt) {
    const p = this.player;
    p.update(dt, this.input.controls(), this.world);
    this.server.players.get(p.id).pos = p.pos;            // TODO(multiplayer): server simulates input instead of trusting this

    if (p.jumped) { this.audio.play('jump'); this.stats.jumps++; }
    if (p.impactSpeed > 9) this.audio.play('land');
    if (p.stepDistance > (p.crouching ? 1.6 : 2.3)) { p.stepDistance = 0; this.audio.play('step'); }
    this.stats.playSeconds += dt;

    this.updateInteraction(dt);
  }

  updateInteraction(dt) {
    const p = this.player, world = this.world;
    this.target = world.raycast(p.eyePosition(), p.lookDirection(), CONFIG.PLAYER.REACH);

    // Hold left mouse to break: progress fills based on block hardness.
    if (this.input.mouse.left && this.target) {
      const t = this.target, key = `${t.x},${t.y},${t.z}`;
      if (!this.mining || this.mining.key !== key) this.mining = { key, progress: 0 };
      const def = BlockRegistry.byId(world.get(t.x, t.y, t.z));
      if (def.breakable) {
        const time = Math.max(CONFIG.MINE.MIN_TIME, def.hardness * CONFIG.MINE.TIME_PER_HARDNESS);
        this.mining.progress += dt / time;
        if (this.mining.progress >= 1) { this.server.handle(p.id, { type: 'break', x: t.x, y: t.y, z: t.z }); this.mining = null; }
      }
    } else this.mining = null;

    // Right mouse to place (hold to repeat).
    this.placeCooldown -= dt;
    if (this.input.mouse.right && this.placeCooldown <= 0 && this.target) {
      const t = this.target, slot = this.inventory.selectedSlot;
      if (slot && (t.nx || t.ny || t.nz)) {
        const res = this.server.handle(p.id, { type: 'place', x: t.x + t.nx, y: t.y + t.ny, z: t.z + t.nz, block: slot.item });
        if (res.ok) this.inventory.consume(this.inventory.selected);
        this.ui.refreshHotbar(this.inventory);
        this.placeCooldown = CONFIG.MINE.PLACE_COOLDOWN;
      }
    }
  }

  /* ----- per-frame ----- */
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now;
    const p = this.player;

    if (this.state === 'playing') {
      // Mouse look runs every frame (not in the fixed step) so it feels immediate.
      const sens = CONFIG.MOUSE_SENS * this.settings.sens;
      p.yaw -= this.input.dx * sens;
      p.pitch = clamp(p.pitch - this.input.dy * sens, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      this.input.dx = this.input.dy = 0;
      if (this.input.wheel) { this.inventory.select(this.inventory.selected + this.input.wheel); this.input.wheel = 0; this.ui.refreshHotbar(this.inventory); }

      this.accumulator += dt;
      while (this.accumulator >= CONFIG.STEP) { this.tick(CONFIG.STEP); this.accumulator -= CONFIG.STEP; }
      this.particles.update(dt, this.world);
    }

    if (this.renderer) {
      this.renderer.rebuildDirty();
      const alpha = this.state === 'playing' ? this.accumulator / CONFIG.STEP : 1;
      const eye = p.eyePosition(alpha), dir = p.lookDirection();
      const prog = this.mining ? clamp(this.mining.progress, 0, 1) : 0;
      this.renderer.render({ x: eye.x, y: eye.y, z: eye.z, dir, fov: this.settings.fov }, this.target, prog, this.particles);
    }

    this.fpsFrames++; this.fpsClock += dt;
    if (this.fpsClock >= 0.5) {
      this.fps = Math.round(this.fpsFrames / this.fpsClock); this.fpsFrames = 0; this.fpsClock = 0;
      if (this.debugVisible && this.state === 'playing') this.updateDebug();
    }
  }

  updateDebug() {
    const p = this.player, t = this.target;
    const tgt = t ? `${BlockRegistry.byId(this.world.get(t.x, t.y, t.z)).type} (${t.x}, ${t.y}, ${t.z})` : 'none';
    const r = this.renderer ? this.renderer.stats : { drawnChunks: 0, triangles: 0 };
    this.ui.setDebugText(
      `FPS ${this.fps}\nXYZ ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(1)}\n` +
      `Speed ${Math.hypot(p.vel.x, p.vel.z).toFixed(1)}  ${p.onGround ? 'grounded' : 'airborne'}\n` +
      `Looking at ${tgt}\nChunks ${r.drawnChunks}/${this.renderer ? this.renderer.chunks.length : 0}  Tris ${Math.round(r.triangles)}`);
  }
}

/* ============================== EXPORTS / BOOT ============================== */
const api = { CONFIG, BlockRegistry, TILE, World, MapGenerator, buildChunkMesh, Player, Inventory, GameServer, Mat4, AIR, B, VERTEX_FLOATS };
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;                     // lets tests/logic.test.js run the game logic in Node
} else {
  root.PhysicsWars = api;
  const boot = () => { root.game = new Game(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}

})(typeof window !== 'undefined' ? window : globalThis);
