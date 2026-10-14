/* ============================================================================
   MINECRAFT PHYSICS WARS  -  Version 0.9  (physics war expansion)

   Plain WebGL, no dependencies. Load with <script src="game.js"></script>.

   Sections (search for the banner names):
     1. CONFIG               tuning constants
     2. BLOCK REGISTRY       every block's properties in one place
     3. UTILS / MATH         noise, mat4 helpers
     4. WORLD                voxel storage (blocks + metadata + owner), raycast
     5. TEXTURES             procedural pixel-art atlas (all original)
     6. MESHER               chunk geometry: cubes, shaped blocks, fluids
     7. BODIES               player / mob physics (AABB vs voxels, fluids)
     8. SYSTEMS              fluids, fire, structural collapse, falling groups, redstone
     9. DATA                 items, resources, classes, land types
    10. MAP GENERATOR        terrain, plots, land features, vault
    11. GAME SERVER          authoritative rules, match phases, events, scoring
    12. BOTS                 simple AI players
    13. RENDERER             WebGL chunks, entities, replay scene
    14. PARTICLES / AUDIO / INPUT / STORAGE
    15. UI                   menus, HUD, lobby, panels
    16. GAME                 client controller that wires everything together

   Architecture note: the client NEVER edits the world directly. It sends
   requests ({type:'break'|'place'|'attack'|...}) to GameServer.handle(), which
   validates them, mutates the World and emits events. The server also simulates
   all movement and physics. Today the "server" runs in the same page; later it
   can move behind a WebSocket without touching gameplay code.
   ============================================================================ */
(function (root) {
'use strict';

/* ============================== 1. CONFIG ============================== */
const QUERY = (typeof location !== 'undefined' && location.search) ? new URLSearchParams(location.search) : null;
const TIME_SPEED = QUERY ? (parseFloat(QUERY.get('speed')) || 1) : 1;   // ?speed=10 makes match timers 10x shorter (testing)

const CONFIG = {
  VERSION: '0.9',
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
  HEALTH: { MAX: 100, REGEN_DELAY: 8, REGEN_RATE: 1.2, FALL_SAFE: 13, FALL_DMG: 4.5 },
  PLOT_RADIUS: 18,
  MATCH: {
    COUNTDOWN: 3, BUILD: 180 / TIME_SPEED, WAR: 420 / TIME_SPEED, CHAOS: 120 / TIME_SPEED,
    SANDBOX_RESPAWN: 2, SPEED: TIME_SPEED,
  },
  RENDER: { FOG_START: 50, FOG_END: 140, SKY: [0.55, 0.78, 0.95], REBUILD_BUDGET: 4 },
  ATLAS: { TILES: 8, TILE_PX: 16 },
  COLORS: ['#ff5a36', '#3fa7ff', '#7be05a', '#ffd23f', '#c77dff', '#ff8fab'],
};

/* ========================== 2. BLOCK REGISTRY ========================== */
// Direction table. Index order matters: [+x, -x, +y, -y, +z, -z]; (index ^ 1) is the opposite direction.
const DIRS6 = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
const faceIndex = (axis, sign) => axis * 2 + (sign > 0 ? 0 : 1);

const TILE_NAMES = ['grass_top', 'grass_side', 'dirt', 'stone', 'wood', 'glass', 'sand', 'gravel', 'bedrock',
  'tnt_side', 'tnt_top', 'water', 'lava', 'leaves', 'iron_ore', 'iron_block', 'obsidian', 'fire',
  'wire_off', 'wire_on', 'plate_off', 'plate_on', 'lever_off', 'lever_on', 'button', 'tripwire',
  'piston_side', 'piston_front', 'piston_back', 'piston_head', 'door', 'timer', 'sensor', 'alarm',
  'vault', 'log_side', 'log_top', 'vault_top', 'icon_pickaxe', 'icon_sword', 'icon_axe', 'icon_bow', 'icon_staff', 'icon_lighter'];
const TILE = {};
TILE_NAMES.forEach((n, i) => { TILE[n.toUpperCase()] = i; });

/*
 * Metadata (world.meta, 16 bits per cell) conventions:
 *   fluids      : bits0-3 level, bit4 (16) = permanent source
 *   wire        : bit0 powered
 *   plate/button/lever/tripwire/sensor : bit0 active output
 *   piston      : bit0 extended, bit1 powered, bits2-4 facing (DIRS6 index)
 *   piston_head : bits2-4 facing
 *   door        : bit0 open, bit1 powered, bits8-15 disguise block id (0 = plain door)
 *   timer       : bit0 pulse output, bit1 powered
 *   alarm       : bit1 powered
 *   fire        : age
 */
const BlockRegistry = (() => {
  const list = [];
  const byType = {};
  function define(def) {
    const block = Object.assign({
      hardness: 1, blastResistance: 1, weight: 1,
      gravityAffected: false, flammable: false, burnChance: 0, transparent: false,
      solid: true, breakable: true, placeable: true, targetable: true, replaceable: false,
      shape: 'cube', cullSame: false, sound: 'soft', color: [0.5, 0.5, 0.5],
      tiles: { top: 0, side: 0, bottom: 0 }, tileFn: null, boxes: null, solidFn: null,
      mech: null, needsFloor: false, drop: null, pushable: true, fluid: null,
    }, def, { id: list.length });
    block.opaque = block.shape === 'cube' && !block.transparent;
    list.push(block);
    byType[block.type] = block;
    return block;
  }
  const all = (t) => ({ top: t, side: t, bottom: t });

  // ids 0-8 are kept from v0.1
  define({ type: 'air', solid: false, transparent: true, breakable: false, placeable: false, targetable: false, replaceable: true, hardness: 0, blastResistance: 0, weight: 0, tiles: null });
  define({ type: 'grass', hardness: 1, blastResistance: 1.5, weight: 3, color: [0.38, 0.66, 0.27], tiles: { top: TILE.GRASS_TOP, side: TILE.GRASS_SIDE, bottom: TILE.DIRT }, drop: ['earth', 1] });
  define({ type: 'dirt', hardness: 1, blastResistance: 1.5, weight: 3, color: [0.52, 0.38, 0.26], tiles: all(TILE.DIRT), drop: ['earth', 1] });
  define({ type: 'stone', hardness: 5, blastResistance: 8, weight: 5, sound: 'stone', color: [0.49, 0.49, 0.51], tiles: all(TILE.STONE), drop: ['stone', 1] });
  define({ type: 'wood', hardness: 2.5, blastResistance: 3, weight: 3, sound: 'wood', color: [0.69, 0.54, 0.33], flammable: true, burnChance: 0.12, tiles: all(TILE.WOOD), drop: ['wood', 1] });
  define({ type: 'glass', hardness: 0.3, blastResistance: 0.3, weight: 1, sound: 'glass', color: [0.78, 0.92, 1.0], transparent: true, cullSame: true, tiles: all(TILE.GLASS), drop: ['glass', 1, 0.5] });
  define({ type: 'sand', hardness: 0.8, blastResistance: 1, weight: 3, color: [0.86, 0.80, 0.59], gravityAffected: true, tiles: all(TILE.SAND), drop: ['earth', 1] });
  define({ type: 'gravel', hardness: 1, blastResistance: 1.5, weight: 3.5, sound: 'stone', color: [0.52, 0.5, 0.5], gravityAffected: true, tiles: all(TILE.GRAVEL), drop: ['earth', 1] });
  define({ type: 'bedrock', hardness: Infinity, blastResistance: Infinity, weight: 99, sound: 'stone', color: [0.2, 0.2, 0.22], breakable: false, placeable: false, pushable: false, tiles: all(TILE.BEDROCK) });
  // --- new in the physics war expansion ---
  define({ type: 'tnt', hardness: 0.1, blastResistance: 0.1, weight: 3, sound: 'wood', color: [0.85, 0.2, 0.15], gravityAffected: true, flammable: true, burnChance: 1, mech: 'consumer', tiles: { top: TILE.TNT_TOP, side: TILE.TNT_SIDE, bottom: TILE.TNT_TOP }, drop: ['tnt', 1] });
  define({ type: 'water', shape: 'fluid', solid: false, transparent: true, breakable: false, placeable: false, targetable: false, replaceable: true, hardness: 0, blastResistance: 100, pushable: false, color: [0.2, 0.4, 0.9], fluid: { maxLevel: 8, alpha: 0.62 }, tiles: all(TILE.WATER) });
  define({ type: 'lava', shape: 'fluid', solid: false, transparent: true, breakable: false, placeable: false, targetable: false, replaceable: true, hardness: 0, blastResistance: 100, pushable: false, color: [1, 0.45, 0.1], fluid: { maxLevel: 4, alpha: 0.96 }, tiles: all(TILE.LAVA) });
  define({ type: 'leaves', hardness: 0.2, blastResistance: 0.2, weight: 0.5, color: [0.25, 0.55, 0.2], transparent: true, cullSame: true, flammable: true, burnChance: 0.3, placeable: false, tiles: all(TILE.LEAVES), drop: ['wood', 1, 0.3] });
  define({ type: 'log', hardness: 2.2, blastResistance: 3, weight: 3.5, sound: 'wood', color: [0.45, 0.33, 0.2], flammable: true, burnChance: 0.07, placeable: false, tiles: { top: TILE.LOG_TOP, side: TILE.LOG_SIDE, bottom: TILE.LOG_TOP }, drop: ['wood', 2] });
  define({ type: 'iron_ore', hardness: 4, blastResistance: 6, weight: 5, sound: 'stone', color: [0.6, 0.5, 0.45], placeable: false, tiles: all(TILE.IRON_ORE), drop: ['iron', 1] });
  define({ type: 'iron_block', hardness: 6, blastResistance: 12, weight: 8, sound: 'stone', color: [0.8, 0.8, 0.84], tiles: all(TILE.IRON_BLOCK), drop: ['iron', 1] });
  define({ type: 'obsidian', hardness: 12, blastResistance: 40, weight: 6, sound: 'stone', color: [0.12, 0.08, 0.2], placeable: false, tiles: all(TILE.OBSIDIAN) });
  define({ type: 'fire', shape: 'box', solid: false, transparent: true, hardness: 0, blastResistance: 0, weight: 0, targetable: true, replaceable: true, pushable: false, placeable: false, color: [1, 0.55, 0.1], tiles: all(TILE.FIRE), boxes: () => [[0.06, 0, 0.06, 0.94, 0.9, 0.94]] });
  define({ type: 'wire', shape: 'box', solid: false, transparent: true, hardness: 0.1, blastResistance: 0.1, weight: 0.2, mech: 'conductor', needsFloor: true, color: [0.8, 0.2, 0.2], tileFn: (m) => ((m & 1) ? TILE.WIRE_ON : TILE.WIRE_OFF), tiles: all(TILE.WIRE_OFF), boxes: () => [[0, 0, 0, 1, 0.08, 1]], drop: ['mech', 1, 0.8] });
  define({ type: 'plate', shape: 'box', solid: false, transparent: true, hardness: 0.1, blastResistance: 0.1, weight: 0.3, mech: 'source', needsFloor: true, color: [0.6, 0.6, 0.6], tileFn: (m) => ((m & 1) ? TILE.PLATE_ON : TILE.PLATE_OFF), tiles: all(TILE.PLATE_OFF), boxes: (m) => [[0.06, 0, 0.06, 0.94, (m & 1) ? 0.03 : 0.07, 0.94]], drop: ['mech', 1, 0.8] });
  define({ type: 'lever', shape: 'box', solid: false, transparent: true, hardness: 0.2, blastResistance: 0.2, weight: 0.3, mech: 'source', needsFloor: true, color: [0.55, 0.45, 0.3], tileFn: (m) => ((m & 1) ? TILE.LEVER_ON : TILE.LEVER_OFF), tiles: all(TILE.LEVER_OFF), boxes: () => [[0.3, 0, 0.3, 0.7, 0.55, 0.7]], drop: ['mech', 1, 0.8] });
  define({ type: 'button', shape: 'box', solid: false, transparent: true, hardness: 0.2, blastResistance: 0.2, weight: 0.3, mech: 'source', needsFloor: true, color: [0.5, 0.5, 0.55], tiles: all(TILE.BUTTON), boxes: (m) => [[0.3, 0, 0.3, 0.7, (m & 1) ? 0.1 : 0.2, 0.7]], drop: ['mech', 1, 0.8] });
  define({ type: 'tripwire', shape: 'box', solid: false, transparent: true, hardness: 0.05, blastResistance: 0.05, weight: 0.1, mech: 'source', needsFloor: true, color: [0.8, 0.8, 0.8], tiles: all(TILE.TRIPWIRE), boxes: () => [[0, 0.1, 0, 1, 0.14, 1]], drop: ['mech', 1, 0.8] });
  define({
    type: 'piston', hardness: 3, blastResistance: 6, weight: 4, sound: 'stone', color: [0.55, 0.5, 0.45], mech: 'consumer', pushable: false,
    tileFn: (m, a, s) => { const f = (m >> 2) & 7, i = faceIndex(a, s); return i === f ? TILE.PISTON_FRONT : i === (f ^ 1) ? TILE.PISTON_BACK : TILE.PISTON_SIDE; },
    tiles: all(TILE.PISTON_SIDE), drop: ['mech', 2, 0.8],
  });
  define({
    type: 'piston_head', shape: 'box', solid: true, transparent: true, hardness: 3, blastResistance: 6, weight: 1, pushable: false, placeable: false, color: [0.6, 0.45, 0.3], tiles: all(TILE.PISTON_HEAD),
    boxes: (m) => {
      const f = (m >> 2) & 7, a = f >> 1, pos = !(f & 1), plate = [0, 0, 0, 1, 1, 1], rod = [0.375, 0.375, 0.375, 0.625, 0.625, 0.625];
      plate[a] = pos ? 0.75 : 0; plate[a + 3] = pos ? 1 : 0.25;
      rod[a] = pos ? 0 : 0.25; rod[a + 3] = pos ? 0.75 : 1;
      return [plate, rod];
    },
  });
  define({
    type: 'door', hardness: 2, blastResistance: 4, weight: 3, sound: 'wood', color: [0.6, 0.45, 0.28], flammable: true, burnChance: 0.1, mech: 'consumer', pushable: true,
    solidFn: (m) => !(m & 1),
    tileFn: (m, a, s) => { const d = m >> 8; if (d) { const bd = list[d]; return a === 1 ? (s > 0 ? bd.tiles.top : bd.tiles.bottom) : bd.tiles.side; } return TILE.DOOR; },
    tiles: all(TILE.DOOR), drop: ['wood', 2],
  });
  define({ type: 'timer', hardness: 1.5, blastResistance: 3, weight: 2, sound: 'stone', color: [0.4, 0.6, 0.8], mech: 'consumer', tiles: all(TILE.TIMER), drop: ['mech', 2, 0.8] });
  define({ type: 'sensor', hardness: 1.5, blastResistance: 3, weight: 2, sound: 'stone', color: [0.3, 0.8, 0.7], mech: 'source', tiles: all(TILE.SENSOR), drop: ['mech', 2, 0.8] });
  define({ type: 'alarm', hardness: 1.5, blastResistance: 3, weight: 2, sound: 'stone', color: [0.9, 0.3, 0.3], mech: 'consumer', tiles: all(TILE.ALARM), drop: ['mech', 1, 0.8] });
  define({ type: 'vault', hardness: Infinity, blastResistance: Infinity, weight: 20, sound: 'stone', color: [1, 0.8, 0.2], breakable: false, placeable: false, pushable: false, tiles: { top: TILE.VAULT_TOP, side: TILE.VAULT, bottom: TILE.VAULT } });

  return {
    list,
    byType: (t) => byType[t],
    byId: (id) => list[id],
    placeable: () => list.filter((b) => b.placeable),
  };
})();
const BLOCKS = BlockRegistry.list;
const ID = {};
BLOCKS.forEach((b) => { ID[b.type] = b.id; });
const AIR = 0;
const B = (type) => BlockRegistry.byType(type).id;

/* ========================== 3. UTILS / MATH ============================ */
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const approach = (v, target, maxDelta) => (v < target ? Math.min(v + maxDelta, target) : Math.max(v - maxDelta, target));
const dist3 = (ax, ay, az, bx, by, bz) => Math.hypot(ax - bx, ay - by, az - bz);
const keyOf = (x, y, z) => x + ',' + y + ',' + z;
const unkey = (k) => k.split(',').map(Number);

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
  identity() { return new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]); },
  perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2), nf = 1 / (near - far);
    return new Float32Array([f / aspect, 0, 0, 0, 0, f, 0, 0, 0, 0, (far + near) * nf, -1, 0, 0, 2 * far * near * nf, 0]);
  },
  lookAt(ex, ey, ez, cx, cy, cz) {
    let zx = ex - cx, zy = ey - cy, zz = ez - cz;
    let l = Math.hypot(zx, zy, zz) || 1; zx /= l; zy /= l; zz /= l;
    let xx = zz, xy = 0, xz = -zx;                              // x = up(0,1,0) x z
    l = Math.hypot(xx, xy, xz) || 1; xx /= l; xy /= l; xz /= l;
    const yx = zy * xz - zz * xy, yy = zz * xx - zx * xz, yz = zx * xy - zy * xx;
    return new Float32Array([
      xx, yx, zx, 0, xy, yy, zy, 0, xz, yz, zz, 0,
      -(xx * ex + xy * ey + xz * ez), -(yx * ex + yy * ey + yz * ez), -(zx * ex + zy * ey + zz * ez), 1,
    ]);
  },
  multiply(a, b) {
    const out = new Float32Array(16);
    for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) {
      let s = 0;
      for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k];
      out[c * 4 + r] = s;
    }
    return out;
  },
  translation(x, y, z) { const m = Mat4.identity(); m[12] = x; m[13] = y; m[14] = z; return m; },
  scaling(x, y, z) { const m = Mat4.identity(); m[0] = x; m[5] = y; m[10] = z; return m; },
  rotationY(a) { const c = Math.cos(a), s = Math.sin(a), m = Mat4.identity(); m[0] = c; m[2] = -s; m[8] = s; m[10] = c; return m; },
  rotationX(a) { const c = Math.cos(a), s = Math.sin(a), m = Mat4.identity(); m[5] = c; m[6] = s; m[9] = -s; m[10] = c; return m; },
  rotationZ(a) { const c = Math.cos(a), s = Math.sin(a), m = Mat4.identity(); m[0] = c; m[1] = s; m[4] = -s; m[5] = c; return m; },
  /** Chain multiply: Mat4.chain(a, b, c) = a * b * c */
  chain(...ms) { return ms.reduce((acc, m) => Mat4.multiply(acc, m)); },
  /** Projects a world point; returns {x,y,w} in NDC (x,y in -1..1) or null when behind the camera. */
  project(vp, x, y, z) {
    const cx = vp[0] * x + vp[4] * y + vp[8] * z + vp[12];
    const cy = vp[1] * x + vp[5] * y + vp[9] * z + vp[13];
    const cw = vp[3] * x + vp[7] * y + vp[11] * z + vp[15];
    if (cw <= 0.05) return null;
    return { x: cx / cw, y: cy / cw, w: cw };
  },
};

/* ============================== 4. WORLD =============================== */
class World {
  constructor(sx = CONFIG.WORLD.SIZE_X, sy = CONFIG.WORLD.SIZE_Y, sz = CONFIG.WORLD.SIZE_Z) {
    this.sizeX = sx; this.sizeY = sy; this.sizeZ = sz;
    this.blocks = new Uint8Array(sx * sy * sz);
    this.meta = new Uint16Array(sx * sy * sz);       // see metadata conventions above
    this.owner = new Uint8Array(sx * sy * sz);       // 0 = natural, n = placed by player slot n-1
    this.listeners = [];                              // (x, y, z, oldId, newId, oldMeta, oldOwner) => void
  }
  index(x, y, z) { return x + z * this.sizeX + y * this.sizeX * this.sizeZ; }
  inBounds(x, y, z) { return x >= 0 && x < this.sizeX && y >= 0 && y < this.sizeY && z >= 0 && z < this.sizeZ; }
  get(x, y, z) { return this.inBounds(x, y, z) ? this.blocks[this.index(x, y, z)] : AIR; }
  getMeta(x, y, z) { return this.inBounds(x, y, z) ? this.meta[this.index(x, y, z)] : 0; }
  getOwner(x, y, z) { return this.inBounds(x, y, z) ? this.owner[this.index(x, y, z)] : 0; }
  def(x, y, z) { return BLOCKS[this.get(x, y, z)]; }
  /** Collision solidity. Side walls and the floor are solid; open sky above is not. */
  isSolid(x, y, z) {
    if (y >= this.sizeY) return false;
    if (x < 0 || x >= this.sizeX || z < 0 || z >= this.sizeZ || y < 0) return true;
    const i = this.index(x, y, z), d = BLOCKS[this.blocks[i]];
    return d.solidFn ? d.solidFn(this.meta[i]) : d.solid;
  }
  /** Sets a block (and resets its metadata/owner unless given). Fires listeners unless silent. */
  set(x, y, z, id, silent = false, meta = 0, owner = 0) {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z), old = this.blocks[i], oldMeta = this.meta[i], oldOwner = this.owner[i];
    if (old === id && oldMeta === meta && oldOwner === owner) return false;
    this.blocks[i] = id; this.meta[i] = meta; this.owner[i] = owner;
    if (!silent) for (const fn of this.listeners) fn(x, y, z, old, id, oldMeta, oldOwner);
    return true;
  }
  /** Changes only the metadata (state bits). Still notifies listeners so meshes refresh. */
  setMeta(x, y, z, meta, silent = false) {
    if (!this.inBounds(x, y, z)) return false;
    const i = this.index(x, y, z);
    if (this.meta[i] === meta) return false;
    const oldMeta = this.meta[i];
    this.meta[i] = meta;
    if (!silent) for (const fn of this.listeners) fn(x, y, z, this.blocks[i], this.blocks[i], oldMeta, this.owner[i]);
    return true;
  }
  /** Y of the highest non-air block in a column, or -1. */
  getHeight(x, z) {
    for (let y = this.sizeY - 1; y >= 0; y--) if (this.blocks[this.index(x, y, z)] !== AIR) return y;
    return -1;
  }
  /** Highest solid (collidable) block in a column, or -1. */
  getSolidHeight(x, z) {
    for (let y = this.sizeY - 1; y >= 0; y--) if (this.isSolid(x, y, z)) return y;
    return -1;
  }
  clone() {
    const w = new World(this.sizeX, this.sizeY, this.sizeZ);
    w.blocks.set(this.blocks); w.meta.set(this.meta); w.owner.set(this.owner);
    return w;
  }
  clear() { this.blocks.fill(0); this.meta.fill(0); this.owner.fill(0); }
  /**
   * Voxel raycast (Amanatides & Woo DDA). `o` and `d` are {x,y,z}; d must be normalised.
   * Returns {x,y,z, nx,ny,nz, dist} for the first targetable block hit (n* = face normal) or null.
   */
  raycast(o, d, maxDist, includeFluids = false) {
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
      if (this.inBounds(x, y, z)) {
        const id = this.blocks[this.index(x, y, z)];
        if (id !== AIR && (BLOCKS[id].targetable || (includeFluids && BLOCKS[id].shape === 'fluid'))) return { x, y, z, nx, ny, nz, dist: t };
      }
      if (tx < ty && tx < tz) { x += sx; t = tx; tx += tdx; nx = -sx; ny = 0; nz = 0; }
      else if (ty < tz)        { y += sy; t = ty; ty += tdy; nx = 0; ny = -sy; nz = 0; }
      else                     { z += sz; t = tz; tz += tdz; nx = 0; ny = 0; nz = -sz; }
      if (t > maxDist) break;
    }
    return null;
  }
  /** True when the straight segment between two points crosses a solid block. */
  lineBlocked(ax, ay, az, bx, by, bz) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return false;
    const steps = Math.ceil(len / 0.5);
    for (let i = 1; i < steps; i++) {
      const t = i / steps;
      if (this.isSolid(Math.floor(ax + dx * t), Math.floor(ay + dy * t), Math.floor(az + dz * t))) return true;
    }
    return false;
  }
}

/* ============================ 5. TEXTURES ============================== */
/** Procedural 16x16 pixel-art tiles packed in an 8x8 atlas. Everything here is original. */
function generateAtlas() {
  const { TILES, TILE_PX } = CONFIG.ATLAS;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = TILES * TILE_PX;
  const ctx = canvas.getContext('2d');

  /** Paints one tile. fn(x, y, rng, put) returns [r,g,b,(a)] or undefined (leave transparent). */
  function paint(tile, seed, fn) {
    const rng = mulberry32(seed);
    const img = ctx.createImageData(TILE_PX, TILE_PX);
    for (let y = 0; y < TILE_PX; y++) for (let x = 0; x < TILE_PX; x++) {
      const c = fn(x, y, rng);
      const i = (y * TILE_PX + x) * 4;
      if (c) { img.data[i] = clamp(c[0], 0, 255); img.data[i + 1] = clamp(c[1], 0, 255); img.data[i + 2] = clamp(c[2], 0, 255); img.data[i + 3] = c.length > 3 ? c[3] : 255; }
    }
    ctx.putImageData(img, (tile % TILES) * TILE_PX, Math.floor(tile / TILES) * TILE_PX);
  }
  const jit = (rng, v) => (rng() - 0.5) * v;
  const noisy = (rng, r, g, b, v) => { const n = jit(rng, v); return [r + n, g + n, b + n]; };
  const dirt = (rng) => (rng() < 0.07 ? [96, 66, 44] : noisy(rng, 134, 96, 67, 28));
  const edge = (x, y) => x === 0 || y === 0 || x === 15 || y === 15;
  const GLYPH = { T: ['111', '010', '010', '010', '010'], N: ['101', '111', '111', '101', '101'] };

  paint(TILE.GRASS_TOP, 11, (x, y, r) => noisy(r, 98, 172, 70, 34));
  paint(TILE.GRASS_SIDE, 12, (() => { const depth = []; const r0 = mulberry32(99); for (let x = 0; x < 16; x++) depth.push(3 + (r0() < 0.45 ? 1 : 0) + (r0() < 0.2 ? 1 : 0)); return (x, y, r) => (y < depth[x] ? noisy(r, 98, 172, 70, 34) : dirt(r)); })());
  paint(TILE.DIRT, 13, (x, y, r) => dirt(r));
  paint(TILE.STONE, 14, (x, y, r) => (r() < 0.09 ? [96, 96, 102] : noisy(r, 126, 126, 132, 22)));
  paint(TILE.WOOD, 15, (x, y, r) => {
    const seam = y % 4 === 3, joint = ((y >> 2) % 2 === 0 ? x === 5 : x === 12);
    return seam || joint ? [128, 94, 52] : noisy(r, 182, 142, 86, 14);
  });
  paint(TILE.GLASS, 16, (x, y) => {
    const glint = (x === y && x >= 3 && x <= 6) || (x === y + 1 && x >= 4 && x <= 6);
    return edge(x, y) ? [190, 230, 255, 255] : glint ? [255, 255, 255, 255] : [200, 235, 255, 0];
  });
  paint(TILE.SAND, 17, (x, y, r) => noisy(r, 221, 207, 152, 18));
  paint(TILE.GRAVEL, 18, (x, y, r) => { const n = jit(r, 64); return [128 + n, 124 + n, 122 + n]; });
  paint(TILE.BEDROCK, 19, (x, y, r) => noisy(r, 54, 54, 60, 44));

  paint(TILE.TNT_SIDE, 20, (x, y, r) => {
    if (y >= 5 && y <= 11) {
      const gy = y - 6;
      for (const [ch, x0] of [['T', 2], ['N', 6], ['T', 10]]) {
        if (gy >= 0 && gy < 5 && x >= x0 && x < x0 + 3 && GLYPH[ch][gy][x - x0] === '1') return [30, 25, 25];
      }
      return noisy(r, 235, 230, 220, 10);
    }
    return noisy(r, 196, 42, 32, 16);
  });
  paint(TILE.TNT_TOP, 21, (x, y, r) => ((x >= 5 && x <= 10 && y >= 5 && y <= 10) ? [60, 55, 55] : noisy(r, 186, 38, 28, 16)));
  paint(TILE.WATER, 22, (x, y, r) => noisy(r, 52, 104, 222, 18));
  paint(TILE.LAVA, 23, (x, y, r) => (r() < 0.2 ? [255, 214, 80] : noisy(r, 236, 96, 20, 40)));
  paint(TILE.LEAVES, 24, (x, y, r) => (r() < 0.22 ? undefined : noisy(r, 56, 128, 46, 50)));
  paint(TILE.IRON_ORE, 25, (x, y, r) => (r() < 0.12 ? [214, 164, 134] : r() < 0.09 ? [96, 96, 102] : noisy(r, 126, 126, 132, 22)));
  paint(TILE.IRON_BLOCK, 26, (x, y, r) => (edge(x, y) ? [150, 152, 160] : ((x === 3 || x === 12) && (y === 3 || y === 12)) ? [90, 92, 100] : noisy(r, 206, 208, 214, 10)));
  paint(TILE.OBSIDIAN, 27, (x, y, r) => (r() < 0.1 ? [96, 58, 150] : noisy(r, 24, 16, 40, 16)));
  paint(TILE.FIRE, 28, (() => { const h = []; const r0 = mulberry32(5); for (let x = 0; x < 16; x++) h.push(6 + Math.floor(r0() * 10)); return (x, y, r) => {
    const top = 16 - h[x], mid = 0.5 + Math.sin(x * 0.9) * 0.3;
    if (y < top) return undefined;
    const t = (y - top) / (16 - top);
    return t < 0.4 + mid * 0.1 ? [255, 220, 90] : t < 0.75 ? [255, 140, 30] : [220, 60, 20];
  }; })());
  paint(TILE.WIRE_OFF, 29, (x, y) => ((x === 7 || x === 8 || y === 7 || y === 8) ? [130, 36, 36] : [60, 28, 28]));
  paint(TILE.WIRE_ON, 30, (x, y) => ((x === 7 || x === 8 || y === 7 || y === 8) ? [255, 70, 50] : [120, 40, 36]));
  paint(TILE.PLATE_OFF, 31, (x, y, r) => (edge(x, y) ? [96, 96, 102] : noisy(r, 164, 164, 170, 10)));
  paint(TILE.PLATE_ON, 32, (x, y, r) => (edge(x, y) ? [70, 70, 76] : noisy(r, 120, 150, 120, 10)));
  paint(TILE.LEVER_OFF, 33, (x, y, r) => ((y >= 6 && y <= 9) ? [200, 60, 50] : noisy(r, 118, 98, 66, 14)));
  paint(TILE.LEVER_ON, 34, (x, y, r) => ((y >= 6 && y <= 9) ? [90, 220, 90] : noisy(r, 118, 98, 66, 14)));
  paint(TILE.BUTTON, 35, (x, y, r) => ((x >= 5 && x <= 10 && y >= 5 && y <= 10) ? [190, 195, 210] : noisy(r, 118, 124, 140, 12)));
  paint(TILE.TRIPWIRE, 36, (x, y) => ((y === 7 || y === 8) ? [214, 214, 214] : undefined));
  paint(TILE.PISTON_SIDE, 37, (x, y, r) => ((y % 4 === 3) ? [96, 86, 76] : noisy(r, 150, 138, 120, 12)));
  paint(TILE.PISTON_FRONT, 38, (x, y, r) => (edge(x, y) ? [96, 86, 76] : (x >= 5 && x <= 10 && y >= 5 && y <= 10) ? [64, 60, 56] : noisy(r, 182, 142, 86, 12)));
  paint(TILE.PISTON_BACK, 39, (x, y, r) => noisy(r, 112, 112, 118, 16));
  paint(TILE.PISTON_HEAD, 40, (x, y, r) => (edge(x, y) ? [128, 94, 52] : noisy(r, 190, 150, 92, 12)));
  paint(TILE.DOOR, 41, (x, y, r) => ((x % 5 === 4) ? [100, 64, 30] : (x === 12 && y === 8) ? [210, 210, 120] : noisy(r, 150, 100, 52, 14)));
  paint(TILE.TIMER, 42, (x, y, r) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d > 5 && d < 6.6) return [90, 220, 240];
    if ((x === 7 || x === 8) && y >= 4 && y <= 8) return [255, 255, 255];
    if (y === 8 && x >= 8 && x <= 11) return [255, 255, 255];
    return noisy(r, 52, 70, 96, 10);
  });
  paint(TILE.SENSOR, 43, (x, y, r) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d < 2) return [10, 10, 12];
    if (d < 5) return [240, 250, 250];
    return noisy(r, 40, 110, 104, 10);
  });
  paint(TILE.ALARM, 44, (x, y, r) => {
    const d = Math.hypot(x - 7.5, y - 7.5);
    if (d < 3) return [255, 220, 80];
    if (d < 5.2) return [255, 255, 255];
    return noisy(r, 190, 52, 52, 14);
  });
  paint(TILE.VAULT, 45, (x, y, r) => (edge(x, y) ? [120, 90, 20] : ((x === 3 || x === 12) && (y === 3 || y === 12)) ? [70, 50, 10] : noisy(r, 236, 196, 52, 12)));
  paint(TILE.LOG_SIDE, 46, (x, y, r) => ((x % 4 === 1) ? [78, 56, 32] : noisy(r, 110, 82, 50, 16)));
  paint(TILE.LOG_TOP, 47, (x, y, r) => { const d = Math.hypot(x - 7.5, y - 7.5); return (Math.floor(d) % 3 === 0) ? [140, 104, 62] : noisy(r, 176, 138, 86, 12); });
  paint(TILE.VAULT_TOP, 48, (x, y, r) => { const d = Math.hypot(x - 7.5, y - 7.5); return d < 3 ? [255, 90, 60] : edge(x, y) ? [120, 90, 20] : noisy(r, 250, 214, 90, 12); });

  // --- tool icons (hotbar): tiny pixel drawings on a transparent tile ---
  const icon = (tile, rows, palette) => paint(tile, 7, (x, y) => { const ch = rows[y] && rows[y][x]; return ch && ch !== '.' ? palette[ch] : undefined; });
  const WOODC = [140, 100, 56], STEEL = [220, 224, 236], DARK = [90, 94, 110];
  icon(TILE.ICON_PICKAXE, [
    '................', '...ssssss.......', '..ssddddss......', '.ss...ww.ss.....', '.s....ww..s.....', '......ww........', '.....ww.........', '.....ww.........',
    '....ww..........', '....ww..........', '...ww...........', '...ww...........', '..ww............', '..ww............', '................', '................'], { s: STEEL, d: DARK, w: WOODC });
  icon(TILE.ICON_SWORD, [
    '..............ss', '.............ssd', '............ssd.', '...........ssd..', '..........ssd...', '.........ssd....', '..w.....ssd.....', '...w...ssd......',
    '....w.ssd.......', '.....wssd.......', '.....gwd........', '....gww.........', '...wg...........', '..ww............', '.ww.............', '................'], { s: STEEL, d: DARK, w: WOODC, g: [230, 190, 60] });
  icon(TILE.ICON_AXE, [
    '................', '.....sss........', '....sssss.......', '...ssssdds......', '...sssddd.......', '....ssdw........', '.....sww........', '......ww........',
    '.....ww.........', '.....ww.........', '....ww..........', '....ww..........', '...ww...........', '...ww...........', '..ww............', '................'], { s: STEEL, d: DARK, w: WOODC });
  icon(TILE.ICON_BOW, [
    '................', '....bb..........', '....b.b.........', '....b..b........', '...b....s.......', '...b.....s......', '..b..a....s.....', '..b...a...s.....',
    '..b....a..s.....', '..b.....a.s.....', '...b.....s......', '...b....s.......', '....b..b........', '....b.b.........', '....bb..........', '................'], { b: WOODC, s: [235, 235, 235], a: [200, 200, 210] });
  icon(TILE.ICON_STAFF, [
    '.........yy.....', '........yyyy....', '........yyyy....', '.........yy.....', '.........w......', '........w.......', '........w.......', '.......w........',
    '.......w........', '......w.........', '......w.........', '.....w..........', '.....w..........', '....w...........', '....w...........', '...w............'], { y: [255, 120, 60], w: WOODC });
  icon(TILE.ICON_LIGHTER, [
    '................', '................', '.......ff.......', '......ffff......', '......ffyf......', '.....ssssss.....', '.....sddddss....', '.....sdddds.....',
    '.....sdddds.....', '.....sdddds.....', '.....sdddds.....', '.....sddddss....', '.....ssssss.....', '................', '................', '................'], { f: [255, 150, 40], y: [255, 230, 120], s: [190, 190, 200], d: [110, 110, 124] });
  return canvas;
}

/* ============================== 6. MESHER =============================== */
// Vertex layout (floats): x, y, z, u, v, shade  ->  stride 24 bytes.
const VERTEX_FLOATS = 6;
const AO_LEVELS = [0.5, 0.68, 0.84, 1.0];
// Triangles per quad, in terms of corner indices. Corner order is CCW seen from
// outside for a +axis face; -axis faces use the reversed tables.
const TRI_POS = [0, 1, 2, 0, 2, 3], TRI_POS_FLIP = [1, 2, 3, 1, 3, 0];
const TRI_NEG = [0, 2, 1, 0, 3, 2], TRI_NEG_FLIP = [1, 3, 2, 1, 0, 3];
const CORNERS = [[0, 0], [1, 0], [1, 1], [0, 1]];
const ATLAS_INSET = 0.0006;
const faceShade = (a, s) => (a === 1 ? (s > 0 ? 1.0 : 0.5) : (a === 0 ? 0.8 : 0.66));

function tileFor(def, meta, a, s) {
  if (def.tileFn) return def.tileFn(meta, a, s);
  return a === 1 ? (s > 0 ? def.tiles.top : def.tiles.bottom) : def.tiles.side;
}

/** Emits one quad (two triangles) for the face (axis a, sign s) of the box [min, max]. */
function emitQuad(out, min, max, a, s, tile, shade, ao) {
  const T = CONFIG.ATLAS.TILES, t1 = (a + 1) % 3, t2 = (a + 2) % 3;
  const tu = (tile % T) / T, tv = Math.floor(tile / T) / T, ts = 1 / T;
  const px = [0, 0, 0, 0], py = [0, 0, 0, 0], pz = [0, 0, 0, 0], us = [0, 0, 0, 0], vs = [0, 0, 0, 0];
  const p = [0, 0, 0];
  for (let i = 0; i < 4; i++) {
    const c1 = CORNERS[i][0], c2 = CORNERS[i][1];
    p[a] = s > 0 ? max[a] : min[a]; p[t1] = c1 ? max[t1] : min[t1]; p[t2] = c2 ? max[t2] : min[t2];
    px[i] = p[0]; py[i] = p[1]; pz[i] = p[2];
    let u, v;
    if (a === 1) { u = c1; v = c2; } else if (a === 0) { u = c2; v = 1 - c1; } else { u = c1; v = 1 - c2; }
    us[i] = tu + (ATLAS_INSET + u * (1 - 2 * ATLAS_INSET)) * ts;
    vs[i] = tv + (ATLAS_INSET + v * (1 - 2 * ATLAS_INSET)) * ts;
  }
  const flip = ao ? ao[1] + ao[3] > ao[0] + ao[2] : false;
  const tris = s > 0 ? (flip ? TRI_POS_FLIP : TRI_POS) : (flip ? TRI_NEG_FLIP : TRI_NEG);
  for (let k = 0; k < 6; k++) {
    const i = tris[k];
    out.push(px[i], py[i], pz[i], us[i], vs[i], shade * (ao ? AO_LEVELS[ao[i]] : 1));
  }
}

/** Height (0..1) of a fluid cell's surface. */
function fluidHeight(getId, getMeta, x, y, z, id, def) {
  if (getId(x, y + 1, z) === id) return 1;
  const level = getMeta(x, y, z) & 15;
  return clamp(0.12 + 0.84 * (level / def.fluid.maxLevel), 0.12, 0.96);
}

/**
 * Meshes one cell. ctx = { getId, getMeta, solid:[], fluid:[], ao:bool }.
 * Cubes get face culling + ambient occlusion, shaped blocks emit all faces, fluids go to a separate buffer.
 */
function meshCell(ctx, x, y, z) {
  const getId = ctx.getId, id = getId(x, y, z);
  if (id === AIR) return;
  const def = BLOCKS[id], meta = ctx.getMeta(x, y, z);
  const opaqueAt = (ax, ay, az) => BLOCKS[getId(ax, ay, az)].opaque ? 1 : 0;

  if (def.shape === 'cube') {
    const min = [x, y, z], max = [x + 1, y + 1, z + 1], q = [0, 0, 0], ao = [3, 3, 3, 3];
    for (let a = 0; a < 3; a++) for (let s = -1; s <= 1; s += 2) {
      q[0] = x; q[1] = y; q[2] = z; q[a] += s;
      const nId = getId(q[0], q[1], q[2]);
      if (nId !== AIR) { const nd = BLOCKS[nId]; if (nd.opaque || (nId === id && def.cullSame)) continue; }
      if (ctx.ao) {
        const t1 = (a + 1) % 3, t2 = (a + 2) % 3;
        for (let i = 0; i < 4; i++) {
          const o1 = CORNERS[i][0] ? 1 : -1, o2 = CORNERS[i][1] ? 1 : -1;
          q[t1] += o1; const sA = opaqueAt(q[0], q[1], q[2]); q[t1] -= o1;
          q[t2] += o2; const sB = opaqueAt(q[0], q[1], q[2]); q[t2] -= o2;
          q[t1] += o1; q[t2] += o2; const sC = opaqueAt(q[0], q[1], q[2]); q[t1] -= o1; q[t2] -= o2;
          ao[i] = sA && sB ? 0 : 3 - (sA + sB + sC);
        }
      }
      emitQuad(ctx.solid, min, max, a, s, tileFor(def, meta, a, s), faceShade(a, s), ctx.ao ? ao : null);
    }
  } else if (def.shape === 'box') {
    for (const b of def.boxes(meta)) {
      const min = [x + b[0], y + b[1], z + b[2]], max = [x + b[3], y + b[4], z + b[5]];
      for (let a = 0; a < 3; a++) for (let s = -1; s <= 1; s += 2) {
        if (a === 1 && s < 0 && b[1] === 0) continue;             // resting on the floor: bottom never visible
        emitQuad(ctx.solid, min, max, a, s, tileFor(def, meta, a, s), faceShade(a, s), null);
      }
    }
  } else if (def.shape === 'fluid') {
    const h = fluidHeight(getId, ctx.getMeta, x, y, z, id, def), level = meta & 15;
    const min = [x, y, z], max = [x + 1, y + h, z + 1], q = [0, 0, 0];
    for (let a = 0; a < 3; a++) for (let s = -1; s <= 1; s += 2) {
      q[0] = x; q[1] = y; q[2] = z; q[a] += s;
      const nId = getId(q[0], q[1], q[2]);
      if (nId !== AIR) {
        const nd = BLOCKS[nId];
        if (nd.opaque) continue;
        if (nId === id) { if (a === 1 || (ctx.getMeta(q[0], q[1], q[2]) & 15) >= level) continue; }
      }
      emitQuad(ctx.fluid, min, max, a, s, def.tiles.top, faceShade(a, s), null);
    }
  }
}

/** Builds the triangle lists for one chunk column (all heights). */
function buildChunkMesh(world, cx, cz) {
  const C = CONFIG.WORLD.CHUNK;
  const x0 = cx * C, z0 = cz * C;
  const x1 = Math.min(x0 + C, world.sizeX), z1 = Math.min(z0 + C, world.sizeZ);
  const ctx = { getId: (x, y, z) => world.get(x, y, z), getMeta: (x, y, z) => world.getMeta(x, y, z), solid: [], fluid: [], ao: true };
  for (let y = 0; y < world.sizeY; y++) for (let z = z0; z < z1; z++) for (let x = x0; x < x1; x++) {
    if (world.blocks[world.index(x, y, z)] !== AIR) meshCell(ctx, x, y, z);
  }
  return { data: new Float32Array(ctx.solid), vertexCount: ctx.solid.length / VERTEX_FLOATS, fluidData: new Float32Array(ctx.fluid), fluidCount: ctx.fluid.length / VERTEX_FLOATS };
}

/** Meshes a loose list of blocks [{x,y,z,id,meta}] (falling groups, primed TNT). Coordinates stay relative. */
function buildBlockListMesh(cells) {
  const map = new Map();
  for (const c of cells) map.set(keyOf(c.x, c.y, c.z), c);
  const ctx = { getId: (x, y, z) => { const c = map.get(keyOf(x, y, z)); return c ? c.id : AIR; }, getMeta: (x, y, z) => { const c = map.get(keyOf(x, y, z)); return c ? c.meta : 0; }, solid: [], fluid: [], ao: false };
  for (const c of cells) meshCell(ctx, c.x, c.y, c.z);
  return { data: new Float32Array(ctx.solid), vertexCount: ctx.solid.length / VERTEX_FLOATS, fluidData: new Float32Array(0), fluidCount: 0 };
}

/* ============================== 7. BODIES =============================== */
const EPS = 1e-4;

/** Horizontal push direction (unit-ish) of flowing fluid at a cell: toward lower levels / open air. */
function fluidFlow(world, x, y, z) {
  const id = world.get(x, y, z);
  if (BLOCKS[id].shape !== 'fluid') return [0, 0];
  const level = world.getMeta(x, y, z) & 15;
  let fx = 0, fz = 0;
  for (let i = 0; i < 4; i++) {
    const d = DIRS6[i < 2 ? i : i + 2], nx = x + d[0], nz = z + d[2], nid = world.get(nx, y, nz);
    if (nid === id) { const nl = world.getMeta(nx, y, nz) & 15; fx += d[0] * (level - nl); fz += d[2] * (level - nl); }
    else if (!world.isSolid(nx, y, nz)) { fx += d[0] * 0.5; fz += d[2] * 0.5; }
  }
  if (world.get(x, y + 1, z) === id) { /* falling column: strongest flow comes from neighbours only */ }
  const l = Math.hypot(fx, fz);
  return l > 0 ? [fx / l, fz / l] : [0, 0];
}

/** Anything that moves with gravity and collides with voxels (players, mobs, primed TNT). */
class Body {
  constructor() {
    this.pos = { x: 0, y: 0, z: 0 };       // feet centre
    this.prev = { x: 0, y: 0, z: 0 };      // previous physics step (render interpolation)
    this.vel = { x: 0, y: 0, z: 0 };
    this.yaw = 0; this.pitch = 0;
    this.onGround = false;
    this.inWater = false; this.inLava = false; this.submerged = false;
    this.impactSpeed = 0; this.jumped = false;
    this.halfWidth = CONFIG.PLAYER.WIDTH / 2;
    this.height = CONFIG.PLAYER.HEIGHT;
    this.burnTime = 0;
  }
  teleport(x, y, z) {
    this.pos.x = this.prev.x = x; this.pos.y = this.prev.y = y; this.pos.z = this.prev.z = z;
    this.vel.x = this.vel.y = this.vel.z = 0;
  }
  center() { return { x: this.pos.x, y: this.pos.y + this.height * 0.5, z: this.pos.z }; }
  aabb() {
    const hw = this.halfWidth;
    return { minX: this.pos.x - hw, maxX: this.pos.x + hw, minY: this.pos.y, maxY: this.pos.y + this.height, minZ: this.pos.z - hw, maxZ: this.pos.z + hw };
  }

  sampleFluid(world) {
    const x = Math.floor(this.pos.x), z = Math.floor(this.pos.z);
    const feet = world.get(x, Math.floor(this.pos.y + 0.15), z), chest = world.get(x, Math.floor(this.pos.y + this.height * 0.6), z);
    this.inWater = feet === ID.water || chest === ID.water;
    this.inLava = feet === ID.lava || chest === ID.lava;
    this.submerged = chest === ID.water || chest === ID.lava;
  }

  /**
   * One fixed physics step. (wx, wz) is the desired horizontal direction, `speed` the target speed.
   * env: { gravityScale }.
   */
  simulate(dt, wx, wz, speed, wantJump, jumpPower, world, env) {
    const P = CONFIG.PLAYER, gs = env && env.gravityScale != null ? env.gravityScale : 1;
    this.prev.x = this.pos.x; this.prev.y = this.pos.y; this.prev.z = this.pos.z;
    this.jumped = false; this.impactSpeed = 0;
    this.sampleFluid(world);
    const inFluid = this.inWater || this.inLava;
    const spd = speed * (this.inLava ? 0.35 : this.inWater ? 0.6 : 1);
    const len = Math.hypot(wx, wz);

    if (len > 0) {
      wx /= len; wz /= len;
      const accel = (this.onGround ? P.GROUND_ACCEL : inFluid ? 30 : P.AIR_ACCEL) * dt;
      this.vel.x = approach(this.vel.x, wx * spd, accel);
      this.vel.z = approach(this.vel.z, wz * spd, accel);
    } else if (this.onGround) {
      const fr = P.GROUND_FRICTION * dt;                         // snappy stop, no ice-skating
      this.vel.x = approach(this.vel.x, 0, fr);
      this.vel.z = approach(this.vel.z, 0, fr);
    } else if (inFluid) {
      this.vel.x = approach(this.vel.x, 0, 10 * dt);
      this.vel.z = approach(this.vel.z, 0, 10 * dt);
    }                                                            // in the air with no input: keep momentum

    if (wantJump) {
      if (this.onGround) { this.vel.y = jumpPower; this.onGround = false; this.jumped = true; }
      else if (this.inWater) this.vel.y = Math.min(this.vel.y + 36 * dt, 5.5);
      else if (this.inLava) this.vel.y = Math.min(this.vel.y + 24 * dt, 3.2);
    }
    this.vel.y = Math.max(this.vel.y - P.GRAVITY * gs * (this.submerged ? 0.25 : 1) * dt, -P.TERMINAL);
    if (this.inWater) this.vel.y *= Math.max(0, 1 - 2.5 * dt);
    if (this.inLava) this.vel.y *= Math.max(0, 1 - 4 * dt);
    if (this.inWater) {                                          // current pushes bodies along
      const f = fluidFlow(world, Math.floor(this.pos.x), Math.floor(this.pos.y + 0.15), Math.floor(this.pos.z));
      this.vel.x += f[0] * 9 * dt; this.vel.z += f[1] * 9 * dt;
    }

    this.onGround = false;
    this.moveAxis(world, 'y', this.vel.y * dt);
    this.moveAxis(world, 'x', this.vel.x * dt);
    this.moveAxis(world, 'z', this.vel.z * dt);
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
      else { this.pos.y = best + 1; this.onGround = true; this.impactSpeed = Math.max(this.impactSpeed, -this.vel.y); }
      this.vel.y = 0;
    }
    return false;
  }
}

/** The default (no-class) tuning; classes tweak these slightly (see CLASSES). */
const DEFAULT_MODS = () => ({
  speed: 1, jump: 1, fall: 1, mineSpeed: 1, placeCooldown: 1, meleeDamage: 1, attackCooldown: 1, bowDraw: 1,
  mechCost: 1, mechDelay: 1, tntCap: 0, explosionTaken: 1, hazardTaken: 1, regenRate: 1, regenDelay: 1, repairFree: false, seeMechs: false,
});

class Player extends Body {
  constructor(id, name) {
    super();
    this.id = id; this.name = name;
    this.index = 0; this.color = CONFIG.COLORS[0];
    this.isBot = false;
    this.classId = 'builder'; this.landId = 'forest';
    this.team = 0;                                  // alliance id (== own index when solo)
    this.mods = DEFAULT_MODS();
    this.maxHealth = CONFIG.HEALTH.MAX; this.health = this.maxHealth; this.alive = true;
    this.eyeHeight = CONFIG.PLAYER.EYE;
    this.crouching = false;
    this.stepDistance = 0; this.walkPhase = 0; this.swing = 0; this.drawTime = 0;
    this.controls = { forward: false, back: false, left: false, right: false, jump: false, crouch: false };
    this.resources = {};
    this.cooldowns = { attack: 0, place: 0, shoot: 0, use: 0 };
    this.sinceDamage = 99;                          // seconds since last damage (regeneration)
    this.lastHits = [];                             // [{by, time}] for kill / assist credit
    this.lastCause = null;                          // {by, kind, time}
    this.stats = { kills: 0, assists: 0, deaths: 0, damageDealt: 0, blocksDestroyed: 0, structuresDestroyed: 0, tntKills: 0, objectives: 0, score: 0, surviveSeconds: 0 };
    this.spawn = { x: 0, y: 0, z: 0 };
    this.bounty = 0; this.bountyTime = 0;
    this.respawnTimer = 0;
    this.invulnerable = 0;
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
  update(dt, controls, world, env) {
    const P = CONFIG.PLAYER;
    controls = controls || this.controls;
    this.crouching = !!controls.crouch;
    // Wish direction from keys, relative to where we look (yaw 0 faces -Z).
    const f = (controls.forward ? 1 : 0) - (controls.back ? 1 : 0);
    const s = (controls.right ? 1 : 0) - (controls.left ? 1 : 0);
    const wx = f * -Math.sin(this.yaw) + s * Math.cos(this.yaw);
    const wz = f * -Math.cos(this.yaw) + s * -Math.sin(this.yaw);
    const speed = (this.crouching ? P.CROUCH : P.WALK) * this.mods.speed;
    const px = this.pos.x, pz = this.pos.z;

    this.simulate(dt, wx, wz, speed, !!controls.jump, P.JUMP * this.mods.jump, world, env);

    this.eyeHeight = approach(this.eyeHeight, this.crouching ? P.EYE_CROUCH : P.EYE, 6 * dt);
    const moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
    if (this.onGround) { this.stepDistance += moved; this.walkPhase += moved * 1.6; }
    for (const k in this.cooldowns) this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);
    this.swing = Math.max(0, this.swing - dt * 4);
  }
}

class Mob extends Body {
  constructor(id, x, y, z) {
    super();
    this.id = id; this.type = 'zombie';
    this.halfWidth = 0.3; this.height = 1.8;
    this.health = 20; this.maxHealth = 20; this.alive = true;
    this.teleport(x, y, z);
    this.attackCd = 0; this.walkPhase = 0; this.swing = 0; this.life = 0; this.stuck = 0;
    this.color = '#4c8a3a';
  }
  eyePosition() { return { x: this.pos.x, y: this.pos.y + 1.6, z: this.pos.z }; }
  update(dt, target, world, env) {
    this.life += dt; this.attackCd = Math.max(0, this.attackCd - dt); this.swing = Math.max(0, this.swing - dt * 4);
    let wx = 0, wz = 0, jump = false;
    if (target) {
      const dx = target.pos.x - this.pos.x, dz = target.pos.z - this.pos.z;
      const d = Math.hypot(dx, dz);
      this.yaw = Math.atan2(-dx, -dz);
      if (d > 0.9) { wx = dx / d; wz = dz / d; }
      // hop over obstacles in the way
      const ax = Math.floor(this.pos.x + wx * 0.7), az = Math.floor(this.pos.z + wz * 0.7), fy = Math.floor(this.pos.y + 0.1);
      if (this.onGround && world.isSolid(ax, fy, az) && !world.isSolid(ax, fy + 2, az)) jump = true;
      if (this.onGround && Math.hypot(this.vel.x, this.vel.z) < 0.4 && d > 1.2) { this.stuck += dt; if (this.stuck > 0.4) jump = true; } else this.stuck = 0;
    }
    const px = this.pos.x, pz = this.pos.z;
    this.simulate(dt, wx, wz, 3.4, jump, 8.2, world, env);
    if (this.onGround) this.walkPhase += Math.hypot(this.pos.x - px, this.pos.z - pz) * 1.6;
  }
}

/* ============================== 8. SYSTEMS ============================== */
/*
 * Every system receives the GameServer and talks to it through a few hooks:
 *   server.world, server.emit(evt), server.primeTnt(x,y,z,fuse,owner,cause), server.explode(...),
 *   server.damage(...), server.bodies() ... so each system stays small and testable.
 */

/* ---------- Fluids: grid-based spreading, no real fluid simulation ---------- */
class FluidSystem {
  constructor(server) {
    this.server = server; this.world = server.world;
    this.pending = new Set(); this.acc = 0; this.tickCount = 0; this.budget = 700;
  }
  /** Called for every block change: wake fluid cells next to the change. */
  onChange(x, y, z) {
    const w = this.world;
    let near = BLOCKS[w.get(x, y, z)].shape === 'fluid';
    if (!near) for (const d of DIRS6) if (BLOCKS[w.get(x + d[0], y + d[1], z + d[2])].shape === 'fluid') { near = true; break; }
    if (!near) return;
    this.pending.add(keyOf(x, y, z));
    for (const d of DIRS6) this.pending.add(keyOf(x + d[0], y + d[1], z + d[2]));
  }
  update(dt) {
    this.acc += dt;
    if (this.acc < 0.25) return;
    this.acc -= 0.25; this.tickCount++;
    if (!this.pending.size) return;
    const keys = [];
    for (const k of this.pending) { keys.push(k); if (keys.length >= this.budget) break; }
    for (const k of keys) this.pending.delete(k);
    const deferred = [];
    for (const k of keys) {
      const [x, y, z] = unkey(k), id = this.world.get(x, y, z);
      if (id === ID.lava && this.tickCount % 4 !== 0) { deferred.push(k); continue; }   // lava is slow
      if (BLOCKS[id].shape === 'fluid') this.step(x, y, z, id);
    }
    for (const k of deferred) this.pending.add(k);
  }
  step(x, y, z, id) {
    const w = this.world, def = BLOCKS[id], maxL = def.fluid.maxLevel;
    const meta = w.getMeta(x, y, z), src = !!(meta & 16);
    let level = meta & 15;

    // fluid interactions
    if (id === ID.water) {
      for (const d of DIRS6) {
        if (d[1] > 0) continue;
        const nx = x + d[0], ny = y + d[1], nz = z + d[2], n = w.get(nx, ny, nz);
        if (n === ID.lava) { w.set(nx, ny, nz, (w.getMeta(nx, ny, nz) & 16) ? ID.obsidian : ID.stone); this.server.emit({ type: 'steam', x: nx, y: ny, z: nz }); }
        else if (n === ID.fire) w.set(nx, ny, nz, AIR);
      }
      if (w.get(x, y + 1, z) === ID.fire) w.set(x, y + 1, z, AIR);
    } else if (id === ID.lava) {
      for (const d of DIRS6) {
        const nx = x + d[0], ny = y + d[1], nz = z + d[2], n = w.get(nx, ny, nz);
        if (n === ID.water) { w.set(x, y, z, src ? ID.obsidian : ID.stone); this.server.emit({ type: 'steam', x, y, z }); return; }
        const nd = BLOCKS[n];
        if (nd.flammable && Math.random() < 0.25) {
          if (n === ID.tnt) this.server.primeTnt(nx, ny, nz, 0.8 + Math.random() * 0.8, null, 'lava');
          else if (Math.random() < 0.5) w.set(nx, ny, nz, ID.fire);
        }
      }
    }

    if (!src) {                                                    // flowing cells need a feeder or they drain
      let feed = 0;
      if (w.get(x, y + 1, z) === id) feed = maxL;
      for (let i = 0; i < 4; i++) {
        const d = DIRS6[i < 2 ? i : i + 2];
        if (w.get(x + d[0], y, z + d[2]) === id) feed = Math.max(feed, (w.getMeta(x + d[0], y, z + d[2]) & 15) - 1);
      }
      if (feed <= 0) { w.set(x, y, z, AIR); return; }
      if (feed !== level) { w.setMeta(x, y, z, feed); level = feed; }
    }

    const below = y > 0 ? w.get(x, y - 1, z) : ID.bedrock, bd = BLOCKS[below];
    if (y > 0 && (bd.replaceable || bd.shape === 'fluid') && below !== id) { this.flowInto(x, y - 1, z, id, maxL); return; }
    if (level > 1 && (bd.solid || bd.shape === 'fluid' || !bd.replaceable)) {
      for (let i = 0; i < 4; i++) { const d = DIRS6[i < 2 ? i : i + 2]; this.flowInto(x + d[0], y, z + d[2], id, level - 1); }
    }
  }
  flowInto(x, y, z, fluidId, newLevel) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const t = w.get(x, y, z), td = BLOCKS[t];
    if (t === fluidId) { const m = w.getMeta(x, y, z); if (!(m & 16) && (m & 15) < newLevel) w.setMeta(x, y, z, newLevel); return; }
    if (td.shape === 'fluid') {                                   // water meets lava
      if (fluidId === ID.water) w.set(x, y, z, (w.getMeta(x, y, z) & 16) ? ID.obsidian : ID.stone);
      else w.set(x, y, z, ID.stone);
      this.server.emit({ type: 'steam', x, y, z });
      return;
    }
    if (td.replaceable || (td.needsFloor && !td.solid)) w.set(x, y, z, fluidId, false, newLevel);
  }
}

/* ---------- Fire: spreads through flammable blocks, water puts it out ---------- */
class FireSystem {
  constructor(server) { this.server = server; this.world = server.world; this.fires = new Set(); this.acc = 0; this.cause = new Map(); }
  onChange(x, y, z, old, nw) {
    const k = keyOf(x, y, z);
    if (nw === ID.fire) this.fires.add(k); else if (old === ID.fire) { this.fires.delete(k); this.cause.delete(k); }
  }
  ignite(x, y, z, cause) {
    if (this.world.get(x, y, z) !== AIR) return false;
    this.world.set(x, y, z, ID.fire);
    if (cause != null) this.cause.set(keyOf(x, y, z), cause);
    return true;
  }
  update(dt) {
    this.acc += dt;
    if (this.acc < 0.5) return;
    this.acc -= 0.5;
    const w = this.world;
    for (const k of Array.from(this.fires)) {
      const [x, y, z] = unkey(k);
      if (w.get(x, y, z) !== ID.fire) { this.fires.delete(k); continue; }
      const cause = this.cause.get(k);
      let wet = false, fuel = false;
      for (const d of DIRS6) if (w.get(x + d[0], y + d[1], z + d[2]) === ID.water) wet = true;
      if (wet) { w.set(x, y, z, AIR); continue; }
      for (const d of DIRS6) {
        const nx = x + d[0], ny = y + d[1], nz = z + d[2], n = w.get(nx, ny, nz), nd = BLOCKS[n];
        if (!nd.flammable) continue;
        fuel = true;
        if (Math.random() < nd.burnChance * 0.6) {
          if (n === ID.tnt) this.server.primeTnt(nx, ny, nz, 0.8 + Math.random() * 0.7, cause, 'fire');
          else { this.server.cause = cause; w.set(nx, ny, nz, ID.fire); this.server.cause = null; if (cause != null) this.cause.set(keyOf(nx, ny, nz), cause); }
        }
      }
      const age = (w.getMeta(x, y, z) & 255) + 1;
      if ((!fuel && age > 5 + Math.random() * 5) || age > 60) { w.set(x, y, z, AIR); continue; }
      w.setMeta(x, y, z, age, true);
      this.server.burnBodiesAt(x, y, z, cause);
    }
  }
}

/* ---------- Loose entities ---------- */
class PrimedTnt extends Body {
  constructor(id, x, y, z, fuse, owner, cause) {
    super();
    this.id = id; this.halfWidth = 0.45; this.height = 0.9;
    this.fuse = fuse; this.owner = owner; this.cause = cause || 'tnt'; this.alive = true;
    this.teleport(x, y, z);
    this.vel.x = (Math.random() - 0.5) * 1.2; this.vel.z = (Math.random() - 0.5) * 1.2; this.vel.y = 4.5;
  }
  update(dt, world, env) {
    this.simulate(dt, 0, 0, 0, false, 0, world, env);
    this.fuse -= dt;
  }
}

class Arrow {
  constructor(id, x, y, z, vx, vy, vz, owner, damage) {
    this.id = id; this.pos = { x, y, z }; this.vel = { x: vx, y: vy, z: vz };
    this.owner = owner; this.damage = damage; this.age = 0; this.stuck = false; this.alive = true;
  }
  get yaw() { return Math.atan2(-this.vel.x, -this.vel.z); }
  get pitch() { return Math.atan2(this.vel.y, Math.hypot(this.vel.x, this.vel.z)); }
}

class Meteor {
  constructor(id, tx, ty, tz) {
    this.id = id; this.target = { x: tx, y: ty, z: tz }; this.age = 0; this.alive = true;
    this.pos = { x: tx - 34, y: 78, z: tz - 20 };
    const dx = tx - this.pos.x, dy = ty - this.pos.y, dz = tz - this.pos.z, l = Math.hypot(dx, dy, dz);
    this.vel = { x: dx / l * 42, y: dy / l * 42, z: dz / l * 42 };
  }
}

/** A rigid chunk of blocks that fell off a structure. One mechanism for sand, TNT and whole towers. */
class FallingGroup {
  constructor(id, cells, cause) {
    this.id = id; this.cells = cells; this.cause = cause;
    this.off = 0; this.vel = { x: 0, y: 0, z: 0 }; this.alive = true; this.age = 0;
    this.hit = new Set();
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
    const cols = new Map();
    for (const c of cells) {
      minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z);
      const k = c.x + ',' + c.z, cur = cols.get(k);
      if (!cur || c.y < cur.y) cols.set(k, c);
    }
    this.bounds = { minX, maxX: maxX + 1, minY, maxY: maxY + 1, minZ, maxZ: maxZ + 1 };
    this.bottoms = Array.from(cols.values());
    this.weight = cells.reduce((s, c) => s + BLOCKS[c.id].weight, 0);
    this.owners = new Map();
    for (const c of cells) if (c.owner) this.owners.set(c.owner, (this.owners.get(c.owner) || 0) + 1);
  }
  update(dt, server) {
    this.age += dt;
    const w = server.world;
    this.vel.y = Math.max(this.vel.y - CONFIG.PLAYER.GRAVITY * server.gravityScale * dt, -38);
    const dy = this.vel.y * dt;
    let allowed = dy;
    for (const b of this.bottoms) {
      const yb = b.y + this.off, newY = yb + dy;
      for (let cy = Math.ceil(yb - 1e-6) - 1; cy >= Math.floor(newY); cy--) {
        if (w.isSolid(b.x, cy, b.z)) { allowed = Math.max(allowed, cy + 1 - yb); break; }
      }
    }
    this.off += allowed;
    if (allowed > dy + 1e-9) this.land(server);
  }
  land(server) {
    const w = server.world, impact = -this.vel.y, offInt = Math.round(this.off);
    this.alive = false;
    for (const c of this.cells) {
      const x = c.x, y = c.y + offInt, z = c.z, def = BLOCKS[c.id];
      if (c.id === ID.tnt && impact > 13) { server.primeTnt(x, y, z, 0.15, null, 'collapse', true); continue; }
      const shatter = clamp((impact - 9) / 22, 0, 1) * (def.blastResistance <= 3 ? 0.9 : def.blastResistance <= 8 ? 0.25 : 0.05) * (this.cells.length <= 3 ? 0.15 : 1);   // lone sand/gravel rarely breaks
      const t = w.get(x, y, z);
      if (Math.random() < shatter || !(t === AIR || BLOCKS[t].replaceable || !BLOCKS[t].solid)) { server.emit({ type: 'debris', x, y, z, block: def }); continue; }
      server.suppressSupport = true;
      w.set(x, y, z, c.id, false, c.meta, c.owner);
      server.suppressSupport = false;
    }
    server.emit({ type: 'groundImpact', x: (this.bounds.minX + this.bounds.maxX) / 2, y: this.bounds.minY + offInt, z: (this.bounds.minZ + this.bounds.maxZ) / 2, speed: impact, size: this.cells.length });
  }
}

/* ---------- Structural support: finds blocks no longer connected to the ground ---------- */
class StructureSystem {
  constructor(server) { this.server = server; this.world = server.world; this.queue = []; this.cap = 7000; }
  enqueue(cells, cause) { if (cells.length) this.queue.push({ cells, cause }); }
  isStructural(x, y, z) { const id = this.world.get(x, y, z); return id !== AIR && BLOCKS[id].solid && BLOCKS[id].shape !== 'fluid'; }
  process(maxItems = 3) {
    for (let i = 0; i < maxItems && this.queue.length; i++) this.run(this.queue.shift());
  }
  run({ cells, cause }) {
    const supported = new Set(), seen = new Set();
    for (const [rx, ry, rz] of cells) {
      for (const d of DIRS6) {
        const x = rx + d[0], y = ry + d[1], z = rz + d[2], k = keyOf(x, y, z);
        if (seen.has(k) || supported.has(k) || !this.isStructural(x, y, z)) continue;
        seen.add(k);
        const comp = this.flood(x, y, z, supported);
        if (!comp.supported && comp.cells.length) this.collapse(comp.cells, cause);
      }
    }
  }
  /** DFS that prefers going down, so grounded blocks (the common case) finish in a handful of steps. */
  flood(sx, sy, sz, supportedSet) {
    const w = this.world, visited = new Set([keyOf(sx, sy, sz)]), stack = [[sx, sy, sz]], list = [];
    let grounded = false;
    while (stack.length) {
      const [x, y, z] = stack.pop();
      list.push([x, y, z]);
      if (y === 0 || w.get(x, y, z) === ID.bedrock || supportedSet.has(keyOf(x, y, z))) { grounded = true; break; }
      if (list.length > this.cap) { grounded = true; break; }
      // push in reverse so that "down" is popped first
      for (let i = 5; i >= 0; i--) {
        const d = DIRS6[[2, 4, 5, 0, 1, 3][i]];
        const nx = x + d[0], ny = y + d[1], nz = z + d[2], nk = keyOf(nx, ny, nz);
        if (visited.has(nk) || !this.isStructural(nx, ny, nz)) continue;
        visited.add(nk); stack.push([nx, ny, nz]);
      }
    }
    if (grounded) { for (const k of visited) supportedSet.add(k); return { supported: true, cells: [] }; }
    return { supported: false, cells: list };
  }
  collapse(cellList, cause) {
    const s = this.server, w = this.world;
    const cells = cellList.map(([x, y, z]) => ({ x, y, z, id: w.get(x, y, z), meta: w.getMeta(x, y, z), owner: w.getOwner(x, y, z) }));
    s.suppressSupport = true;
    for (const c of cells) w.set(c.x, c.y, c.z, AIR);
    s.suppressSupport = false;
    const group = new FallingGroup(s.nextId(), cells, cause);
    s.groups.push(group);
    s.onGroupFormed(group, cause);
    for (const c of cells) s.checkAttachments(c.x, c.y, c.z);
  }
}

/** Sand, gravel and unsupported TNT fall as one-block (or column) groups. */
class GravitySystem {
  constructor(server) { this.server = server; this.world = server.world; this.pending = new Set(); }
  onChange(x, y, z) { this.pending.add(keyOf(x, y, z)); this.pending.add(keyOf(x, y + 1, z)); }
  update() {
    if (!this.pending.size) return;
    const w = this.world, keys = Array.from(this.pending).slice(0, 300);
    for (const k of keys) this.pending.delete(k);
    for (const k of keys) {
      const [x, y, z] = unkey(k), id = w.get(x, y, z);
      if (id === AIR || !BLOCKS[id].gravityAffected) continue;
      if (y === 0 || w.isSolid(x, y - 1, z)) continue;
      const cells = [];
      for (let cy = y; cy < w.sizeY && cells.length < 12 && BLOCKS[w.get(x, cy, z)].gravityAffected; cy++) {
        cells.push({ x, y: cy, z, id: w.get(x, cy, z), meta: w.getMeta(x, cy, z), owner: w.getOwner(x, cy, z) });
      }
      this.server.suppressSupport = true;
      for (const c of cells) w.set(c.x, c.y, c.z, AIR);
      this.server.suppressSupport = false;
      const group = new FallingGroup(this.server.nextId(), cells, null);
      this.server.groups.push(group);
      this.server.emit({ type: 'groupFormed', group, small: true });
    }
  }
}

/* ---------- Redstone-like mechanisms: sources -> wires -> consumers ---------- */
class RedstoneSystem {
  constructor(server) {
    this.server = server; this.world = server.world;
    this.mechs = new Set(); this.acc = 0;
    this.timers = new Map();       // timer block key -> { phase, t }
    this.buttons = new Map();      // button key -> seconds left
    this.alarmClock = new Map();
  }
  onChange(x, y, z, old, nw) {
    const k = keyOf(x, y, z), od = BLOCKS[old], nd = BLOCKS[nw];
    if (old === nw) return;
    if (nd.mech) this.mechs.add(k); else this.mechs.delete(k);
    if (od.mech) { this.timers.delete(k); this.buttons.delete(k); }
  }
  ownerMods(x, y, z) {
    const o = this.world.getOwner(x, y, z), p = o ? this.server.playerBySlot(o - 1) : null;
    return p ? p.mods : DEFAULT_MODS();
  }
  /** Player interaction: lever flips, button presses, door toggles, timer starts. */
  use(player, x, y, z) {
    const w = this.world, id = w.get(x, y, z), m = w.getMeta(x, y, z);
    if (id === ID.lever) { w.setMeta(x, y, z, m ^ 1); this.server.emit({ type: 'mechClick', x, y, z, block: BLOCKS[id] }); return true; }
    if (id === ID.button) { w.setMeta(x, y, z, m | 1); this.buttons.set(keyOf(x, y, z), 1.2); this.server.emit({ type: 'mechClick', x, y, z, block: BLOCKS[id] }); return true; }
    if (id === ID.door) { w.setMeta(x, y, z, m ^ 1); this.server.emit({ type: 'doorToggle', x, y, z }); return true; }
    if (id === ID.timer) { this.startTimer(x, y, z); return true; }
    return false;
  }
  startTimer(x, y, z) {
    const k = keyOf(x, y, z);
    if (this.timers.has(k) || this.world.getMeta(x, y, z) & 1) return;
    this.timers.set(k, { phase: 'delay', t: 2.5 * this.ownerMods(x, y, z).mechDelay });
    this.server.emit({ type: 'mechClick', x, y, z, block: BLOCKS[ID.timer] });
  }
  update(dt) {
    this.acc += dt;
    if (this.acc < 0.1) return;
    const step = this.acc; this.acc = 0;
    if (this.mechs.size) this.step(step);
  }
  step(dt) {
    const w = this.world, s = this.server;
    for (const [k, t] of Array.from(this.buttons)) {
      const left = t - dt, [x, y, z] = unkey(k);
      if (left <= 0) { this.buttons.delete(k); if (w.get(x, y, z) === ID.button) w.setMeta(x, y, z, w.getMeta(x, y, z) & ~1); } else this.buttons.set(k, left);
    }
    for (const [k, t] of Array.from(this.timers)) {
      t.t -= dt;
      const [x, y, z] = unkey(k);
      if (w.get(x, y, z) !== ID.timer) { this.timers.delete(k); continue; }
      if (t.t > 0) continue;
      if (t.phase === 'delay') { w.setMeta(x, y, z, w.getMeta(x, y, z) | 1); t.phase = 'pulse'; t.t = 0.7; }
      else { w.setMeta(x, y, z, w.getMeta(x, y, z) & ~1); this.timers.delete(k); }
    }

    const bodies = s.triggerBodies();
    const active = [];
    for (const k of this.mechs) {
      const [x, y, z] = unkey(k), id = w.get(x, y, z), m = w.getMeta(x, y, z);
      let on = false;
      if (id === ID.plate) {
        on = bodies.some((b) => Math.abs(b.pos.x - (x + 0.5)) < b.hw + 0.42 && Math.abs(b.pos.z - (z + 0.5)) < b.hw + 0.42 && b.pos.y < y + 0.5 && b.pos.y + b.h > y);
        if (on !== !!(m & 1)) { w.setMeta(x, y, z, on ? m | 1 : m & ~1); s.emit({ type: 'mechClick', x, y, z, block: BLOCKS[id] }); }
      } else if (id === ID.tripwire) {
        on = bodies.some((b) => Math.abs(b.pos.x - (x + 0.5)) < b.hw + 0.5 && Math.abs(b.pos.z - (z + 0.5)) < b.hw + 0.5 && b.pos.y < y + 1 && b.pos.y + b.h > y);
        if (on !== !!(m & 1)) w.setMeta(x, y, z, on ? m | 1 : m & ~1);
      } else if (id === ID.sensor) {
        const owner = w.getOwner(x, y, z) - 1, op = owner >= 0 ? s.playerBySlot(owner) : null;
        on = bodies.some((b) => b.living && Math.hypot(b.pos.x - (x + 0.5), b.pos.y + 0.9 - (y + 0.5), b.pos.z - (z + 0.5)) < 5.5 &&
          !(b.player && op && (b.player === op || s.areAllies(b.player, op))) && this.sees(x, y, z, b));
        if (on !== !!(m & 1)) { w.setMeta(x, y, z, on ? m | 1 : m & ~1); if (on) s.emit({ type: 'sensorPing', x, y, z, owner }); }
      } else if (id === ID.lever || id === ID.button || id === ID.timer) on = !!(m & 1);
      if (on) active.push([x, y, z]);
    }

    // propagate power through wires (BFS); consumers touching a powered cell receive it
    const visited = new Set(active.map(([x, y, z]) => keyOf(x, y, z))), powered = new Set(), queue = active.slice();
    while (queue.length) {
      const [x, y, z] = queue.pop();
      for (const d of DIRS6) {
        const nx = x + d[0], ny = y + d[1], nz = z + d[2], nk = keyOf(nx, ny, nz), nid = w.get(nx, ny, nz), nd = BLOCKS[nid];
        if (nd.mech === 'conductor') { if (!visited.has(nk)) { visited.add(nk); powered.add(nk); queue.push([nx, ny, nz]); } }
        else if (nd.mech === 'consumer') powered.add(nk);
      }
    }

    for (const k of Array.from(this.mechs)) {
      const [x, y, z] = unkey(k), id = w.get(x, y, z), nd = BLOCKS[id], m = w.getMeta(x, y, z);
      if (nd.mech === 'conductor') { const want = powered.has(k) ? 1 : 0; if ((m & 1) !== want) w.setMeta(x, y, z, (m & ~1) | want); continue; }
      if (nd.mech !== 'consumer') continue;
      const isP = powered.has(k), was = !!(m & 2);
      if (id === ID.tnt) { if (isP) s.primeTnt(x, y, z, 0.9, w.getOwner(x, y, z) - 1, 'trap'); continue; }
      if (isP === was) {
        if (id === ID.alarm && isP) this.alarmTick(x, y, z, dt);
        else if (id === ID.piston && isP && !(m & 1)) this.extend(x, y, z);       // blocked earlier? try again
        continue;
      }
      w.setMeta(x, y, z, isP ? m | 2 : m & ~2);
      if (id === ID.piston) { if (isP) this.extend(x, y, z); else this.retract(x, y, z); }
      else if (id === ID.door) { w.setMeta(x, y, z, (w.getMeta(x, y, z) & ~1) | (isP ? 1 : 0)); s.emit({ type: 'doorToggle', x, y, z }); }
      else if (id === ID.alarm) { if (isP) { this.alarmClock.set(k, 0); this.alarmTick(x, y, z, 1); } }
      else if (id === ID.timer) { if (isP) this.startTimer(x, y, z); }
    }
  }
  /** Line of sight from a sensor block to a body, starting just outside the (solid) sensor cube. */
  sees(x, y, z, b) {
    const sx = x + 0.5, sy = y + 0.5, sz = z + 0.5, tx = b.pos.x, ty = b.pos.y + 1, tz = b.pos.z;
    const dx = tx - sx, dy = ty - sy, dz = tz - sz, l = Math.hypot(dx, dy, dz) || 1, k = Math.min(0.85, l) / l;
    return !this.world.lineBlocked(sx + dx * k, sy + dy * k, sz + dz * k, tx, ty, tz);
  }
  alarmTick(x, y, z, dt) {
    const k = keyOf(x, y, z), t = (this.alarmClock.get(k) || 0) + dt;
    if (t >= 1) { this.alarmClock.set(k, 0); this.server.emit({ type: 'alarm', x, y, z, owner: this.world.getOwner(x, y, z) - 1 }); } else this.alarmClock.set(k, t);
  }

  extend(x, y, z) {
    const w = this.world, m = w.getMeta(x, y, z);
    if (m & 1) return false;
    const f = (m >> 2) & 7, d = DIRS6[f], chain = [];
    let cx = x + d[0], cy = y + d[1], cz = z + d[2];
    for (let i = 0; ; i++) {
      if (!w.inBounds(cx, cy, cz)) return false;
      const id = w.get(cx, cy, cz), bd = BLOCKS[id];
      if (id === AIR || bd.replaceable) break;
      if (!bd.pushable || i >= 8) return false;                   // blocked: too many blocks or something immovable
      chain.push([cx, cy, cz]);
      cx += d[0]; cy += d[1]; cz += d[2];
    }
    const server = this.server;
    server.suppressSupport = true;
    for (let k = chain.length - 1; k >= 0; k--) {
      const [bx, by, bz] = chain[k];
      const id = w.get(bx, by, bz), meta = w.getMeta(bx, by, bz), owner = w.getOwner(bx, by, bz);
      w.set(bx + d[0], by + d[1], bz + d[2], id, false, meta, owner);
      w.set(bx, by, bz, AIR);
    }
    const owner = w.getOwner(x, y, z);
    w.set(x + d[0], y + d[1], z + d[2], ID.piston_head, false, f << 2, owner);
    server.suppressSupport = false;
    w.setMeta(x, y, z, (w.getMeta(x, y, z) | 1));
    const pushed = chain.map(([bx, by, bz]) => [bx + d[0], by + d[1], bz + d[2]]);
    pushed.push([x + d[0], y + d[1], z + d[2]]);
    server.pushBodies(pushed, d);
    server.structure.enqueue(chain.concat([[x + d[0], y + d[1], z + d[2]]]), null);
    server.emit({ type: 'piston', x, y, z, extended: true });
    return true;
  }
  retract(x, y, z) {
    const w = this.world, m = w.getMeta(x, y, z);
    if (!(m & 1)) return;
    const f = (m >> 2) & 7, d = DIRS6[f], hx = x + d[0], hy = y + d[1], hz = z + d[2];
    if (w.get(hx, hy, hz) === ID.piston_head) { this.server.suppressSupport = true; w.set(hx, hy, hz, AIR); this.server.suppressSupport = false; }
    w.setMeta(x, y, z, m & ~1);
    this.server.emit({ type: 'piston', x, y, z, extended: false });
  }
}

/* ================================ 9. DATA ================================ */
/** Resources are what players spend. Caps keep hoarding in check; `start` is the base starting amount. */
const RESOURCES = {
  wood:  { label: 'Wood',  cap: 60, start: 24, color: '#b98b52' },
  stone: { label: 'Stone', cap: 80, start: 24, color: '#9a9aa4' },
  iron:  { label: 'Iron',  cap: 30, start: 4,  color: '#d6d9e4' },
  glass: { label: 'Glass', cap: 30, start: 8,  color: '#bfe6ff' },
  tnt:   { label: 'TNT',   cap: 8,  start: 3,  color: '#e0402e' },
  water: { label: 'Water', cap: 6,  start: 2,  color: '#4a84ff' },
  lava:  { label: 'Lava',  cap: 4,  start: 1,  color: '#ff8a1e' },
  mech:  { label: 'Parts', cap: 60, start: 12, color: '#ff6a5a' },
  earth: { label: 'Earth', cap: 80, start: 24, color: '#9a7350' },
};
const RESOURCE_ORDER = ['wood', 'stone', 'iron', 'glass', 'tnt', 'water', 'lava', 'mech', 'earth'];

/** Everything that can sit in a hotbar slot. kind: tool | block | fluid | mech */
const ITEMS = {
  pickaxe: { kind: 'tool', label: 'Pickaxe' },
  sword:   { kind: 'tool', label: 'Sword' },
  axe:     { kind: 'tool', label: 'Axe' },
  bow:     { kind: 'tool', label: 'Bow' },
  staff:   { kind: 'tool', label: 'Knockback Staff' },
  lighter: { kind: 'tool', label: 'Lighter' },
  stone:   { kind: 'block', label: 'Stone', block: 'stone', res: 'stone', cost: 1 },
  wood:    { kind: 'block', label: 'Wood', block: 'wood', res: 'wood', cost: 1 },
  glass:   { kind: 'block', label: 'Glass', block: 'glass', res: 'glass', cost: 1 },
  iron:    { kind: 'block', label: 'Iron Block', block: 'iron_block', res: 'iron', cost: 1 },
  dirt:    { kind: 'block', label: 'Dirt', block: 'dirt', res: 'earth', cost: 1 },
  sand:    { kind: 'block', label: 'Sand', block: 'sand', res: 'earth', cost: 1 },
  gravel:  { kind: 'block', label: 'Gravel', block: 'gravel', res: 'earth', cost: 1 },
  tnt:     { kind: 'block', label: 'TNT', block: 'tnt', res: 'tnt', cost: 1 },
  water:   { kind: 'fluid', label: 'Water', block: 'water', res: 'water', cost: 1 },
  lava:    { kind: 'fluid', label: 'Lava', block: 'lava', res: 'lava', cost: 1 },
  wire:    { kind: 'mech', label: 'Wire', block: 'wire', res: 'mech', cost: 0.5 },
  plate:   { kind: 'mech', label: 'Pressure Plate', block: 'plate', res: 'mech', cost: 1 },
  tripwire:{ kind: 'mech', label: 'Tripwire', block: 'tripwire', res: 'mech', cost: 1 },
  lever:   { kind: 'mech', label: 'Lever', block: 'lever', res: 'mech', cost: 1 },
  button:  { kind: 'mech', label: 'Button', block: 'button', res: 'mech', cost: 1 },
  piston:  { kind: 'mech', label: 'Piston', block: 'piston', res: 'mech', cost: 3 },
  door:    { kind: 'mech', label: 'Door (disguises)', block: 'door', res: 'wood', cost: 2 },
  timer:   { kind: 'mech', label: 'Timer', block: 'timer', res: 'mech', cost: 2 },
  sensor:  { kind: 'mech', label: 'Sensor', block: 'sensor', res: 'mech', cost: 2 },
  alarm:   { kind: 'mech', label: 'Alarm', block: 'alarm', res: 'mech', cost: 1 },
};
const ITEM_ORDER = Object.keys(ITEMS);

const TOOLS = {
  pickaxe: { dmg: 3,  cd: 0.5,  reach: 3.2, kb: 3,  mine: 2.6 },
  sword:   { dmg: 7,  cd: 0.45, reach: 3.3, kb: 5,  mine: 1.2 },
  axe:     { dmg: 11, cd: 0.85, reach: 3.1, kb: 6,  mine: 1.0, woodMine: 2.5 },
  staff:   { dmg: 2,  cd: 0.7,  reach: 3.4, kb: 16, mine: 1.0 },
  bow:     { dmg: 9,  cd: 0.5,  draw: 0.7, speed: 34, mine: 1.0 },
  lighter: { mine: 1.0 },
};
/** Seconds to break `def` by hand/tool (used by both the client progress bar and bots). */
function mineTime(def, toolId, mods) {
  const t = TOOLS[toolId] || { mine: 1 };
  let mult = t.mine || 1;
  if (t.woodMine && (def.sound === 'wood')) mult = t.woodMine;
  else if (toolId === 'pickaxe' && (def.sound === 'soft')) mult = 1.6;
  if (mods) mult *= mods.mineSpeed;
  return Math.max(CONFIG.MINE.MIN_TIME, def.hardness * CONFIG.MINE.TIME_PER_HARDNESS / mult);
}

/** Classes: small bonuses only. A good player with any class can beat a good player with another. */
const CLASSES = {
  builder: {
    name: 'Builder', blurb: 'Fast, frugal construction. Best for defensive and creative play.',
    perks: ['Mines blocks 20% faster', 'Places blocks 30% faster', 'Re-placing a recently destroyed block is free (repair)'],
    mods: { mineSpeed: 1.2, placeCooldown: 0.7, repairFree: true }, bonus: { wood: 6, stone: 6 },
  },
  fighter: {
    name: 'Fighter', blurb: 'Hits a little harder and a little faster. Best for aggressive players.',
    perks: ['+15% melee damage', 'Attacks 15% faster', 'Draws the bow 15% faster'],
    mods: { meleeDamage: 1.15, attackCooldown: 0.85, bowDraw: 0.85 }, bonus: {},
  },
  engineer: {
    name: 'Engineer', blurb: 'Mechanisms are cheaper and quicker. Spots hidden contraptions nearby.',
    perks: ['Mechanisms cost 40% less', 'Timers and pulses 40% shorter', 'Highlights hidden mechanisms within 7 blocks', '+8 parts'],
    mods: { mechCost: 0.6, mechDelay: 0.6, seeMechs: true }, bonus: { mech: 8 },
  },
  demolitionist: {
    name: 'Demolitionist', blurb: 'Carries more TNT and shrugs off a little blast damage.',
    perks: ['Carry +3 TNT', 'Takes 30% less explosion damage', '+2 TNT to start'],
    mods: { tntCap: 3, explosionTaken: 0.7 }, bonus: { tnt: 2 },
  },
  scout: {
    name: 'Scout', blurb: 'Quick on their feet. Best for flanking and hit-and-run.',
    perks: ['10% faster movement', 'Jumps 8% higher', 'Takes half fall damage'],
    mods: { speed: 1.1, jump: 1.08, fall: 0.5 }, bonus: {},
  },
  survivalist: {
    name: 'Survivalist', blurb: 'Hard to finish off. Best for players who prioritize staying alive.',
    perks: ['Regenerates faster, starts sooner', 'Takes 25% less lava / fire / flood damage', 'Disasters hurt less'],
    mods: { regenRate: 1.8, regenDelay: 0.6, hazardTaken: 0.75 }, bonus: {},
  },
};
const CLASS_ORDER = ['builder', 'fighter', 'engineer', 'demolitionist', 'scout', 'survivalist'];

/** Land types: each plot has a reason to pick it AND a reason to fear it. */
const LANDS = {
  fortress: {
    name: 'Fortress', icon: '#8d8d98', blurb: 'Stone walls, towers and natural cliffs behind your base.',
    pros: ['Pre-built stone walls and four towers', 'Cliffs protect your back', '+20 stone, +2 iron'],
    cons: ['Little wood or glass', 'Cliffs box you in, so expanding is slow', 'No water nearby'],
    res: { stone: 20, iron: 2, wood: -12, glass: -4, water: -1 }, blastMult: 1,
  },
  forest: {
    name: 'Forest', icon: '#3f8f3a', blurb: 'Dense woods, wood everywhere, and a cabin to start in.',
    pros: ['Trees give wood and cover', 'Wooden cabin ready to go', '+30 wood'],
    cons: ['Everything burns: lava and fire can eat your base', 'Little stone and iron'],
    res: { wood: 30, stone: -8, iron: -2 }, blastMult: 1,
  },
  mountain: {
    name: 'Mountain', icon: '#b7b0a2', blurb: 'A high plateau with steep cliffs and rock spires.',
    pros: ['High ground sees the whole map', 'Cliffs on every side', '+12 stone, +3 iron'],
    cons: ['Brittle rock: 20% less blast resistance, spires topple', 'Long falls and slow expansion', 'Little wood'],
    res: { stone: 12, iron: 3, wood: -10, earth: -8 }, blastMult: 0.8,
  },
  cave: {
    name: 'Cave', icon: '#5a5260', blurb: 'Natural tunnels and chambers under your base.',
    pros: ['Ready-made bunker and tunnels', 'Iron ore in the walls', 'Hidden route toward enemies'],
    cons: ['Pour water or lava down the shaft and you drown', 'TNT on the ceiling brings it down', 'Little wood and glass'],
    res: { stone: 10, iron: 6, mech: 4, wood: -8, glass: -4 }, blastMult: 1,
  },
  river: {
    name: 'River', icon: '#3f78d8', blurb: 'A river crosses your plot. Water is your friend (and your problem).',
    pros: ['Moat and current for defence', 'Water puts fires out', '+8 water, +8 earth'],
    cons: ['Less flat building land', 'Sand banks slump when undermined', 'Digging near the river floods your tunnels'],
    res: { water: 8, earth: 8, wood: -6, stone: -6 }, blastMult: 1,
  },
  industrial: {
    name: 'Industrial', icon: '#c9c3b0', blurb: 'Iron veins, a piston machine and a stack of TNT crates.',
    pros: ['Iron and machine parts', 'Pre-built piston machine', 'Great for traps'],
    cons: ['TNT crates can chain-explode, yours or stolen', 'Little wood or cover', 'Little stone'],
    res: { iron: 10, mech: 30, stone: -6, wood: -10, glass: -4 }, blastMult: 1,
  },
};
const LAND_ORDER = ['fortress', 'forest', 'mountain', 'cave', 'river', 'industrial'];

/** Flavour text shown in the lobby when a class and land fit well together (never mandatory, never overpowered). */
const SYNERGIES = {
  'engineer:cave': 'Underground trap factory',
  'builder:fortress': 'Bulwark: fast, cheap walls on top of walls',
  'scout:mountain': 'Eagle: high ground and quick getaways',
  'demolitionist:mountain': 'Avalanche: blast the cliffs down on enemies',
  'survivalist:river': 'Tide-walker: water defences and hard to kill',
  'builder:forest': 'Woodworker: lots of wood, fast building',
  'fighter:industrial': 'Armoury: machines cover your melee',
  'engineer:industrial': 'Workshop: parts everywhere',
  'demolitionist:industrial': 'Powder keg: lots of TNT (and lots of risk)',
  'scout:river': 'Skipper: hop the river and flank',
};

/** Starting resources for a class + land combination. */
function startResources(classId, landId, unlimited) {
  const r = {}, cls = CLASSES[classId], land = LANDS[landId];
  for (const k of RESOURCE_ORDER) {
    let v = RESOURCES[k].start + ((cls && cls.bonus[k]) || 0) + ((land && land.res[k]) || 0);
    const cap = RESOURCES[k].cap + (k === 'tnt' && cls ? cls.mods.tntCap || 0 : 0);
    v = clamp(v, 0, cap);
    r[k] = unlimited ? 999 : v;
  }
  return r;
}
function resourceCap(key, mods) { return RESOURCES[key].cap + (key === 'tnt' ? mods.tntCap : 0); }

/* ============================ 10. MAP GENERATOR ============================ */
const BOT_NAMES = ['RYZU', 'KAI', 'MOSS', 'BLITZ', 'NOVA', 'TORCH'];
const PLOT_BASE_RADIUS = 12;     // base-integrity zone around each spawn pad

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
  /**
   * Fills `world` (clearing it first) and returns { spawns, plots, center, vault }. Deterministic for a given seed.
   * opts: { seed, lands: [landId x6], owners: [slot|-1 x6] }
   */
  generate(world, opts = {}) {
    if (typeof opts === 'string') opts = {};
    world.clear();
    const seed = opts.seed != null ? opts.seed : 1337;
    const rng = mulberry32(seed);
    const { sizeX: sx, sizeY: sy, sizeZ: sz } = world;
    const spawns = this.computeSpawns(world);
    const lands = opts.lands || LAND_ORDER;
    const owners = opts.owners || [0, 1, 2, 3, 4, 5];
    const cx = Math.floor(sx / 2), cz = Math.floor(sz / 2);
    const PAD = this.PAD_HEIGHT, CENTER = this.CENTER_HEIGHT, PR = CONFIG.PLOT_RADIUS;

    const put = (x, y, z, type, ownerCode = 0, meta = 0) => world.set(x, y, z, ID[type], true, meta, ownerCode);
    const carve = (x, y, z) => { if (world.inBounds(x, y, z) && y >= 2) world.set(x, y, z, AIR, true); };
    const outward = spawns.map((s) => { const dx = s.x - (cx + 0.5), dz = s.z - (cz + 0.5), l = Math.hypot(dx, dz); return [dx / l, dz / l]; });

    // ---- terrain profile (heights + surface materials) ----
    const heights = new Int16Array(sx * sz), top = new Uint8Array(sx * sz), fill = new Uint8Array(sx * sz);
    const riverMask = new Uint8Array(sx * sz);
    const profile = (landId, dx, dz, dist, o, hb) => {
      const along = dx * -o[1] + dz * o[0], across = dx * o[0] + dz * o[1];   // along the tangent, across = outward (+) / toward centre (-)
      switch (landId) {
        case 'fortress': {
          const cliff = (across > 2 && dist > 11) ? clamp((dist - 11) * 2.2, 0, 9) : 0;
          return { h: PAD + cliff, top: ID.stone, fill: ID.stone };
        }
        case 'mountain': {
          const t = smoothstep(9, 15, dist);
          let h = lerp(26, hb, t);
          const spire = (hashNoise(Math.floor(dx / 2), Math.floor(dz / 2), seed + 3) < 0.1 && dist > 10 && dist < 16.5 && across > -5) ? 10 : 0;
          return { h: h + spire, top: dist < 8.5 ? ID.grass : ID.stone, fill: dist < 8.5 ? ID.dirt : ID.stone };
        }
        case 'river': {
          const c = -11 + Math.sin(along * 0.28) * 2.2, d = Math.abs(across - c);
          if (Math.abs(along) < 17 && d < 2.6) return { h: PAD - 3, top: ID.sand, fill: ID.sand, river: true };
          if (Math.abs(along) < 17 && d < 5) return { h: PAD, top: ID.sand, fill: ID.sand };
          return { h: PAD, top: ID.grass, fill: ID.dirt };
        }
        case 'industrial': return { h: PAD, top: dist < 5 ? ID.stone : ID.gravel, fill: ID.stone };
        case 'cave': return { h: PAD, top: ID.grass, fill: ID.dirt };
        default: return { h: PAD, top: ID.grass, fill: ID.dirt };                      // forest
      }
    };
    for (let z = 0; z < sz; z++) {
      for (let x = 0; x < sx; x++) {
        const i = x + z * sx;
        let h = 13 + (fbm(x / 28, z / 28, seed) - 0.5) * 12;
        let tp = h <= 11 ? ID.sand : (fbm(x / 9 + 50, z / 9 + 50, seed + 7) > 0.68 ? ID.gravel : ID.grass);
        let fl = h <= 11 ? ID.sand : ID.dirt;
        for (const s of spawns) {
          const dx = x - s.x, dz = z - s.z, dist = Math.hypot(dx, dz);
          if (dist >= PR) continue;
          const t = profile(lands[s.index], dx, dz, dist, outward[s.index], h);
          // flat pad in the middle, land profile outside, fade to natural terrain at the plot edge
          const padH = lands[s.index] === 'mountain' ? 26 : PAD;
          const wgt = 1 - smoothstep(PR - 6, PR, dist);
          h = dist < 8 ? padH : lerp(h, t.h, wgt);
          if (wgt > 0.35) { tp = t.top; fl = t.fill; }
          if (t.river && wgt > 0.35) riverMask[i] = 1;
        }
        const dc = Math.hypot(x - cx, z - cz), tc = smoothstep(11, 17, dc);
        h = lerp(CENTER, h, tc);
        if (tc < 1) { tp = ID.grass; fl = ID.dirt; }
        h = clamp(Math.round(h), 4, sy - 4);
        heights[i] = h; top[i] = tp; fill[i] = fl;
        for (let y = 0; y <= h; y++) {
          let id;
          if (y === 0) id = ID.bedrock;
          else if (y === h) id = tp;
          else if (y >= h - 3) id = fl;
          else id = ID.stone;
          world.set(x, y, z, id, true);
        }
      }
    }
    // water in river channels (permanent sources, level 8)
    for (let z = 0; z < sz; z++) for (let x = 0; x < sx; x++) {
      if (!riverMask[x + z * sx]) continue;
      for (let y = heights[x + z * sx] + 1; y <= PAD - 1; y++) world.set(x, y, z, ID.water, true, 16 | 8);
    }

    // ---- plots ----
    const plots = [];
    for (const s of spawns) {
      const land = lands[s.index], owner = owners[s.index], oc = owner >= 0 ? owner + 1 : 0;
      const px = Math.floor(s.x), pz = Math.floor(s.z), o = outward[s.index];
      // grid-aligned local frame: f = forward (toward the centre), r = to the right. Keeps walls and machines axis-aligned.
      const f = Math.abs(o[0]) > Math.abs(o[1]) ? [-Math.sign(o[0]), 0] : [0, -Math.sign(o[1])], r = [-f[1], f[0]];
      const base = land === 'mountain' ? 26 : PAD;
      const at = (a, b) => [px + f[0] * a + r[0] * b, pz + f[1] * a + r[1] * b];   // local coords: a forward (to centre), b to the right
      const surfaceAt = (x, z) => world.getSolidHeight(x, z);

      // pad floor and corner posts
      const padBlock = land === 'industrial' ? 'iron_block' : 'stone';
      for (let dz = -4; dz <= 4; dz++) for (let dx = -4; dx <= 4; dx++) put(px + dx, base, pz + dz, padBlock, oc);
      for (const [dx, dz] of [[-4, -4], [4, -4], [-4, 4], [4, 4]]) {
        for (let k = 1; k <= 3; k++) put(px + dx, base + k, pz + dz, 'wood', oc);
        put(px + dx, base + 4, pz + dz, 'glass', oc);
      }

      const wall = (type, a0, b0, a1, b1, h) => {                  // straight wall in local coords
        const n = Math.max(Math.abs(a1 - a0), Math.abs(b1 - b0));
        for (let i = 0; i <= n; i++) {
          const a = a0 + (a1 - a0) * (n ? i / n : 0), b = b0 + (b1 - b0) * (n ? i / n : 0), [x, z] = at(a, b);
          for (let k = 1; k <= h; k++) put(x, base + k, z, type, oc);
        }
      };

      if (land === 'fortress') {
        // square wall ring with a 3-wide gate facing the centre, four towers
        for (const side of [-7, 7]) { wall('stone', -7, side, 7, side, 3); }
        wall('stone', -7, -7, -7, 7, 3);
        for (let b = -7; b <= 7; b++) if (Math.abs(b) > 1) { const [x, z] = at(7, b); for (let k = 1; k <= 3; k++) put(x, base + k, z, 'stone', oc); }
        for (const [a, b] of [[-7, -7], [7, -7], [-7, 7], [7, 7]]) {
          const [x, z] = at(a, b);
          for (let k = 1; k <= 5; k++) put(x, base + k, z, 'stone', oc);
          put(x, base + 6, z, 'glass', oc);
        }
      } else if (land === 'forest') {
        // cabin: wood walls, glass windows, door gap facing the centre
        for (let a = -2; a <= 2; a++) for (let b = -2; b <= 2; b++) {
          const edge = Math.max(Math.abs(a), Math.abs(b)) === 2, [x, z] = at(a + 0, b + 5);
          put(x, base, z, 'wood', oc);
          if (edge) for (let k = 1; k <= 3; k++) put(x, base + k, z, (k === 2 && (Math.abs(a) === 2) !== (Math.abs(b) === 2)) ? 'glass' : 'wood', oc);
          put(x, base + 4, z, 'wood', oc);
        }
        { const [x, z] = at(-2, 5); put(x, base + 1, z, 'air', oc); put(x, base + 2, z, 'air', oc); }
      } else if (land === 'mountain') {
        // plateau parapet (partial) and a watchtower
        for (let a = -8; a <= 8; a++) for (const b of [-8, 8]) { const [x, z] = at(a, b); if (surfaceAt(x, z) >= base - 1 && Math.abs(a) > 2) { put(x, base + 1, z, 'stone', oc); put(x, base + 2, z, 'stone', oc); } }
        const [tx, tz] = at(0, -6);
        for (let k = 1; k <= 6; k++) put(tx, base + k, tz, 'stone', oc);
        put(tx, base + 7, tz, 'glass', oc);
      } else if (land === 'cave') {
        // shed over the stair entrance; the caves themselves are carved below
        for (let a = -1; a <= 1; a++) for (let b = -1; b <= 1; b++) {
          const [x, z] = at(a, b + 6);
          put(x, base + 4, z, 'wood', oc);
          if (Math.max(Math.abs(a), Math.abs(b)) === 1 && !(a === 0 && b === -1)) for (let k = 1; k <= 3; k++) put(x, base + k, z, 'wood', oc);
        }
      } else if (land === 'river') {
        // two-wide plank bridge over the channel plus a small dock
        for (let a = -17; a <= 3; a++) for (let b = 0; b <= 1; b++) {
          const [x, z] = at(a, b + 3);
          if (Math.hypot(x - px, z - pz) > 17) continue;
          if (world.get(x, base - 1, z) === ID.water || world.get(x, base - 2, z) === ID.water) put(x, base - 1, z, 'wood', oc);
        }
      } else if (land === 'industrial') {
        // TNT crate (2x3), lever + wire + piston machine
        for (let a = 0; a < 2; a++) for (let b = 0; b < 3; b++) { const [x, z] = at(a - 3, b + 7); put(x, base + 1, z, 'tnt', oc); }
        const [lx, lz] = at(-2, -6), [w1x, w1z] = at(-1, -6), [px2, pz2] = at(0, -6);
        put(lx, base + 1, lz, 'lever', oc); put(w1x, base + 1, w1z, 'wire', oc);
        const facing = f[0] > 0 ? 0 : f[0] < 0 ? 1 : f[1] > 0 ? 4 : 5;
        put(px2, base + 1, pz2, 'piston', oc, facing << 2);
        for (let k = 1; k <= 2; k++) { const [x, z] = at(1, -6); put(x, base + k, z, 'iron_block', oc); }
      }

      // land features outside the pad
      if (land === 'forest') {
        for (let n = 0; n < 34; n++) {
          const ang = rng() * Math.PI * 2, d = 6 + rng() * 10, x = Math.round(px + Math.cos(ang) * d), z = Math.round(pz + Math.sin(ang) * d);
          if (Math.hypot(x - px, z - pz) < 7) continue;
          this.tree(world, rng, x, z);
        }
      }
      if (land === 'cave') this.carveCaves(world, rng, px, pz, base, f, r, carve);
      if (land === 'industrial' || land === 'cave' || land === 'mountain') {
        // iron veins just under the surface around the plot
        for (let n = 0; n < 26; n++) {
          const ang = rng() * Math.PI * 2, d = 6 + rng() * 11, x = Math.round(px + Math.cos(ang) * d), z = Math.round(pz + Math.sin(ang) * d);
          if (!world.inBounds(x, 1, z)) continue;
          const h = world.getHeight(x, z);
          for (let k = 0; k < 4; k++) { const oy = h - 1 - Math.floor(rng() * 4), ox = x + Math.floor(rng() * 3) - 1, oz = z + Math.floor(rng() * 3) - 1; if (world.get(ox, oy, oz) === ID.stone) world.set(ox, oy, oz, ID.iron_ore, true); }
        }
      }
      plots.push({ index: s.index, landId: land, owner, x: px, z: pz, baseY: base, outward: o });
    }

    // ---- centre vault: hollow stone building with doors, windows, glass roof and the vault core ----
    for (let dz = -4; dz <= 4; dz++) {
      for (let dx = -4; dx <= 4; dx++) {
        const edge = Math.max(Math.abs(dx), Math.abs(dz)) === 4;
        put(cx + dx, CENTER, cz + dz, 'stone');
        for (let k = 1; k <= 4; k++) world.set(cx + dx, CENTER + k, cz + dz, AIR, true);
        if (edge) {
          for (let k = 1; k <= 4; k++) put(cx + dx, CENTER + k, cz + dz, 'stone');
          const along = Math.abs(dx) === 4 ? dz : dx;
          if (along === 0) { world.set(cx + dx, CENTER + 1, cz + dz, AIR, true); world.set(cx + dx, CENTER + 2, cz + dz, AIR, true); }
          if (Math.abs(along) === 2) put(cx + dx, CENTER + 3, cz + dz, 'glass');
        }
        put(cx + dx, CENTER + 5, cz + dz, 'glass');
      }
    }
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) put(cx + dx, CENTER + 1, cz + dz, 'stone');
    put(cx, CENTER + 2, cz, 'vault');
    const vault = { x: cx + 0.5, y: CENTER + 2, z: cz + 0.5, block: [cx, CENTER + 2, cz], radius: 4.2 };

    // ---- natural boulders and a few lone trees for cover on the neutral ground ----
    for (let n = 0; n < 16; n++) {
      const bx = 6 + Math.floor(rng() * (sx - 12)), bz = 6 + Math.floor(rng() * (sz - 12));
      if (spawns.some((s) => Math.hypot(bx - s.x, bz - s.z) < PR + 2) || Math.hypot(bx - cx, bz - cz) < 17) continue;
      const rr = 1.3 + rng() * 1.5, topY = heights[bx + bz * sx];
      for (let dz = -3; dz <= 3; dz++) for (let dx = -3; dx <= 3; dx++) for (let dy = -1; dy <= 3; dy++) {
        if (Math.hypot(dx, dy, dz) <= rr) world.set(bx + dx, topY + dy, bz + dz, ID.stone, true);
      }
    }
    for (let n = 0; n < 14; n++) {
      const x = 6 + Math.floor(rng() * (sx - 12)), z = 6 + Math.floor(rng() * (sz - 12));
      if (spawns.some((s) => Math.hypot(x - s.x, z - s.z) < PR + 1) || Math.hypot(x - cx, z - cz) < 16) continue;
      if (world.get(x, world.getHeight(x, z), z) === ID.grass) this.tree(world, rng, x, z);
    }

    for (const s of spawns) s.y = world.getSolidHeight(Math.floor(s.x), Math.floor(s.z)) + 1;
    for (const p of plots) { const s = spawns[p.index]; p.spawn = { x: s.x, y: s.y, z: s.z }; }
    return { spawns, plots, center: { x: cx + 0.5, z: cz + 0.5 }, vault, name: 'plains' };
  },

  tree(world, rng, x, z) {
    if (!world.inBounds(x, 1, z)) return;
    const gy = world.getHeight(x, z);
    if (gy < 0 || world.get(x, gy, z) === ID.water || world.get(x, gy, z) === ID.sand) return;
    const hgt = 4 + Math.floor(rng() * 3);
    for (let dy = 0; dy < 3; dy++) {
      const rr = dy === 2 ? 1.5 : 2.3;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        if (Math.hypot(dx, dz) > rr) continue;
        const lx = x + dx, ly = gy + hgt - 1 + dy, lz = z + dz;
        if (world.get(lx, ly, lz) === AIR) world.set(lx, ly, lz, ID.leaves, true);
      }
    }
    for (let k = 1; k <= hgt; k++) world.set(x, gy + k, z, ID.log, true);
  },

  /** Chambers and tunnels under a cave plot, a staircase down from the pad and a tunnel toward the centre. */
  carveCaves(world, rng, px, pz, base, f, t, carve) {
    const sphere = (cx, cy, cz, r) => {
      for (let dz = -Math.ceil(r); dz <= Math.ceil(r); dz++) for (let dx = -Math.ceil(r); dx <= Math.ceil(r); dx++) for (let dy = -Math.ceil(r); dy <= Math.ceil(r); dy++) {
        if (dx * dx + dy * dy + dz * dz <= r * r) carve(Math.round(cx + dx), Math.round(cy + dy), Math.round(cz + dz));
      }
    };
    const chambers = [[0, 0, 5], [8, 6, 4.2], [-3, -8, 4.6], [10, -6, 3.8]].map(([a, b, r]) => [px + f[0] * a + t[0] * b, base - 6 - Math.floor(rng() * 2), pz + f[1] * a + t[1] * b, r]);
    for (const [x, y, z, r] of chambers) sphere(x, y, z, r);
    const tunnel = (x0, y0, z0, x1, y1, z1, r) => {
      const n = Math.ceil(Math.hypot(x1 - x0, y1 - y0, z1 - z0) * 1.5);
      for (let i = 0; i <= n; i++) {
        const k = i / n, wob = Math.sin(k * 9 + x0) * 0.8;
        sphere(lerp(x0, x1, k) + wob, lerp(y0, y1, k), lerp(z0, z1, k) - wob, r);
      }
    };
    for (let i = 0; i < chambers.length - 1; i++) tunnel(chambers[i][0], chambers[i][1], chambers[i][2], chambers[i + 1][0], chambers[i + 1][1], chambers[i + 1][2], 1.7);
    // stairs from the pad down into the first chamber (2 wide)
    for (let i = 0; i < 6; i++) {
      for (let w = -1; w <= 0; w++) {
        const x = Math.round(px + f[0] * (3 + i) + t[0] * (6 + w)), z = Math.round(pz + f[1] * (3 + i) + t[1] * (6 + w));
        for (let k = 0; k < 4; k++) carve(x, base - i + k, z);
      }
    }
    tunnel(chambers[0][0], chambers[0][1], chambers[0][2], px + f[0] * 12 + t[0] * 6, base - 5, pz + f[1] * 12 + t[1] * 6, 1.6);   // toward the centre
    tunnel(px + f[0] * 12 + t[0] * 6, base - 5, pz + f[1] * 12 + t[1] * 6, px + f[0] * 15 + t[0] * 6, base - 1, pz + f[1] * 15 + t[1] * 6, 1.6);
    // iron ore in the walls
    for (let n = 0; n < 60; n++) {
      const c = chambers[Math.floor(rng() * chambers.length)];
      const x = Math.round(c[0] + (rng() - 0.5) * 12), y = Math.round(c[1] + (rng() - 0.5) * 6), z = Math.round(c[2] + (rng() - 0.5) * 12);
      if (world.get(x, y, z) === ID.stone) world.set(x, y, z, ID.iron_ore, true);
    }
  },
};

/* =========================== 11. GAME SERVER ============================ */
/**
 * Authoritative game state. In this prototype it lives in the page; for multiplayer the same class runs on a
 * Node server and `handle()` is fed by sockets. Clients only ever *ask*; the server decides.
 * It simulates every player/bot/entity at a fixed step through update(dt).
 */
const PVP_PHASES = new Set(['war', 'chaos', 'sandbox']);
const HAZARD_KINDS = new Set(['lava', 'fire', 'flood', 'drown', 'disaster', 'mob']);
const TNT_CAUSES = new Set(['tnt', 'chain', 'trap', 'collapse']);

/* ---------- disaster events: each has start / active (tick) / end ---------- */
const EVENT_DEFS = {
  tntRain: {
    name: 'TNT RAIN', duration: 18,
    start(s, ev) { ev.data.acc = 0; },
    tick(s, ev, dt) {
      ev.data.acc += dt * 3;
      while (ev.data.acc >= 1) {
        ev.data.acc -= 1;
        const plot = s.randomPlot(0.5);
        const x = plot ? plot.x + (Math.random() - 0.5) * 30 : 6 + Math.random() * (s.world.sizeX - 12);
        const z = plot ? plot.z + (Math.random() - 0.5) * 30 : 6 + Math.random() * (s.world.sizeZ - 12);
        s.spawnTnt(clamp(x, 3, s.world.sizeX - 3), s.world.sizeY - 3, clamp(z, 3, s.world.sizeZ - 3), 2.4 + Math.random() * 0.8, null, 'rain', -4);
      }
    },
  },
  earthquake: {
    name: 'EARTHQUAKE', duration: 14,
    start(s, ev) { ev.data.acc = 0; ev.data.push = 0; },
    tick(s, ev, dt) {
      ev.data.push += dt;
      if (ev.data.push >= 1) { ev.data.push = 0; for (const b of s.bodies()) if (b.onGround) { b.vel.x += (Math.random() - 0.5) * 6; b.vel.z += (Math.random() - 0.5) * 6; b.vel.y += 2.2; } }
      ev.data.acc += dt;
      if (ev.data.acc < 0.7) return;
      ev.data.acc = 0;
      const w = s.world, cells = [];
      for (let i = 0; i < 6; i++) {                                   // crack the surface
        const plot = s.randomPlot(0.8);
        const x = Math.floor(plot ? plot.x + (Math.random() - 0.5) * 30 : Math.random() * w.sizeX), z = Math.floor(plot ? plot.z + (Math.random() - 0.5) * 30 : Math.random() * w.sizeZ);
        if (!w.inBounds(x, 1, z)) continue;
        const top = w.getSolidHeight(x, z);
        for (let dy = 0; dy < 2; dy++) { const d = BLOCKS[w.get(x, top - dy, z)]; if (d.breakable && d.blastResistance <= 4 && d.shape === 'cube') { s.cause = null; w.set(x, top - dy, z, AIR); cells.push([x, top - dy, z]); } }
      }
      for (let i = 0; i < 4; i++) {                                   // weaken the foot of structures: weak owned blocks at ground level
        const plot = s.randomPlot(1);
        if (!plot) break;
        const x = Math.floor(plot.x + (Math.random() - 0.5) * 24), z = Math.floor(plot.z + (Math.random() - 0.5) * 24), y = plot.baseY + 1;
        const d = BLOCKS[w.get(x, y, z)];
        if (w.getOwner(x, y, z) && d.breakable && d.blastResistance <= 4 && d.shape === 'cube') { w.set(x, y, z, AIR); cells.push([x, y, z]); }
      }
      s.emit({ type: 'quakeTick', cells });
    },
  },
  flood: {
    name: 'FLOOD', duration: 38,
    start(s, ev) { ev.data.layer = 10; },
    tick(s, ev) {
      const target = Math.min(24, Math.floor(10 + ev.t * 0.55));
      while (ev.data.layer < target) { ev.data.layer++; s.fillLayer(ev.data.layer, ID.water, 16 | 8 | 32); }
    },
    end(s, ev) { s.drains.push({ id: ID.water, y: ev.data.layer, acc: 0 }); },
  },
  lavaRise: {
    name: 'LAVA RISE', duration: 36,
    start(s, ev) { ev.data.layer = 2; },
    tick(s, ev) {
      const target = Math.min(18, Math.floor(2 + ev.t * 0.42));
      while (ev.data.layer < target) { ev.data.layer++; s.fillLayer(ev.data.layer, ID.lava, 16 | 4 | 32); }
    },
    end(s, ev) { s.drains.push({ id: ID.lava, y: ev.data.layer, acc: 0 }); },
  },
  meteor: {
    name: 'METEOR STRIKE', duration: 18,
    start(s, ev) { ev.data.next = 0.5; ev.data.left = 3; },
    tick(s, ev, dt) {
      ev.data.next -= dt;
      if (ev.data.left > 0 && ev.data.next <= 0) {
        ev.data.left--; ev.data.next = 5.5;
        const plot = s.randomPlot(0.7), w = s.world;
        const x = Math.floor(clamp(plot ? plot.x + (Math.random() - 0.5) * 16 : 10 + Math.random() * (w.sizeX - 20), 6, w.sizeX - 6));
        const z = Math.floor(clamp(plot ? plot.z + (Math.random() - 0.5) * 16 : 10 + Math.random() * (w.sizeZ - 20), 6, w.sizeZ - 6));
        s.pendingMeteors.push({ t: 3, x: x + 0.5, y: w.getSolidHeight(x, z) + 1, z: z + 0.5 });
        s.emit({ type: 'meteorWarning', x: x + 0.5, z: z + 0.5, seconds: 3 });
      }
    },
  },
  mobAttack: {
    name: 'MOB ATTACK', duration: 26,
    start(s, ev) { ev.data.waves = 2; ev.data.next = 0; },
    tick(s, ev, dt) {
      ev.data.next -= dt;
      if (ev.data.waves > 0 && ev.data.next <= 0) { ev.data.waves--; ev.data.next = 9; for (let i = 0; i < 4; i++) s.spawnMobAtEdge(); }
    },
    end(s) { for (const m of s.mobs) { m.alive = false; s.emit({ type: 'mobDespawn', mob: m }); } },
  },
  collapse: {
    name: 'STRUCTURAL COLLAPSE', duration: 6,
    start(s, ev) { ev.data.strikes = 3; ev.data.next = 1.2; },
    tick(s, ev, dt) {
      ev.data.next -= dt;
      if (ev.data.strikes > 0 && ev.data.next <= 0) { ev.data.strikes--; ev.data.next = 1.4; s.collapseStrike(); }
    },
  },
  lowGravity: {
    name: 'LOW GRAVITY', duration: 22,
    start(s) { s.gravityScale = 0.35; },
    end(s) { s.gravityScale = 1; },
  },
  darkness: {
    name: 'DARKNESS', duration: 22,
    start(s) { s.darkness = 1; },
    end(s) { s.darkness = 0; },
  },
};
const EVENT_LIST = Object.keys(EVENT_DEFS);

class GameServer {
  constructor(world) {
    this.world = world;
    this.players = [];                 // by slot index
    this.playerMap = new Map();
    this.listeners = [];
    this.idCounter = 1;
    this.suppressSupport = false;      // true while we batch-remove blocks (collapse is queued once instead)
    this.cause = null;                 // player slot responsible for the current block removals (credit / scoring)

    this.fluids = new FluidSystem(this);
    this.fire = new FireSystem(this);
    this.structure = new StructureSystem(this);
    this.gravity = new GravitySystem(this);
    this.redstone = new RedstoneSystem(this);
    world.listeners.push((x, y, z, o, n, om, oo) => this.onWorldChange(x, y, z, o, n, om, oo));
    this.resetState();
  }
  resetState() {
    this.tnts = []; this.groups = []; this.arrows = []; this.meteors = []; this.mobs = []; this.pendingMeteors = []; this.drains = [];
    this.players.length = 0; this.playerMap.clear();
    this.gravityScale = 1; this.darkness = 0;
    this.mode = 'sandbox'; this.phase = 'idle'; this.phaseTime = 0; this.clock = 0;
    this.unlimited = true; this.allianceMode = false;
    this.map = null; this.plots = [];
    this.event = null; this.eventGap = 2; this.lastEventType = null;
    this.vault = { progress: 0, team: -1, cooldown: 0, capturing: false, captured: 0 };
    this.baseCount = [0, 0, 0, 0, 0, 0]; this.baseRef = [0, 0, 0, 0, 0, 0]; this.baseDestroyed = [false, false, false, false, false, false];
    this.recentBreaks = new Map();
    this.proposals = [];
    this.nextTeam = 100;
    this.results = null; this.winnerTeam = null; this.winCheckClock = 0;
    this.stepCount = 0;
  }
  nextId() { return this.idCounter++; }
  subscribe(fn) { this.listeners.push(fn); }
  emit(event) { for (const fn of this.listeners) fn(event); }

  /* ------------------------------ setup ------------------------------ */
  addPlayer(player) {
    player.index = this.players.length;
    player.color = CONFIG.COLORS[player.index % CONFIG.COLORS.length];
    this.players[player.index] = player;
    this.playerMap.set(player.id, player);
    return player;
  }
  playerBySlot(i) { return this.players[i] || null; }
  playerById(id) { return this.playerMap.get(id) || null; }
  get human() { return this.players.find((p) => !p.isBot) || null; }
  areAllies(a, b) { return !!a && !!b && a !== b && a.team === b.team; }

  /**
   * Builds a new match. cfg: { mode:'war'|'alliance'|'sandbox', name, classId, botCount, seed, lands:[6], botClasses }
   * Returns the generated map info.
   */
  startMatch(cfg = {}) {
    this.resetState();
    this.world.listeners.length && 0;
    const mode = cfg.mode || 'war', botCount = clamp(cfg.botCount == null ? 3 : cfg.botCount, 0, 5), n = 1 + botCount;
    this.mode = mode; this.unlimited = mode === 'sandbox'; this.allianceMode = mode === 'alliance';
    const rng = mulberry32((cfg.seed != null ? cfg.seed : 1) * 7919 + 13);
    const lands = cfg.lands || this.assignLands(cfg.seed != null ? cfg.seed : 1);
    this.suspendTracking = true;                                   // do not run per-block systems while generating
    this.map = MapGenerator.generate(this.world, { seed: cfg.seed != null ? cfg.seed : 1337, lands, owners: [0, 1, 2, 3, 4, 5].map((i) => (i < n ? i : -1)) });
    this.suspendTracking = false;
    this.plots = this.map.plots;
    this.fluids.pending.clear(); this.fire.fires.clear(); this.redstone.mechs.clear(); this.gravity.pending.clear();
    this.scanWorldForSystems();

    const botNames = BOT_NAMES.slice().sort(() => rng() - 0.5);
    const classPool = CLASS_ORDER.filter((c) => c !== cfg.classId).sort(() => rng() - 0.5);
    for (let i = 0; i < n; i++) {
      const isBot = i > 0, p = new Player(isBot ? 'b' + i : 'p0', isBot ? botNames[i - 1] : (cfg.name || 'PLAYER'));
      this.addPlayer(p);
      p.isBot = isBot;
      p.classId = isBot ? (cfg.botClasses && cfg.botClasses[i - 1]) || classPool[(i - 1) % classPool.length] : (cfg.classId || 'builder');
      p.landId = lands[i];
      p.team = this.nextTeam++;
      this.applyClass(p);
      const plot = this.plots[i];
      p.spawn = { x: plot.spawn.x, y: plot.spawn.y, z: plot.spawn.z };
      p.resources = startResources(p.classId, p.landId, this.unlimited);
      this.respawn(p, true);
      p.yaw = Math.atan2(-(this.map.center.x - p.spawn.x), -(this.map.center.z - p.spawn.z));
      p.pitch = -0.1;
      if (isBot) p.bot = new Bot(this, p);
    }
    if (this.allianceMode && n >= 3) {                              // random starting alliances: 1 pair (3-4 players) or 2 pairs (5-6)
      const order = this.players.map((p) => p.index).sort(() => rng() - 0.5), pairs = n >= 5 ? 2 : 1;
      for (let k = 0; k < pairs; k++) {
        const a = this.players[order[k * 2]], b = this.players[order[k * 2 + 1]], t = this.nextTeam++;
        a.team = t; b.team = t;
      }
    }
    this.computeBaseCounts();
    this.phase = mode === 'sandbox' ? 'sandbox' : 'countdown';
    this.phaseTime = 0;
    if (mode === 'sandbox') for (let i = 0; i < n; i++) this.baseRef[i] = this.baseCount[i];
    this.emit({ type: 'matchStart', mode });
    this.emit({ type: 'phase', phase: this.phase });
    return this.map;
  }
  /** Deterministic land assignment: a shuffle of the six land types (so every plot differs). */
  assignLands(seed) {
    const rng = mulberry32(seed * 2654435761 >>> 0), a = LAND_ORDER.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }
  applyClass(p) {
    p.mods = DEFAULT_MODS();
    Object.assign(p.mods, CLASSES[p.classId].mods);
    p.maxHealth = CONFIG.HEALTH.MAX;
  }
  scanWorldForSystems() {
    const w = this.world;
    for (let y = 0; y < w.sizeY; y++) for (let z = 0; z < w.sizeZ; z++) for (let x = 0; x < w.sizeX; x++) {
      const id = w.blocks[w.index(x, y, z)];
      if (id === AIR) continue;
      const d = BLOCKS[id];
      if (d.mech) this.redstone.mechs.add(keyOf(x, y, z));
      if (id === ID.fire) this.fire.fires.add(keyOf(x, y, z));
    }
  }
  respawn(p, initial = false) {
    p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
    p.health = p.maxHealth; p.alive = true; p.burnTime = 0; p.air = 10; p.sinceDamage = 99;
    p.invulnerable = initial ? 0 : 2.5; p.respawnTimer = 0; p.lastHits.length = 0; p.lastCause = null;
    if (!initial) this.emit({ type: 'respawn', player: p });
  }

  /* ----------------------------- rules ----------------------------- */
  pvpEnabled() { return PVP_PHASES.has(this.phase); }
  plotOf(p) { return this.plots[p.index]; }
  inPlot(plot, x, z) { return Math.hypot(x + 0.5 - plot.x, z + 0.5 - plot.z) <= CONFIG.PLOT_RADIUS; }
  /** Territory / phase rules for editing blocks. */
  canModify(p, x, y, z) {
    if (this.phase === 'sandbox') return true;
    if (this.phase === 'build') return this.inPlot(this.plotOf(p), x, z);
    return this.phase === 'war' || this.phase === 'chaos';
  }
  landBlastMult(x, z) {
    for (const plot of this.plots) if (Math.hypot(x - plot.x, z - plot.z) < CONFIG.PLOT_RADIUS) return LANDS[plot.landId].blastMult;
    return 1;
  }
  randomPlot(ownedBias = 0.5) {
    const owned = this.plots.filter((p) => p.owner >= 0 && this.players[p.owner] && this.players[p.owner].alive);
    const list = Math.random() < ownedBias && owned.length ? owned : this.plots;
    return list.length ? list[Math.floor(Math.random() * list.length)] : null;
  }

  /* -------------------------- resources -------------------------- */
  addResource(p, key, amount) {
    if (this.unlimited || !amount) return 0;
    const cap = resourceCap(key, p.mods), before = p.resources[key] || 0;
    p.resources[key] = Math.min(cap, before + amount);
    return p.resources[key] - before;
  }
  hasResource(p, key, amount) { return this.unlimited || (p.resources[key] || 0) + 1e-9 >= amount; }
  spend(p, key, amount) { if (!this.unlimited) p.resources[key] = Math.max(0, (p.resources[key] || 0) - amount); }
  dropFor(p, def) {
    if (!def.drop) return;
    const [res, amount, chance] = def.drop;
    if (chance != null && Math.random() > chance) return;
    this.addResource(p, res, amount);
  }

  /* ---------------------------- actions ---------------------------- */
  handle(playerId, msg) {
    const p = this.playerMap.get(playerId);
    if (!p) return { ok: false, reason: 'unknown-player' };
    if (!p.alive) return { ok: false, reason: 'dead' };
    switch (msg.type) {
      case 'break': return this.breakBlock(p, msg);
      case 'place': return this.placeBlock(p, msg);
      case 'use': return this.useBlock(p, msg);
      case 'attack': return this.attack(p, msg);
      case 'shoot': return this.shoot(p, msg);
      case 'ignite': return this.ignite(p, msg);
      case 'propose': return this.proposeAlliance(p, msg);
      case 'respond': return this.respondAlliance(p, msg);
      case 'leaveAlliance': return this.leaveAlliance(p);
      case 'bounty': return this.placeBounty(p, msg);
      default: return { ok: false, reason: 'unknown-action' };
    }
  }
  withinReach(p, x, y, z, extra = 1.0) {
    const e = p.eyePosition();
    return Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y, z + 0.5 - e.z) <= CONFIG.PLAYER.REACH + extra;
  }

  breakBlock(p, { x, y, z }) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return { ok: false, reason: 'out-of-bounds' };
    const id = w.get(x, y, z);
    if (id === AIR) return { ok: false, reason: 'empty' };
    const def = BLOCKS[id];
    if (!def.breakable) return { ok: false, reason: 'unbreakable' };
    if (!this.withinReach(p, x, y, z)) return { ok: false, reason: 'too-far' };
    if (!this.canModify(p, x, y, z)) return { ok: false, reason: 'not-allowed' };
    this.cause = p.index;
    w.set(x, y, z, AIR);
    this.cause = null;
    this.dropFor(p, def);
    p.stats.blocksDestroyed++; p.stats.score += 1;
    this.emit({ type: 'blockBroken', x, y, z, block: def, by: p.id });
    return { ok: true };
  }

  placeBlock(p, { x, y, z, item, against }) {
    const w = this.world, it = ITEMS[item];
    if (!it || it.kind === 'tool') return { ok: false, reason: 'bad-item' };
    const def = BlockRegistry.byType(it.block);
    if (!w.inBounds(x, y, z)) return { ok: false, reason: 'out-of-bounds' };
    const cur = BLOCKS[w.get(x, y, z)];
    if (!(cur.replaceable || cur.shape === 'fluid') || w.get(x, y, z) === def.id) return { ok: false, reason: 'occupied' };
    if (p.cooldowns.place > 0) return { ok: false, reason: 'cooldown' };
    if (!this.withinReach(p, x, y, z)) return { ok: false, reason: 'too-far' };
    if (!this.canModify(p, x, y, z)) return { ok: false, reason: 'not-allowed' };
    let supported = false;
    for (const d of DIRS6) if (BLOCKS[w.get(x + d[0], y + d[1], z + d[2])].solid) { supported = true; break; }
    if (!supported) return { ok: false, reason: 'no-support' };
    if (def.needsFloor && !w.isSolid(x, y - 1, z)) return { ok: false, reason: 'no-floor' };
    let lift = false;
    if (def.solid) {                                                   // never entomb a player or mob
      for (const b of this.bodies()) {
        const a = b.aabb();
        if (a.maxX > x + 1e-3 && a.minX < x + 1 - 1e-3 && a.maxY > y + 1e-3 && a.minY < y + 1 - 1e-3 && a.maxZ > z + 1e-3 && a.minZ < z + 1 - 1e-3) {
          // "pillar jumping": you may build a block under your own feet if there is room to be lifted onto it
          if (b === p && y === Math.floor(a.minY + 0.01) && !w.isSolid(x, y + 1, z) && !w.isSolid(x, y + 2, z)) { lift = true; continue; }
          return { ok: false, reason: 'player-in-way' };
        }
      }
    }
    // cost (Builder re-places a recently destroyed block of their own for free; Engineer pays less for mechanisms)
    let cost = it.cost * (it.kind === 'mech' && it.res === 'mech' ? p.mods.mechCost : 1);
    const rk = keyOf(x, y, z), rec = this.recentBreaks.get(rk);
    let repaired = false;
    if (p.mods.repairFree && rec && rec.id === def.id && rec.owner === p.index + 1 && this.clock - rec.time < 90) { cost = 0; repaired = true; this.recentBreaks.delete(rk); }
    if (!this.hasResource(p, it.res, cost)) return { ok: false, reason: 'no-resource' };

    let meta = 0;
    if (def.id === ID.piston) {                                       // pistons face where the player looks
      const l = p.lookDirection(), ax = Math.abs(l.x), ay = Math.abs(l.y), az = Math.abs(l.z);
      const f = ay > ax && ay > az ? (l.y > 0 ? 2 : 3) : ax > az ? (l.x > 0 ? 0 : 1) : (l.z > 0 ? 4 : 5);
      meta = f << 2;
    } else if (def.id === ID.door && against) {                      // doors copy the look of the block they are built against
      const ad = w.def(against.x, against.y, against.z);
      if (ad.shape === 'cube' && ad.opaque && ad.id !== ID.door) meta = ad.id << 8;
    } else if (def.shape === 'fluid') meta = 16 | def.fluid.maxLevel;
    this.spend(p, it.res, cost);
    this.cause = p.index;
    w.set(x, y, z, def.id, false, meta, p.index + 1);
    this.cause = null;
    if (lift) { p.pos.y = y + 1; p.prev.y = p.pos.y; p.vel.y = Math.max(p.vel.y, 0); }
    p.cooldowns.place = CONFIG.MINE.PLACE_COOLDOWN * p.mods.placeCooldown * (it.kind === 'mech' ? 0.8 : 1);
    this.emit({ type: 'blockPlaced', x, y, z, block: def, by: p.id, repaired });
    return { ok: true, repaired };
  }

  useBlock(p, { x, y, z }) {
    if (!this.withinReach(p, x, y, z)) return { ok: false, reason: 'too-far' };
    if (p.cooldowns.use > 0) return { ok: false, reason: 'cooldown' };
    p.cooldowns.use = 0.2;
    return this.redstone.use(p, x, y, z) ? { ok: true } : { ok: false, reason: 'nothing' };
  }

  ignite(p, { x, y, z, nx = 0, ny = 1, nz = 0 }) {
    const w = this.world;
    if (!this.withinReach(p, x, y, z)) return { ok: false, reason: 'too-far' };
    if (!this.canModify(p, x, y, z)) return { ok: false, reason: 'not-allowed' };
    if (w.get(x, y, z) === ID.tnt) { this.primeTnt(x, y, z, 3.2, p.index, 'tnt'); return { ok: true, tnt: true }; }
    if (w.get(x + nx, y + ny, z + nz) === AIR && (nx || ny || nz) && this.fire.ignite(x + nx, y + ny, z + nz, p.index)) { this.emit({ type: 'ignite', x: x + nx, y: y + ny, z: z + nz }); return { ok: true }; }
    return { ok: false, reason: 'nothing' };
  }

  attack(p, { targetId, tool = 'sword' }) {
    const t = TOOLS[tool];
    if (!t || t.dmg == null) return { ok: false, reason: 'bad-tool' };
    if (p.cooldowns.attack > 0) return { ok: false, reason: 'cooldown' };
    const target = this.playerMap.get(targetId) || this.mobs.find((m) => m.id === targetId);
    if (!target || !target.alive || target === p) return { ok: false, reason: 'no-target' };
    const e = p.eyePosition(), c = target.center();
    if (Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z) > t.reach + 0.9) return { ok: false, reason: 'too-far' };
    if (this.world.lineBlocked(e.x, e.y, e.z, c.x, c.y, c.z)) return { ok: false, reason: 'blocked' };
    p.cooldowns.attack = t.cd * p.mods.attackCooldown;
    p.swing = 1;
    let dmg = t.dmg * p.mods.meleeDamage;
    if (!p.onGround && p.vel.y < -2) dmg *= 1.4;                       // falling hit
    const dx = c.x - e.x, dz = c.z - e.z, l = Math.hypot(dx, dz) || 1;
    const dealt = this.damage(target, dmg, { kind: 'melee', by: p.index, direct: true });
    if (dealt !== null) {
      target.vel.x += dx / l * t.kb; target.vel.z += dz / l * t.kb; target.vel.y += 2.5 + t.kb * 0.18;
      this.emit({ type: 'hit', target, by: p.id, tool });
    }
    return { ok: true };
  }

  shoot(p, { charge = 1 }) {
    if (p.cooldowns.shoot > 0) return { ok: false, reason: 'cooldown' };
    const T = TOOLS.bow, ch = clamp(charge, 0.15, 1);
    p.cooldowns.shoot = T.cd; p.swing = 0.6;
    const e = p.eyePosition(), d = p.lookDirection(), speed = T.speed * (0.5 + 0.5 * ch);
    const a = new Arrow(this.nextId(), e.x + d.x * 0.6, e.y + d.y * 0.6, e.z + d.z * 0.6, d.x * speed, d.y * speed, d.z * speed, p.index, T.dmg * (0.4 + 0.6 * ch) * p.mods.meleeDamage);
    this.arrows.push(a);
    this.emit({ type: 'shoot', by: p.id, arrow: a });
    return { ok: true };
  }

  /* ------------------------ health and damage ------------------------ */
  /** Applies damage with class modifiers and phase rules. Returns the damage dealt, or null if nothing happened. */
  damage(target, amount, src) {
    if (!target.alive || amount <= 0) return null;
    const attacker = src.by != null && src.by >= 0 ? this.players[src.by] : null;
    if (target instanceof Mob) {
      target.health -= amount;
      if (attacker) attacker.stats.damageDealt += amount;
      if (target.health <= 0) { target.alive = false; this.emit({ type: 'mobDeath', mob: target }); if (attacker) { attacker.stats.score += 40; } }
      return amount;
    }
    if (attacker && attacker !== target) {
      if (!this.pvpEnabled()) return null;                              // no player-vs-player damage during BUILD
      if (src.direct && this.areAllies(attacker, target)) return null;   // allies cannot hit each other directly (explosions still can)
    }
    if (target.invulnerable > 0) return null;
    if (src.kind === 'explosion') amount *= target.mods.explosionTaken;
    else if (src.kind === 'fall') amount *= target.mods.fall;
    else if (HAZARD_KINDS.has(src.kind)) amount *= target.mods.hazardTaken;
    amount = Math.max(0, amount);
    if (this.phase === 'build' && target.health - amount <= 0) {       // nobody is eliminated while building: just respawn
      this.emit({ type: 'damage', target, amount, src });
      this.respawn(target);
      return amount;
    }
    const dealt = Math.min(amount, target.health);
    target.health -= amount; target.sinceDamage = 0;
    if (attacker && attacker !== target) {
      attacker.stats.damageDealt += dealt;
      target.lastHits.push({ by: attacker.index, time: this.clock });
      target.lastCause = { by: attacker.index, kind: src.kind, time: this.clock, tnt: !!src.tnt };
    }
    this.emit({ type: 'damage', target, amount: dealt, src });
    if (target.health <= 0) this.kill(target, src);
    return dealt;
  }

  kill(target, src) {
    target.health = 0; target.alive = false;
    target.stats.deaths++;
    let killerIdx = src.by != null && src.by >= 0 && src.by !== target.index ? src.by : -1;
    if (killerIdx < 0 && target.lastCause && this.clock - target.lastCause.time < 8) killerIdx = target.lastCause.by;   // pushed into lava, etc.
    const killer = killerIdx >= 0 ? this.players[killerIdx] : null;
    const viaTnt = src.tnt || (target.lastCause && target.lastCause.tnt && this.clock - target.lastCause.time < 8);
    let bounty = 0;
    if (killer && killer !== target) {
      killer.stats.kills++; killer.stats.score += 500;
      if (viaTnt && src.kind === 'explosion') killer.stats.tntKills++;
      if (target.bounty > 0) { bounty = target.bounty; killer.stats.score += bounty; }
      for (const h of target.lastHits) {                               // assists: anyone else who hurt the victim recently
        if (h.by === killer.index || this.clock - h.time > 8) continue;
        const a = this.players[h.by];
        if (a && !a.assisted) { a.stats.assists++; a.stats.score += 150; a.assisted = true; }
      }
      for (const q of this.players) q.assisted = false;
    }
    target.bounty = 0; target.bountyTime = 0; target.lastHits.length = 0;
    target.respawnTimer = this.mode === 'sandbox' ? CONFIG.MATCH.SANDBOX_RESPAWN : 0;
    this.emit({ type: 'death', victim: target, killer, kind: src.kind, detail: src.detail || null, bounty, tnt: viaTnt });
    this.winCheckClock = 0.4;
  }

  /* -------------------------- TNT and explosions -------------------------- */
  spawnTnt(x, y, z, fuse, owner, cause, vy) {
    const t = new PrimedTnt('t' + this.nextId(), x, y, z, fuse, owner == null || owner < 0 ? null : owner, cause);
    if (vy != null) { t.vel.x = t.vel.z = 0; t.vel.y = vy; }
    this.tnts.push(t);
    this.emit({ type: 'tntPrimed', tnt: t });
    return t;
  }
  /** Turns a TNT block into a lit TNT entity. `force` spawns it even without a block (landing groups, rain). */
  primeTnt(x, y, z, fuse, owner, cause, force = false) {
    const w = this.world;
    if (!force) {
      if (w.get(x, y, z) !== ID.tnt) return null;
      if (owner === undefined) owner = w.getOwner(x, y, z) - 1;
      w.set(x, y, z, AIR);
    }
    return this.spawnTnt(x + 0.5, y, z + 0.5, fuse, owner, cause);
  }

  /**
   * Explosion: destroy blocks by blast resistance, hurt and launch bodies, chain-prime TNT, then re-check structures.
   * opts: { radius, power, owner (slot), cause, fire, crater }
   */
  explode(x, y, z, opts = {}) {
    const w = this.world, radius = opts.radius || 4.2, power = opts.power || 1, owner = opts.owner == null ? null : opts.owner, cause = opts.cause || 'tnt';
    const R = Math.ceil(radius), destroyed = [], debris = [];
    this.cause = owner;
    this.suppressSupport = true;
    for (let dz = -R; dz <= R; dz++) for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
      const bx = Math.floor(x) + dx, by = Math.floor(y) + dy, bz = Math.floor(z) + dz;
      const dist = Math.hypot(bx + 0.5 - x, by + 0.5 - y, bz + 0.5 - z);
      if (dist > radius || !w.inBounds(bx, by, bz) || by < 1) continue;
      const id = w.get(bx, by, bz);
      if (id === AIR) continue;
      const def = BLOCKS[id];
      if (def.shape === 'fluid') continue;
      if (id === ID.tnt) { this.primeTnt(bx, by, bz, 0.25 + Math.random() * 0.7, owner, 'chain'); continue; }
      const crater = opts.crater && dist <= opts.crater && def.breakable;
      const str = 12 * power * (1 - Math.pow(dist / radius, 1.4)) * (0.85 + Math.random() * 0.3);
      if (crater || (def.breakable && str > def.blastResistance * this.landBlastMult(bx, bz))) {
        const wasOwned = w.getOwner(bx, by, bz) > 0;
        w.set(bx, by, bz, AIR);
        destroyed.push([bx, by, bz]);
        if (debris.length < 40 && Math.random() < 0.3) debris.push([bx, by, bz, id]);
        if (wasOwned) this.rememberBreak(bx, by, bz, id, w.getOwner(bx, by, bz));
      }
    }
    this.suppressSupport = false;
    const attacker = owner != null ? this.players[owner] : null;
    if (attacker) { attacker.stats.blocksDestroyed += destroyed.length; attacker.stats.score += destroyed.length; }

    // bodies: damage + launch
    const tntLike = TNT_CAUSES.has(cause);
    for (const b of this.bodies()) {
      const c = b.center(), d = Math.hypot(c.x - x, c.y - y, c.z - z);
      if (d > radius * 2) continue;
      const f = 1 - d / (radius * 2), exposure = w.lineBlocked(x, y, z, c.x, c.y, c.z) ? 0.35 : 1;
      const dmg = power * 70 * f * f * exposure;
      const l = d < 0.05 ? 1 : d, dirx = d < 0.05 ? 0 : (c.x - x) / l, diry = d < 0.05 ? 1 : (c.y - y) / l, dirz = d < 0.05 ? 0 : (c.z - z) / l;
      const kb = power * 20 * f * (exposure > 0.5 ? 1 : 0.6);
      b.vel.x += dirx * kb; b.vel.z += dirz * kb; b.vel.y += diry * kb + power * 6 * f;
      const hs = Math.hypot(b.vel.x, b.vel.z); if (hs > 34) { b.vel.x *= 34 / hs; b.vel.z *= 34 / hs; }
      if (dmg > 0.5) this.damage(b, dmg, { kind: 'explosion', by: owner, tnt: tntLike, direct: false, detail: cause });
    }
    for (const t of this.tnts) {                                       // loose TNT and falling groups get shoved too
      const d = Math.hypot(t.pos.x - x, t.pos.y - y, t.pos.z - z);
      if (d > 0.1 && d < radius * 2) { const f = 1 - d / (radius * 2); t.vel.x += (t.pos.x - x) / d * 14 * f * power; t.vel.z += (t.pos.z - z) / d * 14 * f * power; t.vel.y += 8 * f * power; }
    }
    for (const g of this.groups) { if (Math.hypot((g.bounds.minX + g.bounds.maxX) / 2 - x, g.bounds.minY - y, (g.bounds.minZ + g.bounds.maxZ) / 2 - z) < radius * 2) g.vel.y += 4 * power; }
    if (opts.fire) {                                                   // incendiary: light flammables around the crater
      for (const [bx, by, bz] of destroyed) if (Math.random() < 0.12) for (const d of DIRS6) { const n = BLOCKS[w.get(bx + d[0], by + d[1], bz + d[2])]; if (n.flammable) { this.fire.ignite(bx, by, bz, owner); break; } }
    } else if (cause === 'tnt' || cause === 'chain') {
      for (const [bx, by, bz] of destroyed) if (Math.random() < 0.04) for (const d of DIRS6) { if (BLOCKS[w.get(bx + d[0], by + d[1], bz + d[2])].flammable) { this.fire.ignite(bx, by, bz, owner); break; } }
    }
    this.cause = null;
    this.structure.enqueue(destroyed.map((c) => c.slice()), owner);
    for (const [bx, by, bz] of destroyed) this.checkAttachments(bx, by, bz);
    this.emit({ type: 'explosion', x, y, z, radius, power, count: destroyed.length, debris, cause, owner });
    return destroyed.length;
  }

  rememberBreak(x, y, z, id, owner) {
    this.recentBreaks.set(keyOf(x, y, z), { id, owner, time: this.clock });
    if (this.recentBreaks.size > 4000) { const first = this.recentBreaks.keys().next().value; this.recentBreaks.delete(first); }
  }

  collapseStrike() {
    const w = this.world;
    let best = null;
    for (const plot of this.plots) {
      if (plot.owner < 0 || !this.players[plot.owner] || !this.players[plot.owner].alive) continue;
      let top = -1, bx = 0, bz = 0;
      for (let z = plot.z - 10; z <= plot.z + 10; z++) for (let x = plot.x - 10; x <= plot.x + 10; x++) {
        for (let y = w.sizeY - 1; y > plot.baseY + 1; y--) if (w.getOwner(x, y, z) && w.isSolid(x, y, z)) { if (y > top && Math.random() < 0.9) { top = y; bx = x; bz = z; } break; }
      }
      if (top > 0 && (!best || Math.random() < 0.5)) best = { x: bx, z: bz, y: plot.baseY };
    }
    if (!best) return;
    this.emit({ type: 'collapseStrike', x: best.x + 0.5, y: best.y + 0.5, z: best.z + 0.5 });
    this.explode(best.x + 0.5, best.y + 0.5, best.z + 0.5, { radius: 3.4, power: 1.1, cause: 'disaster' });
  }

  /* ---------------------- block-change bookkeeping ---------------------- */
  onWorldChange(x, y, z, old, nw, oldMeta, oldOwner) {
    if (this.suspendTracking) return;
    this.fluids.onChange(x, y, z);
    this.fire.onChange(x, y, z, old, nw);
    this.redstone.onChange(x, y, z, old, nw);
    this.gravity.onChange(x, y, z);
    const od = BLOCKS[old], nd = BLOCKS[nw];
    if (old === nw) return;
    if (od.solid && od.shape !== 'fluid' && !(nd.solid && nd.shape !== 'fluid') && !this.suppressSupport) this.structure.enqueue([[x, y, z]], this.cause);
    if (!nd.solid) this.checkAttachments(x, y, z);
    // pistons: head and base stay in sync
    if (old === ID.piston_head) {
      const d = DIRS6[(oldMeta >> 2) & 7], bx = x - d[0], by = y - d[1], bz = z - d[2];
      if (this.world.get(bx, by, bz) === ID.piston) this.world.setMeta(bx, by, bz, this.world.getMeta(bx, by, bz) & ~1);
    } else if (old === ID.piston && (oldMeta & 1)) {
      const d = DIRS6[(oldMeta >> 2) & 7];
      if (this.world.get(x + d[0], y + d[1], z + d[2]) === ID.piston_head) this.world.set(x + d[0], y + d[1], z + d[2], AIR);
    }
    // base integrity bookkeeping (blocks owned by a player and standing above their pad)
    if (oldOwner > 0 && od.solid && od.shape !== 'fluid') this.integrityDelta(oldOwner - 1, x, y, z, -1);
    const no = this.world.getOwner(x, y, z);
    if (no > 0 && nd.solid && nd.shape !== 'fluid') this.integrityDelta(no - 1, x, y, z, +1);
  }
  integrityDelta(slot, x, y, z, delta) {
    const plot = this.plots[slot];
    if (!plot || y <= plot.baseY || Math.hypot(x + 0.5 - plot.x, z + 0.5 - plot.z) > PLOT_BASE_RADIUS) return;
    this.baseCount[slot] += delta;
    if (delta < 0 && !this.baseDestroyed[slot] && (this.phase === 'war' || this.phase === 'chaos' || this.phase === 'sandbox') && this.integrity(slot) < 5) {
      this.baseDestroyed[slot] = true;
      const by = this.cause != null && this.cause !== slot ? this.players[this.cause] : null;
      if (by) by.stats.score += 300;
      this.emit({ type: 'baseDestroyed', player: this.players[slot], by });
    }
  }
  computeBaseCounts() {
    const w = this.world;
    this.baseCount.fill(0);
    for (const plot of this.plots) {
      if (plot.owner < 0) continue;
      for (let y = plot.baseY + 1; y < w.sizeY; y++) for (let z = plot.z - PLOT_BASE_RADIUS; z <= plot.z + PLOT_BASE_RADIUS; z++) for (let x = plot.x - PLOT_BASE_RADIUS; x <= plot.x + PLOT_BASE_RADIUS; x++) {
        if (!w.inBounds(x, y, z) || w.getOwner(x, y, z) !== plot.owner + 1) continue;
        if (Math.hypot(x + 0.5 - plot.x, z + 0.5 - plot.z) <= PLOT_BASE_RADIUS && w.isSolid(x, y, z) && w.get(x, y, z) !== ID.water) this.baseCount[plot.owner]++;
      }
    }
  }
  /** 0..100 integrity of a player's base compared with when the war began. */
  integrity(slot) { if (this.phase === 'build' || this.phase === 'countdown') return 100; const ref = Math.max(this.baseRef[slot], 30); return clamp(Math.floor(100 * this.baseCount[slot] / ref), 0, 100); }
  /** Switches and rails that lose their floor pop off. */
  checkAttachments(x, y, z) {
    const w = this.world, above = w.get(x, y + 1, z);
    if (above !== AIR && BLOCKS[above].needsFloor && !w.isSolid(x, y, z)) { w.set(x, y + 1, z, AIR); this.emit({ type: 'debris', x, y: y + 1, z, block: BLOCKS[above] }); }
  }

  onGroupFormed(group, cause) {
    const attacker = cause != null && cause >= 0 ? this.players[cause] : null;
    let major = 0, majorN = 0, total = 0;
    for (const [owner, n] of group.owners) { total += n; if (n > majorN) { majorN = n; major = owner; } }
    if (attacker && total >= 12 && major - 1 !== attacker.index) { attacker.stats.structuresDestroyed++; attacker.stats.score += 100; }
    this.emit({ type: 'groupFormed', group, cause, structure: total >= 12 });
  }

  /* ------------------------- bodies and triggers ------------------------- */
  bodies() { const r = []; for (const p of this.players) if (p.alive) r.push(p); for (const m of this.mobs) if (m.alive) r.push(m); return r; }
  triggerBodies() {
    const r = [];
    for (const p of this.players) if (p.alive) r.push({ pos: p.pos, hw: p.halfWidth, h: p.height, living: true, player: p });
    for (const m of this.mobs) if (m.alive) r.push({ pos: m.pos, hw: m.halfWidth, h: m.height, living: true, player: null });
    for (const t of this.tnts) r.push({ pos: t.pos, hw: t.halfWidth, h: t.height, living: false, player: null });
    return r;
  }
  burnBodiesAt(x, y, z, cause) {
    for (const b of this.bodies()) { const a = b.aabb(); if (a.maxX > x && a.minX < x + 1 && a.maxY > y && a.minY < y + 1 && a.maxZ > z && a.minZ < z + 1) { b.burnTime = Math.max(b.burnTime, 4); b.burnCause = cause; } }
  }
  pushBodies(cells, d) {
    for (const b of this.bodies()) {
      const a = b.aabb();
      for (const [x, y, z] of cells) {
        if (a.maxX > x && a.minX < x + 1 && a.maxY > y && a.minY < y + 1.2 && a.maxZ > z && a.minZ < z + 1) { b.vel.x += d[0] * 13; b.vel.y += d[1] * 13 + 5; b.vel.z += d[2] * 13; break; }
      }
    }
  }
  fillLayer(y, id, meta) {
    const w = this.world;
    for (let z = 0; z < w.sizeZ; z++) for (let x = 0; x < w.sizeX; x++) if (w.get(x, y, z) === AIR) w.set(x, y, z, id, false, meta);
    this.emit({ type: 'layerFilled', y, id });
  }
  spawnMobAtEdge() {
    const w = this.world, side = Math.floor(Math.random() * 4), t = 4 + Math.random() * (w.sizeX - 8);
    const x = side === 0 ? 2 : side === 1 ? w.sizeX - 3 : t, z = side === 2 ? 2 : side === 3 ? w.sizeZ - 3 : t;
    const m = new Mob('m' + this.nextId(), x + 0.5, w.getSolidHeight(Math.floor(x), Math.floor(z)) + 1, z + 0.5);
    this.mobs.push(m);
    this.emit({ type: 'mobSpawn', mob: m });
  }

  /* ----------------------------- diplomacy ----------------------------- */
  proposeAlliance(p, { target }) {
    const t = this.playerMap.get(target);
    if (!this.allianceMode) return { ok: false, reason: 'mode' };
    if (!t || !t.alive || t === p || this.areAllies(p, t)) return { ok: false, reason: 'invalid' };
    if (this.proposals.some((q) => q.from === p && q.to === t)) return { ok: false, reason: 'pending' };
    this.proposals.push({ from: p, to: t, time: this.clock });
    this.emit({ type: 'proposal', from: p, to: t });
    return { ok: true };
  }
  respondAlliance(p, { from, accept }) {
    const q = this.proposals.find((r) => r.from.id === from && r.to === p);
    if (!q) return { ok: false, reason: 'none' };
    this.proposals = this.proposals.filter((r) => r !== q);
    if (!accept) { this.emit({ type: 'proposalDeclined', from: q.from, to: p }); return { ok: true }; }
    const t = this.nextTeam++;
    for (const x of this.players) if (x.team === q.from.team || x.team === p.team) x.team = t;
    this.emit({ type: 'allianceFormed', a: q.from, b: p });
    return { ok: true };
  }
  leaveAlliance(p) {
    const mates = this.players.filter((x) => this.areAllies(p, x));
    if (!mates.length) return { ok: false, reason: 'solo' };
    p.team = this.nextTeam++;
    this.emit({ type: 'allianceBroken', player: p, betrayal: mates.some((m) => m.alive) });
    return { ok: true };
  }
  placeBounty(p, { target, amount = 100 }) {
    const t = this.playerMap.get(target);
    if (!t || !t.alive || t === p || this.areAllies(p, t)) return { ok: false, reason: 'invalid' };
    if (p.stats.score < amount) return { ok: false, reason: 'no-points' };
    p.stats.score -= amount; t.bounty += amount; t.bountyTime = 120;
    this.emit({ type: 'bounty', from: p, target: t, amount });
    return { ok: true };
  }

  /* ----------------------------- main update ----------------------------- */
  update(dt) {
    if (this.phase === 'idle' || this.phase === 'ended') return;
    this.stepCount++; this.clock += dt; this.phaseTime += dt;
    this.updatePhase(dt);
    const env = { gravityScale: this.gravityScale };
    const live = this.phase !== 'countdown';

    for (const p of this.players) {
      if (!p.alive) { this.updateDead(p, dt); continue; }
      if (p.bot && live) p.bot.update(dt);
      this.tickPlayer(p, dt, env, live);
    }
    this.updateMobs(dt, env);
    this.updateTnts(dt, env);
    this.updateArrows(dt);
    this.updateGroups(dt);
    this.updateMeteors(dt);
    this.gravity.update(dt);
    this.structure.process(3);
    this.fluids.update(dt);
    this.fire.update(dt);
    this.redstone.update(dt);
    this.updateDrains(dt);
    if (this.phase === 'chaos') this.updateEvents(dt);
    if (live) { this.updateVault(dt); this.updateBounties(dt); this.updateProposals(); }
    this.winCheckClock -= dt;
    if (this.winCheckClock <= 0) { this.winCheckClock = 0.5; this.checkWinner(false); }
  }

  updatePhase(dt) {
    const M = CONFIG.MATCH;
    if (this.phase === 'countdown' && this.phaseTime >= M.COUNTDOWN) this.setPhase('build');
    else if (this.phase === 'build' && this.phaseTime >= M.BUILD) { this.setPhase('war'); for (let i = 0; i < 6; i++) { this.baseRef[i] = Math.max(this.baseCount[i], 1); } }
    else if (this.phase === 'war' && this.phaseTime >= M.WAR - M.CHAOS) { this.setPhase('chaos'); this.eventGap = 2; }
    else if (this.phase === 'chaos' && this.phaseTime >= M.CHAOS) this.checkWinner(true);
  }
  setPhase(name) {
    this.phase = name; this.phaseTime = 0;
    this.emit({ type: 'phase', phase: name });
  }
  /** Seconds left in the current phase (or in the whole match with `total`). */
  timeLeft(total = false) {
    const M = CONFIG.MATCH;
    const left = { countdown: M.COUNTDOWN, build: M.BUILD, war: M.WAR - M.CHAOS, chaos: M.CHAOS }[this.phase];
    if (left == null) return 0;
    const cur = Math.max(0, left - this.phaseTime);
    if (!total) return cur;
    return this.phase === 'build' ? cur + M.WAR : this.phase === 'war' ? cur + M.CHAOS : cur;
  }

  updateDead(p, dt) {
    if (this.mode === 'sandbox' && p.respawnTimer > 0) { p.respawnTimer -= dt; if (p.respawnTimer <= 0) this.respawn(p); }
  }

  tickPlayer(p, dt, env, live) {
    const wasAir = !p.onGround;
    p.update(dt, p.controls, this.world, env);
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    if (p.impactSpeed > CONFIG.HEALTH.FALL_SAFE && !p.inWater && !p.inLava && wasAir) {
      const dmg = (p.impactSpeed - CONFIG.HEALTH.FALL_SAFE) * CONFIG.HEALTH.FALL_DMG;
      this.damage(p, dmg, { kind: 'fall' });
      this.emit({ type: 'hardLanding', player: p, speed: p.impactSpeed });
    }
    if (!p.alive) return;
    if (p.inLava) { p.burnTime = 4; p.burnCause = null; this.damage(p, 22 * dt, { kind: 'lava', by: p.lastCause ? undefined : undefined }); }
    if (p.inWater) p.burnTime = 0;
    if (p.burnTime > 0) { p.burnTime -= dt; this.damage(p, 4 * dt, { kind: 'fire', by: p.burnCause != null ? p.burnCause : undefined, direct: false }); }
    if (!p.alive) return;
    // drowning: head under water for too long
    const headWater = this.world.get(Math.floor(p.pos.x), Math.floor(p.pos.y + p.eyeHeight), Math.floor(p.pos.z)) === ID.water;
    p.air = headWater ? Math.max(-1, (p.air == null ? 10 : p.air) - dt) : Math.min(10, (p.air == null ? 10 : p.air) + dt * 4);
    if (p.air <= 0) this.damage(p, 6 * dt, { kind: 'drown' });
    if (!p.alive) return;
    // stuck inside blocks (landed groups, pistons): pop up, otherwise suffocate
    if (this.world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.9), Math.floor(p.pos.z))) {
      let moved = false;
      for (let k = 1; k <= 4 && !moved; k++) if (!this.world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.9 + k), Math.floor(p.pos.z)) && !this.world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y + 1.9 + k), Math.floor(p.pos.z))) { p.pos.y += k; moved = true; }
      if (!moved) this.damage(p, 8 * dt, { kind: 'crush', detail: 'suffocation' });
    }
    p.sinceDamage += dt;
    if (p.alive && p.health < p.maxHealth && p.sinceDamage > CONFIG.HEALTH.REGEN_DELAY * p.mods.regenDelay) p.health = Math.min(p.maxHealth, p.health + CONFIG.HEALTH.REGEN_RATE * p.mods.regenRate * dt);
    if (live && (this.phase === 'war' || this.phase === 'chaos')) { p.stats.surviveSeconds += dt; p.stats.score += 10 * dt; }
  }

  updateMobs(dt, env) {
    for (const m of this.mobs) {
      if (!m.alive) continue;
      let target = null, best = 1e9;
      for (const p of this.players) if (p.alive) { const d = Math.hypot(p.pos.x - m.pos.x, p.pos.z - m.pos.z); if (d < best) { best = d; target = p; } }
      m.update(dt, target, this.world, env);
      if (target && best < 1.5 && Math.abs(target.pos.y - m.pos.y) < 1.8 && m.attackCd <= 0) {
        m.attackCd = 0.9; m.swing = 1;
        const dx = target.pos.x - m.pos.x, dz = target.pos.z - m.pos.z, l = Math.hypot(dx, dz) || 1;
        this.damage(target, 6, { kind: 'mob', by: undefined, detail: 'mob' });
        target.vel.x += dx / l * 4; target.vel.z += dz / l * 4; target.vel.y += 3;
      }
      if (m.burnTime > 0) { m.burnTime -= dt; this.damage(m, 3 * dt, { kind: 'fire' }); }
      if (m.inLava) this.damage(m, 30 * dt, { kind: 'lava' });
      if (m.life > 90 || m.pos.y < -5) m.alive = false;
    }
    if (this.mobs.length && this.stepCount % 120 === 0) this.mobs = this.mobs.filter((m) => m.alive);
  }

  updateTnts(dt, env) {
    for (const t of this.tnts) {
      if (!t.alive) continue;
      t.update(dt, this.world, env);
      if (t.inLava) t.fuse = Math.min(t.fuse, 0.05);
      if (t.fuse <= 0) {
        t.alive = false;
        const c = t.center();
        this.explode(c.x, c.y, c.z, { radius: 4.2, power: 1, owner: t.owner, cause: t.cause === 'rain' ? 'disaster' : t.cause === 'trap' || t.cause === 'chain' || t.cause === 'collapse' ? t.cause : 'tnt' });
      }
    }
    if (this.tnts.length && this.tnts.some((t) => !t.alive)) this.tnts = this.tnts.filter((t) => t.alive);
  }

  updateArrows(dt) {
    const w = this.world;
    for (const a of this.arrows) {
      if (!a.alive) continue;
      a.age += dt;
      if (a.stuck) { if (a.age > 12) a.alive = false; continue; }
      a.vel.y -= 14 * dt;
      const dx = a.vel.x * dt, dy = a.vel.y * dt, dz = a.vel.z * dt, n = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / 0.35));
      for (let i = 0; i < n && !a.stuck && a.alive; i++) {
        a.pos.x += dx / n; a.pos.y += dy / n; a.pos.z += dz / n;
        if (w.isSolid(Math.floor(a.pos.x), Math.floor(a.pos.y), Math.floor(a.pos.z))) { a.stuck = true; a.age = 8; this.emit({ type: 'arrowStuck', arrow: a }); break; }
        for (const b of this.bodies()) {
          if (b instanceof Player && b.index === a.owner && a.age < 0.4) continue;
          const bb = b.aabb(), m = 0.18;
          if (a.pos.x > bb.minX - m && a.pos.x < bb.maxX + m && a.pos.y > bb.minY - m && a.pos.y < bb.maxY + m && a.pos.z > bb.minZ - m && a.pos.z < bb.maxZ + m) {
            const dealt = this.damage(b, a.damage, { kind: 'arrow', by: a.owner, direct: true });
            if (dealt !== null) { const s = Math.hypot(a.vel.x, a.vel.z) || 1; b.vel.x += a.vel.x / s * 3; b.vel.z += a.vel.z / s * 3; b.vel.y += 1.5; this.emit({ type: 'hit', target: b, by: a.owner, tool: 'bow' }); a.alive = false; }
            break;
          }
        }
      }
      if (a.pos.y < -5) a.alive = false;
    }
    if (this.arrows.length && this.stepCount % 60 === 0) this.arrows = this.arrows.filter((a) => a.alive);
  }

  updateGroups(dt) {
    for (const g of this.groups) {
      if (!g.alive) continue;
      g.update(dt, this);
      if (!g.alive) continue;
      this.crush(g);
    }
    if (this.groups.length && this.groups.some((g) => !g.alive)) this.groups = this.groups.filter((g) => g.alive);
  }
  /** Falling blocks hurt whatever they land on. */
  crush(g) {
    const b0 = g.bounds;
    for (const b of this.bodies()) {
      if (g.hit.has(b.id)) continue;
      const a = b.aabb();
      if (a.maxX < b0.minX || a.minX > b0.maxX || a.maxY < b0.minY + g.off || a.minY > b0.maxY + g.off || a.maxZ < b0.minZ || a.minZ > b0.maxZ) continue;
      for (const c of g.cells) {
        const cy = c.y + g.off;
        if (a.maxX > c.x && a.minX < c.x + 1 && a.maxY > cy && a.minY < cy + 1 && a.maxZ > c.z && a.minZ < c.z + 1) {
          g.hit.add(b.id);
          const speed = Math.abs(g.vel.y), dmg = clamp(6 + Math.sqrt(g.cells.length) * speed * 0.55, 6, 90);
          this.damage(b, dmg, { kind: 'crush', by: g.cause, detail: g.cells.length > 6 ? 'collapse' : 'block' });
          b.vel.y = Math.min(b.vel.y, -4);
          break;
        }
      }
    }
  }

  updateMeteors(dt) {
    for (const pm of this.pendingMeteors) {
      pm.t -= dt;
      if (pm.t <= 0 && !pm.done) { pm.done = true; const m = new Meteor(this.nextId(), pm.x, pm.y, pm.z); this.meteors.push(m); this.emit({ type: 'meteorLaunch', meteor: m }); }
    }
    if (this.pendingMeteors.length && this.pendingMeteors.every((p) => p.done)) this.pendingMeteors = [];
    const w = this.world;
    for (const m of this.meteors) {
      if (!m.alive) continue;
      m.age += dt;
      m.pos.x += m.vel.x * dt; m.pos.y += m.vel.y * dt; m.pos.z += m.vel.z * dt;
      const hit = w.isSolid(Math.floor(m.pos.x), Math.floor(m.pos.y), Math.floor(m.pos.z)) || m.pos.y <= m.target.y || m.age > 6;
      if (hit) {
        m.alive = false;
        this.explode(m.pos.x, Math.max(m.pos.y, m.target.y), m.pos.z, { radius: 6.5, power: 2.2, cause: 'disaster', fire: true, crater: 3.4 });
        this.emit({ type: 'meteorImpact', x: m.pos.x, y: m.pos.y, z: m.pos.z });
      }
    }
    if (this.meteors.length && this.meteors.some((m) => !m.alive)) this.meteors = this.meteors.filter((m) => m.alive);
  }

  updateDrains(dt) {
    if (!this.drains.length) return;
    const w = this.world;
    for (const d of this.drains) {
      d.acc += dt;
      if (d.acc < 0.3) continue;
      d.acc = 0;
      for (let z = 0; z < w.sizeZ; z++) for (let x = 0; x < w.sizeX; x++) if (w.get(x, d.y, z) === d.id && (w.getMeta(x, d.y, z) & 32)) w.set(x, d.y, z, AIR);
      d.y--;
    }
    this.drains = this.drains.filter((d) => d.y > 1);
    if (!this.drains.length) this.emit({ type: 'drained' });
  }

  updateEvents(dt) {
    if (!this.event) {
      this.eventGap -= dt;
      if (this.eventGap > 0) return;
      const pool = EVENT_LIST.filter((e) => e !== this.lastEventType);
      const type = pool[Math.floor(Math.random() * pool.length)];
      this.startEvent(type);
      return;
    }
    const ev = this.event, def = EVENT_DEFS[ev.type];
    ev.t += dt;
    if (ev.state === 'start' && ev.t >= 1.5) { ev.state = 'active'; this.emit({ type: 'event', phase: 'active', name: def.name, id: ev.type }); }
    if (ev.state === 'active' && def.tick) def.tick(this, ev, dt);
    if (ev.t >= def.duration) { if (def.end) def.end(this, ev); this.emit({ type: 'event', phase: 'end', name: def.name, id: ev.type }); this.lastEventType = ev.type; this.event = null; this.eventGap = 4; }
  }
  startEvent(type) {
    const def = EVENT_DEFS[type];
    this.event = { type, name: def.name, state: 'start', t: 0, duration: def.duration, data: {} };
    if (def.start) def.start(this, this.event);
    this.emit({ type: 'event', phase: 'start', name: def.name, id: type });
  }

  /* ---------------------------- objective vault ---------------------------- */
  updateVault(dt) {
    const v = this.vault, m = this.map.vault;
    if (v.cooldown > 0) { v.cooldown -= dt; v.progress = 0; v.capturing = false; return; }
    const inside = this.players.filter((p) => p.alive && Math.hypot(p.pos.x - m.x, p.pos.z - m.z) <= m.radius && p.pos.y > m.y - 3.5 && p.pos.y < m.y + 3);
    const teams = new Set(inside.map((p) => p.team));
    if (teams.size === 1) {
      const team = inside[0].team;
      if (v.team !== team) { v.team = team; v.progress = 0; }
      v.progress += dt / 10; v.capturing = true;
      if (v.progress >= 1) {
        v.progress = 0; v.cooldown = 45; v.capturing = false; v.captured++;
        for (const p of inside) {
          p.stats.objectives++; p.stats.score += 250;
          for (const [k, a] of Object.entries({ tnt: 2, iron: 3, mech: 4, lava: 1, water: 1, glass: 4 })) this.addResource(p, k, a);
        }
        this.emit({ type: 'vaultCaptured', players: inside });
      }
    } else {
      v.capturing = false;
      v.progress = Math.max(0, v.progress - dt / 6);
    }
  }
  updateBounties(dt) { for (const p of this.players) if (p.bounty > 0) { p.bountyTime -= dt; if (p.bountyTime <= 0) { p.bounty = 0; this.emit({ type: 'bountyExpired', target: p }); } } }
  updateProposals() { this.proposals = this.proposals.filter((q) => q.from.alive && q.to.alive && this.clock - q.time < 60); }

  /* ------------------------------ win / results ------------------------------ */
  alivePlayers() { return this.players.filter((p) => p.alive); }
  checkWinner(timeUp) {
    if (this.phase === 'sandbox' || this.phase === 'ended' || this.phase === 'countdown' || this.phase === 'idle') return;
    if (this.phase === 'build' && !timeUp) return;
    const alive = this.alivePlayers(), teams = new Set(alive.map((p) => p.team));
    if (teams.size <= 1 && this.players.length > 1) {
      if (alive.length > 1 && this.allianceMode && !timeUp) return;      // surviving allies keep playing: betrayal is still possible
      if (alive.length <= 1 || !this.allianceMode) { this.endMatch(alive, alive.length ? 'last-standing' : 'draw'); return; }
    }
    if (timeUp) {
      const score = new Map();
      for (const p of alive) score.set(p.team, (score.get(p.team) || 0) + p.stats.score);
      let best = null, bestScore = -1;
      for (const [team, s] of score) if (s > bestScore) { best = team; bestScore = s; }
      this.endMatch(alive.filter((p) => p.team === best), 'time');
    }
  }
  endMatch(winners, reason) {
    if (this.phase === 'ended') return;
    if (this.event) { const def = EVENT_DEFS[this.event.type]; if (def.end) def.end(this, this.event); this.event = null; }
    this.gravityScale = 1; this.darkness = 0;
    this.phase = 'ended'; this.winnerTeam = winners.length ? winners[0].team : null;
    const win = new Set(winners);
    const results = this.players.map((p) => {
      const won = win.has(p);
      return {
        player: p, won, ...p.stats, score: Math.round(p.stats.score),
        xp: Math.round(p.stats.score * 0.25 + (won ? 400 : 0) + p.stats.kills * 50 + p.stats.structuresDestroyed * 25),
        coins: Math.round(p.stats.score * 0.1 + (won ? 300 : 0) + p.stats.kills * 25),
      };
    }).sort((a, b) => (b.won - a.won) || (b.score - a.score));
    this.results = { winners, reason, rows: results };
    this.emit({ type: 'matchEnd', winners, reason, results });
  }

  scoreboard() {
    return this.players.slice().sort((a, b) => b.stats.score - a.stats.score);
  }
  /** Render-friendly view of everything that moves (used by the replay recorder). */
  snapshot(alpha = 1) {
    const L = (b, k) => lerp(b.prev[k], b.pos[k], alpha);
    return {
      time: this.clock,
      players: this.players.map((p) => ({ id: p.id, index: p.index, name: p.name, color: p.color, classId: p.classId, alive: p.alive, health: p.health, x: L(p, 'x'), y: L(p, 'y'), z: L(p, 'z'), yaw: p.yaw, pitch: p.pitch, walk: p.walkPhase, swing: p.swing, crouch: p.crouching, burning: p.burnTime > 0, isBot: p.isBot, team: p.team, bounty: p.bounty })),
      tnts: this.tnts.map((t) => ({ x: L(t, 'x'), y: L(t, 'y'), z: L(t, 'z'), fuse: t.fuse })),
      groups: this.groups.map((g) => ({ g, off: g.off })),
      arrows: this.arrows.filter((a) => a.alive).map((a) => ({ x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: a.yaw, pitch: a.pitch })),
      mobs: this.mobs.filter((m) => m.alive).map((m) => ({ x: L(m, 'x'), y: L(m, 'y'), z: L(m, 'z'), yaw: m.yaw, walk: m.walkPhase, swing: m.swing })),
      meteors: this.meteors.map((m) => ({ x: m.pos.x, y: m.pos.y, z: m.pos.z })),
    };
  }
}

/* ============================== 12. BOTS ================================ */
/**
 * Bots drive their Player exactly like a human would: they only set controls/yaw/pitch and send requests to
 * GameServer.handle(). No bot code touches the world directly, so bots obey every rule (reach, phase, resources).
 */
const TAU = Math.PI * 2;
const angleDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

class Bot {
  constructor(server, player) {
    this.s = server; this.p = player;
    const r = Math.random;
    this.aggression = 0.45 + r() * 0.5;        // how eagerly it leaves home to fight
    this.greed = r();                          // interest in the vault
    this.loyalty = r();                        // betrayal chance when only allies remain
    this.thinkClock = r() * 0.3;
    this.mine = null;                          // {x,y,z,t,need}
    this.queue = null; this.queueIndex = 0; this.buildDone = false;
    this.mode = 'idle'; this.target = null; this.goal = null;
    this.flee = null;                          // {x,z,t}
    this.detour = 0; this.detourT = 0;
    this.stuckClock = 0; this.lastX = 0; this.lastZ = 0;
    this.tntCooldown = 6 + r() * 10; this.shootCharge = 0; this.strafe = r() < 0.5 ? 1 : -1; this.strafeT = 0;
    this.gatherTarget = null; this.proposalT = 0; this.betrayT = -1;
  }

  /* ---------- helpers ---------- */
  face(tx, ty, tz, snap = false) {
    const p = this.p, e = p.eyePosition(), dx = tx - e.x, dy = ty - e.y, dz = tz - e.z;
    const yaw = Math.atan2(-dx, -dz), pitch = Math.atan2(dy, Math.hypot(dx, dz));
    p.yaw = snap ? yaw : p.yaw + clamp(angleDiff(p.yaw, yaw), -0.22, 0.22);
    p.pitch = snap ? pitch : p.pitch + clamp(pitch - p.pitch, -0.2, 0.2);
  }
  enemies() { return this.s.players.filter((q) => q.alive && q !== this.p && !this.s.areAllies(q, this.p)); }
  dist(q) { return Math.hypot(q.pos.x - this.p.pos.x, q.pos.z - this.p.pos.z); }
  hasLOS(q) { const e = this.p.eyePosition(), c = q.center(); return !this.s.world.lineBlocked(e.x, e.y, e.z, c.x, c.y, c.z); }
  dangerous(x, y, z) { const id = this.s.world.get(x, y, z); return id === ID.lava || id === ID.fire; }
  /** First free cell above the ground in this column. */
  groundY(x, z) { return this.s.world.getSolidHeight(x, z) + 1; }

  /* ---------- movement ---------- */
  /** Steers toward (x, z), jumping steps, digging walls and bridging gaps. `stopAt` = distance at which it stops. */
  walkTo(x, z, dt, stopAt = 0.6, allowDig = true, goalY = null) {
    const p = this.p, w = this.s.world, c = p.controls;
    const dx = x - p.pos.x, dz = z - p.pos.z, d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    this.detourT -= dt; if (this.detourT <= 0) this.detour = 0;
    const want = Math.atan2(-dx, -dz) + this.detour;
    p.yaw += clamp(angleDiff(p.yaw, want), -0.2, 0.2);
    p.pitch += (0 - p.pitch) * 0.2;
    c.forward = true;
    const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const ax = Math.floor(p.pos.x + fx * 0.75), az = Math.floor(p.pos.z + fz * 0.75), fy = Math.floor(p.pos.y + 0.05);
    if (p.inWater || p.inLava) c.jump = true;
    // obstacle in front?
    if (w.isSolid(ax, fy, az)) {
      const canStep = !w.isSolid(ax, fy + 1, az) && !w.isSolid(ax, fy + 2, az) && !w.isSolid(Math.floor(p.pos.x), fy + 2, Math.floor(p.pos.z));
      if (canStep) { if (p.onGround) c.jump = true; }
      else if (goalY != null && goalY - p.pos.y > 1.6 && this.pillarUp(dt)) { /* climbing over the wall */ }
      else if (allowDig) this.digAhead(ax, fy, az, dt);
      else { this.detour = (Math.random() < 0.5 ? 1 : -1) * 1.3; this.detourT = 0.8; }
    } else if (w.isSolid(ax, fy + 1, az)) {
      if (allowDig) this.digAhead(ax, fy + 1, az, dt); else { c.crouch = false; }
    } else {
      this.mine = null;
      // gap / drop / hazard check
      let drop = 0;
      while (drop < 6 && !w.isSolid(ax, fy - 1 - drop, az)) drop++;
      const landing = w.get(ax, fy - 1 - drop, az);
      if (this.dangerous(ax, fy, az) || this.dangerous(ax, fy - 1, az) || landing === ID.lava || (drop >= 5)) {
        if (drop >= 5 && this.s.hasResource(p, 'earth', 1) && this.s.canModify(p, ax, fy - 1, az) && p.cooldowns.place <= 0 && !this.dangerous(ax, fy, az)) {
          this.s.handle(p.id, { type: 'place', x: ax, y: fy - 1, z: az, item: 'dirt' });
        } else { c.forward = drop < 5 && !this.dangerous(ax, fy, az); this.detour = (Math.random() < 0.5 ? 1 : -1) * 1.5; this.detourT = 0.9; }
      }
    }
    // stuck watchdog
    this.stuckClock += dt;
    if (this.stuckClock > 0.9) {
      const moved = Math.hypot(p.pos.x - this.lastX, p.pos.z - this.lastZ);
      if (moved < 0.35 && !this.mine) { this.detour = (Math.random() < 0.5 ? 1 : -1) * (0.9 + Math.random()); this.detourT = 1; if (p.onGround) c.jump = true; }
      this.stuckClock = 0; this.lastX = p.pos.x; this.lastZ = p.pos.z;
    }
    return false;
  }

  digDown(dt) {
    const p = this.p, s = this.s, w = s.world, fx = Math.floor(p.pos.x), fy = Math.floor(p.pos.y - 0.05), fz = Math.floor(p.pos.z);
    const below = w.get(fx, fy, fz);
    if (below === AIR || !BLOCKS[below].breakable || !s.canModify(p, fx, fy, fz)) return;
    for (let k = 1; k < 8; k++) { const id = w.get(fx, fy - k, fz); if (id === ID.lava || id === ID.water) return; if (w.isSolid(fx, fy - k, fz)) break; }
    this.face(fx + 0.5, fy + 0.5, fz + 0.5, true);
    if (!this.mine || this.mine.y !== fy || this.mine.x !== fx || this.mine.z !== fz) this.mine = { x: fx, y: fy, z: fz, t: 0, need: mineTime(BLOCKS[below], 'pickaxe', p.mods) };
    this.mine.t += dt;
    if (this.mine.t >= this.mine.need) { s.handle(p.id, { type: 'break', x: fx, y: fy, z: fz }); this.mine = null; }
  }
  /** Builds a block under its own feet (pillar jumping), mining the ceiling first if needed. Returns true if it acted. */
  pillarUp(dt) {
    const p = this.p, s = this.s, w = s.world, c = p.controls;
    const fx = Math.floor(p.pos.x), fy = Math.floor(p.pos.y + 0.01), fz = Math.floor(p.pos.z);
    if (!p.onGround) return true;
    if (w.isSolid(fx, fy + 2, fz)) {                                    // ceiling in the way: dig up first
      if (!s.canModify(p, fx, fy + 2, fz) || !BLOCKS[w.get(fx, fy + 2, fz)].breakable) return false;
      this.face(fx + 0.5, fy + 2.5, fz + 0.5, true);
      if (!this.mine || this.mine.y !== fy + 2 || this.mine.x !== fx || this.mine.z !== fz) this.mine = { x: fx, y: fy + 2, z: fz, t: 0, need: mineTime(BLOCKS[w.get(fx, fy + 2, fz)], 'pickaxe', p.mods) };
      this.mine.t += dt;
      if (this.mine.t >= this.mine.need) { s.handle(p.id, { type: 'break', x: fx, y: fy + 2, z: fz }); this.mine = null; }
      return true;
    }
    const item = this.pickMaterial();
    if (!item || p.cooldowns.place > 0) return !!item;
    c.forward = false;
    this.face(p.pos.x, p.pos.y - 3, p.pos.z, true);
    s.handle(p.id, { type: 'place', x: fx, y: fy, z: fz, item });
    return true;
  }

  digAhead(x, y, z, dt) {
    const p = this.p, w = this.s.world, c = p.controls;
    // prefer the head-height block, then the foot block
    let ty = y;
    if (w.isSolid(x, y + 1, z) && BLOCKS[w.get(x, y + 1, z)].breakable) ty = y + 1;
    if (ty === y && !w.isSolid(x, y, z)) ty = y + 1;
    const id = w.get(x, ty, z), def = BLOCKS[id];
    if (!def.breakable || id === AIR) { this.detour = 1.4; this.detourT = 1; this.mine = null; return; }
    // blow through someone else's wall instead of nibbling at it
    if (this.s.phase !== 'build' && this.tntCooldown <= 0 && this.s.hasResource(p, 'tnt', 1) && w.getOwner(x, ty, z) && w.getOwner(x, ty, z) !== p.index + 1 && this.tryBreachTnt(x, y, z)) return;
    if (!this.s.canModify(p, x, ty, z)) { this.detour = 1.4; this.detourT = 1; this.mine = null; return; }
    c.forward = false;
    if (!this.mine || this.mine.x !== x || this.mine.y !== ty || this.mine.z !== z) this.mine = { x, y: ty, z, t: 0, need: mineTime(def, 'pickaxe', p.mods) };
    this.face(x + 0.5, ty + 0.5, z + 0.5);
    this.mine.t += dt;
    if (this.mine.t >= this.mine.need) {
      const r = this.s.handle(p.id, { type: 'break', x, y: ty, z });
      if (!r.ok) { this.detour = 1.4; this.detourT = 1; }
      this.mine = null;
    }
  }

  /* ---------- TNT tactics ---------- */
  /** Drops a TNT block on the ground in front of a wall, lights it and runs. */
  tryBreachTnt(wx, wy, wz) {
    const p = this.p, w = this.s.world, fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
    const px = Math.floor(p.pos.x + fx * 1.2), pz = Math.floor(p.pos.z + fz * 1.2), py = Math.floor(p.pos.y);
    if (w.get(px, py, pz) !== AIR) return false;
    const r = this.s.handle(p.id, { type: 'place', x: px, y: py, z: pz, item: 'tnt' });
    if (!r.ok) return false;
    this.s.handle(p.id, { type: 'ignite', x: px, y: py, z: pz });
    this.startFlee(px + 0.5, pz + 0.5, 4.2);
    this.tntCooldown = 14 + Math.random() * 12;
    return true;
  }
  startFlee(fromX, fromZ, seconds) {
    const p = this.p, dx = p.pos.x - fromX, dz = p.pos.z - fromZ, l = Math.hypot(dx, dz) || 1;
    this.flee = { x: p.pos.x + dx / l * 18, z: p.pos.z + dz / l * 18, t: seconds };
    this.mine = null;
  }

  /* ---------- building ---------- */
  planBuild() {
    const s = this.s, w = s.world, p = this.p, plot = s.plotOf(p), half = 4, q = [];
    const cx = Math.floor(plot.x), cz = Math.floor(plot.z);
    const dxm = s.map.center.x - plot.x, dzm = s.map.center.z - plot.z;
    const axisX = Math.abs(dxm) > Math.abs(dzm), sign = (axisX ? dxm : dzm) > 0 ? 1 : -1;
    const gap = axisX ? [cx + sign * half, cz] : [cx, cz + sign * half];
    this.gap = gap; this.out = axisX ? [sign, 0] : [0, sign];
    const ring = [];
    for (let x = -half; x <= half; x++) for (let z = -half; z <= half; z++) if (Math.max(Math.abs(x), Math.abs(z)) === half) ring.push([cx + x, cz + z]);
    ring.sort((a, b) => Math.atan2(a[1] - cz, a[0] - cx) - Math.atan2(b[1] - cz, b[0] - cx));
    for (let layer = 0; layer < 3; layer++) for (const [x, z] of ring) {
      if (x === gap[0] && z === gap[1] && layer < 2) continue;
      q.push({ kind: 'wall', x, z, layer, y0: this.groundY(x, z) });
    }
    // gate trap: a pressure plate outside the gap with a TNT block on each side of it
    const px = gap[0] + this.out[0] * 3, pz = gap[1] + this.out[1] * 3, sx = this.out[1], sz = this.out[0];
    q.push({ kind: 'plate', x: px, z: pz }, { kind: 'tnt', x: px + sx, z: pz + sz }, { kind: 'tnt', x: px - sx, z: pz - sz });
    for (let layer = 3; layer < 5; layer++) for (const [x, z] of ring) q.push({ kind: 'wall', x, z, layer, y0: this.groundY(x, z) });
    this.queue = q; this.queueIndex = 0;
  }
  pickMaterial() {
    const p = this.p, s = this.s;
    let best = null, bestAmt = 0;
    for (const [item, res] of [['stone', 'stone'], ['wood', 'wood'], ['dirt', 'earth'], ['iron', 'iron']]) {
      if (res === 'iron' && (p.resources.iron || 0) < 12) continue;
      const a = s.unlimited ? 999 : (p.resources[res] || 0);
      if (a >= 1 && a > bestAmt) { best = item; bestAmt = a; }
    }
    return best;
  }
  buildUpdate(dt) {
    const p = this.p, s = this.s, w = s.world;
    if (!this.queue) this.planBuild();
    if (this.queueIndex >= this.queue.length) {
      if (!this.gather(dt, 18)) { /* idle near home */ this.walkTo(s.plotOf(p).x, s.plotOf(p).z, dt, 2, false); }
      return;
    }
    const job = this.queue[this.queueIndex];
    if (this.jobRef !== job) { this.jobRef = job; this.jobT = 0; }
    this.jobT += dt;
    if (this.jobT > 6) { this.queueIndex++; return; }                     // unreachable or blocked: move on
    let y, item;
    if (job.kind === 'wall') { y = job.y0 + job.layer; item = this.pickMaterial(); }
    else { y = this.groundY(job.x, job.z); item = job.kind; }
    if (job.kind === 'wall') {                                           // skip cells that are already filled
      if (w.isSolid(job.x, y, job.z)) { this.queueIndex++; return; }
    } else if (w.get(job.x, y, job.z) !== AIR) { this.queueIndex++; return; }
    if (job.kind === 'tnt' && !s.hasResource(p, 'tnt', 1)) { this.queueIndex++; return; }
    if (job.kind === 'plate' && !s.hasResource(p, 'mech', 1 * p.mods.mechCost)) { this.queueIndex++; return; }
    if (!item) { if (!this.gather(dt, 40)) this.queueIndex++; return; }   // out of materials: collect more
    const e = p.eyePosition(), dist = Math.hypot(job.x + 0.5 - e.x, y + 0.5 - e.y, job.z + 0.5 - e.z);
    if (dist > 4.8) { this.walkTo(job.x + 0.5, job.z + 0.5, dt, 3.4, false); return; }
    this.face(job.x + 0.5, y + 0.5, job.z + 0.5);
    if (p.cooldowns.place > 0) return;
    const r = s.handle(p.id, { type: 'place', x: job.x, y, z: job.z, item });
    if (r.ok || r.reason !== 'cooldown') this.queueIndex++;
    if (!r.ok && r.reason === 'player-in-way') { this.queueIndex--; this.detour = 1; this.detourT = 0.5; p.controls.forward = true; }
  }

  /* ---------- gathering ---------- */
  findGatherTarget() {
    const p = this.p, w = this.s.world, bx = Math.floor(p.pos.x), by = Math.floor(p.pos.y), bz = Math.floor(p.pos.z);
    const needWood = (p.resources.wood || 0) < 25, needStone = (p.resources.stone || 0) < 25, needIron = (p.resources.iron || 0) < 6;
    let best = null, bestScore = 1e9;
    for (let dz = -11; dz <= 11; dz++) for (let dx = -11; dx <= 11; dx++) for (let dy = -4; dy <= 5; dy++) {
      const x = bx + dx, y = by + dy, z = bz + dz;
      if (!w.inBounds(x, y, z)) continue;
      const id = w.get(x, y, z);
      if (id === AIR || w.getOwner(x, y, z)) continue;
      let pref = 0;
      if (id === ID.log) pref = needWood ? 0 : 6;
      else if (id === ID.iron_ore) pref = needIron ? -2 : 7;
      else if (id === ID.stone) pref = needStone ? 1 : 7;
      else if (id === ID.dirt || id === ID.grass || id === ID.sand) pref = 5;
      else continue;
      if (!w.isSolid(x, y + 1, z) || true) {
        const open = !w.isSolid(x, y + 1, z) || !w.isSolid(x + 1, y, z) || !w.isSolid(x - 1, y, z) || !w.isSolid(x, y, z + 1) || !w.isSolid(x, y, z - 1);
        if (!open) continue;
      }
      const score = Math.hypot(dx, dz, dy * 1.5) + pref * 2;
      if (score < bestScore) { bestScore = score; best = { x, y, z }; }
    }
    return best;
  }
  /** Mines the nearest useful block. Returns false when it has nothing to do (or after `maxSeconds`). */
  gather(dt, maxSeconds) {
    const p = this.p, w = this.s.world;
    this.gatherT = (this.gatherT || 0) + dt;
    if (this.gatherT > maxSeconds) { this.gatherT = 0; return false; }
    if (!this.gatherTarget || w.get(this.gatherTarget.x, this.gatherTarget.y, this.gatherTarget.z) === AIR) this.gatherTarget = this.findGatherTarget();
    const t = this.gatherTarget;
    if (!t) return false;
    const e = p.eyePosition(), d = Math.hypot(t.x + 0.5 - e.x, t.y + 0.5 - e.y, t.z + 0.5 - e.z);
    if (d > 4.6) { this.walkTo(t.x + 0.5, t.z + 0.5, dt, 3.2, true); return true; }
    const def = BLOCKS[w.get(t.x, t.y, t.z)];
    if (!this.mine || this.mine.x !== t.x || this.mine.y !== t.y || this.mine.z !== t.z) this.mine = { x: t.x, y: t.y, z: t.z, t: 0, need: mineTime(def, def.sound === 'wood' ? 'axe' : 'pickaxe', p.mods) };
    this.face(t.x + 0.5, t.y + 0.5, t.z + 0.5);
    this.mine.t += dt;
    if (this.mine.t >= this.mine.need) { this.s.handle(p.id, { type: 'break', x: t.x, y: t.y, z: t.z }); this.mine = null; this.gatherTarget = null; }
    return true;
  }

  /* ---------- fighting ---------- */
  pickTarget(list) {
    let best = null, bestScore = 1e9;
    for (const q of list) {
      const d = this.dist(q);
      const score = d * (q.bounty > 0 ? 0.6 : 1) * (q.health < 35 ? 0.7 : 1) + (this.s.integrity(q.index) < 40 ? -4 : 0);
      if (score < bestScore) { bestScore = score; best = q; }
    }
    return best;
  }
  warUpdate(dt) {
    const p = this.p, s = this.s, c = p.controls;
    this.tntCooldown -= dt;
    if (this.flee) {                                                      // run away from a lit fuse
      this.flee.t -= dt;
      this.walkTo(this.flee.x, this.flee.z, dt, 1, false);
      c.jump = c.jump || false;
      if (this.flee.t <= 0) this.flee = null;
      return;
    }
    const foes = this.enemies();
    this.thinkClock -= dt;
    if (this.thinkClock <= 0) {
      this.thinkClock = 0.3 + Math.random() * 0.2;
      this.target = this.pickTarget(foes);
      const t = this.target, d = t ? this.dist(t) : 99;
      const hurt = p.health < p.maxHealth * 0.3;
      const vaultReady = s.vault.cooldown <= 0 && s.phase !== 'build';
      const toVault = Math.hypot(s.map.vault.x - p.pos.x, s.map.vault.z - p.pos.z);
      if (hurt && t && d < 16) this.mode = 'retreat';
      else if (t && d < 3.4 && this.hasLOS(t)) this.mode = 'melee';
      else if (t && d < 26 && d > 6 && this.hasLOS(t) && this.aggression > 0.3) this.mode = 'shoot';
      else if (vaultReady && this.greed > 0.45 && toVault < 60 && (!t || d > 12)) this.mode = 'vault';
      else if ((p.resources.stone || 0) < 4 && (p.resources.wood || 0) < 4 && !s.unlimited) this.mode = 'gather';
      else if (t && (this.aggression > 0.55 || d < 30 || s.phase === 'chaos')) this.mode = 'hunt';
      else this.mode = 'gather';
    }
    const t = this.target;
    if (t && !t.alive) this.target = null;
    switch (this.mode) {
      case 'retreat': {
        const home = s.plotOf(p);
        if (t) { const dx = p.pos.x - t.pos.x, dz = p.pos.z - t.pos.z; const l = Math.hypot(dx, dz) || 1; this.walkTo(p.pos.x + dx / l * 6 + (home.x - p.pos.x) * 0.2, p.pos.z + dz / l * 6 + (home.z - p.pos.z) * 0.2, dt, 0.5, false); }
        c.jump = c.jump || (p.onGround && Math.random() < 0.02);
        break;
      }
      case 'melee': {
        if (!t) break;
        this.face(t.pos.x, t.pos.y + 1.2, t.pos.z, true);
        this.strafeT -= dt; if (this.strafeT <= 0) { this.strafe = -this.strafe; this.strafeT = 0.5 + Math.random() * 0.8; }
        if (this.dist(t) > 2.4) c.forward = true; else if (this.dist(t) < 1.3) c.back = true;
        if (this.strafe > 0) c.right = true; else c.left = true;
        const tool = p.mods.meleeDamage > 1.1 || Math.random() < 0.3 ? 'sword' : (Math.random() < 0.35 ? 'axe' : 'sword');
        if (p.cooldowns.attack <= 0) s.handle(p.id, { type: 'attack', targetId: t.id, tool });
        break;
      }
      case 'shoot': {
        if (!t) break;
        const flight = this.dist(t) / 28, lead = flight;
        this.face(t.pos.x + t.vel.x * lead, t.pos.y + 1.2 + this.dist(t) * 0.035, t.pos.z + t.vel.z * lead, true);
        this.shootCharge += dt;
        this.strafeT -= dt; if (this.strafeT <= 0) { this.strafe = -this.strafe; this.strafeT = 0.6 + Math.random(); }
        if (this.strafe > 0) c.right = true; else c.left = true;
        if (this.shootCharge >= TOOLS.bow.draw * p.mods.bowDraw && p.cooldowns.shoot <= 0) { s.handle(p.id, { type: 'shoot', charge: 1 }); this.shootCharge = 0; }
        break;
      }
      case 'vault': {
        const v = s.map.vault;
        if (v.y + 1 - p.pos.y > 2.2 && Math.hypot(v.x - p.pos.x, v.z - p.pos.z) < 8 && this.pillarUp(dt)) break;
        this.walkTo(v.x, v.z, dt, 1.2, true, v.y + 1);
        break;
      }
      case 'hunt': {
        if (!t) break;
        // drop TNT on the target when close and exposed
        const d = this.dist(t);
        if (d < 9 && d > 4.5 && this.tntCooldown <= 0 && s.hasResource(p, 'tnt', 1) && this.aggression > 0.4 && Math.abs(t.pos.y - p.pos.y) < 3) {
          const tx = Math.floor(t.pos.x), tz = Math.floor(t.pos.z), ty = Math.floor(t.pos.y);
          this.face(tx + 0.5, ty + 0.5, tz + 0.5, true);
          const px = Math.floor(p.pos.x + (t.pos.x - p.pos.x) * 0.45), pz = Math.floor(p.pos.z + (t.pos.z - p.pos.z) * 0.45), py = Math.floor(p.pos.y);
          if (s.handle(p.id, { type: 'place', x: px, y: py, z: pz, item: 'tnt' }).ok) { s.handle(p.id, { type: 'ignite', x: px, y: py, z: pz }); this.startFlee(px + 0.5, pz + 0.5, 4); this.tntCooldown = 12 + Math.random() * 10; break; }
        }
        // go for their base spawn when they are not visible, otherwise straight at them
        const plot = s.plots[t.index], vis = this.hasLOS(t);
        const gx = vis || d < 14 ? t.pos.x : plot.x, gz = vis || d < 14 ? t.pos.z : plot.z, gy = vis || d < 14 ? t.pos.y : plot.spawn.y;
        const dy = gy - p.pos.y;
        if (dy > 2.2 && d < 8 && this.pillarUp(dt)) break;                      // enemy is above us: build upward
        if (dy < -3 && d < 4) { this.digDown(dt); break; }                        // enemy is below: dig down
        this.walkTo(gx, gz, dt, 1.8, true, gy);
        if (d < 3.4 && vis) this.mode = 'melee';
        break;
      }
      default: {                                                          // gather / idle at home
        if (!this.gather(dt, 25)) { const home = s.plotOf(p); this.walkTo(home.x, home.z, dt, 3, false); }
      }
    }
  }

  /* ---------- diplomacy ---------- */
  diplomacy(dt) {
    const s = this.s, p = this.p;
    if (!s.allianceMode) return;
    const prop = s.proposals.find((q) => q.to === p);
    if (prop) {
      this.proposalT += dt;
      if (this.proposalT > 3) { this.proposalT = 0; s.handle(p.id, { type: 'respond', from: prop.from.id, accept: this.loyalty > 0.25 }); }
    } else this.proposalT = 0;
    // betrayal: when only allies are left near the end, some bots turn on their partner
    const alive = s.alivePlayers();
    if (s.phase === 'chaos' && alive.length > 1 && alive.every((q) => q.team === alive[0].team) && alive.includes(p)) {
      if (this.betrayT < 0) this.betrayT = 4 + Math.random() * 40;
      this.betrayT -= dt;
      if (this.betrayT <= 0 && this.loyalty < 0.55) { s.handle(p.id, { type: 'leaveAlliance' }); this.betrayT = 1e9; }
    }
  }

  update(dt) {
    const p = this.p, s = this.s, c = p.controls;
    c.forward = c.back = c.left = c.right = c.jump = c.crouch = false;
    if (!p.alive) return;
    this.diplomacy(dt);
    if (s.phase === 'build') this.buildUpdate(dt);
    else if (s.phase === 'war' || s.phase === 'chaos' || s.phase === 'sandbox') this.warUpdate(dt);
    if (p.inLava || p.inWater) c.jump = true;
  }
}

/* ============================ 13. RENDERER ============================== */
const WORLD_VS = `
attribute vec3 aPos; attribute vec2 aUV; attribute float aShade;
uniform mat4 uVP; uniform mat4 uModel; uniform vec3 uCam;
varying vec2 vUV; varying float vShade; varying float vDist;
void main(){ vec4 wp = uModel * vec4(aPos, 1.0); vUV = aUV; vShade = aShade; vDist = length(wp.xyz - uCam); gl_Position = uVP * wp; }`;
const WORLD_FS = `
precision mediump float;
uniform sampler2D uTex; uniform vec3 uFogColor; uniform float uFogStart; uniform float uFogEnd;
uniform vec3 uTint; uniform float uAlpha; uniform float uBright;
varying vec2 vUV; varying float vShade; varying float vDist;
void main(){
  vec4 c = texture2D(uTex, vUV);
  if (c.a < 0.5) discard;
  float f = clamp((vDist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  vec3 col = c.rgb * vShade * uBright + uTint;
  gl_FragColor = vec4(mix(col, uFogColor, f), uAlpha);
}`;
const SOLID_VS = `
attribute vec3 aPos; attribute vec3 aNrm;
uniform mat4 uVP; uniform mat4 uModel; uniform mat3 uNM; uniform vec3 uCam; uniform float uLit;
varying float vShade; varying float vDist;
void main(){
  vec4 wp = uModel * vec4(aPos, 1.0);
  vec3 n = normalize(uNM * aNrm + vec3(0.0001));
  vShade = mix(1.0, 0.5 + 0.5 * max(dot(n, normalize(vec3(0.35, 0.85, 0.4))), 0.0) + 0.1 * abs(n.x) , uLit);
  vDist = length(wp.xyz - uCam);
  gl_Position = uVP * wp;
}`;
const SOLID_FS = `
precision mediump float; uniform vec4 uColor; uniform vec3 uFogColor; uniform float uFogStart; uniform float uFogEnd; uniform float uBright;
varying float vShade; varying float vDist;
void main(){
  float f = clamp((vDist - uFogStart) / (uFogEnd - uFogStart), 0.0, 1.0);
  gl_FragColor = vec4(mix(uColor.rgb * vShade * uBright, uFogColor, f), uColor.a);
}`;

// Unit cube centred on the origin with face normals: 36 triangle vertices (pos+normal) and 24 line vertices.
const CUBE_TRIS = (() => {
  const v = [];
  const faces = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
  for (const n of faces) {
    const a = n[0] ? 0 : n[1] ? 1 : 2, t1 = (a + 1) % 3, t2 = (a + 2) % 3, s = n[a];
    const c = CORNERS.map(([c1, c2]) => { const p = [0, 0, 0]; p[a] = s * 0.5; p[t1] = c1 - 0.5; p[t2] = c2 - 0.5; return p; });
    for (const i of (s > 0 ? TRI_POS : TRI_NEG)) v.push(...c[i], n[0], n[1], n[2]);
  }
  return new Float32Array(v);
})();
const CUBE_LINES = (() => {
  const v = [];
  for (let i = 0; i < 8; i++) {
    const p = [(i & 1) - 0.5, ((i >> 1) & 1) - 0.5, ((i >> 2) & 1) - 0.5];
    for (let a = 0; a < 3; a++) if (!((i >> a) & 1)) { const q = p.slice(); q[a] += 1; v.push(...p, 0, 0, 0, ...q, 0, 0, 0); }
  }
  return new Float32Array(v);
})();

/** Per-world GPU chunk meshes. The live game has one; a replay clone gets its own. */
class ChunkSet {
  constructor(gl, world, listen) {
    this.gl = gl; this.world = world;
    const C = CONFIG.WORLD.CHUNK;
    this.cx = Math.ceil(world.sizeX / C); this.cz = Math.ceil(world.sizeZ / C);
    this.chunks = [];
    for (let i = 0; i < this.cx * this.cz; i++) this.chunks.push({ buf: null, count: 0, fbuf: null, fcount: 0, dirty: true });
    if (listen) world.listeners.push((x, y, z) => this.markDirty(x, z));
  }
  markDirty(x, z) {
    const C = CONFIG.WORLD.CHUNK, cx = Math.floor(x / C), cz = Math.floor(z / C);
    const mark = (a, b) => { if (a >= 0 && b >= 0 && a < this.cx && b < this.cz) this.chunks[b * this.cx + a].dirty = true; };
    mark(cx, cz);
    const lx = x - cx * C, lz = z - cz * C;                                  // border edits change the neighbour's faces + AO
    if (lx === 0) mark(cx - 1, cz); if (lx === C - 1) mark(cx + 1, cz);
    if (lz === 0) mark(cx, cz - 1); if (lz === C - 1) mark(cx, cz + 1);
    if (lx === 0 && lz === 0) mark(cx - 1, cz - 1); if (lx === C - 1 && lz === 0) mark(cx + 1, cz - 1);
    if (lx === 0 && lz === C - 1) mark(cx - 1, cz + 1); if (lx === C - 1 && lz === C - 1) mark(cx + 1, cz + 1);
  }
  rebuild(i) {
    const gl = this.gl, c = this.chunks[i], mesh = buildChunkMesh(this.world, i % this.cx, Math.floor(i / this.cx));
    if (!c.buf) c.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, c.buf); gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.DYNAMIC_DRAW); c.count = mesh.vertexCount;
    if (mesh.fluidCount) { if (!c.fbuf) c.fbuf = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, c.fbuf); gl.bufferData(gl.ARRAY_BUFFER, mesh.fluidData, gl.DYNAMIC_DRAW); }
    c.fcount = mesh.fluidCount; c.dirty = false;
  }
  update(budget) {
    let n = 0;
    for (let i = 0; i < this.chunks.length && n < budget; i++) if (this.chunks[i].dirty) { this.rebuild(i); n++; }
    return n;
  }
  pending() { let n = 0; for (const c of this.chunks) if (c.dirty) n++; return n; }
  buildAll() { for (let i = 0; i < this.chunks.length; i++) this.rebuild(i); }
  dispose() { const gl = this.gl; for (const c of this.chunks) { if (c.buf) gl.deleteBuffer(c.buf); if (c.fbuf) gl.deleteBuffer(c.fbuf); } this.chunks = []; }
}

const HUMAN_SKIN = [0.87, 0.67, 0.5], ZOMBIE_SKIN = [0.3, 0.55, 0.28];

class Renderer {
  constructor(canvas, atlasCanvas) {
    this.canvas = canvas;
    const opts = { antialias: true, alpha: false, powerPreference: 'high-performance' };
    const gl = canvas.getContext('webgl', opts) || canvas.getContext('experimental-webgl', opts);
    if (!gl) throw new Error('WebGL is not available in this browser.');
    this.gl = gl;
    this.worldProg = this.makeProgram(WORLD_VS, WORLD_FS, ['aPos', 'aUV', 'aShade'], ['uVP', 'uModel', 'uCam', 'uTex', 'uFogColor', 'uFogStart', 'uFogEnd', 'uTint', 'uAlpha', 'uBright']);
    this.solidProg = this.makeProgram(SOLID_VS, SOLID_FS, ['aPos', 'aNrm'], ['uVP', 'uModel', 'uNM', 'uCam', 'uLit', 'uColor', 'uFogColor', 'uFogStart', 'uFogEnd', 'uBright']);
    this.cubeTris = this.makeBuffer(CUBE_TRIS);
    this.cubeLines = this.makeBuffer(CUBE_LINES);
    this.texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, atlasCanvas);
    for (const [k, v] of [[gl.TEXTURE_MIN_FILTER, gl.NEAREST], [gl.TEXTURE_MAG_FILTER, gl.NEAREST], [gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE], [gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE]]) gl.texParameteri(gl.TEXTURE_2D, k, v);
    gl.enable(gl.DEPTH_TEST); gl.enable(gl.CULL_FACE); gl.cullFace(gl.BACK);
    this.stats = { drawnChunks: 0, triangles: 0, totalChunks: 0 };
    this.blockMeshes = new Map(); this.iconQuads = new Map(); this.groupMeshes = new WeakMap();
    this.scratch = Mat4.identity(); this.nm = new Float32Array(9); this.lastVP = Mat4.identity();
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
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, vsSrc)); gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fsSrc));
    attribs.forEach((name, i) => gl.bindAttribLocation(prog, i, name));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error('Program link error: ' + gl.getProgramInfoLog(prog));
    const u = {};
    for (const name of uniforms) u[name] = gl.getUniformLocation(prog, name);
    return { prog, u, attribCount: attribs.length };
  }
  makeBuffer(data) { const gl = this.gl, b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW); return b; }
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
  newChunkSet(world, listen) { return new ChunkSet(this.gl, world, listen); }

  /* ---------- small mesh helpers ---------- */
  blockMesh(id, meta = 0) {
    const key = id + ':' + meta;
    let m = this.blockMeshes.get(key);
    if (!m) {
      const mesh = buildBlockListMesh([{ x: 0, y: 0, z: 0, id, meta }]), gl = this.gl, buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
      m = { buf, count: mesh.vertexCount }; this.blockMeshes.set(key, m);
    }
    return m;
  }
  iconQuad(tile) {
    let m = this.iconQuads.get(tile);
    if (!m) {
      const T = CONFIG.ATLAS.TILES, u0 = (tile % T) / T, v0 = Math.floor(tile / T) / T, s = 1 / T, I = ATLAS_INSET, a = u0 + I * s, b = u0 + (1 - I) * s, c = v0 + I * s, d = v0 + (1 - I) * s;
      const q = (z, flip) => {
        const p = [[-0.5, -0.5, a, d], [0.5, -0.5, b, d], [0.5, 0.5, b, c], [-0.5, 0.5, a, c]];
        const idx = flip ? [0, 2, 1, 0, 3, 2] : [0, 1, 2, 0, 2, 3], out = [];
        for (const i of idx) out.push(p[i][0], p[i][1], z, p[i][2], p[i][3], 1);
        return out;
      };
      const data = new Float32Array([...q(0.012, false), ...q(-0.012, true)]), gl = this.gl, buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      m = { buf, count: 12 }; this.iconQuads.set(tile, m);
    }
    return m;
  }
  groupMesh(g) {
    let m = this.groupMeshes.get(g);
    if (!m) {
      const mesh = buildBlockListMesh(g.cells.map((c) => ({ x: c.x, y: c.y, z: c.z, id: c.id, meta: c.meta }))), gl = this.gl, buf = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, mesh.data, gl.STATIC_DRAW);
      m = { buf, count: mesh.vertexCount }; this.groupMeshes.set(g, m);
    }
    return m;
  }
  freeGroupMeshes(groups) { for (const g of groups) { const m = this.groupMeshes.get(g); if (m) { this.gl.deleteBuffer(m.buf); this.groupMeshes.delete(g); } } }

  /* ---------- draw primitives ---------- */
  drawMesh(m, model) {
    const gl = this.gl, wp = this.worldProg, stride = VERTEX_FLOATS * 4;
    gl.uniformMatrix4fv(wp.u.uModel, false, model);
    gl.bindBuffer(gl.ARRAY_BUFFER, m.buf);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
    gl.drawArrays(gl.TRIANGLES, 0, m.count);
  }
  /** Draws the unit cube (or its outline) with a model matrix and RGBA colour. */
  box(model, color, lit = 1, lines = false) {
    const gl = this.gl, sp = this.solidProg, nm = this.nm;
    nm[0] = model[0]; nm[1] = model[1]; nm[2] = model[2]; nm[3] = model[4]; nm[4] = model[5]; nm[5] = model[6]; nm[6] = model[8]; nm[7] = model[9]; nm[8] = model[10];
    gl.uniformMatrix4fv(sp.u.uModel, false, model); gl.uniformMatrix3fv(sp.u.uNM, false, nm);
    gl.uniform1f(sp.u.uLit, lit); gl.uniform4f(sp.u.uColor, color[0], color[1], color[2], color[3] == null ? 1 : color[3]);
    gl.bindBuffer(gl.ARRAY_BUFFER, lines ? this.cubeLines : this.cubeTris);
    gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 24, 0); gl.vertexAttribPointer(1, 3, gl.FLOAT, false, 24, 12);
    gl.drawArrays(lines ? gl.LINES : gl.TRIANGLES, 0, lines ? 24 : 36);
  }
  /** Box at world centre (x,y,z) with size (sx,sy,sz); cheap path for particles and overlays. */
  boxAt(x, y, z, sx, sy, sz, color, lit = 1, lines = false) {
    const m = this.scratch; m.fill(0);
    m[0] = sx; m[5] = sy; m[10] = sz; m[12] = x; m[13] = y; m[14] = z; m[15] = 1;
    this.box(m, color, lit, lines);
  }
  /** One articulated part: pivot (px,py,pz) rotated about X by rx, box centred (0,cy,0) below/above the pivot. */
  part(base, px, py, pz, rx, cy, w, h, d, color) {
    const m = Mat4.chain(base, Mat4.translation(px, py, pz), Mat4.rotationX(rx), Mat4.translation(0, cy, 0), Mat4.scaling(w, h, d));
    this.box(m, color, 1);
  }
  humanoid(e, skin, shirt, legs, zombie, time) {
    const swing = zombie ? 0 : e.swing || 0, ph = (e.walk || 0) * 3.2;
    const crouch = e.crouch ? 0.14 : 0, burn = e.burning ? 0.25 + 0.25 * Math.sin(time * 18) : 0;
    const tint = (c) => burn ? [Math.min(1, c[0] + burn), c[1] * (1 - burn * 0.4), c[2] * (1 - burn * 0.6)] : c;
    const base = Mat4.chain(Mat4.translation(e.x, e.y, e.z), Mat4.rotationY(e.yaw));
    const sw = Math.sin(ph) * (e.moving === false ? 0 : 0.85);
    const armSwing = zombie ? -1.35 + Math.sin(ph) * 0.15 : null;
    this.part(base, -0.14, 0.7, 0, sw, -0.35, 0.27, 0.7, 0.27, tint(legs));
    this.part(base, 0.14, 0.7, 0, -sw, -0.35, 0.27, 0.7, 0.27, tint(legs));
    this.part(base, 0, 1.05 - crouch, 0, crouch * 2, 0, 0.58, 0.7, 0.3, tint(shirt));
    this.part(base, 0, 1.4 - crouch, 0, e.pitch ? clamp(e.pitch, -1.2, 1.2) : 0, 0.21, 0.42, 0.42, 0.42, tint(skin));
    const ra = zombie ? armSwing : -sw - swing * 1.9, la = zombie ? armSwing : sw;
    this.part(base, 0.4, 1.38 - crouch, 0, ra, -0.3, 0.22, 0.68, 0.22, tint(zombie ? skin : shirt));
    this.part(base, -0.4, 1.38 - crouch, 0, la, -0.3, 0.22, 0.68, 0.22, tint(zombie ? skin : shirt));
  }

  /* ---------- frame ---------- */
  /**
   * scene: { chunks, cam:{x,y,z,dir,fov}, snap (entities), selfIndex, target, mining, particles, darkness, time,
   *          held:{kind:'block'|'tool',id,meta,tile}, swing, hints:[[x,y,z]], vault, warnings, mobsOnly }
   * rect: {x,y,w,h} in device pixels (bottom-left origin) - defaults to the whole canvas.
   */
  draw(scene, rect) {
    const gl = this.gl, R = CONFIG.RENDER, cam = scene.cam;
    rect = rect || { x: 0, y: 0, w: this.canvas.width, h: this.canvas.height };
    const dark = scene.darkness || 0, bright = 1 - dark * 0.72;
    const sky = R.SKY.map((v) => v * (1 - dark * 0.88));
    const fogS = lerp(R.FOG_START, 4, dark), fogE = lerp(R.FOG_END, 34, dark);
    gl.viewport(rect.x, rect.y, rect.w, rect.h);
    gl.enable(gl.SCISSOR_TEST); gl.scissor(rect.x, rect.y, rect.w, rect.h);
    gl.clearColor(sky[0], sky[1], sky[2], 1);
    gl.depthMask(true); gl.disable(gl.BLEND);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    const proj = Mat4.perspective(cam.fov * Math.PI / 180, rect.w / rect.h, 0.05, 300);
    const view = Mat4.lookAt(cam.x, cam.y, cam.z, cam.x + cam.dir.x, cam.y + cam.dir.y, cam.z + cam.dir.z);
    const vp = Mat4.multiply(proj, view);
    this.lastVP = vp;
    const ident = Mat4.identity(), time = scene.time || 0, snap = scene.snap;

    // --- terrain, falling groups, primed TNT (textured pass) ---
    const wp = this.worldProg;
    this.useProgram(wp);
    gl.uniformMatrix4fv(wp.u.uVP, false, vp); gl.uniform3f(wp.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform3f(wp.u.uFogColor, sky[0], sky[1], sky[2]); gl.uniform1f(wp.u.uFogStart, fogS); gl.uniform1f(wp.u.uFogEnd, fogE);
    gl.uniform3f(wp.u.uTint, 0, 0, 0); gl.uniform1f(wp.u.uAlpha, 1); gl.uniform1f(wp.u.uBright, bright);
    gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, this.texture); gl.uniform1i(wp.u.uTex, 0);
    gl.uniformMatrix4fv(wp.u.uModel, false, ident);
    const cs = scene.chunks, C = CONFIG.WORLD.CHUNK, stride = VERTEX_FLOATS * 4, visible = [];
    const planes = this.frustum(vp);
    let tris = 0;
    for (let i = 0; i < cs.chunks.length; i++) {
      const ch = cs.chunks[i];
      if (!ch.count && !ch.fcount) continue;
      const x0 = (i % cs.cx) * C, z0 = Math.floor(i / cs.cx) * C;
      if (!this.boxInFrustum(planes, x0, 0, z0, x0 + C, cs.world.sizeY, z0 + C)) continue;
      visible.push(ch);
      if (!ch.count) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, ch.buf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
      gl.drawArrays(gl.TRIANGLES, 0, ch.count); tris += ch.count / 3;
    }
    this.stats.drawnChunks = visible.length; this.stats.triangles = tris; this.stats.totalChunks = cs.chunks.length;
    if (snap) {
      for (const gr of snap.groups) { const m = this.groupMesh(gr.g); this.drawMesh(m, Mat4.translation(0, gr.off, 0)); }
      const tm = this.blockMesh(ID.tnt);
      for (const t of snap.tnts) {
        const flash = (Math.floor(t.fuse * 5) % 2 === 0) ? 0.55 : 0, grow = 1 + (t.fuse < 0.6 ? (0.6 - t.fuse) * 0.4 : 0);
        gl.uniform3f(wp.u.uTint, flash, flash, flash);
        this.drawMesh(tm, Mat4.chain(Mat4.translation(t.x, t.y + 0.45, t.z), Mat4.scaling(0.9 * grow, 0.9 * grow, 0.9 * grow), Mat4.translation(-0.5, -0.5, -0.5)));
      }
      gl.uniform3f(wp.u.uTint, 0, 0, 0);
    }

    // --- entities, particles, overlays (flat-lit solid pass) ---
    const sp = this.solidProg;
    this.useProgram(sp);
    gl.uniformMatrix4fv(sp.u.uVP, false, vp); gl.uniform3f(sp.u.uCam, cam.x, cam.y, cam.z);
    gl.uniform3f(sp.u.uFogColor, sky[0], sky[1], sky[2]); gl.uniform1f(sp.u.uFogStart, fogS); gl.uniform1f(sp.u.uFogEnd, fogE); gl.uniform1f(sp.u.uBright, bright);
    if (snap) {
      for (const p of snap.players) {
        if (!p.alive || p.index === scene.selfIndex) continue;
        const col = hexToRgb(p.color);
        this.humanoid(p, HUMAN_SKIN, col, [0.2, 0.22, 0.4], false, time);
      }
      for (const m of snap.mobs) this.humanoid({ x: m.x, y: m.y, z: m.z, yaw: m.yaw, walk: m.walk, swing: m.swing, pitch: 0 }, ZOMBIE_SKIN, [0.2, 0.42, 0.5], [0.22, 0.25, 0.5], true, time);
      for (const a of snap.arrows) {
        const m = Mat4.chain(Mat4.translation(a.x, a.y, a.z), Mat4.rotationY(a.yaw), Mat4.rotationX(a.pitch), Mat4.scaling(0.06, 0.06, 0.9));
        this.box(m, [0.55, 0.4, 0.25, 1], 1);
      }
      for (const m of snap.meteors) {
        const s = 2.4, r = Mat4.chain(Mat4.translation(m.x, m.y, m.z), Mat4.rotationY(time * 3), Mat4.rotationX(time * 2), Mat4.scaling(s, s, s));
        this.box(r, [1, 0.45, 0.1, 1], 0);
        this.box(Mat4.chain(Mat4.translation(m.x, m.y, m.z), Mat4.rotationY(-time * 4), Mat4.scaling(1.5, 1.5, 1.5)), [1, 0.85, 0.3, 1], 0);
      }
    }
    if (scene.particles) for (const p of scene.particles.items) this.boxAt(p.x, p.y, p.z, p.size, p.size, p.size, p.color, p.glow ? 0 : 1);

    // --- translucent bits: fluids, target crack, vault beam, warnings, hints ---
    gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    if (scene.target) {
      const t = scene.target, cx = t.x + 0.5, cy = t.y + 0.5, cz = t.z + 0.5;
      if (scene.mining > 0) { gl.depthMask(false); this.boxAt(cx, cy, cz, 1.004, 1.004, 1.004, [0, 0, 0, 0.12 + 0.55 * scene.mining], 0); gl.depthMask(true); }
      this.boxAt(cx, cy, cz, 1.005, 1.005, 1.005, [0, 0, 0, 0.95], 0, true);
    }
    if (scene.hints) for (const h of scene.hints) this.boxAt(h[0] + 0.5, h[1] + 0.5, h[2] + 0.5, 1.03, 1.03, 1.03, [1, 0.85, 0.2, 0.9], 0, true);
    if (scene.warnings) for (const wn of scene.warnings) { gl.depthMask(false); const pulse = 0.25 + 0.2 * Math.sin(time * 14); this.boxAt(wn.x, wn.y + 0.06, wn.z, 7, 0.12, 7, [1, 0.15, 0.1, pulse], 0); this.boxAt(wn.x, wn.y + 20, wn.z, 0.5, 40, 0.5, [1, 0.3, 0.1, 0.18], 0); gl.depthMask(true); }
    if (scene.vault) {
      const v = scene.vault, pulse = 0.5 + 0.5 * Math.sin(time * 3), col = v.cooldown > 0 ? [0.4, 0.4, 0.45, 0.14] : v.capturing ? [0.3, 1, 0.4, 0.3] : [1, 0.85, 0.2, 0.16 + 0.1 * pulse];
      gl.depthMask(false); this.boxAt(v.x, v.y + 12, v.z, 1.4, 26, 1.4, col, 0); gl.depthMask(true);
    }
    // fluids last, so everything solid is already in the depth buffer
    this.useProgram(wp);
    gl.uniformMatrix4fv(wp.u.uModel, false, ident); gl.uniform1f(wp.u.uAlpha, 0.74); gl.uniform3f(wp.u.uTint, 0, 0, 0);
    gl.depthMask(false);
    for (const ch of visible) {
      if (!ch.fcount) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, ch.fbuf);
      gl.vertexAttribPointer(0, 3, gl.FLOAT, false, stride, 0); gl.vertexAttribPointer(1, 2, gl.FLOAT, false, stride, 12); gl.vertexAttribPointer(2, 1, gl.FLOAT, false, stride, 20);
      gl.drawArrays(gl.TRIANGLES, 0, ch.fcount);
    }
    gl.depthMask(true); gl.disable(gl.BLEND); gl.uniform1f(wp.u.uAlpha, 1);

    // --- first-person held item ---
    if (scene.held) this.drawHeld(scene.held, proj, scene.swing || 0, time, bright);
    gl.disable(gl.SCISSOR_TEST);
  }

  drawHeld(held, proj, swing, time, bright) {
    const gl = this.gl, wp = this.worldProg;
    gl.clear(gl.DEPTH_BUFFER_BIT);
    this.useProgram(wp);
    gl.uniformMatrix4fv(wp.u.uVP, false, proj); gl.uniform3f(wp.u.uCam, 0, 0, 0);
    gl.uniform1f(wp.u.uFogStart, 500); gl.uniform1f(wp.u.uFogEnd, 600); gl.uniform1f(wp.u.uBright, Math.max(bright, 0.6)); gl.uniform3f(wp.u.uTint, 0, 0, 0); gl.uniform1f(wp.u.uAlpha, 1);
    const bob = Math.sin(time * 2.2) * 0.008, sw = Math.sin(swing * Math.PI);
    if (held.kind === 'block') {
      const m = Mat4.chain(Mat4.translation(0.46 - sw * 0.1, -0.42 + bob - sw * 0.12, -0.78 - sw * 0.1), Mat4.rotationY(0.55), Mat4.rotationX(0.2 - sw * 0.7), Mat4.scaling(0.3, 0.3, 0.3), Mat4.translation(-0.5, -0.5, -0.5));
      this.drawMesh(this.blockMesh(held.id, held.meta || 0), m);
    } else if (held.kind === 'tool') {
      gl.disable(gl.CULL_FACE);
      const m = Mat4.chain(Mat4.translation(0.4, -0.3 + bob, -0.72), Mat4.rotationY(-0.35), Mat4.rotationZ(-0.5 + sw * 0.2), Mat4.rotationX(-sw * 1.3), Mat4.translation(0, 0.1, 0), Mat4.scaling(0.42, 0.42, 0.42));
      this.drawMesh(this.iconQuad(held.tile), m);
      gl.enable(gl.CULL_FACE);
    }
  }

  frustum(vp) {
    const p = [];
    const row = (i) => [vp[i], vp[4 + i], vp[8 + i], vp[12 + i]];
    const r0 = row(0), r1 = row(1), r2 = row(2), r3 = row(3);
    for (const [a, s] of [[r0, 1], [r0, -1], [r1, 1], [r1, -1], [r2, 1], [r2, -1]]) p.push([r3[0] + s * a[0], r3[1] + s * a[1], r3[2] + s * a[2], r3[3] + s * a[3]]);
    return p;
  }
  boxInFrustum(planes, x0, y0, z0, x1, y1, z1) {
    for (const [a, b, c, d] of planes) {
      const px = a > 0 ? x1 : x0, py = b > 0 ? y1 : y0, pz = c > 0 ? z1 : z0;
      if (a * px + b * py + c * pz + d < 0) return false;
    }
    return true;
  }
}
function hexToRgb(h) {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/* ===================== 14. PARTICLES / AUDIO / INPUT / STORAGE ===================== */
class ParticleSystem {
  constructor(max = 700) { this.items = []; this.max = max; }
  push(p) { if (this.items.length >= this.max) this.items.shift(); this.items.push(p); }
  burst(x, y, z, color, count, speed = 3.2, size = 0.14) {
    for (let i = 0; i < count; i++) {
      const shade = 0.75 + Math.random() * 0.4;
      this.push({
        x: x + (Math.random() - 0.5) * 0.7, y: y + (Math.random() - 0.5) * 0.7, z: z + (Math.random() - 0.5) * 0.7,
        vx: (Math.random() - 0.5) * speed * 2, vy: Math.random() * speed + 1, vz: (Math.random() - 0.5) * speed * 2,
        life: 0.5 + Math.random() * 0.5, size: size * (0.6 + Math.random() * 0.7), grav: 20,
        color: [clamp(color[0] * shade, 0, 1), clamp(color[1] * shade, 0, 1), clamp(color[2] * shade, 0, 1), 1],
      });
    }
  }
  /** Glowing, weightless puffs: fire, smoke, sparks, explosion flash. */
  puff(x, y, z, color, count, spread = 1, rise = 1.5, size = 0.3, life = 0.7, glow = true) {
    for (let i = 0; i < count; i++) {
      this.push({
        x: x + (Math.random() - 0.5) * spread, y: y + (Math.random() - 0.5) * spread * 0.6, z: z + (Math.random() - 0.5) * spread,
        vx: (Math.random() - 0.5) * spread * 2, vy: rise * (0.5 + Math.random()), vz: (Math.random() - 0.5) * spread * 2,
        life: life * (0.6 + Math.random() * 0.8), size: size * (0.6 + Math.random() * 0.8), grav: -2, glow,
        color: [color[0], color[1], color[2], 1],
      });
    }
  }
  explosion(x, y, z, radius) {
    const n = Math.min(110, Math.floor(radius * 18));
    this.puff(x, y, z, [1, 0.8, 0.25], n, radius * 0.8, 3.5, radius * 0.22, 0.55);
    this.puff(x, y, z, [1, 0.4, 0.1], n, radius * 1.1, 2.5, radius * 0.2, 0.8);
    this.puff(x, y, z, [0.25, 0.25, 0.27], Math.floor(n * 0.8), radius * 1.3, 3, radius * 0.28, 1.3, false);
  }
  update(dt, world) {
    for (let i = this.items.length - 1; i >= 0; i--) {
      const p = this.items[i];
      p.life -= dt;
      if (p.life <= 0) { this.items[i] = this.items[this.items.length - 1]; this.items.pop(); continue; }
      p.vy -= (p.grav == null ? 20 : p.grav) * dt;
      p.x += p.vx * dt; p.z += p.vz * dt;
      const ny = p.y + p.vy * dt;
      if (!p.glow && world.isSolid(Math.floor(p.x), Math.floor(ny - p.size / 2), Math.floor(p.z))) { p.vy = -p.vy * 0.25; p.vx *= 0.6; p.vz *= 0.6; }
      else p.y = ny;
      if (p.glow) p.color[3] = 1;
    }
  }
}

/** Tiny WebAudio synth: every sound is generated, nothing is downloaded. */
class AudioEngine {
  constructor() { this.ctx = null; this.master = null; this.volume = 0.7; this.muted = false; this.lastPlay = {}; }
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
  noise(duration, type, freq, gain, q = 1, freqEnd) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime, n = Math.floor(ctx.sampleRate * duration);
    const buf = ctx.createBuffer(1, n, ctx.sampleRate), data = buf.getChannelData(0);
    for (let i = 0; i < n; i++) data[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource(); src.buffer = buf;
    const filter = ctx.createBiquadFilter(); filter.type = type; filter.frequency.setValueAtTime(freq, t); filter.Q.value = q;
    if (freqEnd) filter.frequency.exponentialRampToValueAtTime(freqEnd, t + duration);
    const g = ctx.createGain(); g.gain.setValueAtTime(gain, t); g.gain.exponentialRampToValueAtTime(0.001, t + duration);
    src.connect(filter); filter.connect(g); g.connect(this.master); src.start(t);
  }
  tone(f0, f1, duration, gain, wave = 'square', delay = 0) {
    if (!this.ctx) return;
    const ctx = this.ctx, t = ctx.currentTime + delay;
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
  /** vol: 0..1 distance attenuation computed by the caller. */
  play(name, block, vol = 1) {
    if (!this.ctx || this.muted || vol <= 0.02) return;
    const now = this.ctx.currentTime;
    if (this.lastPlay[name] && now - this.lastPlay[name] < 0.04) return;     // never stack identical sounds in one instant
    this.lastPlay[name] = now;
    const [ft, ff, fq] = this.surface(block ? block.sound : 'soft'), v = vol;
    switch (name) {
      case 'break': this.noise(0.18, ft, ff, 0.55 * v, fq); this.tone(140, 60, 0.12, 0.12 * v, 'triangle'); break;
      case 'place': this.noise(0.07, ft, ff, 0.3 * v, fq); this.tone(190, 110, 0.08, 0.14 * v, 'triangle'); break;
      case 'step': this.noise(0.05, 'lowpass', 520, 0.14 * v); break;
      case 'jump': this.tone(260, 430, 0.1, 0.07 * v, 'sine'); break;
      case 'land': this.noise(0.12, 'lowpass', 340, 0.35 * v); break;
      case 'click': this.tone(520, 420, 0.05, 0.08 * v, 'square'); break;
      case 'explode': this.noise(1.1, 'lowpass', 900, 1.0 * v, 1, 60); this.tone(90, 28, 0.9, 0.5 * v, 'sawtooth'); this.noise(0.25, 'highpass', 2500, 0.3 * v); break;
      case 'bigexplode': this.noise(1.8, 'lowpass', 700, 1.0 * v, 1, 40); this.tone(70, 20, 1.5, 0.6 * v, 'sawtooth'); break;
      case 'fuse': this.noise(0.5, 'highpass', 3800, 0.16 * v, 1); break;
      case 'hit': this.noise(0.08, 'bandpass', 900, 0.4 * v, 3); this.tone(220, 90, 0.1, 0.18 * v, 'square'); break;
      case 'hurt': this.tone(300, 120, 0.2, 0.22 * v, 'sawtooth'); this.noise(0.1, 'lowpass', 600, 0.25 * v); break;
      case 'shoot': this.noise(0.12, 'bandpass', 1800, 0.25 * v, 2, 600); this.tone(320, 140, 0.1, 0.08 * v, 'triangle'); break;
      case 'death': this.tone(260, 50, 0.7, 0.3 * v, 'sawtooth'); this.noise(0.4, 'lowpass', 400, 0.3 * v); break;
      case 'rumble': this.noise(0.9, 'lowpass', 160, 0.5 * v, 1, 60); break;
      case 'crash': this.noise(0.7, 'lowpass', 500, 0.7 * v, 1, 80); this.tone(110, 40, 0.5, 0.3 * v, 'triangle'); break;
      case 'piston': this.noise(0.12, 'lowpass', 400, 0.4 * v); this.tone(120, 70, 0.12, 0.2 * v, 'square'); break;
      case 'mech': this.tone(900, 700, 0.04, 0.1 * v, 'square'); this.noise(0.03, 'highpass', 4000, 0.1 * v); break;
      case 'door': this.noise(0.15, 'bandpass', 500, 0.3 * v, 2); this.tone(150, 110, 0.15, 0.12 * v, 'triangle'); break;
      case 'alarm': this.tone(880, 880, 0.15, 0.18 * v, 'square'); this.tone(660, 660, 0.15, 0.18 * v, 'square', 0.17); break;
      case 'splash': this.noise(0.25, 'lowpass', 1200, 0.3 * v, 1, 300); break;
      case 'sizzle': this.noise(0.4, 'highpass', 3000, 0.2 * v, 1, 6000); break;
      case 'meteor': this.tone(1200, 120, 1.0, 0.18 * v, 'sawtooth'); this.noise(1.0, 'bandpass', 900, 0.2 * v, 1, 200); break;
      case 'siren': this.tone(400, 800, 0.5, 0.2 * v, 'sawtooth'); this.tone(800, 400, 0.5, 0.2 * v, 'sawtooth', 0.5); break;
      case 'chime': this.tone(660, 660, 0.18, 0.2 * v, 'triangle'); this.tone(880, 880, 0.18, 0.2 * v, 'triangle', 0.14); this.tone(1320, 1320, 0.3, 0.2 * v, 'triangle', 0.28); break;
      case 'phase': this.tone(330, 330, 0.12, 0.2 * v, 'square'); this.tone(495, 495, 0.2, 0.2 * v, 'square', 0.13); break;
      case 'tick': this.tone(1000, 900, 0.05, 0.12 * v, 'square'); break;
      case 'bounty': this.tone(220, 220, 0.2, 0.2 * v, 'sawtooth'); this.tone(165, 165, 0.35, 0.2 * v, 'sawtooth', 0.2); break;
    }
  }
}

class Input {
  constructor() {
    this.keys = new Set();
    this.mouse = { left: false, right: false };
    this.dx = 0; this.dy = 0; this.wheel = 0;
    this.locked = false; this.lockTime = 0;
    this.keyHandlers = []; this.keyUpHandlers = [];
  }
  attach(canvas) {
    window.addEventListener('keydown', (e) => {
      if (this.locked && (e.code === 'Space' || e.code === 'Tab' || e.code.startsWith('Arrow') || e.code === 'F3')) e.preventDefault();
      if (e.code === 'F3' || e.code === 'Tab') e.preventDefault();
      if (e.repeat) return;
      this.keys.add(e.code);
      for (const fn of this.keyHandlers) fn(e);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); for (const fn of this.keyUpHandlers) fn(e); });
    window.addEventListener('blur', () => { this.keys.clear(); this.mouse.left = this.mouse.right = false; });
    window.addEventListener('mousemove', (e) => {
      if (!this.locked || performance.now() - this.lockTime < 120) return;      // ignore the jump some browsers report right after capturing the mouse
      const mx = e.movementX || 0, my = e.movementY || 0;
      if (Math.abs(mx) > 250 || Math.abs(my) > 250) return;
      this.dx += mx; this.dy += my;
    });
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

/* ================================ 15. UI ================================ */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmtTime = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };
const RES_ICON = { wood: 'W', stone: 'S', iron: 'I', glass: 'G', tnt: 'T', water: '~', lava: 'L', mech: 'M', earth: 'E' };

class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.panels = { main: $('panelMain'), pause: $('panelPause'), lobby: $('panelLobby'), how: $('panelHow'), settings: $('panelSettings'), stats: $('panelStats') };
    this.slotEls = [];
    this.cache = {};
    this.bannerTimer = 0;
  }
  /** Writes innerHTML/text only when it changed (HUD updates run several times a second). */
  setHTML(id, html) { if (this.cache[id] !== html) { this.cache[id] = html; this.$(id).innerHTML = html; } }
  setText(id, text) { if (this.cache['t' + id] !== text) { this.cache['t' + id] = text; this.$(id).textContent = text; } }
  setWidth(id, pct) { const k = 'w' + id, v = Math.round(clamp(pct, 0, 100)); if (this.cache[k] !== v) { this.cache[k] = v; this.$(id).style.width = v + '%'; } }

  showPanel(name) { for (const [k, el] of Object.entries(this.panels)) el.classList.toggle('hidden', k !== name); this.$('title').classList.toggle('compact', name === 'lobby' || name === 'how'); this.$('subtitle').classList.toggle('hidden', name === 'lobby' || name === 'how'); }
  showOverlay(panel) { this.$('overlay').classList.remove('hidden'); this.showPanel(panel); }
  hideOverlay() { this.$('overlay').classList.add('hidden'); }
  showHud(v) { this.$('hud').classList.toggle('hidden', !v); }
  showError(msg) { const e = this.$('errorBox'); e.textContent = msg; e.classList.remove('hidden'); this.$('btnPlay').disabled = true; }

  /* ---------- icons ---------- */
  setAtlas(canvas) { document.documentElement.style.setProperty('--atlas', 'url(' + canvas.toDataURL() + ')'); }
  itemTile(itemId) {
    const it = ITEMS[itemId];
    if (it.kind === 'tool') return TILE['ICON_' + itemId.toUpperCase()];
    const def = BlockRegistry.byType(it.block);
    return def.tileFn ? def.tileFn(0, 0, 1) : def.tiles.side;
  }
  iconStyle(el, tile, size = 36) {
    const T = CONFIG.ATLAS.TILES;
    el.style.backgroundSize = `${size * T}px ${size * T}px`;
    el.style.backgroundPosition = `${-(tile % T) * size}px ${-Math.floor(tile / T) * size}px`;
    if (size !== 36) { el.style.width = el.style.height = size + 'px'; }
  }
  iconHTML(tile, size = 24) {
    const T = CONFIG.ATLAS.TILES;
    return `<span class="icon sm" style="width:${size}px;height:${size}px;background-size:${size * T}px ${size * T}px;background-position:${-(tile % T) * size}px ${-Math.floor(tile / T) * size}px"></span>`;
  }

  /* ---------- hotbar and build menu ---------- */
  buildHotbar(count, onSelect) {
    const bar = this.$('hotbar'); bar.innerHTML = ''; this.slotEls = [];
    for (let i = 0; i < count; i++) {
      const el = document.createElement('div');
      el.className = 'slot';
      el.innerHTML = `<span class="key">${i + 1}</span><div class="icon"></div><span class="qty"></span>`;
      el.addEventListener('click', () => onSelect(i));
      bar.appendChild(el); this.slotEls.push(el);
    }
  }
  refreshHotbar(hotbar, selected, server, player) {
    this.slotEls.forEach((el, i) => {
      const id = hotbar[i], icon = el.querySelector('.icon'), qty = el.querySelector('.qty');
      icon.style.display = id ? 'block' : 'none';
      if (id) {
        this.iconStyle(icon, this.itemTile(id));
        const it = ITEMS[id];
        let q = '', low = false;
        if (it.kind !== 'tool' && !server.unlimited) { const have = player.resources[it.res] || 0; q = Math.floor(have / (it.cost * (it.res === 'mech' ? player.mods.mechCost : 1) || 1)); low = q < 1; }
        qty.textContent = q; el.classList.toggle('empty', low);
        el.title = it.label;
      } else qty.textContent = '';
      el.classList.toggle('selected', i === selected);
    });
  }
  buildInventory(onPick) {
    const grid = this.$('invGrid'); grid.innerHTML = '';
    const groups = [['TOOLS', (it) => it.kind === 'tool'], ['BLOCKS', (it) => it.kind === 'block'], ['LIQUIDS', (it) => it.kind === 'fluid'], ['MECHANISMS', (it) => it.kind === 'mech']];
    for (const [title, test] of groups) {
      const h = document.createElement('h3'); h.textContent = title; grid.appendChild(h);
      const row = document.createElement('div'); row.className = 'invRow';
      for (const id of ITEM_ORDER) {
        const it = ITEMS[id]; if (!test(it)) continue;
        const b = document.createElement('button');
        b.className = 'invItem'; b.dataset.item = id;
        b.innerHTML = `<div class="icon"></div><span>${esc(it.label)}</span><em>${it.kind === 'tool' ? '' : it.cost + ' ' + RESOURCES[it.res].label.toLowerCase()}</em>`;
        this.iconStyle(b.querySelector('.icon'), this.itemTile(id));
        b.addEventListener('click', () => onPick(id));
        row.appendChild(b);
      }
      grid.appendChild(row);
    }
  }
  refreshInventoryRes(server, player) {
    this.$('invRes').innerHTML = RESOURCE_ORDER.map((k) => `<span class="chip" style="--c:${RESOURCES[k].color}">${RESOURCES[k].label} <b>${server.unlimited ? '∞' : Math.floor(player.resources[k] || 0)}</b></span>`).join('');
  }
  setPanelOpen(id, open) { this.$(id).classList.toggle('hidden', !open); document.body.classList.toggle('panel-open', open || !this.$('inventory').classList.contains('hidden') || !this.$('diplomacy').classList.contains('hidden')); }

  /* ---------- lobby ---------- */
  renderLobby(cfg, lands, onChange) {
    const modes = [['war', 'WAR', 'Free-for-all: last one standing'], ['alliance', 'ALLIANCE WAR', 'Pairs form at the start; alliances can be made or broken'], ['sandbox', 'SANDBOX', 'Unlimited resources, no timers, respawn']];
    const seg = this.$('segMode');
    seg.innerHTML = modes.map(([id, label, tip]) => `<button class="segbtn ${cfg.mode === id ? 'on' : ''}" data-mode="${id}" title="${esc(tip)}">${label}</button>`).join('');
    seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => onChange({ mode: b.dataset.mode })));
    this.$('outBots').textContent = cfg.bots; this.$('setBots').value = cfg.bots; this.$('setName').value = cfg.name;
    this.$('classCards').innerHTML = CLASS_ORDER.map((id) => {
      const c = CLASSES[id];
      return `<div class="card ${cfg.classId === id ? 'on' : ''}" data-class="${id}"><h4>${esc(c.name)}</h4><p>${esc(c.blurb)}</p><ul>${c.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    }).join('');
    this.$('classCards').querySelectorAll('.card').forEach((el) => el.addEventListener('click', () => onChange({ classId: el.dataset.class })));
    const L = LANDS[lands[0]], syn = SYNERGIES[cfg.classId + ':' + lands[0]];
    this.$('landInfo').innerHTML = `<div class="landcard" style="--c:${L.icon}"><h4>${esc(L.name)} <small>${esc(L.blurb)}</small></h4>
      <div class="pc"><ul class="pros">${L.pros.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><ul class="cons">${L.cons.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
      ${syn ? `<div class="syn">SYNERGY &middot; ${esc(syn)}</div>` : ''}</div>`;
    const n = 1 + cfg.bots;
    this.$('matchup').innerHTML = 'Lands this match: ' + lands.slice(0, n).map((l, i) => `<span class="tag" style="--c:${LANDS[l].icon}">${i === 0 ? 'YOU' : 'BOT ' + i}: ${esc(LANDS[l].name)}</span>`).join(' ');
  }

  /* ---------- HUD ---------- */
  buildHudLabels() { /* static markup lives in index.html */ }
  setStage(stage, objective, time) {
    this.setText('phaseName', stage); this.setText('timer', time); this.setText('objective', objective);
    this.$('hud').dataset.stage = stage.toLowerCase();
  }
  setEventBar(text) {
    const el = this.$('eventBar');
    el.classList.toggle('hidden', !text);
    if (text) this.setText('eventBar', text);
  }
  setVitals(hp, maxHp, integrity, bounty, status) {
    this.setWidth('hpFill', hp / maxHp * 100); this.setText('hpText', Math.ceil(hp));
    this.$('hpFill').classList.toggle('low', hp < maxHp * 0.3);
    this.setWidth('baseFill', integrity); this.setText('baseText', integrity + '%');
    this.$('baseFill').classList.toggle('low', integrity < 35);
    this.setHTML('statusLine', status);
  }
  setResources(server, player) {
    this.setHTML('resources', RESOURCE_ORDER.map((k) => {
      const v = server.unlimited ? '∞' : Math.floor(player.resources[k] || 0), cap = resourceCap(k, player.mods);
      const low = !server.unlimited && (player.resources[k] || 0) < 3;
      return `<span class="chip ${low ? 'low' : ''}" style="--c:${RESOURCES[k].color}" title="${RESOURCES[k].label} (max ${cap})"><i>${RES_ICON[k]}</i><b>${v}</b></span>`;
    }).join(''));
  }
  setPlayers(rows) {
    this.setHTML('players', rows.map((r) => `<div class="prow ${r.alive ? '' : 'dead'} ${r.me ? 'me' : ''} ${r.ally ? 'ally' : ''}" style="--c:${r.color}">
      <i class="dot"></i><span class="nm">${esc(r.name)}${r.ally ? ' <em>ALLY</em>' : ''}${r.bounty ? ' <em class="bty">$' + r.bounty + '</em>' : ''}</span>
      <span class="hpb"><i style="width:${r.alive ? Math.round(r.hp) : 0}%"></i></span><span class="int ${r.integ < 35 ? 'low' : ''}" title="Base integrity">${r.integ}%</span><b class="sc">${r.score}</b></div>`).join(''));
  }
  killfeed(html, cls = '') {
    const feed = this.$('killfeed'), el = document.createElement('div');
    el.className = 'kf ' + cls; el.innerHTML = html;
    feed.appendChild(el);
    while (feed.children.length > 6) feed.removeChild(feed.firstChild);
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 800); }, 6500);
  }
  toast(html, cls = '', ms = 6000) {
    const box = this.$('toasts'), el = document.createElement('div');
    el.className = 'toast ' + cls; el.innerHTML = html;
    box.appendChild(el);
    while (box.children.length > 3) box.removeChild(box.firstChild);
    setTimeout(() => { el.classList.add('fade'); setTimeout(() => el.remove(), 600); }, ms);
  }
  banner(main, sub = '', cls = '', ms = 3200) {
    const b = this.$('banner');
    b.className = cls; this.$('bannerMain').textContent = main; this.$('bannerSub').textContent = sub;
    b.classList.remove('hidden'); void b.offsetWidth; b.classList.add('show');
    clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => { b.classList.add('hidden'); b.classList.remove('show'); }, ms);
  }
  setVault(visible, progress, label, cls) {
    const el = this.$('vault'); el.classList.toggle('hidden', !visible);
    if (visible) { this.setWidth('vaultFill', progress * 100); this.$('vaultFill').className = cls || ''; el.querySelector('.label').textContent = label; }
  }
  setHint(text) { this.setText('hint', text); }
  setCharge(v) { const el = this.$('charge'); el.classList.toggle('hidden', v <= 0); if (v > 0) this.setWidth('chargeFill', v * 100); }
  damageFlash(strength) { const fx = this.$('fx'); fx.style.setProperty('--hurt', clamp(strength, 0, 1).toFixed(2)); }
  setScreenTint(kind) { const fx = this.$('fx'); if (this.cache.tint !== kind) { this.cache.tint = kind; fx.dataset.tint = kind; } }
  setDebug(visible, text) { const d = this.$('debug'); d.classList.toggle('hidden', !visible); if (visible) d.textContent = text; }
  setSpectate(text) { const el = this.$('spectate'); el.classList.toggle('hidden', !text); if (text) el.innerHTML = text; }
  setReplayTag(text, full) { const el = this.$('replayTag'); el.classList.toggle('hidden', !text); el.classList.toggle('fullscreen', !!full); document.body.classList.toggle('killcam', !!text && !!full); if (text) el.innerHTML = text; }

  /* ---------- nameplates (DOM labels projected over the canvas) ---------- */
  updateNameplates(list) {
    const box = this.$('nameplates');
    while (box.children.length < list.length) { const d = document.createElement('div'); d.className = 'np'; box.appendChild(d); }
    for (let i = 0; i < box.children.length; i++) {
      const el = box.children[i], n = list[i];
      if (!n) { el.style.display = 'none'; continue; }
      el.style.display = 'block';
      el.style.transform = `translate(-50%,-100%) translate(${n.x.toFixed(0)}px,${n.y.toFixed(0)}px) scale(${n.scale.toFixed(2)})`;
      const html = `<span class="nn" style="--c:${n.color}">${esc(n.name)}${n.ally ? ' <em>ALLY</em>' : ''}${n.bounty ? ' <em class="bty">$' + n.bounty + '</em>' : ''}</span><span class="nb"><i style="width:${n.hp}%"></i></span>`;
      if (el._h !== html) { el._h = html; el.innerHTML = html; }
    }
  }

  /* ---------- scoreboard / diplomacy / results ---------- */
  renderScoreboard(server, me) {
    const rows = server.scoreboard().map((p, i) => {
      const ally = server.areAllies(p, me);
      return `<tr class="${p === me ? 'me' : ''} ${p.alive ? '' : 'dead'}" style="--c:${p.color}"><td>${i + 1}</td><td><i class="dot"></i>${esc(p.name)}${ally ? ' <em>ALLY</em>' : ''}${p.bounty ? ' <em class="bty">$' + p.bounty + '</em>' : ''}</td><td>${CLASSES[p.classId].name}</td><td>${LANDS[p.landId].name}</td>
        <td>${p.stats.kills}</td><td>${p.stats.assists}</td><td>${p.stats.deaths}</td><td>${server.integrity(p.index)}%</td><td><b>${Math.round(p.stats.score)}</b></td></tr>`;
    }).join('');
    this.setHTML('scoreboard', `<div class="panel wide"><h2>SCOREBOARD</h2><table class="grid"><tr><th>#</th><th>Player</th><th>Class</th><th>Land</th><th>K</th><th>A</th><th>D</th><th>Base</th><th>Score</th></tr>${rows}</table></div>`);
  }
  renderDiplomacy(server, me) {
    if (!server.allianceMode && server.mode !== 'war' && server.mode !== 'alliance') { this.setHTML('diploBody', '<p>Not available in sandbox.</p>'); return; }
    const mates = server.players.filter((p) => server.areAllies(p, me));
    const incoming = server.proposals.filter((q) => q.to === me);
    let html = `<p class="hint">Bounties cost you 100 score and are paid to whoever kills the target. They expire after 2 minutes.${server.allianceMode ? ' Allies cannot hit each other directly, but explosions still hurt.' : ' Alliances are only available in Alliance War.'}</p>`;
    if (mates.length) html += `<p>Your allies: ${mates.map((m) => `<span class="tag" style="--c:${m.color}">${esc(m.name)}</span>`).join(' ')} <button class="btn tiny danger" data-act="leave">BREAK ALLIANCE (betray)</button></p>`;
    for (const q of incoming) html += `<p class="incoming">${esc(q.from.name)} offers an alliance <button class="btn tiny" data-act="accept" data-id="${q.from.id}">ACCEPT</button> <button class="btn tiny" data-act="decline" data-id="${q.from.id}">DECLINE</button></p>`;
    html += '<table class="grid"><tr><th>Player</th><th>Status</th><th>Bounty</th><th></th></tr>';
    for (const p of server.players) {
      if (p === me) continue;
      const ally = server.areAllies(p, me), pending = server.proposals.some((q) => q.from === me && q.to === p);
      html += `<tr class="${p.alive ? '' : 'dead'}" style="--c:${p.color}"><td><i class="dot"></i>${esc(p.name)}</td><td>${p.alive ? (ally ? 'ALLY' : 'enemy') : 'eliminated'}</td><td>${p.bounty ? '$' + p.bounty : '-'}</td><td>`;
      if (p.alive && !ally && server.allianceMode) html += pending ? '<em>request sent</em> ' : `<button class="btn tiny" data-act="propose" data-id="${p.id}">PROPOSE ALLIANCE</button> `;
      if (p.alive && !ally) html += `<button class="btn tiny" data-act="bounty" data-id="${p.id}">BOUNTY +100</button>`;
      html += '</td></tr>';
    }
    html += '</table>';
    this.setHTML('diploBody', html);
  }
  renderResults(server, me, extra) {
    const R = server.results;
    const myRow = R.rows.find((r) => r.player === me);
    const won = myRow && myRow.won;
    const title = R.winners.length === 0 ? 'DRAW' : won ? 'VICTORY' : 'DEFEAT';
    const who = R.winners.length ? R.winners.map((p) => p.name).join(' & ') : 'nobody';
    const reason = { 'last-standing': 'last team standing', time: 'best score when time ran out', draw: 'everyone fell' }[R.reason] || R.reason;
    const rows = R.rows.map((r, i) => `<tr class="${r.player === me ? 'me' : ''} ${r.won ? 'won' : ''}" style="--c:${r.player.color}"><td>${i + 1}</td><td><i class="dot"></i>${esc(r.player.name)}</td><td>${CLASSES[r.player.classId].name}</td><td>${r.kills}</td><td>${r.assists}</td><td>${r.deaths}</td><td>${r.structuresDestroyed}</td><td>${r.tntKills}</td><td>${r.blocksDestroyed}</td><td>${r.objectives}</td><td><b>${r.score}</b></td><td>+${r.xp}</td><td>+${r.coins}</td></tr>`).join('');
    this.$('results').innerHTML = `<div class="panel wide ${won ? 'win' : 'lose'}"><h1>${title}</h1><p class="sub">${esc(who)} &mdash; ${esc(reason)}</p>
      <table class="grid"><tr><th>#</th><th>Player</th><th>Class</th><th>Kills</th><th>Ast</th><th>Deaths</th><th>Structures</th><th>TNT kills</th><th>Blocks</th><th>Objectives</th><th>Score</th><th>XP</th><th>Coins</th></tr>${rows}</table>
      <p class="sub">${extra || ''}</p>
      <div class="row end"><button class="btn small" data-act="menu">MAIN MENU</button>${server.replayAvailable ? '<button class="btn small" data-act="replay">WATCH LAST HIGHLIGHT</button>' : ''}<button class="btn" data-act="again">PLAY AGAIN</button></div></div>`;
    this.$('results').classList.remove('hidden');
  }
}

/* ============================ 16. REPLAY / KILLCAM ============================ */
/**
 * Records entity snapshots (20 Hz) and an undo/redo log of block changes for the last ~14 s.
 * A replay clones the world, rolls it back, and plays everything forward again, so the killcam shows the real
 * explosions, collapses and movement that led to the moment - rendered by the same renderer, from a new camera.
 */
class ReplayRecorder {
  constructor(game) {
    this.game = game; this.keep = 14; this.reset();
    game.world.listeners.push((x, y, z, o, n, om, oo) => {
      if (this.suspended) return;
      this.log.push([game.server.clock, x, y, z, o, om, oo, n, game.world.getMeta(x, y, z), game.world.getOwner(x, y, z)]);
      if (this.log.length > 90000) { this.log.splice(0, 30000); this.logFloor = this.log[0][0]; }
    });
  }
  reset() { this.snaps = []; this.log = []; this.events = []; this.acc = 0; this.logFloor = 0; this.suspended = false; }
  logEvent(type, x, y, z, r) { this.events.push({ t: this.game.server.clock, type, x, y, z, r }); }
  tick(dt) {
    const s = this.game.server;
    this.acc += dt;
    if (this.acc < 0.05) return;
    this.acc = 0;
    const snap = s.snapshot(1);
    this.snaps.push({ t: s.clock, snap });
    const cut = s.clock - this.keep;
    while (this.snaps.length > 2 && this.snaps[0].t < cut) this.snaps.shift();
    let i = 0; while (i < this.log.length && this.log[i][0] < cut) i++;
    if (i > 2000) this.log.splice(0, i);
    while (this.events.length && this.events[0].t < cut) this.events.shift();
  }
}

class Replay {
  /** focus: { mode:'victim', vi, ki } or { mode:'point', x,y,z }. */
  constructor(game, t0, t1, focus, label, fullscreen) {
    const rec = game.recorder, srv = game.server;
    this.game = game; this.focus = focus; this.label = label; this.fullscreen = fullscreen;
    t0 = Math.max(t0, rec.logFloor, rec.snaps.length ? rec.snaps[0].t : t0);
    this.t0 = t0; this.t1 = Math.min(t1, srv.clock);
    this.snaps = rec.snaps.filter((s) => s.t >= this.t0 - 0.06 && s.t <= this.t1 + 0.06).map((s) => s);
    this.ok = this.snaps.length > 4;
    if (!this.ok) return;
    this.world = srv.world.clone();
    for (let i = rec.log.length - 1; i >= 0; i--) {                       // roll the clone back to t0
      const e = rec.log[i];
      if (e[0] <= this.t0) break;
      this.world.set(e[1], e[2], e[3], e[4], true, e[5], e[6]);
    }
    this.fwd = rec.log.filter((e) => e[0] > this.t0 && e[0] <= this.t1);
    this.evts = rec.events.filter((e) => e.t > this.t0 && e.t <= this.t1);
    this.fi = 0; this.ei = 0;
    this.chunks = game.renderer.newChunkSet(this.world, false);
    this.particles = new ParticleSystem(500);
    this.time = this.t0; this.ready = false; this.done = false;
    this.angle0 = Math.random() * 6.28;
  }
  get duration() { return this.t1 - this.t0; }
  update(dt) {
    if (!this.ok || this.done) { this.done = true; return; }
    if (!this.ready) { this.chunks.update(14); if (!this.chunks.pending()) this.ready = true; return; }
    this.time += dt;
    while (this.fi < this.fwd.length && this.fwd[this.fi][0] <= this.time) {
      const e = this.fwd[this.fi++];
      this.world.set(e[1], e[2], e[3], e[7], true, e[8], e[9]);
      this.chunks.markDirty(e[1], e[3]);
    }
    while (this.ei < this.evts.length && this.evts[this.ei].t <= this.time) {
      const e = this.evts[this.ei++];
      if (e.type === 'explosion' || e.type === 'meteorImpact') { this.particles.explosion(e.x, e.y, e.z, e.r || 4); if (this.fullscreen) this.game.audio.play('explode', null, 0.35); }
    }
    this.chunks.update(10);
    this.particles.update(dt, this.world);
    if (this.time >= this.t1) this.done = true;
  }
  snapAt(time) {
    const S = this.snaps;
    let i = 0; while (i < S.length - 1 && S[i + 1].t <= time) i++;
    const a = S[i].snap, b = S[Math.min(i + 1, S.length - 1)].snap, ta = S[i].t, tb = S[Math.min(i + 1, S.length - 1)].t;
    const f = tb > ta ? clamp((time - ta) / (tb - ta), 0, 1) : 0;
    const players = a.players.map((p, j) => { const q = b.players[j] || p; return Object.assign({}, p, { x: lerp(p.x, q.x, f), y: lerp(p.y, q.y, f), z: lerp(p.z, q.z, f), yaw: p.yaw + angleDiff(p.yaw, q.yaw) * f }); });
    return Object.assign({}, a, { players });
  }
  scene(time) {
    const snap = this.snapAt(this.time), f = this.focus;
    let fx, fy, fz, dist;
    if (f.mode === 'victim') {
      const v = snap.players[f.vi], k = f.ki >= 0 ? snap.players[f.ki] : null;
      if (k) { fx = (v.x + k.x) / 2; fy = (v.y + k.y) / 2 + 1; fz = (v.z + k.z) / 2; dist = clamp(Math.hypot(v.x - k.x, v.z - k.z) * 0.8 + 8, 9, 30); }
      else { fx = v.x; fy = v.y + 1.2; fz = v.z; dist = 9; }
    } else { fx = f.x; fy = f.y + 1; fz = f.z; dist = 18; }
    const a = this.angle0 + (this.time - this.t0) * 0.3;
    const cx = fx + Math.cos(a) * dist, cy = fy + dist * 0.4 + 2, cz = fz + Math.sin(a) * dist;
    const dx = fx - cx, dy = fy - cy, dz = fz - cz, l = Math.hypot(dx, dy, dz);
    return { chunks: this.chunks, cam: { x: cx, y: cy, z: cz, dir: { x: dx / l, y: dy / l, z: dz / l }, fov: 70 }, snap, selfIndex: -1, particles: this.particles, time: this.time, darkness: 0 };
  }
  dispose() {
    if (!this.ok) return;
    this.chunks.dispose();
    const gs = new Set(); for (const s of this.snaps) for (const g of s.snap.groups) gs.add(g.g);
    this.game.renderer.freeGroupMeshes(gs);
  }
}

/* ============================== 17. GAME =============================== */
const INTERACTIVE = new Set(['lever', 'button', 'door', 'timer']);
const DEFAULT_HOTBAR = ['pickaxe', 'sword', 'bow', 'stone', 'wood', 'tnt', 'lighter', 'plate', 'wire'];
const KILL_VERB = { melee: 'slew', arrow: 'shot', explosion: 'blew up', crush: 'crushed', mob: 'was mauled by a zombie', lava: 'swam in lava', fire: 'burned', fall: 'hit the ground too hard', drown: 'drowned', flood: 'was swept away' };

function rayAabb(o, d, b, maxT) {
  let t0 = 0, t1 = maxT;
  for (const [a, mn, mx] of [['x', b.minX, b.maxX], ['y', b.minY, b.maxY], ['z', b.minZ, b.maxZ]]) {
    if (Math.abs(d[a]) < 1e-9) { if (o[a] < mn || o[a] > mx) return -1; continue; }
    let ta = (mn - o[a]) / d[a], tb = (mx - o[a]) / d[a];
    if (ta > tb) { const t = ta; ta = tb; tb = t; }
    t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
    if (t0 > t1) return -1;
  }
  return t0;
}

class Game {
  constructor() {
    this.canvas = document.getElementById('gl');
    this.ui = new UI();
    this.audio = new AudioEngine();
    this.input = new Input();
    this.particles = new ParticleSystem();
    this.settings = Storage.load('mpw.settings', { sens: 1, fov: 75, vol: 0.7 });
    this.career = Storage.load('mpw.career', { matches: 0, wins: 0, kills: 0, deaths: 0, xp: 0, coins: 0, blocks: 0, best: 0, playSeconds: 0 });
    this.lobby = Storage.load('mpw.lobby', { mode: 'war', bots: 3, classId: 'builder', name: 'PLAYER', seed: 1 });
    if (!CLASSES[this.lobby.classId]) this.lobby.classId = 'builder';
    this.lobby.bots = clamp(this.lobby.bots | 0, 1, 5);
    this.hotbar = Storage.load('mpw.hotbar', { slots: DEFAULT_HOTBAR }).slots;
    if (!Array.isArray(this.hotbar) || this.hotbar.length !== 9 || this.hotbar.some((h) => h && !ITEMS[h])) this.hotbar = DEFAULT_HOTBAR.slice();
    this.selected = 0;
    this.state = 'menu';            // menu | paused | playing | panel | results
    this.backPanel = 'main';
    this.target = null; this.entityTarget = null; this.mining = null; this.charge = 0; this.leftWas = false; this.rightWas = false;
    this.accumulator = 0; this.lastTime = 0; this.fps = 0; this.fpsFrames = 0; this.fpsClock = 0; this.hudClock = 0; this.time = 0;
    this.debugVisible = false; this.shake = 0; this.hurt = 0; this.dark = 0; this.hints = []; this.hintClock = 0; this.stepSound = 0;
    this.spectateIndex = -1; this.replay = null; this.pendingHighlight = null; this.lastHighlight = null; this.highlightCool = 0; this.pendingKillcam = null;
    this.killDeathTimes = []; this.resultsShown = false; this.statsSaved = false; this.scoreboardHeld = false;

    this.world = new World();
    this.server = new GameServer(this.world);
    this.server.subscribe((e) => this.onServerEvent(e));
    this.recorder = new ReplayRecorder(this);
    this.atlas = generateAtlas();
    this.ui.setAtlas(this.atlas);
    try {
      this.renderer = new Renderer(this.canvas, this.atlas);
      this.chunks = this.renderer.newChunkSet(this.world, true);
    } catch (err) {
      this.ui.showError(err.message + ' Try a recent version of Chrome, Edge or Firefox with hardware acceleration enabled.');
      this.renderer = null;
    }
    this.demoMatch();
    this.bindUI();
    this.input.attach(this.canvas);
    this.input.keyHandlers.push((e) => this.onKey(e));
    this.input.keyUpHandlers.push((e) => this.onKeyUp(e));
    this.audio.setVolume(this.settings.vol);
    this.ui.showOverlay('main');
    requestAnimationFrame((t) => { this.lastTime = t; this.frame(t); });
    window.addEventListener('beforeunload', () => this.saveCareer());
  }

  get player() { return this.server.human; }
  saveCareer() { Storage.save('mpw.career', this.career); Storage.save('mpw.lobby', this.lobby); Storage.save('mpw.hotbar', { slots: this.hotbar }); Storage.save('mpw.settings', this.settings); }

  /** A frozen sample map shown behind the main menu. */
  demoMatch() {
    this.server.startMatch({ mode: 'sandbox', botCount: 5, seed: 1 + Math.floor(Math.random() * 999), classId: 'builder' });
    this.server.phase = 'idle';
    if (this.chunks) { this.chunks.chunks.forEach((c) => { c.dirty = true; }); this.chunks.buildAll(); }
  }

  /* ---------------------------- menu wiring ---------------------------- */
  bindUI() {
    const ui = this.ui, $ = ui.$, click = (id, fn) => $(id).addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); fn(); });
    ui.buildHotbar(9, (i) => this.selectSlot(i));
    ui.buildInventory((item) => { this.hotbar[this.selected] = item; this.audio.play('click'); this.saveCareer(); });
    click('btnPlay', () => { this.backPanel = 'main'; this.openLobby(); });
    click('btnHow', () => { this.backPanel = 'main'; ui.showPanel('how'); });
    click('btnHow2', () => { this.backPanel = 'pause'; ui.showPanel('how'); });
    click('btnSettings', () => { this.backPanel = 'main'; ui.showPanel('settings'); });
    click('btnSettings2', () => { this.backPanel = 'pause'; ui.showPanel('settings'); });
    click('btnStats', () => { this.backPanel = 'main'; this.renderCareer(); ui.showPanel('stats'); });
    click('btnResume', () => this.startPlay());
    click('btnQuit', () => this.leaveMatch());
    click('btnStart', () => this.startMatch());
    click('btnReroll', () => { this.lobby.seed = (this.lobby.seed % 9999) + 1; this.refreshLobby(); });
    document.querySelectorAll('.back').forEach((b) => b.addEventListener('click', () => { this.audio.play('click'); ui.showPanel(this.backPanel); this.saveCareer(); }));
    click('invClose', () => this.setPanel(null));
    click('diploClose', () => this.setPanel(null));
    $('setBots').addEventListener('input', () => { this.lobby.bots = parseInt($('setBots').value, 10); this.refreshLobby(); });
    $('setName').addEventListener('input', () => { this.lobby.name = $('setName').value.replace(/[^\w \-]/g, '').slice(0, 12) || 'PLAYER'; });

    const bindSlider = (id, outId, key, fmt, apply) => {
      const input = $(id), out = $(outId);
      input.value = this.settings[key]; out.textContent = fmt(this.settings[key]);
      input.addEventListener('input', () => { this.settings[key] = parseFloat(input.value); out.textContent = fmt(this.settings[key]); if (apply) apply(this.settings[key]); });
    };
    bindSlider('setSens', 'outSens', 'sens', (v) => v.toFixed(2) + 'x');
    bindSlider('setFov', 'outFov', 'fov', (v) => Math.round(v) + '°');
    bindSlider('setVol', 'outVol', 'vol', (v) => Math.round(v * 100) + '%', (v) => this.audio.setVolume(v));

    $('diploBody').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b || !this.player) return;
      const id = b.dataset.id, act = b.dataset.act, me = this.player, s = this.server;
      if (act === 'propose') s.handle(me.id, { type: 'propose', target: id });
      else if (act === 'accept') s.handle(me.id, { type: 'respond', from: id, accept: true });
      else if (act === 'decline') s.handle(me.id, { type: 'respond', from: id, accept: false });
      else if (act === 'leave') s.handle(me.id, { type: 'leaveAlliance' });
      else if (act === 'bounty') { const r = s.handle(me.id, { type: 'bounty', target: id, amount: 100 }); if (!r.ok) this.ui.toast('Not enough score for a bounty (100).', 'bad', 2500); }
      ui.renderDiplomacy(s, me);
    });
    $('results').addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.dataset.act === 'again') { $('results').classList.add('hidden'); this.openLobby(); }
      else if (b.dataset.act === 'menu') { $('results').classList.add('hidden'); this.toMenu(); }
      else if (b.dataset.act === 'replay' && this.lastHighlight) { $('results').classList.add('hidden'); this.playHighlight(true); }
    });

    document.addEventListener('pointerlockchange', () => {
      const locked = document.pointerLockElement === this.canvas;
      this.input.locked = locked; if (locked) this.input.lockTime = performance.now();
      if (locked) {
        if (this.state === 'paused' || this.state === 'panel' || this.state === 'menu') { this.state = 'playing'; ui.hideOverlay(); ui.showHud(true); this.setPanel(null, true); this.lastTime = performance.now(); this.accumulator = 0; }
      } else {
        this.input.releaseAll();
        this.saveCareer();
        if (this.state === 'playing') { this.state = 'paused'; ui.showOverlay('pause'); }
      }
    });
    document.addEventListener('pointerlockerror', () => { if (this.state === 'paused' || this.state === 'menu') ui.showOverlay('pause'); });
    window.addEventListener('resize', () => this.renderer && this.renderer.resize());
  }
  renderCareer() {
    const c = this.career, rows = [['Matches', c.matches], ['Wins', c.wins], ['Kills', c.kills], ['Deaths', c.deaths], ['Blocks destroyed', c.blocks], ['Best score', c.best], ['XP', c.xp], ['Coins', c.coins], ['Time played', Math.floor(c.playSeconds / 60) + ' min']];
    this.ui.$('statsTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
  }
  openLobby() {
    this.state = 'menu';
    this.ui.showHud(false); this.ui.$('results').classList.add('hidden');
    this.ui.showOverlay('lobby'); this.refreshLobby();
  }
  refreshLobby() {
    const lands = this.server.assignLands(this.lobby.seed);
    this.ui.renderLobby(this.lobby, lands, (patch) => { Object.assign(this.lobby, patch); this.audio.unlock(); this.audio.play('click'); this.refreshLobby(); });
  }
  toMenu() {
    this.releaseLock();
    this.clearReplay();
    this.state = 'menu'; this.ui.showHud(false); this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false);
    this.demoMatch(); this.ui.showOverlay('main');
  }
  leaveMatch() { this.toMenu(); }
  releaseLock() { try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ } }

  startMatch() {
    this.audio.unlock();
    const L = this.lobby;
    this.clearReplay();
    this.recorder.suspended = true;
    this.server.startMatch({ mode: L.mode, botCount: L.bots, seed: L.seed, classId: L.classId, name: L.name });
    this.recorder.reset();
    if (this.chunks) { this.chunks.chunks.forEach((c) => { c.dirty = true; }); this.chunks.buildAll(); }
    this.particles.items.length = 0;
    const p = this.player;
    this.selected = 0; this.mining = null; this.charge = 0; this.hurt = 0; this.shake = 0; this.dark = 0;
    this.spectateIndex = -1; this.lastHighlight = null; this.pendingHighlight = null; this.pendingKillcam = null; this.highlightCool = 15;
    this.resultsShown = false; this.statsSaved = false; this.server.replayAvailable = false;
    this.ui.$('killfeed').innerHTML = ''; this.ui.$('toasts').innerHTML = '';
    this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false);
    this.state = 'paused';
    this.saveCareer();
    this.startPlay();
    const land = LANDS[p.landId], cls = CLASSES[p.classId];
    this.ui.banner(land.name.toUpperCase() + ' · ' + cls.name.toUpperCase(), L.mode === 'sandbox' ? 'Sandbox: unlimited resources' : 'Match starts in a moment. Build phase: edit only your own land.', '', 3800);
  }

  startPlay() {
    this.audio.unlock();
    try { const pr = this.canvas.requestPointerLock(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) { /* handled by pointerlockerror */ }
  }
  selectSlot(i) { this.selected = ((i % 9) + 9) % 9; this.audio.play('click', null, 0.4); }
  setPanel(name, silent) {
    const inv = name === 'inventory', dip = name === 'diplomacy';
    this.ui.setPanelOpen('inventory', inv); this.ui.setPanelOpen('diplomacy', dip);
    if (inv) { this.ui.refreshInventoryRes(this.server, this.player); }
    if (dip) this.ui.renderDiplomacy(this.server, this.player);
    if (silent) return;
    if (name) { this.state = 'panel'; this.releaseLock(); } else if (this.state === 'panel') this.startPlay();
  }

  /* ------------------------------ input ------------------------------ */
  onKeyUp(e) { if (e.code === 'Tab') { this.scoreboardHeld = false; this.ui.$('scoreboard').classList.add('hidden'); } }
  onKey(e) {
    const s = this.server, p = this.player;
    if (this.state === 'panel') {
      if (e.code === 'KeyE' || e.code === 'KeyT') this.setPanel(null);
      else if (e.code === 'Escape') { this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false); this.state = 'paused'; this.ui.showOverlay('pause'); }
      return;
    }
    if (this.state !== 'playing') return;
    if (e.code === 'Tab') { this.scoreboardHeld = true; this.ui.renderScoreboard(s, p); this.ui.$('scoreboard').classList.remove('hidden'); return; }
    if (e.code.startsWith('Digit')) { const n = parseInt(e.code.slice(5), 10); if (n >= 1 && n <= 9) this.selectSlot(n - 1); return; }
    if (e.code === 'KeyM') { this.audio.toggleMute(); return; }
    if (e.code === 'F3') { this.debugVisible = !this.debugVisible; return; }
    if (e.code === 'KeyE') { this.setPanel('inventory'); return; }
    if (e.code === 'KeyT') { this.setPanel('diplomacy'); return; }
    if (e.code === 'KeyY' || e.code === 'KeyN') {
      const q = s.proposals.filter((r) => r.to === p).pop();
      if (q) s.handle(p.id, { type: 'respond', from: q.from.id, accept: e.code === 'KeyY' });
      return;
    }
    if (e.code === 'KeyR') {
      if (this.replay) { if (this.replay.fullscreen) this.endReplay(); }
      else if (!p.alive && this.deathReplay) this.startKillcam(this.deathReplay.victim, this.deathReplay.killer);
      else if (this.lastHighlight) this.playHighlight(false);
      return;
    }
    if (e.code === 'Space' && !p.alive) {
      if (this.replay && this.replay.fullscreen) this.endReplay(); else this.cycleSpectate();
    }
  }
  cycleSpectate() {
    const alive = this.server.players.filter((q) => q.alive && q !== this.player);
    if (!alive.length) return;
    const cur = alive.findIndex((q) => q.index === this.spectateIndex);
    this.spectateIndex = alive[(cur + 1) % alive.length].index;
  }

  /* ------------------------------ sound helpers ------------------------------ */
  listener() { const p = this.player; return p ? p.pos : { x: 50, y: 20, z: 50 }; }
  vol(x, y, z, range = 55) { const l = this.cam || this.listener(), d = Math.hypot(x - l.x, y - l.y, z - l.z); return Math.pow(clamp(1 - d / range, 0, 1), 1.4); }
  sfx(name, x, y, z, range, block) { this.audio.play(name, block, x == null ? 1 : this.vol(x, y, z, range)); }

  /* --------------------- what the server tells the client --------------------- */
  onServerEvent(e) {
    const P = this.particles, me = this.player;
    switch (e.type) {
      case 'blockBroken': P.burst(e.x + 0.5, e.y + 0.5, e.z + 0.5, e.block.color, 14); this.sfx('break', e.x, e.y, e.z, 40, e.block); break;
      case 'blockPlaced': P.burst(e.x + 0.5, e.y + 0.5, e.z + 0.5, e.block.color, 4, 1.4, 0.09); this.sfx('place', e.x, e.y, e.z, 30, e.block); break;
      case 'debris': P.burst(e.x + 0.5, e.y + 0.5, e.z + 0.5, e.block.color, 6, 2.5, 0.12); break;
      case 'explosion': {
        P.explosion(e.x, e.y, e.z, e.radius);
        for (const d of e.debris || []) P.burst(d[0] + 0.5, d[1] + 0.5, d[2] + 0.5, BLOCKS[d[3]].color, 2, 6, 0.16);
        const v = this.vol(e.x, e.y, e.z, 90); this.audio.play(e.radius > 5 ? 'bigexplode' : 'explode', null, v);
        this.shake = Math.max(this.shake, clamp(e.power * v * 1.6, 0, 2));
        this.recorder.logEvent('explosion', e.x, e.y, e.z, e.radius);
        if (e.count >= 55) this.noteHighlight(e.x, e.y, e.z, e.count >= 120 ? 'MASSIVE EXPLOSION' : 'BIG BLAST', e.count);
        break;
      }
      case 'tntPrimed': this.sfx('fuse', e.tnt.pos.x, e.tnt.pos.y, e.tnt.pos.z, 30); break;
      case 'ignite': this.sfx('sizzle', e.x, e.y, e.z, 25); break;
      case 'shoot': { const a = e.arrow; this.sfx('shoot', a.pos.x, a.pos.y, a.pos.z, 45); break; }
      case 'hit': {
        const t = e.target; this.sfx('hit', t.pos.x, t.pos.y + 1, t.pos.z, 40);
        if (t === me) { this.hurt = Math.min(1, this.hurt + 0.35); this.audio.play('hurt', null, 0.8); }
        break;
      }
      case 'damage': if (e.target === me && e.src.kind !== 'melee' && e.src.kind !== 'arrow') { this.hurt = Math.min(1, this.hurt + clamp(e.amount / 40, 0.1, 0.6)); if (e.amount > 3) this.audio.play('hurt', null, 0.7); } break;
      case 'hardLanding': this.sfx('land', e.player.pos.x, e.player.pos.y, e.player.pos.z, 35); break;
      case 'groundImpact': {
        const v = this.vol(e.x, e.y, e.z, 80); this.audio.play('crash', null, v);
        P.puff(e.x, e.y + 0.5, e.z, [0.6, 0.55, 0.5], Math.min(40, 8 + e.size), 3, 2, 0.5, 0.9, false);
        this.shake = Math.max(this.shake, clamp(e.size / 60 * v * 2, 0, 1.2));
        break;
      }
      case 'groupFormed': {
        if (e.structure) {
          const b = e.group.bounds; this.audio.play('rumble', null, this.vol((b.minX + b.maxX) / 2, b.minY, (b.minZ + b.maxZ) / 2, 80));
          if (e.group.cells.length >= 30) this.noteHighlight((b.minX + b.maxX) / 2, b.minY, (b.minZ + b.maxZ) / 2, 'STRUCTURE COLLAPSE', e.group.cells.length);
        }
        break;
      }
      case 'mechClick': this.sfx('mech', e.x, e.y, e.z, 25); break;
      case 'doorToggle': this.sfx('door', e.x, e.y, e.z, 35); break;
      case 'piston': this.sfx('piston', e.x, e.y, e.z, 40); break;
      case 'alarm': this.sfx('alarm', e.x, e.y, e.z, 70); break;
      case 'sensorPing': if (me && e.owner === me.index) { this.ui.toast('SENSOR: movement near your base!', 'warn', 3500); this.audio.play('tick', null, 0.8); } break;
      case 'arrowStuck': break;
      case 'meteorWarning': this.ui.banner('METEOR INCOMING', 'Look for the red marker!', 'warn', 2600); this.audio.play('siren'); break;
      case 'meteorLaunch': this.audio.play('meteor', null, 0.8); break;
      case 'meteorImpact': this.recorder.logEvent('meteorImpact', e.x, e.y, e.z, 6.5); this.shake = Math.max(this.shake, 1.5); this.noteHighlight(e.x, e.y, e.z, 'METEOR STRIKE', 100); break;
      case 'collapseStrike': this.shake = Math.max(this.shake, 1.2); break;
      case 'quakeTick': this.shake = Math.max(this.shake, 0.8); this.audio.play('rumble', null, 0.6); break;
      case 'layerFilled': if (e.y % 3 === 0) this.audio.play('splash', null, 0.3); break;
      case 'event': this.onDisaster(e); break;
      case 'phase': this.onPhase(e); break;
      case 'respawn': if (e.player === me) { this.ui.toast('Respawned', '', 1500); this.spectateIndex = -1; } break;
      case 'vaultCaptured': {
        const names = e.players.map((p) => p.name).join(' & ');
        this.ui.killfeed(`<b>${esc(names)}</b> captured the VAULT <em>+250</em>`, 'good'); this.audio.play('chime', null, 0.8);
        if (e.players.includes(me)) this.ui.banner('VAULT CAPTURED', '+250 score and a loot drop', 'good', 2800);
        this.noteHighlight(this.server.map.vault.x, this.server.map.vault.y, this.server.map.vault.z, 'VAULT CAPTURED', 40);
        break;
      }
      case 'baseDestroyed': {
        const who = e.player; this.ui.killfeed(`<b style="color:${who.color}">${esc(who.name)}</b>'s base was DESTROYED${e.by ? ' by <b style="color:' + e.by.color + '">' + esc(e.by.name) + '</b>' : ''}`, 'bad');
        if (who === me) this.ui.banner('YOUR BASE IS DESTROYED', 'Stay alive. Take someone with you.', 'bad', 3500);
        const pl = this.server.plots[who.index]; if (pl) this.noteHighlight(pl.x, pl.baseY + 3, pl.z, 'BASE DESTROYED', 80);
        this.audio.play('crash', null, 0.7);
        break;
      }
      case 'bounty': {
        this.ui.killfeed(`<b style="color:${e.from.color}">${esc(e.from.name)}</b> put a $${e.amount} BOUNTY on <b style="color:${e.target.color}">${esc(e.target.name)}</b>`, 'warn');
        if (e.target === me) { this.ui.banner('BOUNTY ON YOU', 'Everyone is hunting you for $' + e.target.bounty, 'bad', 3200); this.audio.play('bounty'); }
        break;
      }
      case 'bountyExpired': break;
      case 'proposal': if (e.to === me) { this.ui.toast(`<b style="color:${e.from.color}">${esc(e.from.name)}</b> offers an ALLIANCE &mdash; <kbd>Y</kbd> accept / <kbd>N</kbd> decline`, 'good', 12000); this.audio.play('chime', null, 0.6); } break;
      case 'proposalDeclined': if (e.from === me) this.ui.toast(esc(e.to.name) + ' declined your offer.', '', 3000); break;
      case 'allianceFormed': this.ui.killfeed(`<b style="color:${e.a.color}">${esc(e.a.name)}</b> and <b style="color:${e.b.color}">${esc(e.b.name)}</b> formed an ALLIANCE`, 'good'); if (e.a === me || e.b === me) this.ui.banner('ALLIANCE FORMED', 'Allies cannot hit each other directly. Watch your TNT.', 'good', 2800); break;
      case 'allianceBroken': this.ui.killfeed(`<b style="color:${e.player.color}">${esc(e.player.name)}</b> ${e.betrayal ? 'BETRAYED their allies!' : 'left their alliance'}`, 'bad'); if (e.betrayal) { this.audio.play('siren', null, 0.6); } break;
      case 'death': this.onDeath(e); break;
      case 'mobDeath': break;
      case 'matchEnd': this.onMatchEnd(e); break;
      default: break;
    }
  }
  onPhase(e) {
    const U = this.ui, M = CONFIG.MATCH, s = this.server;
    this.audio.play('phase', null, 0.7);
    if (e.phase === 'build') U.banner('BUILD PHASE', `Fortify your land &mdash; ${fmtTime(M.BUILD)}`.replace('&mdash;', '·'), '', 3400);
    else if (e.phase === 'war') { U.banner('WAR!', 'PvP is on. Destroy their bases. Capture the vault.', 'bad', 3600); this.audio.play('siren', null, 0.5); }
    else if (e.phase === 'chaos') { U.banner('CHAOS', 'Disasters rage until the end', 'warn', 3400); this.audio.play('siren', null, 0.7); }
    else if (e.phase === 'sandbox') U.banner('SANDBOX', 'Unlimited resources. Break everything.', '', 3000);
  }
  onDisaster(e) {
    const U = this.ui;
    if (e.phase === 'start') { U.banner('DISASTER: ' + e.name, 'Brace yourself!', 'warn', 3200); this.audio.play('siren', null, 0.8); U.killfeed('DISASTER &mdash; ' + esc(e.name), 'warn'); }
    else if (e.phase === 'end') U.toast(esc(e.name) + ' is over.', '', 2500);
  }
  onDeath(e) {
    const me = this.player, U = this.ui, v = e.victim, k = e.killer;
    const vn = `<b style="color:${v.color}">${esc(v.name)}</b>`;
    let txt;
    if (k) txt = `<b style="color:${k.color}">${esc(k.name)}</b> ${e.tnt && e.kind === 'explosion' ? 'blew up' : (KILL_VERB[e.kind] || 'killed')} ${vn}`;
    else if (e.kind === 'mob') txt = `${vn} was mauled by a zombie`;
    else txt = `${vn} ${e.kind === 'explosion' ? 'was blown up' : e.kind === 'crush' ? (e.detail === 'collapse' ? 'was crushed by a collapse' : e.detail === 'suffocation' ? 'suffocated' : 'was crushed') : (KILL_VERB[e.kind] || 'died')}`;
    if (e.bounty) txt += ` <em>+$${e.bounty}</em>`;
    U.killfeed(txt, k === me || v === me ? 'me' : '');
    this.sfx('death', v.pos.x, v.pos.y, v.pos.z, 50);
    const t = this.server.clock;
    this.killDeathTimes.push(t);
    this.killDeathTimes = this.killDeathTimes.filter((x) => t - x < 3.5);
    if (this.killDeathTimes.length >= 2) this.noteHighlight(v.pos.x, v.pos.y, v.pos.z, 'DOUBLE KILL', 60);
    else if (e.tnt && k) this.noteHighlight(v.pos.x, v.pos.y, v.pos.z, 'TNT KILL', 45);
    if (k === me && v !== me) { U.banner('ELIMINATED ' + v.name, '+500' + (e.bounty ? ' +$' + e.bounty + ' bounty' : ''), 'good', 1800); }
    if (v === me) {
      this.deathReplay = { victim: v, killer: k };
      this.mining = null; this.charge = 0;
      if (this.server.mode !== 'sandbox' && this.server.phase !== 'ended') {
        U.banner('YOU DIED', k ? 'Killed by ' + k.name : 'Eliminated', 'bad', 2400);
        this.spectateIndex = k && k.alive ? k.index : -1;
        this.pendingKillcam = { at: this.server.clock + 1.0, victim: v, killer: k };
        U.setPanelOpen('inventory', false); U.setPanelOpen('diplomacy', false);
        if (this.state === 'panel') { this.state = 'playing'; this.startPlay(); }
      } else U.banner('YOU DIED', 'Respawning...', 'bad', 1800);
    }
  }
  onMatchEnd(e) {
    this.matchEndAt = this.time + 2.2;
    this.ui.banner(e.winners.length ? (e.winners.includes(this.player) ? 'VICTORY!' : 'MATCH OVER') : 'DRAW', e.winners.length ? e.winners.map((p) => p.name).join(' & ') + ' wins' : 'Nobody survived', e.winners.includes(this.player) ? 'good' : 'bad', 2400);
    this.audio.play('chime', null, 0.9);
  }
  showResults() {
    const s = this.server, me = this.player, row = s.results.rows.find((r) => r.player === me);
    if (!this.statsSaved && row) {
      this.statsSaved = true;
      const c = this.career; c.matches++; if (row.won) c.wins++; c.kills += row.kills; c.deaths += row.deaths; c.xp += row.xp; c.coins += row.coins; c.blocks += row.blocksDestroyed; c.best = Math.max(c.best, row.score); this.saveCareer();
    }
    this.clearReplay(); this.state = 'results'; this.releaseLock(); this.ui.showHud(false);
    this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false); this.ui.$('scoreboard').classList.add('hidden');
    s.replayAvailable = !!this.lastHighlight;
    this.ui.renderResults(s, me, `Career: ${this.career.wins} wins in ${this.career.matches} matches &middot; ${this.career.xp} XP &middot; ${this.career.coins} coins`);
  }

  /* ----------------------------- replays ----------------------------- */
  noteHighlight(x, y, z, label, weight) {
    if (this.server.phase === 'ended' || this.server.mode === 'sandbox' && weight < 60) return;
    this.lastHighlight = { x, y, z, label, t: this.server.clock };
    this.server.replayAvailable = true;
    if (this.highlightCool > 0 || this.replay || this.pendingHighlight || this.state !== 'playing' || !this.player.alive) return;
    this.pendingHighlight = { at: this.server.clock + 1.4, x, y, z, label };
  }
  clearReplay() { if (this.replay) { this.replay.dispose(); this.replay = null; } this.pendingHighlight = null; this.pendingKillcam = null; this.ui && this.ui.setReplayTag(''); }
  endReplay() {
    const r = this.replay; if (!r) return;
    const wasResults = r.fromResults;
    r.dispose(); this.replay = null; this.ui.setReplayTag('');
    if (wasResults) this.showResults();
  }
  startKillcam(victim, killer) {
    if (this.replay || !this.renderer) return;
    const r = new Replay(this, this.server.clock - 8, this.server.clock, { mode: 'victim', vi: victim.index, ki: killer ? killer.index : -1 }, 'KILLCAM', true);
    if (!r.ok) return;
    this.replay = r; this.ui.setReplayTag('<b>KILLCAM</b> &mdash; <kbd>Space</kbd> skip', true);
  }
  playHighlight(fullscreen) {
    const h = this.lastHighlight; if (!h || this.replay || !this.renderer) return;
    const r = new Replay(this, h.t - 5, Math.min(h.t + 2, this.server.clock), { mode: 'point', x: h.x, y: h.y, z: h.z }, h.label, fullscreen);
    if (!r.ok) return;
    r.fromResults = fullscreen && this.state === 'results';
    this.replay = r; this.highlightCool = 24;
    this.ui.setReplayTag(`<b>REPLAY</b> &mdash; ${esc(h.label)}` + (fullscreen ? ' &mdash; <kbd>Space</kbd> skip' : ''), fullscreen);
    if (r.fromResults) { this.ui.showHud(true); this.state = 'results'; }
  }

  /* ----------------------------- simulation ----------------------------- */
  tick(dt) {
    const s = this.server, p = this.player;
    const playing = this.state === 'playing' && p.alive;
    p.controls = playing ? this.input.controls() : { forward: false, back: false, left: false, right: false, jump: false, crouch: false };
    s.update(dt);
    this.recorder.tick(dt);
    if (s.phase === 'ended' && this.state !== 'results' && !this.resultsShown && this.time >= (this.matchEndAt || 0)) { this.resultsShown = true; this.showResults(); return; }
    if (playing) {
      if (p.jumped) this.audio.play('jump', null, 0.8);
      if (p.impactSpeed > 9) this.audio.play('land', null, clamp(p.impactSpeed / 20, 0.3, 1));
      if (p.stepDistance > (p.crouching ? 1.6 : 2.3)) { p.stepDistance = 0; this.audio.play('step', null, 0.9); }
      this.updateInteraction(dt);
    } else { this.mining = null; this.target = null; this.entityTarget = null; this.charge = 0; }
    this.career.playSeconds += dt;
    this.highlightCool = Math.max(0, this.highlightCool - dt);
    if (this.pendingHighlight && s.clock >= this.pendingHighlight.at) { const h = this.pendingHighlight; this.pendingHighlight = null; if (!this.replay && this.state === 'playing') { this.lastHighlight = { x: h.x, y: h.y, z: h.z, label: h.label, t: s.clock - 1.4 }; this.playHighlight(false); } }
    if (this.pendingKillcam && s.clock >= this.pendingKillcam.at) { const k = this.pendingKillcam; this.pendingKillcam = null; if (!p.alive) this.startKillcam(k.victim, k.killer); }
  }

  currentItem() { const id = this.hotbar[this.selected]; return id ? { id, def: ITEMS[id] } : null; }

  updateInteraction(dt) {
    const p = this.player, w = this.world, s = this.server, item = this.currentItem(), inp = this.input;
    const eye = p.eyePosition(), dir = p.lookDirection(), T = item && item.def.kind === 'tool' ? TOOLS[item.id] : null;
    const reach = CONFIG.PLAYER.REACH, hit = w.raycast(eye, dir, reach);
    this.target = hit;
    // entity under the crosshair (players and mobs), only if nearer than the block hit
    const meleeReach = T && T.reach ? T.reach : 3.0;
    let ent = null, best = Math.min(hit ? hit.dist : reach, Math.max(meleeReach, T && T.id === 'bow' ? reach : meleeReach)) + 0.01;
    const consider = (b) => { const a = b.aabb(); a.minX -= 0.12; a.maxX += 0.12; a.minZ -= 0.12; a.maxZ += 0.12; a.maxY += 0.1; const t = rayAabb(eye, dir, a, best); if (t >= 0 && t < best) { best = t; ent = b; } };
    for (const q of s.players) if (q.alive && q !== p) consider(q);
    for (const m of s.mobs) if (m.alive) consider(m);
    this.entityTarget = ent;
    if (ent) this.target = null;
    const left = inp.mouse.left, right = inp.mouse.right, leftEdge = left && !this.leftWas, rightEdge = right && !this.rightWas;
    this.leftWas = left; this.rightWas = right;
    const tgt = this.target;

    // ---- left button ----
    this.charge = 0;
    if (item && item.id === 'bow') {
      if (left) { this.bowHeld = (this.bowHeld || 0) + dt; this.charge = clamp(this.bowHeld / (TOOLS.bow.draw * p.mods.bowDraw), 0, 1); }
      else if (this.bowHeld) { const ch = clamp(this.bowHeld / (TOOLS.bow.draw * p.mods.bowDraw), 0, 1); this.bowHeld = 0; if (ch > 0.2) { s.handle(p.id, { type: 'shoot', charge: ch }); p.cooldowns.shoot = Math.max(p.cooldowns.shoot, 0.05); } }
      this.mining = null;
    } else {
      this.bowHeld = 0;
      if (item && item.id === 'lighter') {
        this.mining = null;
        if (leftEdge && tgt) { const r = s.handle(p.id, { type: 'ignite', x: tgt.x, y: tgt.y, z: tgt.z, nx: tgt.nx, ny: tgt.ny, nz: tgt.nz }); if (!r.ok && r.reason === 'not-allowed') this.ui.toast('You cannot do that here right now.', 'bad', 1500); }
      } else if (left && ent) {
        this.mining = null;
        if (p.cooldowns.attack <= 0) s.handle(p.id, { type: 'attack', targetId: ent.id, tool: T && T.dmg != null ? item.id : 'pickaxe' });
      } else if (left && tgt) {
        const key = tgt.x + ',' + tgt.y + ',' + tgt.z, def = w.def(tgt.x, tgt.y, tgt.z);
        if (!this.mining || this.mining.key !== key) this.mining = { key, progress: 0 };
        if (def.breakable) {
          this.mining.progress += dt / mineTime(def, item && item.def.kind === 'tool' ? item.id : null, p.mods);
          if (this.mining.progress >= 1) {
            const r = s.handle(p.id, { type: 'break', x: tgt.x, y: tgt.y, z: tgt.z });
            if (!r.ok && r.reason === 'not-allowed') this.ui.toast(s.phase === 'build' ? 'Build phase: you can only edit your own land.' : 'You cannot do that right now.', 'bad', 1800);
            this.mining = null;
          }
        }
      } else this.mining = null;
    }

    // ---- right button ----
    if (right && tgt) {
      const def = w.def(tgt.x, tgt.y, tgt.z);
      if (INTERACTIVE.has(def.type) && !p.crouching) { if (rightEdge) s.handle(p.id, { type: 'use', x: tgt.x, y: tgt.y, z: tgt.z }); }
      else if (item && item.def.kind !== 'tool' && (tgt.nx || tgt.ny || tgt.nz)) {
        const r = s.handle(p.id, { type: 'place', x: tgt.x + tgt.nx, y: tgt.y + tgt.ny, z: tgt.z + tgt.nz, item: item.id, against: { x: tgt.x, y: tgt.y, z: tgt.z } });
        if (!r.ok && rightEdge) {
          const msg = { 'no-resource': 'Out of ' + RESOURCES[item.def.res].label.toLowerCase() + '!', 'not-allowed': s.phase === 'build' ? 'Build phase: you can only edit your own land.' : 'You cannot build yet.', 'no-support': 'Needs something to attach to.', 'no-floor': 'Needs solid ground below it.', 'player-in-way': 'Someone is in the way.' }[r.reason];
          if (msg) this.ui.toast(msg, 'bad', 1500);
        }
      }
    }
    // Engineer perk: highlight hidden mechanisms near you
    this.hintClock -= dt;
    if (this.hintClock <= 0) {
      this.hintClock = 0.4; this.hints = [];
      if (p.mods.seeMechs) for (const k of s.redstone.mechs) { const [x, y, z] = unkey(k); if (Math.hypot(x + 0.5 - p.pos.x, y + 0.5 - p.pos.y, z + 0.5 - p.pos.z) < 7 && w.getOwner(x, y, z) !== p.index + 1) this.hints.push([x, y, z]); }
    }
  }

  /* ------------------------------- frame ------------------------------- */
  frame(now) {
    requestAnimationFrame((t) => this.frame(t));
    const dt = Math.min((now - this.lastTime) / 1000, 0.1);
    this.lastTime = now; this.time += dt;
    const s = this.server, p = this.player;
    const simulating = (this.state === 'playing' || this.state === 'panel') && s.phase !== 'idle';
    if (this.state === 'playing' && p.alive) {
      const sens = CONFIG.MOUSE_SENS * this.settings.sens;
      p.yaw -= this.input.dx * sens;
      p.pitch = clamp(p.pitch - this.input.dy * sens, -Math.PI / 2 + 0.01, Math.PI / 2 - 0.01);
      if (this.input.wheel) { this.selectSlot(this.selected + this.input.wheel); this.input.wheel = 0; }
    }
    this.input.dx = this.input.dy = 0;
    if (this.state === 'results' && !(this.replay && this.replay.fullscreen)) this.input.wheel = 0;
    if (simulating) {
      this.accumulator += dt;
      let n = 0;
      while (this.accumulator >= CONFIG.STEP && n++ < 6) { this.tick(CONFIG.STEP); this.accumulator -= CONFIG.STEP; }
      this.particles.update(dt, this.world);
      this.emitAmbient(dt);
    } else if (this.state === 'results') { this.particles.update(dt, this.world); }
    if (this.replay) { this.replay.update(dt); if (this.replay.done) this.endReplay(); }
    this.shake = Math.max(0, this.shake - dt * 2.2); this.hurt = Math.max(0, this.hurt - dt * 1.3);
    this.dark = lerp(this.dark, s.darkness, clamp(dt * 1.5, 0, 1));
    if (this.state === 'playing' || this.state === 'panel') {
      this.hudClock -= dt;
      if (this.hudClock <= 0) { this.hudClock = 0.2; this.updateHud(); }
      if (this.scoreboardHeld && Math.floor(this.time * 2) !== this.sbTick) { this.sbTick = Math.floor(this.time * 2); this.ui.renderScoreboard(s, p); }
      this.ui.refreshHotbar(this.hotbar, this.selected, s, p);
      if (this.state === 'panel') this.ui.refreshInventoryRes(s, p);
    }
    this.render(dt);
    this.fpsFrames++; this.fpsClock += dt;
    if (this.fpsClock >= 0.5) { this.fps = Math.round(this.fpsFrames / this.fpsClock); this.fpsFrames = 0; this.fpsClock = 0; }
  }

  /** Fire and smoke over burning blocks, trails behind meteors and lit TNT. */
  emitAmbient(dt) {
    const P = this.particles, s = this.server;
    this.ambClock = (this.ambClock || 0) - dt;
    if (this.ambClock > 0) return;
    this.ambClock = 0.12;
    const l = this.cam || this.listener();
    let n = 0;
    for (const k of s.fire.fires) {
      const [x, y, z] = unkey(k);
      if (Math.abs(x - l.x) > 40 || Math.abs(z - l.z) > 40) continue;
      P.puff(x + 0.5, y + 0.5, z + 0.5, Math.random() < 0.5 ? [1, 0.5, 0.1] : [1, 0.8, 0.2], 1, 0.6, 1.6, 0.18, 0.6);
      if (Math.random() < 0.15) P.puff(x + 0.5, y + 1, z + 0.5, [0.25, 0.25, 0.25], 1, 0.4, 1.2, 0.25, 1.2, false);
      if (++n > 30) break;
    }
    for (const t of s.tnts) P.puff(t.pos.x, t.pos.y + 1, t.pos.z, [1, 0.8, 0.3], 1, 0.15, 1.5, 0.1, 0.35);
    for (const m of s.meteors) P.puff(m.pos.x, m.pos.y, m.pos.z, [1, 0.5, 0.15], 4, 1.4, 0.5, 0.7, 0.9);
    for (const b of s.bodies()) if (b.burnTime > 0) P.puff(b.pos.x, b.pos.y + 1, b.pos.z, [1, 0.5, 0.1], 1, 0.5, 1.5, 0.15, 0.5);
  }

  stageInfo() {
    const s = this.server, M = CONFIG.MATCH;
    switch (s.phase) {
      case 'countdown': return ['GET READY', 'Match begins in ' + Math.ceil(M.COUNTDOWN - s.phaseTime), fmtTime(M.COUNTDOWN - s.phaseTime)];
      case 'build': { const left = s.timeLeft(); return left <= 30 * (M.BUILD / 180) ? ['PREPARE', 'Set traps, load TNT, sharpen weapons. War is coming.', fmtTime(left)] : ['BUILD', 'Fortify your land. Only your own land can be edited.', fmtTime(left)]; }
      case 'war': { const t = s.phaseTime / (M.WAR - M.CHAOS); const left = s.timeLeft(); return t < 0.33 ? ['FIGHT', 'PvP is on. Hunt, defend, grab the vault.', fmtTime(left)] : t < 0.75 ? ['DESTROY', 'Break enemy bases. Watch their integrity %.', fmtTime(left)] : ['SURVIVE', 'Stay alive. Chaos is near.', fmtTime(left)]; }
      case 'chaos': return ['CHAOS', 'Disasters rage. Last team standing or best score wins.', fmtTime(s.timeLeft())];
      case 'sandbox': return ['SANDBOX', 'Unlimited resources. No timers.', '∞'];
      case 'ended': return ['MATCH OVER', '', '0:00'];
      default: return ['', '', ''];
    }
  }
  updateHud() {
    const s = this.server, p = this.player, U = this.ui;
    const [stage, obj, time] = this.stageInfo();
    U.setStage(stage, obj, time);
    U.setEventBar(s.event && s.event.state === 'active' ? `${s.event.name} &mdash; ${Math.ceil(s.event.duration - s.event.t)}s`.replace('&mdash;', '·') : (s.event ? s.event.name + '...' : ''));
    U.setVitals(p.health, p.maxHealth, s.integrity(p.index), p.bounty, this.statusLine());
    U.setResources(s, p);
    U.setPlayers(s.scoreboard().map((q) => ({ name: q.name, color: q.color, alive: q.alive, hp: q.health / q.maxHealth * 100, integ: s.integrity(q.index), score: Math.round(q.stats.score), me: q === p, ally: s.areAllies(q, p), bounty: q.bounty })));
    const v = s.vault, showV = s.phase === 'war' || s.phase === 'chaos' || s.phase === 'sandbox';
    U.setVault(showV, v.cooldown > 0 ? 1 - v.cooldown / 45 : v.progress, v.cooldown > 0 ? 'VAULT RECHARGING' : v.capturing ? 'CAPTURING...' : 'VAULT (centre of map)', v.cooldown > 0 ? 'cool' : v.capturing ? 'cap' : '');
    U.setCharge(this.charge);
    U.setDebug(this.debugVisible, this.debugText());
    // contextual hint
    let hint = '';
    const t = this.target;
    if (t && p.alive) { const d = this.world.def(t.x, t.y, t.z); if (INTERACTIVE.has(d.type)) hint = { lever: '[Right-click] flip lever', button: '[Right-click] press button', door: '[Right-click] open / close door', timer: '[Right-click] start timer' }[d.type] + '  ·  crouch to place instead'; }
    if (!p.alive) hint = '';
    U.setHint(hint);
    if (!p.alive && s.mode !== 'sandbox' && this.state !== 'results' && !(this.replay && this.replay.fullscreen)) {
      const tg = s.players[this.spectateIndex];
      U.setSpectate(tg && tg.alive ? `SPECTATING <b style="color:${tg.color}">${esc(tg.name)}</b> &mdash; <kbd>Space</kbd> next &middot; <kbd>R</kbd> killcam` : 'SPECTATING &mdash; <kbd>Space</kbd> switch player');
    } else U.setSpectate('');
    U.setScreenTint(this.tintKind());
  }
  statusLine() {
    const p = this.player, s = this.server, bits = [];
    bits.push(`<b>${esc(CLASSES[p.classId].name)}</b> on <b>${esc(LANDS[p.landId].name)}</b>`);
    const mates = s.players.filter((q) => s.areAllies(p, q));
    if (mates.length) bits.push('<span class="ally">ALLIED with ' + mates.map((m) => esc(m.name)).join(', ') + '</span>');
    if (p.bounty) bits.push(`<span class="bad">BOUNTY $${p.bounty}</span>`);
    if (s.base_destroyed_flag) bits.push('');
    if (s.baseDestroyed[p.index]) bits.push('<span class="bad">BASE DESTROYED</span>');
    if (p.burnTime > 0) bits.push('<span class="bad">BURNING</span>');
    return bits.join(' &middot; ');
  }
  tintKind() {
    const p = this.player, w = this.world, c = this.cam;
    if (!c) return '';
    const id = w.get(Math.floor(c.x), Math.floor(c.y), Math.floor(c.z));
    return id === ID.water ? 'water' : id === ID.lava ? 'lava' : p.burnTime > 0 ? 'fire' : '';
  }
  debugText() {
    const p = this.player, t = this.target, r = this.renderer ? this.renderer.stats : { drawnChunks: 0, triangles: 0, totalChunks: 0 };
    const tgt = t ? `${this.world.def(t.x, t.y, t.z).type} (${t.x}, ${t.y}, ${t.z})` : 'none';
    return `FPS ${this.fps}\nXYZ ${p.pos.x.toFixed(1)} ${p.pos.y.toFixed(1)} ${p.pos.z.toFixed(1)}\nLooking at ${tgt}\nChunks ${r.drawnChunks}/${r.totalChunks}  Tris ${Math.round(r.triangles)}\nBodies ${this.server.bodies().length}  TNT ${this.server.tnts.length}  Groups ${this.server.groups.length}  Fluid ${this.server.fluids.pending.size}\nPhase ${this.server.phase}`;
  }

  /* ------------------------------ rendering ------------------------------ */
  mainScene(alpha) {
    const s = this.server, p = this.player, srv = this.server;
    const snap = s.snapshot(alpha);
    let cam, selfIndex = p.index, held = null;
    if (!p.alive && s.mode !== 'sandbox' && s.phase !== 'idle') {
      let tg = s.players[this.spectateIndex];
      if (!tg || !tg.alive) { const alive = s.players.filter((q) => q.alive); tg = alive[0]; if (tg) this.spectateIndex = tg.index; }
      if (tg) {
        const d = { x: -Math.sin(tg.yaw) * Math.cos(tg.pitch), y: Math.sin(tg.pitch), z: -Math.cos(tg.yaw) * Math.cos(tg.pitch) };
        const e = tg.eyePosition(alpha), dist = 5.5;
        cam = { x: e.x - d.x * dist, y: e.y - d.y * dist + 1.2, z: e.z - d.z * dist, dir: { x: d.x, y: d.y - 0.12, z: d.z }, fov: this.settings.fov };
        const l = Math.hypot(cam.dir.x, cam.dir.y, cam.dir.z); cam.dir.x /= l; cam.dir.y /= l; cam.dir.z /= l;
        selfIndex = -1;
      }
    }
    if (!cam) {
      const e = p.eyePosition(alpha), dir = p.lookDirection(), sh = this.shake * 0.12;
      cam = { x: e.x + (Math.random() - 0.5) * sh, y: e.y + (Math.random() - 0.5) * sh, z: e.z + (Math.random() - 0.5) * sh, dir, fov: this.settings.fov };
      const it = this.currentItem();
      if (p.alive && it) held = it.def.kind === 'tool' ? { kind: 'tool', tile: TILE['ICON_' + it.id.toUpperCase()] } : { kind: 'block', id: BlockRegistry.byType(it.def.block).id, meta: it.id === 'piston' ? 12 : 0 };
    }
    this.cam = cam;
    const m = srv.map ? srv.map.vault : null;
    const live = s.phase === 'war' || s.phase === 'chaos' || s.phase === 'sandbox';
    return {
      chunks: this.chunks, cam, snap, selfIndex, target: this.target, mining: this.mining ? clamp(this.mining.progress, 0, 1) : 0,
      particles: this.particles, darkness: this.dark, time: this.time, held, swing: p.swing > 0 ? 1 - p.swing : 0,
      hints: this.hints, vault: m && live ? { x: m.x, y: m.y, z: m.z, cooldown: s.vault.cooldown, capturing: s.vault.capturing } : null,
      warnings: s.pendingMeteors.filter((q) => !q.done),
    };
  }
  render(dt) {
    const r = this.renderer; if (!r) return;
    r.resize();
    const s = this.server;
    if (this.chunks.pending()) this.chunks.update(CONFIG.RENDER.REBUILD_BUDGET + (this.state === 'menu' ? 6 : 0));
    if (this.replay && this.replay.ready && this.replay.fullscreen) {
      r.draw(this.replay.scene(), null);
      this.ui.updateNameplates([]);
      return;
    }
    if (this.state === 'menu' || (this.state === 'paused' && s.phase === 'idle')) {                       // slow flyover behind the menus
      const a = this.time * 0.08, c = s.map ? s.map.center : { x: 50, z: 50 };
      const cx = c.x + Math.cos(a) * 62, cz = c.z + Math.sin(a) * 62, cy = 38, dx = c.x - cx, dy = 8 - cy, dz = c.z - cz, l = Math.hypot(dx, dy, dz);
      r.draw({ chunks: this.chunks, cam: { x: cx, y: cy, z: cz, dir: { x: dx / l, y: dy / l, z: dz / l }, fov: 65 }, snap: s.snapshot(1), selfIndex: -1, particles: null, time: this.time }, null);
      this.ui.updateNameplates([]);
      return;
    }
    const alpha = this.state === 'playing' || this.state === 'panel' ? this.accumulator / CONFIG.STEP : 1;
    const scene = this.mainScene(alpha);
    r.draw(scene, null);
    if (this.replay && this.replay.ready && !this.replay.fullscreen) {
      const k = this.canvas.width / Math.max(1, this.canvas.clientWidth);
      const w = Math.round(320 * k), h = Math.round(180 * k);
      r.draw(this.replay.scene(), { x: Math.round(16 * k), y: Math.round(212 * k), w, h });
    }
    // damage vignette
    this.ui.damageFlash(this.hurt);
    // nameplates
    const plates = [];
    if (this.state === 'playing' || this.state === 'panel') {
      const vp = r.lastVP, cw = this.canvas.clientWidth, ch = this.canvas.clientHeight, cam = scene.cam;
      for (const q of s.players) {
        if (!q.alive || q === this.player) continue;
        const hy = q.pos.y + 2.15, d = Math.hypot(q.pos.x - cam.x, hy - cam.y, q.pos.z - cam.z);
        if (d > 70 || d < 1) continue;
        if (s.world.lineBlocked(cam.x, cam.y, cam.z, q.pos.x, hy - 0.4, q.pos.z)) continue;
        const pr = Mat4.project(vp, q.pos.x, hy, q.pos.z);
        if (!pr || Math.abs(pr.x) > 1.1 || Math.abs(pr.y) > 1.1) continue;
        plates.push({ x: (pr.x * 0.5 + 0.5) * cw, y: (1 - (pr.y * 0.5 + 0.5)) * ch, scale: clamp(1.2 - d / 90, 0.6, 1.1), name: q.name, color: q.color, hp: Math.round(q.health / q.maxHealth * 100), ally: s.areAllies(q, this.player), bounty: q.bounty });
      }
    }
    this.ui.updateNameplates(plates);
  }
}

/* ============================== EXPORTS / BOOT ============================== */
const api = {
  CONFIG, BlockRegistry, BLOCKS, ID, TILE, World, MapGenerator, buildChunkMesh, buildBlockListMesh, Player, Mob, GameServer, Bot, Mat4, AIR, B, VERTEX_FLOATS,
  CLASSES, LANDS, ITEMS, EVENT_DEFS, EVENT_LIST, startResources, mineTime, TOOLS, LAND_ORDER, CLASS_ORDER, RESOURCES,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;                     // lets tests/logic.test.js run the game logic in Node
} else {
  root.PhysicsWars = api;
  const boot = () => { root.game = new Game(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}

})(typeof window !== 'undefined' ? window : globalThis);
