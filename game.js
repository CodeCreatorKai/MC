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
    WALK: 4.3, CROUCH: 1.3,                                    // Minecraft speeds: walk 4.3 b/s, sprint 5.6, sneak 1.3
    GROUND_ACCEL: 50, GROUND_FRICTION: 45, AIR_ACCEL: 14,
    JUMP: 8.4, GRAVITY: 28, TERMINAL: 50, REACH: 6,            // jump about 1.25 blocks high, like Minecraft
  },
  STEP: 1 / 60,                 // fixed physics timestep (seconds)
  MOUSE_SENS: 0.0022,           // radians per pixel at sensitivity 1.0
  MINE: { TIME_PER_HARDNESS: 0.45, MIN_TIME: 0.15, PLACE_COOLDOWN: 0.25 }, // stone ~0.7 s with a pickaxe, close to Minecraft
  COMBAT: { PARRY_WINDOW: 0.3, PURIST: 1.25, HEADSHOT: 1.5 },   // skill: perfect-block window (s), standard-skin crit/headshot bonus, arrow headshot multiplier
  WATER: { AIR: 5, NATURAL_AIR: 10, DROWN_DPS: 9, SWIM_UP: 1.6, POUR_LEVEL: 5 },   // POUR_LEVEL: a bucket spreads at most 4 blocks              // breath (s), drowning damage per second, max swim-up speed (deep water holds you)
  HEALTH: { MAX: 100, REGEN_DELAY: 10, REGEN_RATE: 0.8, FALL_SAFE: 13, FALL_DMG: 4.5 },
  PLOT_RADIUS: 18,
  MATCH: {
    COUNTDOWN: 3, DROP_FIRST: 35 / TIME_SPEED, DROP_EVERY: 70 / TIME_SPEED, BUILD: 120 / TIME_SPEED, WAR: 420 / TIME_SPEED, CHAOS: 120 / TIME_SPEED,
    SANDBOX_RESPAWN: 2, CORE_RESPAWN: 5, CORE_SHIELD: 60 / TIME_SPEED, SPEED: TIME_SPEED,
  },
  RENDER: { FOG_START: 50, FOG_END: 140, SKY: [0.55, 0.78, 0.95], REBUILD_BUDGET: 4 },
  ATLAS: { TILES: 16, TILE_PX: 16 },
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
  'vault', 'log_side', 'log_top', 'vault_top', 'icon_pickaxe', 'icon_sword', 'icon_axe', 'icon_bow', 'icon_staff', 'icon_lighter', 'brick', 'shingle', 'lamp', 'flower_red', 'flower_yellow', 'gold_ore',
  'plotwall', 'turret', 'cannon', 'mine', 'spikes', 'jumppad', 'conv_0', 'conv_1', 'conv_2', 'conv_3', 'sprinkler', 'healer', 'flamer', 'dropper', 'core', 'vaultstone', 'icon_bucket'];
const TILE = {};
TILE_NAMES.forEach((n, i) => { TILE[n.toUpperCase()] = i; });

/*
 * Metadata (world.meta, 16 bits per cell) conventions:
 *   fluids      : bits0-3 level, bit4 (16) = permanent source, bit5 (32) = flood water, bit6 (64) = poured by a player.
 *                 Flood and poured water (and what flows out of it) is DEADLY_WATER: heavy and drowning; natural water is not
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
  define({ type: 'stone', hardness: 8, blastResistance: 8, weight: 5, sound: 'stone', color: [0.49, 0.49, 0.51], tiles: all(TILE.STONE), drop: ['stone', 1] });
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
  define({ type: 'iron_ore', hardness: 9, blastResistance: 6, weight: 5, sound: 'stone', color: [0.6, 0.5, 0.45], placeable: false, tiles: all(TILE.IRON_ORE), drop: ['iron', 1] });
  define({ type: 'iron_block', hardness: 11, blastResistance: 12, weight: 8, sound: 'stone', color: [0.8, 0.8, 0.84], tiles: all(TILE.IRON_BLOCK), drop: ['iron', 1] });
  define({ type: 'obsidian', hardness: 18, blastResistance: 40, weight: 6, sound: 'stone', color: [0.12, 0.08, 0.2], placeable: false, tiles: all(TILE.OBSIDIAN) });
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
  // --- decorative / extra resource blocks ---
  define({ type: 'brick', hardness: 6, blastResistance: 7, weight: 4.5, sound: 'stone', color: [0.62, 0.3, 0.25], tiles: all(TILE.BRICK), drop: ['stone', 1] });
  define({ type: 'shingle', hardness: 2, blastResistance: 3, weight: 2.5, sound: 'wood', color: [0.55, 0.25, 0.2], flammable: true, burnChance: 0.09, tiles: all(TILE.SHINGLE), drop: ['wood', 1] });
  define({ type: 'lamp', hardness: 0.6, blastResistance: 1, weight: 1.5, sound: 'glass', color: [1, 0.9, 0.5], transparent: true, cullSame: true, tiles: all(TILE.LAMP), drop: ['glass', 1, 0.5] });
  define({ type: 'flower_red', shape: 'box', solid: false, transparent: true, hardness: 0.05, blastResistance: 0.05, weight: 0.1, needsFloor: true, placeable: false, color: [0.9, 0.2, 0.25], tiles: all(TILE.FLOWER_RED), boxes: () => [[0.2, 0, 0.2, 0.8, 0.7, 0.8]] });
  define({ type: 'flower_yellow', shape: 'box', solid: false, transparent: true, hardness: 0.05, blastResistance: 0.05, weight: 0.1, needsFloor: true, placeable: false, color: [0.95, 0.8, 0.2], tiles: all(TILE.FLOWER_YELLOW), boxes: () => [[0.2, 0, 0.2, 0.8, 0.7, 0.8]] });
  define({ type: 'gold_ore', hardness: 8, blastResistance: 6, weight: 5, sound: 'stone', color: [0.8, 0.7, 0.3], placeable: false, tiles: all(TILE.GOLD_ORE), drop: ['iron', 2] });
  // --- plot divider (build phase only), automatic machines, TNT dropper ---
  define({ type: 'plotwall', hardness: Infinity, blastResistance: Infinity, weight: 99, sound: 'stone', color: [0.25, 0.27, 0.34], breakable: false, placeable: false, pushable: false, tiles: all(TILE.PLOTWALL) });
  const MACH = { sound: 'stone', pushable: false, machine: true, shape: 'box', transparent: true };
  define({ ...MACH, type: 'turret', hardness: 2, blastResistance: 3, weight: 3, color: [0.4, 0.45, 0.55], tiles: all(TILE.TURRET), boxes: () => [[0.15, 0, 0.15, 0.85, 0.45, 0.85], [0.3, 0.45, 0.3, 0.7, 0.85, 0.7], [0.45, 0.55, 0.05, 0.55, 0.7, 0.45]], drop: ['mech', 3, 0.8] });
  define({ ...MACH, type: 'cannon', hardness: 2.5, blastResistance: 4, weight: 4, color: [0.3, 0.3, 0.34], tiles: all(TILE.CANNON), boxes: () => [[0.05, 0, 0.05, 0.95, 0.35, 0.95], [0.25, 0.35, 0.25, 0.75, 0.95, 0.75]], drop: ['mech', 4, 0.8] });
  define({ ...MACH, type: 'mine', solid: false, hardness: 0.2, blastResistance: 0.3, weight: 0.5, needsFloor: true, color: [0.4, 0.3, 0.2], tiles: all(TILE.MINE), boxes: () => [[0.12, 0, 0.12, 0.88, 0.1, 0.88]], drop: ['mech', 1, 0.8] });
  define({ ...MACH, type: 'spikes', solid: false, hardness: 0.5, blastResistance: 1, weight: 1, needsFloor: true, color: [0.6, 0.6, 0.65], tiles: all(TILE.SPIKES), boxes: () => [[0.03, 0, 0.03, 0.97, 0.3, 0.97]], drop: ['mech', 1, 0.8] });
  define({ ...MACH, type: 'jumppad', solid: false, hardness: 0.4, blastResistance: 1, weight: 1, needsFloor: true, color: [0.3, 0.85, 0.4], tiles: all(TILE.JUMPPAD), boxes: () => [[0.04, 0, 0.04, 0.96, 0.14, 0.96]], drop: ['mech', 1, 0.8] });
  define({ ...MACH, type: 'conveyor', solid: false, hardness: 0.4, blastResistance: 1, weight: 1, needsFloor: true, color: [0.3, 0.3, 0.3], tiles: all(TILE.CONV_0), tileFn: (m) => TILE.CONV_0 + (m & 3), boxes: () => [[0, 0, 0, 1, 0.12, 1]], drop: ['mech', 1, 0.8] });
  define({ ...MACH, type: 'sprinkler', hardness: 1.5, blastResistance: 2, weight: 2, color: [0.3, 0.55, 0.9], tiles: all(TILE.SPRINKLER), boxes: () => [[0.2, 0, 0.2, 0.8, 0.6, 0.8], [0.4, 0.6, 0.4, 0.6, 0.85, 0.6]], drop: ['mech', 2, 0.8] });
  define({ ...MACH, type: 'healer', hardness: 1.5, blastResistance: 2, weight: 2, color: [0.4, 0.9, 0.5], tiles: all(TILE.HEALER), boxes: () => [[0.15, 0, 0.15, 0.85, 0.7, 0.85]], drop: ['mech', 3, 0.8] });
  define({ ...MACH, type: 'flamer', hardness: 2, blastResistance: 3, weight: 3, color: [0.85, 0.35, 0.15], tiles: all(TILE.FLAMER), boxes: () => [[0.15, 0, 0.15, 0.85, 0.5, 0.85], [0.35, 0.5, 0.35, 0.65, 0.8, 0.65]], drop: ['mech', 3, 0.8] });
  define({ type: 'dropper', hardness: 2, blastResistance: 4, weight: 3, sound: 'stone', color: [0.75, 0.3, 0.2], mech: 'consumer', tiles: all(TILE.DROPPER), drop: ['mech', 2, 0.8] });
  // each player's base core: while it stands its owner respawns; enemies must mine it (slowly) or blow it up
  define({ type: 'core', hardness: 25, blastResistance: 7, weight: 10, sound: 'stone', color: [0.7, 0.35, 1], placeable: false, pushable: false, tiles: { top: TILE.CORE, side: TILE.CORE, bottom: TILE.OBSIDIAN } });
  define({ type: 'vaultstone', hardness: Infinity, blastResistance: Infinity, weight: 20, sound: 'stone', color: [0.22, 0.21, 0.28], breakable: false, placeable: false, pushable: false, tiles: all(TILE.VAULTSTONE) });
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
/**
 * Weapon pixel art, 16x16, drawn diagonally like Minecraft items (grip bottom-left, tip top-right).
 * Shapes are written in diagonal coordinates: N runs along the weapon (0 at the grip end, 26 at the tip),
 * M runs across it (negative = upper-left side). Pixels only exist where N and M have the same parity, so
 * |M| <= 1 is the classic two-pixel-wide diagonal blade. Each skin bends the shape (shards, flames, a curved
 * edge, a lightning zig-zag...) and every sprite gets a dark outline so it reads clearly at any size.
 */
function weaponSprite(tool, skinId) {
  const S = WEAPON_SKINS[skinId] || WEAPON_SKINS.default, P = S.pal, g = [];
  for (let y = 0; y < 16; y++) g.push(new Array(16).fill(null));
  const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const hue = (h, l) => { const f = (n) => { const k = (n + h * 12) % 12; return 255 * (l - 0.5 * Math.max(-1, Math.min(k - 3, 9 - k, 1))); }; return [f(0), f(8), f(4)]; };
  /** Blade colour: upper side light, lower side dark; fire skins glow hotter toward the tip, the admin skin cycles hues. */
  const metal = (M, t) => {
    let c = M < 0 ? P.hi : M > 0 ? P.lo : P.mid;
    if (S.fire) c = M < 0 ? lerp(P.mid, P.hi, t) : M > 0 ? lerp(P.lo, P.mid, t * 0.6) : lerp(P.lo, P.hi, t * 0.8);
    if (S.rainbow) c = hue(t * 0.85, M < 0 ? 0.78 : M > 0 ? 0.42 : 0.6);
    if (skinId === 'frost' && t > 0.75 && M <= 0) c = P.hi;
    return c;
  };
  const cells = [];   // [N, M, colour]
  const at = (N, M, c) => cells.push([N, M, c]);
  const band = (n0, n1, m0, m1, colFn) => { for (let N = n0; N <= n1; N++) for (let M = m0; M <= m1; M++) if (((N + M) & 1) === 0) at(N, M, colFn(N, M)); };
  const grip = (n0, n1) => band(n0, n1, 0, 0, (N) => ((N >> 1) & 1 ? P.h2 : P.h1));
  const sk = skinId;

  if (tool === 'sword') {
    band(0, 1, -1, 1, () => P.gd);                                         // pommel
    if (P.gem) at(0, 0, P.gem);
    grip(2, 7);
    const G = sk === 'titan' ? 4 : sk === 'phantom' ? 2 : 3;               // cross-guard
    band(8, 9, -G, G, (N, M) => (Math.abs(M) >= G - 1 ? (sk === 'blood' || sk === 'frost' ? P.gem || P.gd : P.lo) : P.gd));
    if (sk === 'blood') { at(8, -G - 2, P.gd); at(8, G + 2, P.gd); }       // bat-wing guard tips
    if (P.gem && sk !== 'phantom') at(8, 0, P.gem);
    const tip = sk === 'titan' ? 23 : 25;
    for (let N = 10; N <= tip; N++) {
      const t = (N - 10) / (tip - 10);
      let lo = -1, hi = 1;
      if (sk === 'titan') { lo = -2; hi = 2; if (N > 21) { lo = -1; hi = 1; } }
      else if (sk === 'phantom') { lo = -1; hi = 0; }
      else if (sk === 'blood') { lo = -1; hi = N < 14 ? 1 : N < 22 ? 2 : 1; }                  // crescent edge
      else if (sk === 'volt') { const z = ((N - 10) >> 2) & 1 ? -2 : 0; lo = -1 + z; hi = 1 + z; }   // lightning zig-zag
      if (N >= tip - 1) { lo = Math.max(lo, -1); hi = Math.min(hi, sk === 'blood' ? 2 : 1); }
      if (N === tip) { lo = hi = sk === 'blood' ? 1 : 0; if (sk === 'titan') { lo = -1; hi = 1; } }
      for (let M = lo; M <= hi; M++) if (((N + M) & 1) === 0) at(N, M, metal(M - (sk === 'volt' && ((N - 10) >> 2) & 1 ? -2 : 0) - (sk === 'blood' && M > 0 && N > 14 ? 1 : 0), t));
    }
    if (sk === 'frost') for (const [N, M] of [[14, -2], [20, -2], [16, 2], [22, 2], [13, -3], [19, -3]]) at(N, M, P.hi);              // ice shards
    if (sk === 'inferno') for (const [N, M] of [[12, -2], [16, -2], [20, -2], [13, -3], [17, -3], [21, -3], [24, -2], [26, 0]]) at(N, M, N > 18 ? P.hi : P.mid);   // flame tongues
    if (sk === 'phantom') for (const [N, M] of [[15, -3], [21, 3], [24, -2], [12, 2]]) at(N, M, P.gem);                              // spectral sparks
    if (sk === 'volt') { at(26, 0, P.hi); at(9, -5, P.gem); at(9, 5, P.gem); }
    if (sk === 'admin') for (const [N, M] of [[14, -3], [19, 3], [23, -3], [26, 0]]) at(N, M, P.gem);
  } else if (tool === 'axe' || tool === 'pickaxe') {
    const top = tool === 'axe' ? 21 : 19;
    grip(tool === 'axe' ? 3 : 1, top);
    if (tool === 'axe') {
      // head on the upper-left side of the handle top; its edge (furthest out) is the bright cutting edge
      const depth = sk === 'titan' ? 5 : sk === 'phantom' ? 6 : sk === 'blood' ? 5 : 4;
      for (let M = -1; M >= -depth; M--) {
        const k = -M; let n0 = 17 - k, n1 = 20 + Math.ceil(k / 2);                                                         // flares out toward the edge
        if (sk === 'blood') { n0 = 17 - k - (k >= depth - 1 ? 2 : 0); n1 = 20 + k + (k >= depth - 1 ? 1 : 0); }                // wide crescent with horns
        if (sk === 'phantom') { n0 = 17 - k - Math.max(0, k - 3) * 2; n1 = 20 + (k < 4 ? 1 : 0); }                             // scythe hook sweeping down
        if (sk === 'volt' && k >= 3) { n0 += 2; n1 += 1; }                                                                      // notched bolt
        if (sk === 'titan') { n0 = 16 - k; n1 = 21 + k; }
        band(n0, n1, M, M, (N) => (k >= depth - 1 ? (sk === 'inferno' ? lerp(P.mid, P.hi, 0.7) : P.hi) : k <= 1 ? P.lo : metal(0, (N - 14) / 8)));
      }
      if (sk === 'titan') for (let M = 1; M <= 4; M++) band(17 - M, 20 + M, M, M, () => (M >= 3 ? P.hi : P.lo));                       // double-bit
      else band(18, 20, 1, 2, () => P.lo);                                                                                      // back spike
      if (sk === 'frost') for (const [N, M] of [[12, -5], [24, -5], [13, -6], [22, -6]]) at(N, M, P.hi);
      if (sk === 'inferno') for (const [N, M] of [[13, -5], [15, -7], [18, -6], [21, -7], [23, -5]]) at(N, M, P.hi);
      if (P.gem) at(20, 0, P.gem);
    } else {
      // pickaxe head: an arc across the handle top
      const span = sk === 'titan' ? 7 : sk === 'phantom' ? 8 : 7;
      for (let M = -span; M <= span; M++) {
        const a = Math.abs(M), bend = Math.round(a * a / (sk === 'blood' ? 9 : 14)), thick = sk === 'titan' ? (a < 6 ? 2 : 1) : a < span - 1 ? 1 : 0;
        const n1 = 21 - bend, n0 = n1 - thick;
        band(n0, n1, M, M, (N) => (a >= span - 1 ? P.hi : N === n1 ? P.mid : P.lo));
      }
      if (sk === 'frost') { at(14, -8, P.hi); at(14, 8, P.hi); }
      if (sk === 'inferno') for (const [N, M] of [[14, -7], [13, -8], [14, 7], [13, 8], [22, 0]]) at(N, M, P.hi);
      if (sk === 'volt') { at(23, -1, P.gem); at(24, 0, P.hi); at(23, 1, P.gem); }
      if (P.gem) at(21, 0, P.gem);
    }
    if (sk === 'admin' || sk === 'phantom') at(1, 1, P.gem);
  } else if (tool === 'staff') {
    // long shaft with a big orb on top; each skin swaps the head
    grip(1, 18);
    if (sk !== 'default') { at(9, 0, P.gd); at(10, -1, P.gd); at(10, 1, P.gd); }      // grip wrap
    const orb = (cN, r, f) => { for (let N = cN - 6; N <= cN + 6; N++) for (let M = -6; M <= 6; M++) if (((N + M) & 1) === 0) { const d = Math.sqrt(((N - cN) ** 2 + M * M) / 2); if (d <= r) at(N, M, f(d, N - cN, M)); } };
    if (sk === 'titan') band(18, 24, -3, 3, (N, M) => (Math.abs(M) >= 3 || N >= 24 ? P.lo : N === 18 ? P.gd : P.mid));          // sledge head
    else if (sk === 'phantom') { orb(21, 1.6, () => P.gem); for (const [N, M] of [[19, -4], [21, -5], [23, -5], [25, -3], [26, -1]]) at(N, M, P.mid); }   // crescent hook
    else {
      const glow = sk === 'default' ? [255, 120, 60] : S.rainbow ? hue(0.8, 0.6) : P.mid;
      orb(22, 2.3, (d) => (d < 1 ? (P.gem || [255, 230, 160]) : d < 1.8 ? (sk === 'default' ? [255, 170, 90] : P.hi) : glow));
      if (sk === 'frost') for (const [N, M] of [[26, 0], [22, -4], [22, 4], [25, -3]]) at(N, M, P.hi);
      if (sk === 'inferno') for (const [N, M] of [[26, 0], [25, -1], [27, -1], [24, -3], [24, 3]]) at(N, M, N > 25 ? P.hi : P.mid);
      if (sk === 'blood') for (const [N, M] of [[19, -2], [19, 2], [25, -3], [25, 3]]) at(N, M, P.lo);
      if (sk === 'volt') for (const [N, M] of [[26, 0], [25, 3], [21, -4], [23, 4]]) at(N, M, P.gem);
    }
  } else if (tool === 'bow') {
    // limb arc on the upper-left, string straight along M = +3
    const thick = sk === 'titan' ? 2 : 1;
    for (let N = 2; N <= 24; N++) {
      const u = (N - 13) / 11, c = 3 - 9 * (1 - u * u);
      for (let M = Math.round(c) - thick; M <= Math.round(c) + 1; M++) if (((N + M) & 1) === 0) {
        const tip = Math.abs(N - 13) > 8, grp = Math.abs(N - 13) <= 1;
        at(N, M, grp ? P.gd : tip ? (S.rainbow ? hue(N / 24, 0.6) : P.lo) : sk === 'default' ? (M < c ? P.h1 : P.h2) : M < c ? P.mid : P.lo);
      }
    }
    for (let N = 4; N <= 22; N++) if ((N & 1) === 1) at(N, 3, sk === 'volt' || sk === 'phantom' || sk === 'admin' ? P.gem : [236, 236, 236]);
    if (sk === 'frost') for (const [N, M] of [[2, 1], [24, 1], [5, -4], [21, -4]]) at(N, M, P.hi);
    if (sk === 'inferno') for (const [N, M] of [[1, 1], [25, 1], [2, -1], [24, -1], [13, -9]]) at(N, M, P.hi);
    if (sk === 'blood') for (const [N, M] of [[9, -8], [17, -8], [6, -7], [20, -7]]) at(N, M, P.lo);
    if (sk === 'titan') { at(13, -9, P.gem); at(7, -7, P.gd); at(19, -7, P.gd); }
  }
  const shift = tool === 'axe' ? -3 : 0;                                // the axe head is big: slide the whole drawing toward the grip
  for (const [N0, M, c] of cells) {
    const N = N0 + shift, x = Math.floor(1.5 + (N + M) / 2), y = Math.floor(14.5 + (M - N) / 2);
    if (x >= 0 && x < 16 && y >= 0 && y < 16) g[y][x] = c;
  }
  const out = g.map((r) => r.slice());                                   // dark outline around the shape
  for (let y = 0; y < 16; y++) for (let x = 0; x < 16; x++) {
    if (g[y][x]) continue;
    if ((x > 0 && g[y][x - 1]) || (x < 15 && g[y][x + 1]) || (y > 0 && g[y - 1][x]) || (y < 15 && g[y + 1][x])) out[y][x] = P.ol;
  }
  return out;
}

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
  paint(TILE.VAULTSTONE, 46, (x, y, r) => { const row = y >> 2, off = (row % 2) * 4; return (y % 4 === 3 || (x + off) % 8 === 7) ? [200, 160, 50] : noisy(r, 52, 50, 66, 10); });   // dark slate bricks, gold mortar
  paint(TILE.VAULT, 45, (x, y, r) => (edge(x, y) ? [120, 90, 20] : ((x === 3 || x === 12) && (y === 3 || y === 12)) ? [70, 50, 10] : noisy(r, 236, 196, 52, 12)));
  paint(TILE.LOG_SIDE, 46, (x, y, r) => ((x % 4 === 1) ? [78, 56, 32] : noisy(r, 110, 82, 50, 16)));
  paint(TILE.LOG_TOP, 47, (x, y, r) => { const d = Math.hypot(x - 7.5, y - 7.5); return (Math.floor(d) % 3 === 0) ? [140, 104, 62] : noisy(r, 176, 138, 86, 12); });
  paint(TILE.VAULT_TOP, 48, (x, y, r) => { const d = Math.hypot(x - 7.5, y - 7.5); return d < 3 ? [255, 90, 60] : edge(x, y) ? [120, 90, 20] : noisy(r, 250, 214, 90, 12); });

  paint(TILE.BRICK, 60, (x, y, r) => { const row = y >> 2, off = (row % 2) * 4; return (y % 4 === 3 || (x + off) % 8 === 7) ? [190, 176, 160] : noisy(r, 168, 78, 62, 22); });
  paint(TILE.SHINGLE, 61, (x, y, r) => { const row = y >> 2; return (y % 4 === 3) ? [88, 38, 32] : noisy(r, 148 - row * 4 + ((x >> 2) % 2) * 10, 66, 52, 14); });
  paint(TILE.LAMP, 62, (x, y, r) => (edge(x, y) ? [150, 110, 40] : (x === 7 || x === 8 || y === 7 || y === 8) ? [190, 140, 50] : noisy(r, 255, 232, 130, 14)));
  paint(TILE.PLOTWALL, 70, (x, y, r) => { const band = ((x + y) >> 2) % 4 === 0; return edge(x, y) ? [30, 32, 44] : band ? [236, 180, 40] : noisy(r, 52, 56, 74, 10); });
  paint(TILE.TURRET, 71, (x, y, r) => (edge(x, y) ? [40, 44, 56] : (Math.hypot(x - 7.5, y - 7.5) < 3) ? [230, 60, 50] : noisy(r, 92, 100, 122, 12)));
  paint(TILE.CANNON, 72, (x, y, r) => (edge(x, y) ? [20, 20, 24] : (Math.hypot(x - 7.5, y - 7.5) < 4.2) ? [18, 18, 22] : noisy(r, 70, 70, 78, 10)));
  paint(TILE.MINE, 73, (x, y, r) => ((x === 7 || x === 8) && (y === 7 || y === 8)) ? [200, 50, 40] : noisy(r, 108, 84, 58, 16));
  paint(TILE.SPIKES, 74, (x, y, r) => (((x % 4) === 2 && (y % 4) === 2) ? [235, 235, 245] : ((x % 4) === 1 || (y % 4) === 1) ? [120, 122, 134] : noisy(r, 78, 80, 92, 10)));
  paint(TILE.JUMPPAD, 75, (x, y, r) => { const a = Math.abs(x - 7.5) + (y - 3); return (edge(x, y)) ? [20, 90, 40] : (y > 3 && y < 12 && Math.abs(x - 7.5) < (y - 3) * 0.7 && Math.abs(x - 7.5) > (y - 3) * 0.7 - 2.2) ? [255, 255, 255] : noisy(r, 60, 200, 90, 14); });
  for (let d = 0; d < 4; d++) paint(TILE.CONV_0 + d, 76 + d, (x, y, r) => {
    let u = x - 7.5, v = y - 7.5; for (let k = 0; k < [0, 2, 1, 3][d]; k++) { const t = u; u = -v; v = t; }    // rotate the arrow
    const arrow = (Math.abs(u) < 1.5 && v > -5 && v < 3) || (v >= 3 && v < 6 && Math.abs(u) < 6 - v);
    return edge(x, y) ? [30, 30, 32] : arrow ? [250, 210, 60] : noisy(r, 64, 66, 72, 10);
  });
  paint(TILE.SPRINKLER, 80, (x, y, r) => (edge(x, y) ? [30, 70, 130] : ((x + y) % 5 === 0) ? [190, 225, 255] : noisy(r, 70, 130, 220, 14)));
  paint(TILE.HEALER, 81, (x, y, r) => (edge(x, y) ? [30, 120, 60] : ((Math.abs(x - 7.5) < 1.6 && Math.abs(y - 7.5) < 5) || (Math.abs(y - 7.5) < 1.6 && Math.abs(x - 7.5) < 5)) ? [255, 255, 255] : noisy(r, 90, 210, 120, 12)));
  paint(TILE.FLAMER, 82, (x, y, r) => (edge(x, y) ? [60, 20, 10] : (Math.hypot(x - 7.5, y - 8.5) < 3.2) ? [255, 190, 50] : noisy(r, 170, 60, 30, 14)));
  paint(TILE.CORE, 84, (x, y, r) => { const d = Math.abs(x - 7.5) + Math.abs(y - 7.5); return edge(x, y) ? [40, 20, 60] : d < 3 ? [255, 235, 255] : d < 6 ? [200, 110, 255] : noisy(r, 110, 50, 170, 18); });
  paint(TILE.DROPPER, 83, (x, y, r) => (edge(x, y) ? [90, 30, 20] : (Math.hypot(x - 7.5, y - 7.5) < 3.5) ? [20, 20, 20] : noisy(r, 190, 70, 55, 14)));
  const flower = (tile, petal) => paint(tile, 63, (x, y, r) => {
    const d = Math.hypot(x - 7.5, y - 5.5);
    if (d < 1.6) return [250, 230, 90];
    if (d < 4.2) return petal;
    if ((x === 7 || x === 8) && y >= 9) return [60, 140, 50];
    if ((x === 5 && y === 12) || (x === 10 && y === 13)) return [60, 140, 50];
    return undefined;
  });
  flower(TILE.FLOWER_RED, [226, 48, 60]); flower(TILE.FLOWER_YELLOW, [255, 214, 60]);
  paint(TILE.GOLD_ORE, 64, (x, y, r) => (r() < 0.14 ? [250, 212, 70] : r() < 0.09 ? [96, 96, 102] : noisy(r, 126, 126, 132, 22)));

  // --- tool icons (hotbar): tiny pixel drawings on a transparent tile ---
  const iconRows = {};
  const icon = (tile, rows, palette) => { iconRows[tile] = rows; paint(tile, 7, (x, y) => { const ch = rows[y] && rows[y][x]; return ch && ch !== '.' ? palette[ch] : undefined; }); };
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
  icon(TILE.ICON_BUCKET, [
    '................', '.....oooooo.....', '....o......o....', '...o........o...', '..oooooooooooo..', '..osswwwwwwsso..', '..oslwwwwwwsdo..', '...oslllllsdo...',
    '...oslssssddo...', '...osssssssdo...', '....osssssdo....', '....osssssdo....', '....ossssddo....', '.....oooooo.....', '................', '................'], { o: [40, 42, 50], s: [176, 180, 192], l: [226, 230, 238], d: [120, 124, 136], w: [70, 130, 255] });
  const CHEST = ['................', '...aa......aa...', '..aaba....abaa..', '..abbbaaaabbba..', '..abbbbbbbbbba..', '...abbbbbbbba...', '...abtbbbbtba...', '...abbbbbbbba...',
    '...abbbbbbbba...', '...abtttttb.a...', '...abbbbbbbba...', '...abbbbbbbba...', '....abbbbbba....', '....aaaaaaaa....', '................', '................'];
  const c255 = (c) => [c[0] * 255, c[1] * 255, c[2] * 255];
  for (const id of ARMOR_ORDER) {                                    // armor icons for the Locker
    const A = ARMOR[id];
    if (id === 'none') { icon(armorTile(id), CHEST, { a: [70, 70, 80], b: [120, 120, 130], t: [120, 120, 130] }); continue; }
    icon(armorTile(id), CHEST, { a: c255(A.c2).map((v) => v * 0.6), b: c255(A.c1), t: c255(A.trim) });
  }
  for (const tool of WEAPON_TOOLS) for (const sk of WEAPON_SKIN_ORDER) {                // weapons: every skin is its own drawing
    const spr = weaponSprite(tool, sk);
    paint(weaponTile(tool, sk), 7, (x, y) => spr[y][x] || undefined);
  }
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
    this.burnTime = 0; this.chillT = 0; this.buffs = {}; this.streak = 0; this.sinceShot = 99; this.quiverT = 0;
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
    const fy = Math.floor(this.pos.y + 0.15), cy = Math.floor(this.pos.y + this.height * 0.6);
    this.deadlyWater = (feet === ID.water && !!(world.getMeta(x, fy, z) & DEADLY_WATER)) || (chest === ID.water && !!(world.getMeta(x, cy, z) & DEADLY_WATER));
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
      if (!this.onGround && !inFluid) {                           // Minecraft-style air control: steer, but never lose momentum you already have
        const before = Math.hypot(this.vel.x, this.vel.z);
        this.vel.x += wx * accel; this.vel.z += wz * accel;
        const after = Math.hypot(this.vel.x, this.vel.z), cap = Math.max(spd, before);
        if (after > cap) { this.vel.x *= cap / after; this.vel.z *= cap / after; }
      } else {
        this.vel.x = approach(this.vel.x, wx * spd, accel);
        this.vel.z = approach(this.vel.z, wz * spd, accel);
      }
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
      else if (this.inWater && this.deadlyWater) this.vel.y = Math.min(this.vel.y + 30 * dt, this.submerged ? CONFIG.WATER.SWIM_UP : 0.4);   // flood / poured water is heavy: you rise to the surface but never pop out
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
    this.isBot = false; this.isRemote = false;
    this.inQueue = null; this.ackSeq = 0;
    this.classId = 'builder'; this.landId = 'forest';
    this.team = 0;                                  // alliance id (== own index when solo)
    this.mods = DEFAULT_MODS();
    this.maxHealth = CONFIG.HEALTH.MAX; this.health = this.maxHealth; this.alive = true;
    this.eyeHeight = CONFIG.PLAYER.EYE;
    this.crouching = false;
    this.stepDistance = 0; this.walkPhase = 0; this.swing = 0; this.drawTime = 0;
    this.controls = { forward: false, back: false, left: false, right: false, jump: false, crouch: false, sprint: false };
    this.sprinting = false; this.hurtT = 0; this.lastDmg = 0;
    this.held = 'pickaxe'; this.swingKind = 'sword'; this.blocking = false; this.blockT = 0; this.blockCd = 0; this.lastBlocked = false;
    this.resources = {};
    this.cooldowns = { attack: 0, place: 0, shoot: 0, use: 0 };
    this.sinceDamage = 99;                          // seconds since last damage (regeneration)
    this.lastHits = [];                             // [{by, time}] for kill / assist credit
    this.lastCause = null;                          // {by, kind, time}
    this.stats = { kills: 0, assists: 0, deaths: 0, damageDealt: 0, blocksDestroyed: 0, structuresDestroyed: 0, tntKills: 0, objectives: 0, score: 0, surviveSeconds: 0 };
    this.spawn = { x: 0, y: 0, z: 0 };
    this.bounty = 0; this.bountyTime = 0;
    this.look = null;                               // public cosmetics (skin, trail, kill effect, banner, title, emotes)
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
    this.sprinting = !!controls.sprint && f > 0 && !this.crouching && !this.blocking && !this.inWater && !this.inLava;
    const speed = (this.crouching ? P.CROUCH : P.WALK) * this.mods.speed * (this.sprinting ? 1.3 : 1) * (this.blocking ? 0.6 : 1) * (weaponBoost(this.look, this.held).move || 1) * (this.chillT > 0 ? 0.6 : 1) * (this.buffs && this.buffs.swift > 0 ? 1.3 : 1) * (armorPerk(this.look).move || 1) * (this.inWater ? armorPerk(this.look).swim || 1 : 1);
    if (this.chillT > 0) this.chillT -= dt;
    const px = this.pos.x, pz = this.pos.z;

    this.simulate(dt, wx, wz, speed, !!controls.jump, P.JUMP * this.mods.jump, world, env);
    if (this.jumped && this.sprinting) {                         // sprint-jump: only a tiny nudge, so jumping is never faster than running
      const l = Math.hypot(wx, wz) || 1; this.vel.x += wx / l * 0.3; this.vel.z += wz / l * 0.3;
    }
    this.hurtT = Math.max(0, this.hurtT - dt);

    this.eyeHeight = approach(this.eyeHeight, this.crouching ? P.EYE_CROUCH : P.EYE, 6 * dt);
    const moved = Math.hypot(this.pos.x - px, this.pos.z - pz);
    if (this.onGround) { this.stepDistance += moved; this.walkPhase += moved * 1.6; }
    for (const k in this.cooldowns) this.cooldowns[k] = Math.max(0, this.cooldowns[k] - dt);
    this.swing = Math.max(0, this.swing - dt * (this.swingKind === 'axe' ? 2.3 : this.swingKind === 'bow' ? 4 : 3.2));
  }
}

class Mob extends Body {
  constructor(id, x, y, z, type = 'zombie') {
    super();
    this.id = id; this.type = type;
    this.halfWidth = 0.3; this.height = type === 'creeper' ? 1.7 : 1.8;
    this.health = type === 'creeper' ? 40 : 50; this.maxHealth = this.health; this.alive = true;
    this.fuse = 0;                                  // creeper: seconds until it blows up (0 = not lit)
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
    this.simulate(dt, wx, wz, this.type === 'creeper' ? (this.fuse > 0 ? 0.5 : 2.2) : 2.4, jump, 8.2, world, env);
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
    if (this.server.bulkFluid || this.pending.size > 40000) return;          // whole-layer floods are still water; and a hard cap so the queue can never run away
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

    const poured = (meta & 64) && !(meta & 32);                     // bucket water: falling does not refill it, so it never runs away downhill
    if (!src) {                                                    // flowing cells need a feeder or they drain
      let feed = 0;
      if (w.get(x, y + 1, z) === id) feed = poured ? Math.max(1, w.getMeta(x, y + 1, z) & 15) : maxL;
      for (let i = 0; i < 4; i++) {
        const d = DIRS6[i < 2 ? i : i + 2];
        if (w.get(x + d[0], y, z + d[2]) === id) feed = Math.max(feed, (w.getMeta(x + d[0], y, z + d[2]) & 15) - 1);
      }
      if (feed <= 0) { w.set(x, y, z, AIR); return; }
      if (feed !== level) { w.setMeta(x, y, z, (meta & DEADLY_WATER) | feed); level = feed; }
    }

    const below = y > 0 ? w.get(x, y - 1, z) : ID.bedrock, bd = BLOCKS[below];
    const bits = meta & DEADLY_WATER;                              // flood / poured water stays deadly as it spreads
    if (y > 0 && (bd.replaceable || bd.shape === 'fluid') && below !== id) { this.flowInto(x, y - 1, z, id, poured ? Math.max(1, level) : maxL, bits); return; }
    if (level > 1 && (bd.solid || bd.shape === 'fluid' || !bd.replaceable)) {
      for (let i = 0; i < 4; i++) { const d = DIRS6[i < 2 ? i : i + 2]; this.flowInto(x + d[0], y, z + d[2], id, level - 1, bits); }
    }
  }
  flowInto(x, y, z, fluidId, newLevel, bits = 0) {
    const w = this.world;
    if (!w.inBounds(x, y, z)) return;
    const t = w.get(x, y, z), td = BLOCKS[t];
    if (t === fluidId) { const m = w.getMeta(x, y, z); if (!(m & 16) && (m & 15) < newLevel) w.setMeta(x, y, z, (m & DEADLY_WATER) | bits | newLevel); return; }
    if (td.shape === 'fluid') {                                   // water meets lava
      if (fluidId === ID.water) w.set(x, y, z, (w.getMeta(x, y, z) & 16) ? ID.obsidian : ID.stone);
      else w.set(x, y, z, ID.stone);
      this.server.emit({ type: 'steam', x, y, z });
      return;
    }
    if (td.replaceable || (td.needsFloor && !td.solid)) w.set(x, y, z, fluidId, false, newLevel | bits);
  }
}


/* ---------- Machines: blocks that act on their own (turrets, cannons, mines, pads...). Owned by whoever placed them. ---------- */
class MachineSystem {
  constructor(server) { this.server = server; this.world = server.world; this.set = new Set(); this.state = new Map(); this.acc = 0; }
  clear() { this.set.clear(); this.state.clear(); }
  fresh() { return { cd: 0, ammo: 24, armed: this.server.clock + 2.5 }; }
  register(k) { this.set.add(k); if (!this.state.has(k)) this.state.set(k, this.fresh()); }
  onChange(x, y, z, old, nw) {
    if (old === nw) return;
    const k = keyOf(x, y, z);
    if (BLOCKS[nw].machine) { this.set.add(k); this.state.set(k, this.fresh()); }
    else if (BLOCKS[old].machine) { this.set.delete(k); this.state.delete(k); }
  }
  /** Owner's right-click on a turret: +12 arrows for 1 part. */
  refill(player, x, y, z) {
    const st = this.state.get(keyOf(x, y, z)), s = this.server;
    if (!st || this.world.getOwner(x, y, z) !== player.index + 1 || st.ammo >= 36 || !s.hasResource(player, 'mech', 1)) return false;
    s.spend(player, 'mech', 1); st.ammo = Math.min(36, st.ammo + 12);
    s.emit({ type: 'mechClick', x, y, z, block: BLOCKS[ID.turret] });
    return true;
  }
  dropperFire(x, y, z) {
    const s = this.server, k = keyOf(x, y, z), st = this.state.get(k) || this.fresh();
    this.state.set(k, st);
    if (st.cd > 0) return;
    const o = this.world.getOwner(x, y, z) - 1, op = o >= 0 ? s.playerBySlot(o) : null;
    if (op && !s.hasResource(op, 'tnt', 1)) return;
    if (op) s.spend(op, 'tnt', 1);
    st.cd = 1.2;
    s.spawnTnt(x + 0.5, y + 1.3, z + 0.5, 2.4, o, 'dropper', 5);
    s.emit({ type: 'machineFx', kind: 'drop', x, y, z });
  }
  sees(sx, sy, sz, b, h = 1.0) { return !this.world.lineBlocked(sx, sy, sz, b.pos.x, b.pos.y + h, b.pos.z); }
  update(dt) {
    this.acc += dt;
    if (this.acc < 0.1 || !this.set.size) return;
    const step = this.acc; this.acc = 0; this.tickNo = (this.tickNo || 0) + 1;
    const s = this.server, w = this.world, live = s.pvpEnabled();
    const bodies = s.bodies().concat(s.tnts.filter((t) => t.alive !== false));
    const inCell = (b, x, y, z, up = 0.9) => Math.abs(b.pos.x - (x + 0.5)) < b.halfWidth + 0.45 && Math.abs(b.pos.z - (z + 0.5)) < b.halfWidth + 0.45 && b.pos.y > y - 0.45 && b.pos.y < y + up;
    for (const k of Array.from(this.set)) {
      const [x, y, z] = unkey(k), id = w.get(x, y, z);
      if (!BLOCKS[id].machine) { this.set.delete(k); continue; }
      let st = this.state.get(k); if (!st) { st = this.fresh(); this.state.set(k, st); }
      st.cd = Math.max(0, st.cd - step);
      const o = w.getOwner(x, y, z) - 1, op = o >= 0 ? s.playerBySlot(o) : null;
      const foe = (b) => b.alive !== false && (b instanceof Player || b instanceof Mob) && !(op && (b === op || s.areAllies(b, op)));
      const cx = x + 0.5, cy = y + 0.5, cz = z + 0.5;
      if (id === ID.turret) {
        if (!live || st.cd > 0 || st.ammo <= 0) continue;
        let best = null, bd = 17;
        for (const b of bodies) { if (!foe(b)) continue; const d = Math.hypot(b.pos.x - cx, b.pos.y + 1 - cy, b.pos.z - cz); if (d < bd && this.sees(cx, y + 1.05, cz, b, 1.1)) { bd = d; best = b; } }
        if (!best) continue;
        const t = bd / 30, tx = best.pos.x + best.vel.x * t * 0.7, ty = best.pos.y + 1.1, tz = best.pos.z + best.vel.z * t * 0.7;
        let dx = tx - cx, dy = ty - (y + 1.05) + 0.5 * 14 * t * t, dz = tz - cz;
        const spread = 0.05 * bd; dx += (Math.random() - 0.5) * spread; dy += (Math.random() - 0.5) * spread; dz += (Math.random() - 0.5) * spread;
        const l = Math.hypot(dx, dy, dz) || 1, sp = 30;
        const a = new Arrow('a' + s.nextId(), cx, y + 1.05, cz, dx / l * sp, dy / l * sp, dz / l * sp, o, 12);
        a.machine = true; s.arrows.push(a);
        st.ammo--; st.cd = 1.0 + Math.random() * 0.5;
        s.emit({ type: 'machineFx', kind: 'turret', x, y, z });
      } else if (id === ID.cannon) {
        if (!live || st.cd > 0 || w.isSolid(x, y + 1, z)) continue;
        let best = null, bd = 31;
        for (const b of bodies) { if (!foe(b)) continue; const d = Math.hypot(b.pos.x - cx, b.pos.z - cz); if (d > 6.5 && d < bd) { bd = d; best = b; } }
        if (!best || (op && !s.hasResource(op, 'tnt', 1))) continue;
        if (op) s.spend(op, 'tnt', 1);
        const sc = 0.6 + bd * 0.04, tx = best.pos.x + (Math.random() - 0.5) * sc * 2, tz = best.pos.z + (Math.random() - 0.5) * sc * 2, ty = best.pos.y + 0.4;
        const t = clamp(0.5 + bd / 16, 0.9, 2.6), g = CONFIG.PLAYER.GRAVITY;
        const tnt = s.spawnTnt(cx, y + 1.3, cz, t + 0.12, o, 'cannon');
        tnt.vel.x = (tx - cx) / t; tnt.vel.z = (tz - cz) / t; tnt.vel.y = clamp((ty - (y + 1.3) + 0.5 * g * t * t) / t, 4, 34);
        st.cd = 6.5;
        s.emit({ type: 'machineFx', kind: 'cannon', x, y, z });
      } else if (id === ID.mine) {
        if (!live || s.clock < st.armed) continue;
        if (bodies.some((b) => foe(b) && inCell(b, x, y, z, 0.7))) {
          w.set(x, y, z, AIR);
          s.explode(cx, cy, cz, { radius: 2.8, power: 0.9, owner: o >= 0 ? o : null, cause: 'mine', crater: 2 });
        }
      } else if (id === ID.spikes) {
        if (!live || st.cd > 0) continue;
        for (const b of bodies) if (foe(b) && inCell(b, x, y, z, 0.5)) { s.damage(b, 7, { kind: 'trap', by: o, direct: false }); b.vel.x *= 0.45; b.vel.z *= 0.45; st.cd = 0.5; s.emit({ type: 'machineFx', kind: 'spikes', x, y, z }); break; }
      } else if (id === ID.jumppad) {
        for (const b of bodies) if (inCell(b, x, y, z, 0.6) && !(b.padUntil > s.clock)) { b.vel.y = 15; b.vel.x *= 1.2; b.vel.z *= 1.2; b.onGround = false; b.padUntil = s.clock + 0.45; s.emit({ type: 'machineFx', kind: 'pad', x, y, z }); }
      } else if (id === ID.conveyor) {
        const m = w.getMeta(x, y, z) & 3, dx = [1, -1, 0, 0][m], dz = [0, 0, 1, -1][m];
        for (const b of bodies) if (Math.floor(b.pos.x) === x && Math.floor(b.pos.z) === z && b.pos.y > y - 0.45 && b.pos.y < y + 0.6 && b.onGround !== false && b.convTick !== this.tickNo) {
          b.convTick = this.tickNo;
          const nx = b.pos.x + dx * 3.2 * step, nz = b.pos.z + dz * 3.2 * step, ex = nx + dx * (b.halfWidth + 0.05), ez = nz + dz * (b.halfWidth + 0.05);
          if (!w.isSolid(Math.floor(ex), Math.floor(b.pos.y + 0.1), Math.floor(ez)) && !w.isSolid(Math.floor(ex), Math.floor(b.pos.y + 1.1), Math.floor(ez))) { b.pos.x = nx; b.pos.z = nz; }
        }
      } else if (id === ID.sprinkler) {
        if (st.cd > 0) continue;
        st.cd = 1.0; let did = false;
        for (let dz = -6; dz <= 6; dz++) for (let dy = -4; dy <= 5; dy++) for (let dx = -6; dx <= 6; dx++) {
          if (dx * dx + dy * dy + dz * dz > 38) continue;
          if (w.get(x + dx, y + dy, z + dz) === ID.fire) { w.set(x + dx, y + dy, z + dz, AIR); did = true; }
        }
        for (const b of bodies) if (b.burnTime > 0 && Math.hypot(b.pos.x - cx, b.pos.y - cy, b.pos.z - cz) < 6) { b.burnTime = 0; did = true; }
        s.emit({ type: 'machineFx', kind: 'sprinkle', x, y, z, did });
      } else if (id === ID.healer) {
        if (st.cd > 0) continue;
        st.cd = 1.0;
        for (const q of s.players) if (q.alive && op && (q === op || s.areAllies(q, op)) && q.health < q.maxHealth && Math.hypot(q.pos.x - cx, q.pos.y - cy, q.pos.z - cz) < 6.5) { q.health = Math.min(q.maxHealth, q.health + 6); s.emit({ type: 'machineFx', kind: 'heal', x: q.pos.x, y: q.pos.y, z: q.pos.z }); }
      } else if (id === ID.flamer) {
        if (!live || st.cd > 0) continue;
        let best = null, bd = 7.5;
        for (const b of bodies) { if (!foe(b)) continue; const d = Math.hypot(b.pos.x - cx, b.pos.y + 0.9 - cy, b.pos.z - cz); if (d < bd && this.sees(cx, y + 0.9, cz, b, 0.9)) { bd = d; best = b; } }
        if (!best) continue;
        best.burnTime = Math.max(best.burnTime || 0, 4); best.burnCause = o >= 0 ? o : null;
        const fx = Math.floor(best.pos.x), fy = Math.floor(best.pos.y), fz = Math.floor(best.pos.z);
        if (w.get(fx, fy, fz) === AIR) s.fire.ignite(fx, fy, fz, o);
        st.cd = 1.2;
        s.emit({ type: 'machineFx', kind: 'flame', x, y, z, tx: best.pos.x, ty: best.pos.y + 0.9, tz: best.pos.z });
      }
    }
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
    if (this.acc < 0.9) return;                                      // fire spreads about once a second
    this.acc -= 0.9;
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
      if (y === 0 || w.get(x, y, z) === ID.bedrock || w.get(x, y, z) === ID.plotwall || supportedSet.has(keyOf(x, y, z))) { grounded = true; break; }
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
  onChange(x, y, z) { if (this.server.bulkFluid) return; this.pending.add(keyOf(x, y, z)); this.pending.add(keyOf(x, y + 1, z)); }
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
    if (id === ID.turret) return this.server.machines.refill(player, x, y, z);
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
      // plates and tripwires ignore whoever placed them (and their allies), so nobody walks onto their own trap
      const trapOwner = (id === ID.plate || id === ID.tripwire) ? s.playerBySlot(w.getOwner(x, y, z) - 1) : null;
      const trips = (b) => !(trapOwner && b.player && (b.player === trapOwner || s.areAllies(b.player, trapOwner)));
      if (id === ID.plate) {
        on = bodies.some((b) => trips(b) && Math.abs(b.pos.x - (x + 0.5)) < b.hw + 0.42 && Math.abs(b.pos.z - (z + 0.5)) < b.hw + 0.42 && b.pos.y < y + 0.5 && b.pos.y + b.h > y);
        if (on !== !!(m & 1)) { w.setMeta(x, y, z, on ? m | 1 : m & ~1); s.emit({ type: 'mechClick', x, y, z, block: BLOCKS[id] }); }
      } else if (id === ID.tripwire) {
        on = bodies.some((b) => trips(b) && Math.abs(b.pos.x - (x + 0.5)) < b.hw + 0.5 && Math.abs(b.pos.z - (z + 0.5)) < b.hw + 0.5 && b.pos.y < y + 1 && b.pos.y + b.h > y);
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
      else if (id === ID.dropper) { if (isP) s.machines.dropperFire(x, y, z); }
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
  mech:  { label: 'Parts', cap: 80, start: 22, color: '#ff6a5a' },
  earth: { label: 'Earth', cap: 80, start: 24, color: '#9a7350' },
  arrow: { label: 'Arrows', cap: 20, start: 10, color: '#e8d8a8' },      // a limited quiver: refills slowly when you stop shooting
};
const RESOURCE_ORDER = ['wood', 'stone', 'iron', 'glass', 'tnt', 'water', 'lava', 'mech', 'earth', 'arrow'];
/** Supply drop loot: one is picked per crate. */
const DROP_LOOT = [
  { id: 'quiver', name: 'Quiver Pack', desc: '+12 arrows, +1 TNT', give: { arrow: 12, tnt: 1 } },
  { id: 'rage', name: 'Berserker Rage', desc: '+30% damage for 20 s', buff: ['rage', 20] },
  { id: 'swift', name: 'Swiftness', desc: '+30% speed for 20 s', buff: ['swift', 20] },
  { id: 'armor', name: 'Iron Skin', desc: '-40% damage taken for 25 s', buff: ['armor', 25] },
  { id: 'medkit', name: 'Medkit', desc: 'Full health + short iron skin', heal: true, buff: ['armor', 6] },
  { id: 'demo', name: 'Demolition Kit', desc: '+4 TNT, +1 lava', give: { tnt: 4, lava: 1 } },
];
const DROP_LOOT_BY_ID = Object.fromEntries(DROP_LOOT.map((l) => [l.id, l]));
const BUFF_INFO = { rage: { name: 'RAGE', color: '#ff5a4a' }, swift: { name: 'SWIFT', color: '#5ae0ff' }, armor: { name: 'IRON SKIN', color: '#ffd23f' } };
/** Daily challenges: three are picked per day (same three for everyone on that date). kind = what counts. */
const DAILY_POOL = [
  { id: 'kills', kind: 'kill', n: 5, coins: 60, text: 'Get 5 eliminations' },
  { id: 'freeze', kind: 'chill', n: 8, coins: 80, text: 'Freeze enemies 8 times (Glacier)' },
  { id: 'burn', kind: 'burn', n: 8, coins: 80, text: 'Set enemies on fire 8 times (Inferno)' },
  { id: 'leech', kind: 'leech', n: 10, coins: 80, text: 'Lifesteal 10 times (Bloodmoon)' },
  { id: 'core', kind: 'core', n: 1, coins: 100, text: 'Destroy an enemy core' },
  { id: 'drops', kind: 'drop', n: 2, coins: 80, text: 'Claim 2 supply drops' },
  { id: 'streak', kind: 'streak', n: 1, coins: 100, text: 'Get a 3 kill streak' },
  { id: 'crits', kind: 'crit', n: 10, coins: 60, text: 'Land 10 critical hits' },
  { id: 'arrows', kind: 'arrowHit', n: 12, coins: 60, text: 'Hit 12 arrows' },
  { id: 'tnt', kind: 'tntKill', n: 2, coins: 80, text: 'Get 2 TNT eliminations' },
  { id: 'win', kind: 'win', n: 1, coins: 120, text: 'Win a match' },
  { id: 'play', kind: 'play', n: 3, coins: 60, text: 'Play 3 matches' },
];
const DAILY_BY_ID = Object.fromEntries(DAILY_POOL.map((d) => [d.id, d]));
const QUIVER = { REFILL_AFTER: 4, REFILL_EVERY: 5, REFILL_TO: 10 };   // s without shooting before refilling, s per arrow, refills up to

/** Everything that can sit in a hotbar slot. kind: tool | block | fluid | mech */
const ITEMS = {
  pickaxe: { kind: 'tool', label: 'Pickaxe' },
  sword:   { kind: 'tool', label: 'Sword' },
  axe:     { kind: 'tool', label: 'Axe' },
  bow:     { kind: 'tool', label: 'Bow' },
  staff:   { kind: 'tool', label: 'Knockback Staff' },
  lighter: { kind: 'tool', label: 'Lighter' },
  bucket:  { kind: 'tool', label: 'Bucket (scoop / pour)' },
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
  // automatic machines: place them and they work on their own (enemies only; they never hurt you or your allies)
  turret:  { kind: 'mech', label: 'Arrow Turret', block: 'turret', res: 'mech', cost: 6, auto: true },
  cannon:  { kind: 'mech', label: 'TNT Cannon', block: 'cannon', res: 'mech', cost: 8, auto: true },
  mine:    { kind: 'mech', label: 'Land Mine', block: 'mine', res: 'mech', cost: 2, auto: true },
  spikes:  { kind: 'mech', label: 'Spike Trap', block: 'spikes', res: 'mech', cost: 2, auto: true },
  flamer:  { kind: 'mech', label: 'Flamethrower', block: 'flamer', res: 'mech', cost: 5, auto: true },
  jumppad: { kind: 'mech', label: 'Launch Pad', block: 'jumppad', res: 'mech', cost: 2, auto: true },
  conveyor:{ kind: 'mech', label: 'Conveyor', block: 'conveyor', res: 'mech', cost: 1, auto: true },
  sprinkler:{ kind: 'mech', label: 'Sprinkler', block: 'sprinkler', res: 'mech', cost: 3, auto: true },
  healer:  { kind: 'mech', label: 'Healing Beacon', block: 'healer', res: 'mech', cost: 5, auto: true },
  dropper: { kind: 'mech', label: 'TNT Dropper', block: 'dropper', res: 'mech', cost: 4 },
};
const ITEM_ORDER = Object.keys(ITEMS);

/** Combat numbers follow Minecraft's feel (scaled to 100 HP): sword about 7 hits, axe heavy and slow; slowed down so fights last several seconds, sprint hits knock back harder, crits while falling.
 *  cd = seconds for a full attack charge, kb = horizontal knockback speed (blocks/s). */
const TOOLS = {
  pickaxe: { dmg: 9,  cd: 1.0,  crit: 1.5,  reach: 3.2, kb: 7,  mine: 2.6 },
  sword:   { dmg: 15, cd: 0.8,  crit: 1.5,  reach: 3.3, kb: 7,  mine: 1.2 },
  axe:     { dmg: 21, cd: 1.25, crit: 2.0,  reach: 3.1, kb: 7,  mine: 1.0, woodMine: 2.5 },
  staff:   { dmg: 4,  cd: 0.9,  reach: 3.4, kb: 18, mine: 1.0 },
  bow:     { dmg: 18, cd: 0.9,  draw: 1.2, speed: 26, mine: 1.0 },   // full draw takes 1 s, like Minecraft
  lighter: { mine: 1.0 },
};
/** Seconds to break `def` by hand/tool (used by both the client progress bar and bots). */
function mineTime(def, toolId, mods, look, ctx) {
  const t = TOOLS[toolId] || { mine: 1 }, b = weaponBoost(look, toolId);
  let mult = t.mine || 1;
  if (t.woodMine && (def.sound === 'wood')) mult = t.woodMine;
  else if (toolId === 'pickaxe' && (def.sound === 'soft')) mult = 1.6;
  mult *= b.mine || 1;                                                       // pickaxe skins: mining perks
  const hard = def.sound === 'stone' || def.sound === 'metal', soft = def.sound === 'soft' || def.sound === 'wood';
  if (b.mineHard && hard) mult *= b.mineHard;
  if (b.mineSoft && soft) mult *= b.mineSoft;
  if (b.raid && ctx && ctx.enemy) mult *= b.raid;
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
    perks: ['Carry +5 TNT', 'Takes 35% less explosion damage', '+4 TNT to start', '+5% melee damage'],
    mods: { tntCap: 5, explosionTaken: 0.65, meleeDamage: 1.05 }, bonus: { tnt: 4 },
  },
  scout: {
    name: 'Scout', blurb: 'Quick on their feet. Best for flanking and hit-and-run.',
    perks: ['12% faster movement', 'Jumps 8% higher', 'Takes half fall damage', 'Draws the bow 15% faster', '+4 wood to start'],
    mods: { speed: 1.12, jump: 1.08, fall: 0.5, bowDraw: 0.85 }, bonus: { wood: 4 },
  },
  survivalist: {
    name: 'Survivalist', blurb: 'Hard to finish off. Best for players who prioritize staying alive.',
    perks: ['Regenerates faster, starts sooner', 'Takes 25% less lava / fire / flood damage', 'Disasters hurt less'],
    mods: { regenRate: 1.5, regenDelay: 0.6, hazardTaken: 0.75 }, bonus: {},
  },
};
/** AI difficulty. aim = bow aim error multiplier, lead = how well bots lead moving targets, bowRange = max shooting distance,
 *  shootGap = pause between arrows (s), draw = bow draw time multiplier, botBow / botMelee = damage multipliers for AI attacks,
 *  rate = chance per update that a ready melee swing is taken, block = block frequency, think = reaction time multiplier, aggr = eagerness offset. */
const DIFFICULTIES = {
  easy:   { name: 'Easy',   blurb: 'Slow, sloppy AI. Bows are weak and rare.',            aim: 2.4,  lead: 0.25, bowRange: 18, shootGap: 3.2, draw: 1.5,  botBow: 0.5,  botMelee: 0.7, rate: 0.10, block: 0,   think: 1.6, aggr: -0.2 },
  normal: { name: 'Normal', blurb: 'A fair fight. Archers miss a fair amount.',            aim: 1.5,  lead: 0.6,  bowRange: 26, shootGap: 1.8, draw: 1.25, botBow: 0.7,  botMelee: 0.9, rate: 0.30, block: 1,   think: 1.15, aggr: 0 },
  hard:   { name: 'Hard',   blurb: 'Sharper aim, faster reactions, real blocking.',        aim: 0.9,  lead: 0.9,  bowRange: 32, shootGap: 1.1, draw: 1.1,  botBow: 0.85, botMelee: 1.0, rate: 0.60, block: 1.5, think: 1.0, aggr: 0.1 },
  brutal: { name: 'Brutal', blurb: 'Near-perfect aim and relentless pressure. Good luck.', aim: 0.45, lead: 1.0,  bowRange: 38, shootGap: 0.6, draw: 1.0,  botBow: 1.0,  botMelee: 1.1, rate: 1.0,  block: 2.5, think: 0.75, aggr: 0.2 },
};
const DIFF_ORDER = ['easy', 'normal', 'hard', 'brutal'];
const CLASS_ORDER = ['builder', 'fighter', 'engineer', 'demolitionist', 'scout', 'survivalist'];

/** Land types: each plot has a reason to pick it AND a reason to fear it. */
const LANDS = {
  fortress: {
    name: 'Fortress', icon: '#8d8d98', blurb: 'Stone walls, towers and natural cliffs behind your base.',
    pros: ['Pre-built stone walls and four towers', 'Cliffs protect your back', '+16 stone, +2 iron'],
    cons: ['Little wood or glass', 'Cliffs box you in, so expanding is slow', 'No water nearby'],
    res: { stone: 16, iron: 2, wood: -12, glass: -4, water: -1 }, blastMult: 1,
  },
  forest: {
    name: 'Forest', icon: '#3f8f3a', blurb: 'Dense woods, wood everywhere, and a cabin to start in.',
    pros: ['Trees give wood and cover', 'Wooden cabin ready to go', '+24 wood, a little of everything else'],
    cons: ['Everything burns: lava and fire can eat your base', 'Little iron or stone nearby'],
    res: { wood: 24, stone: 6, iron: 2, glass: 4, mech: 2 }, blastMult: 1,
  },
  mountain: {
    name: 'Mountain', icon: '#b7b0a2', blurb: 'A high plateau with steep cliffs and rock spires.',
    pros: ['High ground sees the whole map', 'Cliffs on every side', '+22 stone, +5 iron, +5 parts'],
    cons: ['Spires topple when undermined', 'Long falls and slow expansion', 'Little wood'],
    res: { stone: 22, iron: 5, mech: 5, wood: 0, earth: 0 }, blastMult: 1,
  },
  cave: {
    name: 'Cave', icon: '#5a5260', blurb: 'Natural tunnels and chambers under your base.',
    pros: ['Ready-made bunker and tunnels', 'Iron ore in the walls', 'Hidden route toward enemies'],
    cons: ['Pour water or lava down the shaft and you drown', 'TNT on the ceiling brings it down', 'Little wood and glass'],
    res: { stone: 10, iron: 3, mech: 1, wood: -8, glass: -4 }, blastMult: 1,
  },
  river: {
    name: 'River', icon: '#3f78d8', blurb: 'A river crosses your plot. Water is your friend (and your problem).',
    pros: ['Moat and current for defence', 'Water puts fires out', '+8 water, +4 earth'],
    cons: ['Less flat building land', 'Sand banks slump when undermined', 'Digging near the river floods your tunnels'],
    res: { water: 8, earth: 4, wood: -8, stone: -10 }, blastMult: 1,
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
const PLOT_BASE_RADIUS = 12;
const sy = (world) => world.sizeY;     // base-integrity zone around each spawn pad

/**
 * The centre vault: an unbreakable obstacle course with three capture pads, each worth more than the last.
 *   Stage 1 THE GATE   courtyard wall with four gates, lava pits, a room with one narrow door; pad on the room floor.
 *   Stage 2 THE ROOF   parkour pillars around the room up to its roof; pad in the far roof corner.
 *   Stage 3 THE SPIRE  three more pillars on the roof up to the spire; pad on the very top.
 * Nobody can build inside the vault zone, so the course has to be run. Returns the map's vault description
 * (pads + the waypoint course bots follow). Coordinates in cells relative to the centre (dx, dz).
 */
const VAULT_ZONE = 10;
function buildVault(world, cx, cz, CENTER) {
  const put = (dx, y, dz, type, meta = 0) => world.set(cx + dx, y, cz + dz, ID[type], true, meta, 0);
  const air = (dx, y, dz) => world.set(cx + dx, y, cz + dz, AIR, true);
  const G = CENTER + 1;                                            // feet level on the courtyard floor
  for (let dz = -VAULT_ZONE; dz <= VAULT_ZONE; dz++) for (let dx = -VAULT_ZONE; dx <= VAULT_ZONE; dx++) {
    for (let y = CENTER - 3; y <= CENTER; y++) put(dx, y, dz, y === CENTER ? 'stone' : 'stone');
    for (let y = G; y <= CENTER + 16; y++) air(dx, y, dz);
  }
  const D = (dx, dz) => Math.max(Math.abs(dx), Math.abs(dz));
  for (let dz = -9; dz <= 9; dz++) for (let dx = -9; dx <= 9; dx++) {
    const d = D(dx, dz);
    if (d === 9 && Math.min(Math.abs(dx), Math.abs(dz)) > 1) for (let y = G; y < G + 3; y++) put(dx, y, dz, 'vaultstone');     // courtyard wall, 3-wide gates mid-side
    if (d <= 9) put(dx, CENTER, dz, 'vaultstone');                                                                                // course floor
    if (d === 3) for (let y = G; y < G + 5; y++) put(dx, y, dz, 'vaultstone');                                                    // the room
    if (d <= 3) put(dx, G + 5, dz, 'vaultstone');                                                                                 // its roof
    if (d <= 1) { put(dx, CENTER, dz, 'vault'); for (let y = G + 6; y <= G + 9; y++) put(dx, y, dz, 'vaultstone'); put(dx, G + 9, dz, 'vault'); }   // pad 1 + the spire (pad 3 on top)
  }
  air(3, G, 0); air(3, G + 1, 0);                                    // one narrow door
  for (const dz of [-2, 2]) put(3, G + 2, dz, 'glass');               // windows
  for (const dx of [-3, 3]) put(dx, G + 2, -2, 'glass');
  for (const [dx, dz] of [[-3, -3], [-2, -3], [-3, -2], [-2, -2]]) put(dx, G + 5, dz, 'vault');   // pad 2: far roof corner
  for (const [dx, dz] of [[8, 4], [8, -4], [-8, 4], [-8, -4], [4, 8], [-4, -8]]) put(dx, CENTER, dz, 'lava', 16);   // lava pits by the wall
  const climb = [[5, 3, 1], [5, 5, 2], [3, 5, 3], [1, 5, 4], [-1, 5, 5]];       // parkour pillars to the roof: [dx, dz, height]
  for (const [dx, dz, h] of climb) for (let y = G; y < G + h; y++) put(dx, y, dz, 'vaultstone');
  const spire = [[3, 3, 7], [3, 1, 8], [3, -1, 9]];                               // pillars on the roof (heights above the floor)
  for (const [dx, dz, h] of spire) for (let y = G + 6; y < G + h; y++) put(dx, y, dz, 'vaultstone');
  for (const [dx, dz] of [[9, 9], [9, -9], [-9, 9], [-9, -9]]) put(dx, G + 3, dz, 'lamp');
  const W = (dx, dz, y) => ({ x: cx + dx + 0.5, z: cz + dz + 0.5, y });
  const pads = [{ x: cx + 0.5, y: G, z: cz + 0.5, r: 1.6 }, { x: cx - 2, y: G + 6, z: cz - 2, r: 1.3 }, { x: cx + 0.5, y: G + 10, z: cz + 0.5, r: 1.6 }];
  const entries = {
    px: [W(9, 0, G), W(6, 0, G)], nx: [W(-9, 0, G), W(-6, 0, G), W(-6, -6, G), W(6, -6, G), W(6, 0, G)],
    pz: [W(0, 9, G), W(0, 6, G), W(6, 6, G), W(6, 0, G)], nz: [W(0, -9, G), W(0, -6, G), W(6, -6, G), W(6, 0, G)],
  };
  const room = [W(4, 0, G), W(3, 0, G), W(1, 0, G), W(0, 0, G)];
  const toRoof = [W(6, 2, G), ...climb.map(([dx, dz, h]) => W(dx, dz, G + h)), W(-1, 3, G + 6), W(-2, 3, G + 6), W(-2, -1, G + 6), { x: cx - 2, z: cz - 2, y: G + 6 }];
  const toSpire = [W(-2, 3, G + 6), W(2, 3, G + 6), ...spire.map(([dx, dz, h]) => W(dx, dz, G + h)), W(1, -1, G + 10), W(0, 0, G + 10)];
  return { x: cx + 0.5, y: G, z: cz + 0.5, block: [cx, CENTER, cz], radius: 1.6, cx, cz, floorY: CENTER, pads, entries, room, toRoof, toSpire };
}
/** Bot course for vault stage `stage` (0-2), entering through the gate nearest to (x, z). */
function vaultCourse(m, stage, x, z) {
  const dx = x - m.x, dz = z - m.z, gate = Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? 'px' : 'nx') : (dz > 0 ? 'pz' : 'nz');
  const inRoom = Math.max(Math.abs(dx), Math.abs(dz)) < 3 && Math.abs(dz) < 3, exit = [...m.room].reverse().concat([{ x: m.cx + 6.5, z: m.cz + 0.5, y: m.y }]);
  const entry = inRoom ? exit : m.entries[gate];
  if (stage === 0) return inRoom ? m.room.slice(-2) : [...entry, ...m.room];
  return stage === 1 ? [...entry, ...m.toRoof] : [...entry, ...m.toRoof, ...m.toSpire];
}
const VAULT_STAGES = [
  { name: 'THE GATE', time: 6, score: 150, give: { tnt: 1, arrow: 5, mech: 2 } },
  { name: 'THE ROOF', time: 7, score: 300, give: { tnt: 2, iron: 3, mech: 4, arrow: 8 }, buffs: [['swift', 15]] },
  { name: 'THE SPIRE', time: 8, score: 600, give: { tnt: 4, lava: 2, iron: 5, mech: 8, arrow: 12 }, buffs: [['rage', 20], ['armor', 20]] },
];
const vaultRewardText = (st) => Object.entries(st.give).map(([k, a]) => '+' + a + ' ' + RESOURCES[k].label.toLowerCase()).join(', ') + (st.buffs ? ', ' + st.buffs.map((b) => BUFF_INFO[b[0]].name.toLowerCase()).join(' + ') : '');
/** Playable maps. All three keep the plot ring and the centre vault, so every class/land/bot logic still applies. */
const MAPS = {
  plains:  { name: 'Plains',  icon: '#5fae45', blurb: 'Open terrain with boulders and lone trees. Good for learning the ropes.' },
  canyon:  { name: 'Canyon',  icon: '#b9805a', blurb: 'Huge cliffs and a deep gorge. Knock enemies off ledges and bring the mesas down on them.' },
  village: { name: 'Village', icon: '#c9a15a', blurb: 'Houses, a church tower and narrow gravel streets: lots of structures to blow apart.' },
};
const MAP_ORDER = ['plains', 'canyon', 'village'];

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
    const mapId = MAPS[opts.mapId] ? opts.mapId : 'plains';
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
        let h, tp, fl;
        if (mapId === 'canyon') {
          const nc = fbm(x / 30 + 10, z / 30 + 10, seed + 21), t = smoothstep(0.43, 0.57, nc);
          h = lerp(7, 24, t) + (fbm(x / 6, z / 6, seed + 5) - 0.5) * 3;
          tp = h >= 18 ? (fbm(x / 5, z / 5, seed + 9) > 0.6 ? ID.gravel : ID.stone) : h >= 11 ? ID.grass : ID.sand;
          fl = h >= 15 ? ID.stone : h >= 11 ? ID.dirt : ID.sand;
        } else if (mapId === 'village') {
          h = 13 + (fbm(x / 30, z / 30, seed) - 0.5) * 3;
          tp = ID.grass; fl = ID.dirt;
        } else {
          h = 13 + (fbm(x / 28, z / 28, seed) - 0.5) * 12;
          tp = h <= 11 ? ID.sand : (fbm(x / 9 + 50, z / 9 + 50, seed + 7) > 0.68 ? ID.gravel : ID.grass);
          fl = h <= 11 ? ID.sand : ID.dirt;
        }
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
      let core = null;
      if (opts.cores && owner >= 0) { const [cx2, cz2] = at(-2, 0); put(cx2, base + 1, cz2, 'core', oc); core = [cx2, base + 1, cz2]; }
      plots.push({ index: s.index, landId: land, owner, x: px, z: pz, baseY: base, outward: o, core });
    }

    // ---- centre vault: a three-stage obstacle course (courtyard + locked room, parkour to the roof, the spire) ----
    const vault = buildVault(world, cx, cz, CENTER);

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

    if (mapId === 'village') this.village(world, rng, spawns, cx, cz, PR);
    if (mapId === 'canyon') this.canyonExtras(world, rng, spawns, cx, cz, PR);
    this.decorate(world, rng, mapId, spawns, cx, cz, PR);
    for (const s of spawns) s.y = world.getSolidHeight(Math.floor(s.x), Math.floor(s.z)) + 1;
    for (const p of plots) { const s = spawns[p.index]; p.spawn = { x: s.x, y: s.y, z: s.z }; }
    // ---- plot dividers: tall walls on the borders between plots, so nobody sees what the others are building. Removed when the war starts. ----
    const wallCells = [];
    if (opts.walls) {
      const sx2 = world.sizeX, sz2 = world.sizeZ, near = new Int8Array(sx2 * sz2);
      for (let z = 0; z < sz2; z++) for (let x = 0; x < sx2; x++) {
        let bi = 0, bd = 1e9;
        for (let i = 0; i < plots.length; i++) { const d = (x + 0.5 - plots[i].x) ** 2 + (z + 0.5 - plots[i].z) ** 2; if (d < bd) { bd = d; bi = i; } }
        near[x + z * sx2] = bi;
      }
      for (let z = 0; z < sz2; z++) for (let x = 0; x < sx2; x++) {
        const n = near[x + z * sx2];
        const edgeCol = (x > 0 && near[x - 1 + z * sx2] !== n) || (x < sx2 - 1 && near[x + 1 + z * sx2] !== n) || (z > 0 && near[x + (z - 1) * sx2] !== n) || (z < sz2 - 1 && near[x + (z + 1) * sx2] !== n);
        if (!edgeCol) continue;
        for (let y = 1; y < world.sizeY; y++) if (world.get(x, y, z) === AIR) { world.set(x, y, z, ID.plotwall, true); wallCells.push(x, y, z); }
      }
    }
    return { spawns, plots, center: { x: cx + 0.5, z: cz + 0.5 }, vault, name: mapId, mapId, wallCells };
  },

  /** Village: a grid of houses with gravel streets between them, plus a church tower. */
  village(world, rng, spawns, cx, cz, PR) {
    const sx = world.sizeX, sz = world.sizeZ, CELL = 11, put = (x, y, z, t) => world.set(x, y, z, ID[t], true, 0, 0);
    const free = (x, z, m) => x >= 6 && z >= 6 && x < sx - 6 && z < sz - 6 && Math.hypot(x - cx, z - cz) > 19 && spawns.every((s) => Math.hypot(x - s.x, z - s.z) > PR + m);
    // gravel streets (3 wide) between building cells
    for (let z = 4; z < sz - 4; z++) for (let x = 4; x < sx - 4; x++) {
      if (!free(x, z, 1)) continue;
      const lx = (x - 6) % CELL, lz = (z - 6) % CELL;
      if (lx >= 8 || lz >= 8) { const gy = world.getSolidHeight(x, z); if (gy > 2 && world.get(x, gy, z) === ID.grass) world.set(x, gy, z, ID.gravel, true, 0, 0); }
    }
    const kinds = ['brick', 'wood', 'stone'];
    let churchDone = false;
    for (let gx = 6; gx + CELL <= sx - 6; gx += CELL) for (let gz = 6; gz + CELL <= sz - 6; gz += CELL) {
      const w = 5 + Math.floor(rng() * 3), d = 5 + Math.floor(rng() * 3), x0 = gx + 1, z0 = gz + 1;
      if (!free(x0 + w / 2, z0 + d / 2, 1) || rng() < 0.08) continue;
      const hgt = 3 + (rng() < 0.3 ? 1 : 0), mat = kinds[Math.floor(rng() * kinds.length)];
      let g = 0, n = 0;
      for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) { g += world.getSolidHeight(x, z); n++; }
      g = Math.round(g / n);
      const church = !churchDone && rng() < 0.35 && Math.hypot(x0 - cx, z0 - cz) > 26;
      if (church) churchDone = true;
      for (let x = x0 - 1; x <= x0 + w; x++) for (let z = z0 - 1; z <= z0 + d; z++) {      // flatten the lot
        for (let y = g + 1; y < Math.min(sy(world), g + hgt + 6); y++) world.set(x, y, z, AIR, true);
        for (let y = world.getSolidHeight(x, z) + 1; y <= g; y++) world.set(x, y, z, ID.dirt, true, 0, 0);
      }
      const side = Math.floor(rng() * 4);
      for (let x = x0; x < x0 + w; x++) for (let z = z0; z < z0 + d; z++) {
        const edge = x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1, corner = (x === x0 || x === x0 + w - 1) && (z === z0 || z === z0 + d - 1);
        put(x, g, z, 'wood');
        if (edge) {
          for (let k = 1; k <= hgt; k++) {
            let t = corner ? 'log' : mat;
            if (!corner && k === 2 && ((x - x0 + z - z0) % 3 === 1)) t = 'glass';
            put(x, g + k, z, t === 'log' ? 'log' : t);
          }
        }
        put(x, g + hgt + 1, z, 'shingle');                                                  // flat roof
        if (x > x0 && x < x0 + w - 1 && z > z0 && z < z0 + d - 1) put(x, g + hgt + 2, z, 'shingle');
      }
      // door on the chosen side (2 high), facing the street
      const mx = Math.floor(x0 + w / 2), mz = Math.floor(z0 + d / 2);
      const dx = side === 0 ? x0 : side === 1 ? x0 + w - 1 : mx, dz = side === 2 ? z0 : side === 3 ? z0 + d - 1 : mz;
      world.set(dx, g + 1, dz, AIR, true); world.set(dx, g + 2, dz, AIR, true);
      // furnishing: a lamp, sometimes a TNT crate or an iron block, a flower box outside
      put(mx, g + hgt, mz, 'lamp');
      if (rng() < 0.22) { put(x0 + 1, g + 1, z0 + 1, 'tnt'); put(x0 + 2, g + 1, z0 + 1, 'tnt'); }
      else if (rng() < 0.2) put(x0 + 1, g + 1, z0 + d - 2, 'iron_block');
      if (church) {                                                                       // bell tower on the roof
        for (let k = hgt + 2; k <= hgt + 7; k++) { put(mx, g + k, mz, 'brick'); }
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) put(mx + ax, g + hgt + 7, mz + az, 'stone');
        put(mx, g + hgt + 8, mz, 'lamp');
      }
    }
    // well and lamp posts in the street crossings
    for (let gx = 6; gx + CELL <= sx - 6; gx += CELL) for (let gz = 6; gz + CELL <= sz - 6; gz += CELL) {
      const x = gx + 9, z = gz + 9;
      if (!free(x, z, 2) || rng() < 0.4) continue;
      const g = world.getSolidHeight(x, z);
      for (let k = 1; k <= 3; k++) put(x, g + k, z, 'log');
      put(x, g + 4, z, 'lamp');
    }
  },

  /** Canyon: a few stone arches and bridges across the gorge, gold in the cliff faces. */
  canyonExtras(world, rng, spawns, cx, cz, PR) {
    const sx = world.sizeX, sz = world.sizeZ;
    for (let n = 0; n < 5; n++) {                                                         // wooden bridges between two high points
      const x0 = 10 + Math.floor(rng() * (sx - 20)), z0 = 10 + Math.floor(rng() * (sz - 20)), alongX = rng() < 0.5;
      if (spawns.some((s) => Math.hypot(x0 - s.x, z0 - s.z) < PR) || Math.hypot(x0 - cx, z0 - cz) < 18) continue;
      let ya = world.getSolidHeight(x0, z0);
      if (ya < 17) continue;
      for (let i = 0; i < 26; i++) {
        const x = alongX ? x0 + i : x0, z = alongX ? z0 : z0 + i;
        if (!world.inBounds(x, 1, z)) break;
        const gy = world.getSolidHeight(x, z);
        if (i > 3 && gy >= ya - 1) break;                                                // reached the other side
        for (let w = 0; w < 2; w++) { const bx = alongX ? x : x + w, bz = alongX ? z + w : z; if (world.get(bx, ya, bz) === AIR) world.set(bx, ya, bz, ID.wood, true, 0, 0); }
      }
    }
    for (let n = 0; n < 70; n++) {                                                        // gold veins in the rock
      const x = 4 + Math.floor(rng() * (sx - 8)), z = 4 + Math.floor(rng() * (sz - 8));
      const h = world.getSolidHeight(x, z), y = h - 2 - Math.floor(rng() * 5);
      if (y > 2 && world.get(x, y, z) === ID.stone && !spawns.some((s) => Math.hypot(x - s.x, z - s.z) < 9)) world.set(x, y, z, ID.gold_ore, true);
    }
  },

  /** Flowers on grass and a few gold ores: decorative blocks, owner 0. */
  decorate(world, rng, mapId, spawns, cx, cz, PR) {
    const sx = world.sizeX, sz = world.sizeZ, chance = mapId === 'canyon' ? 0.012 : 0.03;
    for (let z = 3; z < sz - 3; z++) for (let x = 3; x < sx - 3; x++) {
      if (rng() > chance) continue;
      const gy = world.getSolidHeight(x, z);
      if (gy < 2 || world.get(x, gy, z) !== ID.grass || world.get(x, gy + 1, z) !== AIR) continue;
      if (spawns.some((s) => Math.hypot(x - s.x, z - s.z) < 5) || Math.hypot(x - cx, z - cz) < 6) continue;
      world.set(x, gy + 1, z, rng() < 0.5 ? ID.flower_red : ID.flower_yellow, true, 0, 0);
    }
    if (mapId !== 'canyon') for (let n = 0; n < 24; n++) {
      const x = 4 + Math.floor(rng() * (sx - 8)), z = 4 + Math.floor(rng() * (sz - 8)), y = world.getSolidHeight(x, z) - 3 - Math.floor(rng() * 3);
      if (y > 2 && world.get(x, y, z) === ID.stone && !spawns.some((s) => Math.hypot(x - s.x, z - s.z) < 9)) world.set(x, y, z, ID.gold_ore, true);
    }
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
/* ========================== 10b. PROGRESSION & COSMETICS ========================== */
/**
 * XP and coins unlock COSMETICS ONLY (skins, trails, kill effects, emotes, banners, titles).
 * Nothing in here changes damage, speed, resources or any other gameplay number: no pay-to-win.
 */
const LEVEL_XP = 600;                                           // XP per level, growing with level (a long climb)
const levelFor = (xp) => { let lvl = 1, need = LEVEL_XP; while (xp >= need && lvl < 99) { xp -= need; lvl++; need = Math.round(LEVEL_XP * (1 + lvl * 0.5)); } return { level: lvl, into: xp, need }; };

const COSMETICS = {
  skin: {
    default: { name: 'Team Colours', cost: 0, level: 1, blurb: 'Your team colour shirt.' },
    knight:  { name: 'Knight',  cost: 800, level: 2, skin: [0.84, 0.82, 0.88], shirt: [0.68, 0.71, 0.78], legs: [0.36, 0.38, 0.44] },
    ember:   { name: 'Ember',   cost: 1000, level: 3, skin: [0.95, 0.62, 0.42], shirt: [0.86, 0.26, 0.12], legs: [0.3, 0.1, 0.08] },
    frost:   { name: 'Frost',   cost: 1000, level: 4, skin: [0.82, 0.93, 1.0],  shirt: [0.45, 0.72, 0.95], legs: [0.2, 0.32, 0.55] },
    shadow:  { name: 'Shadow',  cost: 1500, level: 6, skin: [0.3, 0.3, 0.36],   shirt: [0.14, 0.12, 0.2],  legs: [0.08, 0.07, 0.12] },
    golden:  { name: 'Golden',  cost: 4000, level: 12, skin: [1.0, 0.88, 0.45], shirt: [0.96, 0.78, 0.2],  legs: [0.62, 0.45, 0.1] },
    admin:   { name: 'Admin',   cost: 0, level: 1, admin: true, skin: [0.95, 0.8, 1], shirt: [0.92, 0.18, 0.85], legs: [0.12, 0.08, 0.16] },
    leaf:    { name: 'Woodland', cost: 1200, level: 5, skin: [0.78, 0.66, 0.46], shirt: [0.28, 0.56, 0.24], legs: [0.34, 0.26, 0.14] },
    // ---- the silly ones (bots love these). face: eyes / mouth / nose / top describe the head ----
    chicken: { name: 'Chicken', cost: 400, level: 1, funny: true, joke: 'Bawk. Comes with a comb.', skin: [0.97, 0.97, 0.95], shirt: [0.95, 0.95, 0.92], legs: [0.98, 0.78, 0.2], face: { eyes: 'dot', mouth: 'beak', top: 'comb' } },
    banana:  { name: 'Banana Man', cost: 500, level: 1, funny: true, joke: 'Appeal guaranteed.', skin: [1, 0.9, 0.3], shirt: [1, 0.86, 0.22], legs: [0.95, 0.8, 0.2], face: { eyes: 'big', mouth: 'smile', top: 'stem' } },
    clown:   { name: 'Honk', cost: 700, level: 2, funny: true, joke: 'Honk honk. Red nose included.', skin: [0.98, 0.97, 0.97], shirt: [0.62, 0.3, 0.85], legs: [0.25, 0.75, 0.3], face: { eyes: 'big', mouth: 'grin', nose: [0.95, 0.12, 0.12], top: 'hair', topColor: [1, 0.45, 0.1] } },
    nerd:    { name: 'Big Brain', cost: 700, level: 2, funny: true, joke: 'Glasses +10 IQ. Teeth not included.', skin: [0.96, 0.8, 0.66], shirt: [0.3, 0.55, 0.35], legs: [0.45, 0.35, 0.25], face: { eyes: 'glasses', mouth: 'teeth', top: 'hair', topColor: [0.35, 0.22, 0.12] } },
    frog:    { name: 'Frog Prince', cost: 900, level: 3, funny: true, joke: 'Kiss not required.', skin: [0.35, 0.75, 0.3], shirt: [0.3, 0.65, 0.28], legs: [0.25, 0.5, 0.2], face: { eyes: 'big', mouth: 'line', top: 'crown' } },
    robot:   { name: 'Beep Boop', cost: 900, level: 3, funny: true, joke: 'Beep. Boop. Antenna blinks.', skin: [0.7, 0.72, 0.76], shirt: [0.5, 0.52, 0.58], legs: [0.35, 0.36, 0.4], face: { eyes: 'visor', mouth: 'none', top: 'antenna' } },
    pig:     { name: 'Bacon', cost: 1000, level: 4, funny: true, joke: 'Oink. Big snout energy.', skin: [0.98, 0.68, 0.72], shirt: [0.95, 0.6, 0.66], legs: [0.88, 0.5, 0.56], face: { eyes: 'dot', mouth: 'smile', nose: 'snout', top: 'ears', topColor: [0.95, 0.58, 0.64] } },
    grandpa: { name: 'Grandpa', cost: 1100, level: 4, funny: true, joke: 'Back in my day we mined by hand.', skin: [0.95, 0.8, 0.68], shirt: [0.55, 0.38, 0.25], legs: [0.35, 0.33, 0.3], face: { eyes: 'glasses', mouth: 'mustache', top: 'hair', topColor: [0.94, 0.94, 0.94] } },
    derp:    { name: 'Derp', cost: 600, level: 2, funny: true, joke: 'Eyes looking two ways at once.', skin: [0.96, 0.82, 0.62], shirt: [0.95, 0.4, 0.6], legs: [0.3, 0.4, 0.85], face: { eyes: 'derp', mouth: 'tongue', top: 'party' } },
    imp:     { name: 'Lil Imp', cost: 1300, level: 5, funny: true, joke: 'Tiny horns, big trouble.', skin: [0.88, 0.25, 0.2], shirt: [0.25, 0.1, 0.12], legs: [0.15, 0.06, 0.08], face: { eyes: 'angry', mouth: 'grin', top: 'horns' } },
    chef:    { name: 'Le Chef', cost: 1500, level: 6, funny: true, joke: 'Sleepy chef with a fancy mustache.', skin: [0.96, 0.8, 0.66], shirt: [0.97, 0.97, 0.97], legs: [0.2, 0.2, 0.24], face: { eyes: 'sleepy', mouth: 'mustache', top: 'chef' } },
  },
  trail: {
    none:    { name: 'No Trail', cost: 0, level: 1 },
    sparks:  { name: 'Sparks',   cost: 600, level: 2, color: [1, 0.8, 0.25], glow: true, rise: 0.4, size: 0.1 },
    smoke:   { name: 'Smoke',    cost: 600, level: 3, color: [0.4, 0.4, 0.42], glow: false, rise: 0.8, size: 0.2 },
    snow:    { name: 'Snowfall', cost: 1050, level: 5, color: [0.92, 0.97, 1], glow: true, rise: -0.2, size: 0.1 },
    leaves:  { name: 'Leaf Litter', cost: 1050, level: 6, color: [0.3, 0.7, 0.25], glow: false, rise: 0.2, size: 0.12 },
    rainbow: { name: 'Rainbow',  cost: 2400, level: 9, color: null, glow: true, rise: 0.3, size: 0.12 },
  },
  kill: {
    none:     { name: 'Standard', cost: 0, level: 1 },
    confetti: { name: 'Confetti', cost: 750, level: 2 },
    lightning:{ name: 'Lightning', cost: 1350, level: 5 },
    ghost:    { name: 'Ghost Rise', cost: 1050, level: 4 },
    pixels:   { name: 'Pixel Pop', cost: 900, level: 3 },
  },
  banner: {
    solid:   { name: 'Solid',   cost: 0, level: 1, a: null, b: null, pattern: 'solid' },
    stripes: { name: 'Stripes', cost: 300, level: 1, a: [1, 1, 1], b: null, pattern: 'stripes' },
    cross:   { name: 'Cross',   cost: 450, level: 2, a: [1, 0.9, 0.3], b: null, pattern: 'cross' },
    diag:    { name: 'Diagonal', cost: 450, level: 3, a: [0.1, 0.1, 0.12], b: null, pattern: 'diag' },
    chevron: { name: 'Chevron', cost: 600, level: 4, a: [0.95, 0.95, 0.95], b: [0.9, 0.2, 0.2], pattern: 'chevron' },
    skull:   { name: 'Skull',   cost: 1200, level: 7, a: [0.95, 0.95, 0.95], b: [0.1, 0.1, 0.1], pattern: 'skull' },
  },
  emote: {
    gg:     { name: 'GG!',            text: 'GG!',            cost: 0, level: 1 },
    oops:   { name: 'Oops!',          text: 'Oops!',          cost: 0, level: 1 },
    boom:   { name: 'BOOM!',          text: 'BOOM!',          cost: 0, level: 1 },
    help:   { name: 'Help!',          text: 'Help!',          cost: 0, level: 1 },
    nice:   { name: 'Nice shot!',     text: 'Nice shot!',     cost: 300, level: 2 },
    fire:   { name: 'Fire in the hole!', text: 'Fire in the hole!', cost: 450, level: 3 },
    wave:   { name: 'o/',             text: 'o/',             cost: 300, level: 2 },
    rip:    { name: 'RIP',            text: 'RIP',            cost: 360, level: 4 },
    think:  { name: 'Hmm...',         text: 'Hmm...',         cost: 360, level: 3 },
    taunt:  { name: 'Come get me!',   text: 'Come get me!',   cost: 600, level: 5 },
  },
};
/**
 * Weapon skins: bought with coins (earned by playing), one tool at a time. Each collection has its own look AND its own
 * playstyle: a perk paired with a drawback, so no skin is simply "better". Admin skins only appear for admins (code LN1).
 * perk fields (all optional, per tool):
 *   dmg  melee damage x        speed  swing cooldown x (lower = faster)   mine  mining speed x     move  walk speed x while held
 *   kb   knockback x           chill  s of 40% slow on hit                burn  s of fire on hit   leech share of damage healed
 *   backstab  damage x from behind   draw  bow draw time x   arrow  arrow damage x   arrowSpeed  arrow speed x   grav  arrow drop x
 * pal = colours for the pixel art (hi/mid/lo blade, h1/h2 grip, gd guard, gem, fx particles, ol outline).
 */
const WEAPON_TOOLS = ['sword', 'axe', 'pickaxe', 'bow', 'staff'];
const WEAPON_SKINS = {
  default: { name: 'Standard', cost: 0, level: 1, tag: 'Purist: no gimmicks, +25% crit and headshot damage. Pure skill.', staffTag: 'Purist: no gimmicks, +25% crit damage. Pure skill.', pickTag: 'Plain steel. No perk, no drawback.', perk: {},
    pal: { hi: [240, 242, 250], mid: [196, 200, 212], lo: [128, 132, 148], h1: [134, 94, 56], h2: [96, 64, 38], gd: [150, 150, 162], ol: [34, 34, 42] } },
  frost: { name: 'Glacier', cost: 1200, level: 3, tag: 'Ice crystal. Hits freeze enemies in place.', staffTag: 'Freeze ray: hits slow enemies, pushes a little less.', pickTag: 'Cryo drill: tears through stone and ore, sluggish in dirt.',
    perk: { staff: { chill: 1.2, kb: 0.85 }, sword: { chill: 1.6, dmg: 0.9 }, axe: { chill: 2.2, dmg: 0.9 }, pickaxe: { mineHard: 1.35, mineSoft: 0.8 }, bow: { chill: 2, arrow: 0.9 } },
    pal: { hi: [240, 252, 255], mid: [150, 215, 250], lo: [70, 140, 210], h1: [210, 235, 250], h2: [120, 170, 210], gd: [180, 230, 255], gem: [255, 255, 255], fx: [0.7, 0.9, 1], ol: [18, 48, 92] } },
  inferno: { name: 'Inferno', cost: 1500, level: 5, tag: 'Living flame. Sets enemies on fire, but swings slower.', staffTag: 'Blowtorch: knocked-back enemies catch fire.', pickTag: 'Melts rock fast, but some blocks burn up and drop nothing.', fire: true,
    perk: { staff: { burn: 2, kb: 0.9 }, sword: { burn: 3, speed: 1.12 }, axe: { burn: 3.5, speed: 1.12 }, pickaxe: { mine: 1.25, scorch: 0.2 }, bow: { burn: 4, draw: 1.15 } },
    pal: { hi: [255, 236, 120], mid: [255, 140, 40], lo: [190, 40, 20], h1: [74, 42, 30], h2: [42, 22, 18], gd: [64, 40, 40], gem: [255, 220, 90], fx: [1, 0.55, 0.12], ol: [52, 10, 4] } },
  blood: { name: 'Bloodmoon', cost: 1800, level: 7, tag: 'Cursed crimson. Heals you on every hit, hits a bit softer.', staffTag: 'Leech rod: every bonk heals you as much as it hurts them.', pickTag: 'Every block you mine heals you a little.',
    perk: { staff: { leech: 1, kb: 0.9 }, sword: { leech: 0.25, dmg: 0.9 }, axe: { leech: 0.25, dmg: 0.92 }, pickaxe: { mineHeal: 2, mine: 0.9 }, bow: { leech: 0.25, arrow: 0.9 } },
    pal: { hi: [255, 120, 128], mid: [204, 32, 54], lo: [112, 10, 30], h1: [48, 36, 48], h2: [26, 20, 30], gd: [74, 62, 80], gem: [255, 60, 84], fx: [0.9, 0.08, 0.15], ol: [30, 0, 10] } },
  volt: { name: 'Voltage', cost: 1800, level: 8, tag: 'Neon lightning. Run faster with it out, hits lighter.', staffTag: 'Shock prod: +20% knockback, slightly slower swings.', pickTag: 'Zips through dirt, sand and wood, and you run faster.',
    perk: { staff: { kb: 1.2, speed: 1.12 }, sword: { move: 1.15, speed: 0.9, dmg: 0.85 }, axe: { move: 1.12, speed: 0.92, dmg: 0.88 }, pickaxe: { mineSoft: 1.4, move: 1.1, mineHard: 0.9 }, bow: { arrowSpeed: 1.4, draw: 0.9, arrow: 0.85 } },
    pal: { hi: [255, 255, 190], mid: [255, 230, 60], lo: [40, 190, 255], h1: [54, 54, 74], h2: [30, 30, 44], gd: [40, 200, 255], gem: [150, 255, 255], fx: [0.55, 1, 1], ol: [16, 16, 40] } },
  titan: { name: 'Titan', cost: 2500, level: 11, tag: 'Heavy bronze. Huge hits and knockback, but slow.', staffTag: 'Wrecking ball: launches enemies far, but heavy and slow.', pickTag: 'Breaks two blocks deep in one go, but each swing is slow.',
    perk: { staff: { kb: 1.6, speed: 1.25, move: 0.92 }, sword: { dmg: 1.15, kb: 1.7, speed: 1.15, move: 0.92 }, axe: { dmg: 1.2, kb: 1.8, speed: 1.2, move: 0.9 }, pickaxe: { deep: true, mine: 0.75 }, bow: { arrow: 1.25, kb: 2.2, draw: 1.3 } },
    pal: { hi: [200, 200, 210], mid: [146, 146, 156], lo: [92, 92, 102], h1: [156, 108, 52], h2: [112, 76, 36], gd: [226, 176, 62], gem: [255, 218, 86], fx: [1, 0.85, 0.35], ol: [30, 28, 30] } },
  phantom: { name: 'Phantom', cost: 3000, level: 14, tag: 'Spectral blade. Deadly from behind, weaker head-on.', staffTag: 'Uppercut: sends enemies flying UP instead of away.', pickTag: 'A thief\'s tool: much faster inside enemy land.',
    perk: { staff: { launch: 1.7, kb: 0.8 }, sword: { backstab: 1.6, dmg: 0.92 }, axe: { backstab: 1.5, dmg: 0.92 }, pickaxe: { raid: 1.5, mine: 0.9 }, bow: { grav: 0.35, arrow: 0.92 } },
    pal: { hi: [246, 236, 255], mid: [190, 160, 255], lo: [120, 80, 210], h1: [54, 42, 74], h2: [30, 24, 46], gd: [150, 120, 220], gem: [240, 220, 255], fx: [0.8, 0.65, 1], ol: [30, 14, 62] } },
  admin: { name: 'Admin', cost: 0, level: 1, admin: true, tag: 'Every perk at once. Admins only.', staffTag: 'Yeets everything. Admins only.', pickTag: 'Mines 3x faster, double drops, 2 deep.', rainbow: true,
    perk: { staff: { kb: 2, launch: 1.5, chill: 1.5, burn: 2 }, sword: { dmg: 1.5, speed: 0.7, chill: 1.5, burn: 3, leech: 0.3, kb: 1.5, move: 1.15 }, axe: { dmg: 1.5, speed: 0.7, chill: 1.5, burn: 3, leech: 0.3, kb: 1.5 },
      pickaxe: { mine: 3, double: true, mineHeal: 2, deep: true }, bow: { draw: 0.5, arrow: 1.5, arrowSpeed: 1.3, burn: 3, chill: 1.5 } },
    pal: { hi: [255, 190, 250], mid: [255, 70, 225], lo: [130, 0, 170], h1: [34, 34, 38], h2: [16, 16, 20], gd: [34, 34, 38], gem: [255, 255, 255], fx: [1, 0.45, 0.95], ol: [10, 0, 22] } },
};
const WEAPON_SKIN_ORDER = Object.keys(WEAPON_SKINS);
const OLD_WEAPON_SKINS = { iron: 'frost', gold: 'volt', diamond: 'phantom', ember: 'inferno' };     // skins bought before the redesign carry over
const weaponSkinId = (id) => (WEAPON_SKINS[id] ? id : OLD_WEAPON_SKINS[id] || null);
/** The perk a look's equipped skin gives `tool` ({} when none). */
function weaponBoost(look, tool) { const id = look && look.weapons && look.weapons[tool], sk = WEAPON_SKINS[id]; return (sk && sk.perk[tool]) || {}; }
/** Atlas tile for a tool drawn in a skin (the plain icon for the standard skin). */
function weaponTile(tool, skin) {
  const ti = WEAPON_TOOLS.indexOf(tool), si = WEAPON_SKIN_ORDER.indexOf(skin);
  return ti >= 0 && si > 0 ? 100 + ti * 8 + si : TILE['ICON_' + String(tool).toUpperCase()];
}
/** Perk list as [text, good] pairs, for the Locker. */
function perkLines(b) {
  const pct = (v) => Math.round(Math.abs(v - 1) * 100) + '%', out = [];
  const up = (v, good, bad) => out.push(v > 1 ? [good + ' +' + pct(v), true] : [bad + ' -' + pct(v), false]);
  if (b.chill) out.push(['Hits slow enemies for ' + b.chill + 's', true]);
  if (b.burn) out.push(['Hits set enemies on fire (' + b.burn + 's)', true]);
  if (b.leech) out.push(['Heal ' + Math.round(b.leech * 100) + '% of damage dealt', true]);
  if (b.backstab) out.push(['+' + pct(b.backstab) + ' damage from behind', true]);
  if (b.launch) out.push(['Launches enemies ' + pct(b.launch) + ' higher', true]);
  if (b.grav) out.push(['Arrows fly almost straight', true]);
  if (b.arrowSpeed) up(b.arrowSpeed, 'Arrow speed', 'Arrow speed');
  if (b.kb) up(b.kb, 'Knockback', 'Knockback');
  if (b.dmg) up(b.dmg, 'Damage', 'Damage');
  if (b.arrow) up(b.arrow, 'Arrow damage', 'Arrow damage');
  if (b.speed) out.push(b.speed < 1 ? ['Swing speed +' + pct(1 / b.speed), true] : ['Swing speed -' + pct(1 / b.speed), false]);
  if (b.draw) out.push(b.draw < 1 ? ['Draw speed +' + pct(1 / b.draw), true] : ['Draw speed -' + pct(1 / b.draw), false]);
  if (b.mine) up(b.mine, 'Mining speed', 'Mining speed');
  if (b.move) up(b.move, 'Move speed while held', 'Move speed while held');
  if (b.mineHard) up(b.mineHard, 'Mining stone and ore', 'Mining stone and ore');
  if (b.mineSoft) up(b.mineSoft, 'Mining dirt, sand and wood', 'Mining dirt, sand and wood');
  if (b.raid) out.push(['+' + pct(b.raid) + ' mining speed in enemy land', true]);
  if (b.deep) out.push(['Breaks the block behind too (2 deep)', true]);
  if (b.mineHeal) out.push(['Heal ' + b.mineHeal + ' HP per block mined', true]);
  if (b.double) out.push(['Double resources from mining', true]);
  if (b.scorch) out.push([Math.round(b.scorch * 100) + '% of mined blocks drop nothing', false]);
  return out.filter((l) => l[1]).concat(out.filter((l) => !l[1]));       // perks first, then drawbacks
}
const COSMETIC_SLOTS = ['skin', 'trail', 'kill', 'banner'];
/**
 * Armor sets (Locker > ARMOR). Like weapon skins, every set has a perk and a drawback.
 * perk: guard = damage taken x, move = walk speed x, swim = speed in water x, air = breath x, drown = drowning damage x,
 *       fireproof = fire/lava damage x, fall = fall damage x, regen = healing x, kbRes = knockback taken x,
 *       chillBack = melee attackers get slowed, stealth = name tag hidden from enemies beyond 10 blocks.
 * c1 / c2 / trim = colours of the plates.
 */
const ARMOR = {
  none:    { name: 'No Armor', cost: 0, level: 1, tag: 'Just your shirt. Light as a feather.', perk: {} },
  leather: { name: 'Leather', cost: 800, level: 1, tag: 'Cheap and light: a little protection.', perk: { guard: 0.93 }, c1: [0.55, 0.36, 0.2], c2: [0.42, 0.26, 0.14], trim: [0.72, 0.52, 0.3] },
  chain: { name: 'Chainmail', cost: 2000, level: 3, tag: 'Solid rings of steel, a bit heavy.', perk: { guard: 0.87, move: 0.97, critWeak: 1.1 }, c1: [0.62, 0.64, 0.68], c2: [0.45, 0.47, 0.5], trim: [0.82, 0.82, 0.86] },
  diver: { name: 'Diving Suit', cost: 2500, level: 4, tag: 'Hold your breath 3x longer and swim fast.', perk: { air: 3, swim: 1.5, guard: 1.05 }, c1: [0.86, 0.6, 0.24], c2: [0.24, 0.34, 0.46], trim: [0.96, 0.82, 0.4], visor: true },
  frost: { name: 'Glacier Plate', cost: 4000, level: 6, tag: 'Anyone who hits you in melee is frozen.', perk: { chillBack: 1.2, guard: 0.95, move: 0.97 }, c1: [0.62, 0.86, 1], c2: [0.3, 0.55, 0.86], trim: [0.97, 0.99, 1] },
  inferno: { name: 'Magma Mail', cost: 4000, level: 7, tag: 'Fire and lava barely hurt. Water is your enemy.', perk: { fireproof: 0.35, drown: 1.6 }, c1: [0.76, 0.2, 0.08], c2: [0.3, 0.08, 0.05], trim: [1, 0.62, 0.15] },
  blood: { name: 'Vampire Coat', cost: 4500, level: 8, tag: 'Heal twice as fast, but take more damage.', perk: { regen: 1.8, guard: 1.1 }, c1: [0.45, 0.04, 0.1], c2: [0.15, 0.03, 0.06], trim: [0.85, 0.15, 0.2] },
  volt: { name: 'Volt Suit', cost: 5000, level: 9, tag: 'Run faster. Slightly fragile.', perk: { move: 1.08, guard: 1.05 }, c1: [0.2, 0.2, 0.28], c2: [0.12, 0.12, 0.18], trim: [1, 0.9, 0.2] },
  phantom: { name: 'Shadow Cloak', cost: 7000, level: 12, tag: 'Hidden name tag at range and soft landings.', perk: { stealth: true, fall: 0.4 }, c1: [0.22, 0.16, 0.34], c2: [0.12, 0.08, 0.2], trim: [0.7, 0.55, 1] },
  titan: { name: 'Titan Plate', cost: 8000, level: 14, tag: 'Huge protection and barely any knockback. Slow.', perk: { guard: 0.75, kbRes: 0.55, move: 0.88, critWeak: 1.3 }, c1: [0.58, 0.56, 0.52], c2: [0.38, 0.36, 0.34], trim: [0.95, 0.75, 0.25] },
  admin:   { name: 'Admin Aegis', cost: 0, level: 1, admin: true, tag: 'Everything at once. Admins only.', perk: { guard: 0.3, kbRes: 0.2, fireproof: 0.2, air: 5, regen: 2.5, swim: 1.5 }, c1: [0.95, 0.25, 0.85], c2: [0.4, 0.05, 0.5], trim: [1, 1, 1] },
};
const ARMOR_ORDER = Object.keys(ARMOR);
const armorTile = (id) => 140 + Math.max(0, ARMOR_ORDER.indexOf(id));
const armorPerk = (look) => (look && ARMOR[look.armor] ? ARMOR[look.armor].perk : {});
function armorPerkLines(b) {
  const pct = (v) => Math.round(Math.abs(v - 1) * 100) + '%', out = [];
  if (b.guard) out.push(b.guard < 1 ? ['Damage taken -' + pct(b.guard), true] : ['Damage taken +' + pct(b.guard), false]);
  if (b.kbRes) out.push(['Knockback taken -' + pct(b.kbRes), true]);
  if (b.fireproof) out.push(['Fire and lava damage -' + pct(b.fireproof), true]);
  if (b.air) out.push(['Breath lasts ' + b.air + 'x longer', true]);
  if (b.swim) out.push(['Swim speed +' + pct(b.swim), true]);
  if (b.regen) out.push(['Healing +' + pct(b.regen), true]);
  if (b.chillBack) out.push(['Melee attackers are slowed', true]);
  if (b.stealth) out.push(['Name tag hidden from far enemies', true]);
  if (b.fall) out.push(['Fall damage -' + pct(b.fall), true]);
  if (b.move) out.push(b.move > 1 ? ['Move speed +' + pct(b.move), true] : ['Move speed -' + pct(b.move), false]);
  if (b.drown) out.push(['Drown ' + pct(b.drown) + ' faster', false]);
  if (b.critWeak) out.push(['Crits hurt ' + pct(b.critWeak) + ' more', false]);
  return out.filter((l) => l[1]).concat(out.filter((l) => !l[1]));
}
/** Admin panel: opened by typing this as a join code. Anyone who reads game.js can see it, so it is a fun extra, not security. */
const GAME_VERSION = '2.7 (Oct 18)';   // shown on the main menu so players can tell an old cached copy apart
const ADMIN_CODE = 'LN1';
const ADMIN_DEFAULTS = { speed: 1, jump: 1, damage: 1, mine: 1, health: 100, regen: 1, draw: 1, god: false, infinite: false };
const ADMIN_SLIDERS = [                                         // [key, label, min, max, step, format]
  ['speed', 'Move speed', 0.5, 4, 0.1, (v) => v.toFixed(1) + 'x'], ['jump', 'Jump height', 0.5, 3, 0.1, (v) => v.toFixed(1) + 'x'],
  ['damage', 'Melee & arrow damage', 0.5, 10, 0.5, (v) => v.toFixed(1) + 'x'], ['mine', 'Mining speed', 0.5, 20, 0.5, (v) => v.toFixed(1) + 'x'],
  ['health', 'Max health', 50, 1000, 10, (v) => Math.round(v) + ' HP'], ['regen', 'Regeneration', 0.5, 20, 0.5, (v) => v.toFixed(1) + 'x'],
  ['draw', 'Bow draw speed', 0.5, 5, 0.1, (v) => v.toFixed(1) + 'x'],
];
const DEFAULT_EMOTES = ['gg', 'oops', 'boom', 'help'];
const BANNER_COLORS = [[1, 0.35, 0.2], [0.25, 0.65, 1], [0.45, 0.88, 0.35], [1, 0.82, 0.25], [0.78, 0.5, 1], [1, 0.55, 0.7], [0.95, 0.95, 0.95], [0.15, 0.15, 0.18]];

/** Titles unlock from play, never from coins. `ok(career)` decides. */
const TITLES = {
  rookie:   { name: 'Rookie',            desc: 'Play your first match.', ok: () => true },
  veteran:  { name: 'Veteran',           desc: 'Play 10 matches.', ok: (c) => c.matches >= 10 },
  winner:   { name: 'Champion',          desc: 'Win a match.', ok: (c) => c.wins >= 1 },
  dominator:{ name: 'Dominator',         desc: 'Win 5 matches.', ok: (c) => c.wins >= 5 },
  hunter:   { name: 'Hunter',            desc: 'Get 25 kills.', ok: (c) => c.kills >= 25 },
  demo:     { name: 'Demolition Expert', desc: 'Get 10 TNT eliminations.', ok: (c) => (c.tntKills || 0) >= 10 },
  wrecker:  { name: 'Wrecking Ball',     desc: 'Destroy 25 structures.', ok: (c) => (c.structures || 0) >= 25 },
  digger:   { name: 'Terraformer',       desc: 'Destroy 5,000 blocks.', ok: (c) => c.blocks >= 5000 },
  rich:     { name: 'Tycoon',            desc: 'Earn 5,000 coins in total.', ok: (c) => (c.totalCoins || 0) >= 5000 },
  lvl10:    { name: 'Block Lord',        desc: 'Reach level 10.', ok: (c) => levelFor(c.xp).level >= 10 },
};
const TITLE_ORDER = Object.keys(TITLES);

const DEFAULT_WEAPONS = () => ({ sword: 'default', axe: 'default', pickaxe: 'default', bow: 'default', staff: 'default' });
const DEFAULT_PROFILE = () => ({ owned: { skin: ['default'], trail: ['none'], kill: ['none'], banner: ['solid'], emote: DEFAULT_EMOTES.slice(), weapon: [], armor: ['none'] }, equipped: { skin: 'default', trail: 'none', kill: 'none', banner: 'solid', title: 'rookie', emotes: DEFAULT_EMOTES.slice(), bannerColor: 0, weapons: DEFAULT_WEAPONS(), armor: 'none' } });
const fixWeaponKey = (k) => { const [t, sk] = String(k).split(':'), id = weaponSkinId(sk); return WEAPON_TOOLS.includes(t) && id && id !== 'default' ? t + ':' + id : null; };

/** Validates (and repairs) a profile loaded from storage or received over the network. */
function sanitizeProfile(pr) {
  const d = DEFAULT_PROFILE();
  if (!pr || typeof pr !== 'object') return d;
  for (const slot of [...COSMETIC_SLOTS, 'emote']) {
    const have = pr.owned && Array.isArray(pr.owned[slot]) ? pr.owned[slot].filter((id) => COSMETICS[slot][id]) : [];
    d.owned[slot] = Array.from(new Set([...d.owned[slot], ...have]));
  }
  const eq = pr.equipped || {};
  for (const slot of COSMETIC_SLOTS) if (COSMETICS[slot][eq[slot]] && d.owned[slot].includes(eq[slot])) d.equipped[slot] = eq[slot];
  if (TITLES[eq.title]) d.equipped.title = eq.title;
  if (Array.isArray(eq.emotes)) d.equipped.emotes = [0, 1, 2, 3].map((i) => (COSMETICS.emote[eq.emotes[i]] && d.owned.emote.includes(eq.emotes[i]) ? eq.emotes[i] : DEFAULT_EMOTES[i]));
  d.equipped.bannerColor = clamp(eq.bannerColor | 0, 0, BANNER_COLORS.length - 1);
  d.owned.weapon = pr.owned && Array.isArray(pr.owned.weapon) ? Array.from(new Set(pr.owned.weapon.map(fixWeaponKey).filter(Boolean))) : [];
  d.owned.armor = Array.from(new Set(['none', ...(pr.owned && Array.isArray(pr.owned.armor) ? pr.owned.armor.filter((a) => ARMOR[a] && !ARMOR[a].admin) : [])]));
  if (ARMOR[eq.armor] && (d.owned.armor.includes(eq.armor) || ARMOR[eq.armor].admin)) d.equipped.armor = eq.armor;
  for (const t of WEAPON_TOOLS) { const id = weaponSkinId(eq.weapons && eq.weapons[t]); if (WEAPON_SKINS[id] && (id === 'default' || d.owned.weapon.includes(t + ':' + id))) d.equipped.weapons[t] = id; }
  return d;
}
/** The small public part of a profile that other players see. */
function publicLook(profile) {
  const e = profile.equipped;
  return { skin: e.skin, trail: e.trail, kill: e.kill, banner: e.banner, bannerColor: e.bannerColor, title: e.title, emotes: e.emotes.slice(), weapons: Object.assign(DEFAULT_WEAPONS(), e.weapons), armor: ARMOR[e.armor] ? e.armor : 'none' };
}
function sanitizeLook(l) {
  const d = DEFAULT_PROFILE().equipped;
  if (!l || typeof l !== 'object') return publicLook({ equipped: d });
  const out = { skin: COSMETICS.skin[l.skin] ? l.skin : d.skin, trail: COSMETICS.trail[l.trail] ? l.trail : d.trail, kill: COSMETICS.kill[l.kill] ? l.kill : d.kill, banner: COSMETICS.banner[l.banner] ? l.banner : d.banner, bannerColor: clamp(l.bannerColor | 0, 0, BANNER_COLORS.length - 1), title: TITLES[l.title] ? l.title : d.title };
  out.emotes = [0, 1, 2, 3].map((i) => (l.emotes && COSMETICS.emote[l.emotes[i]] ? l.emotes[i] : DEFAULT_EMOTES[i]));
  out.weapons = DEFAULT_WEAPONS();
  out.armor = ARMOR[l.armor] ? l.armor : 'none';
  for (const t of WEAPON_TOOLS) { const id = l.weapons && weaponSkinId(l.weapons[t]); if (id) out.weapons[t] = id; }
  return out;
}
/** Random cosmetics for bots, so the lobby looks lively and every match looks different. */
function randomLook(rng = Math.random) {
  const pick = (slot) => { const ids = Object.keys(COSMETICS[slot]).filter((id) => !COSMETICS[slot][id].admin); return ids[Math.floor(rng() * ids.length)]; };
  const weapons = {}; for (const t of WEAPON_TOOLS) weapons[t] = rng() < 0.5 ? 'default' : ['frost', 'inferno', 'blood', 'volt', 'titan', 'phantom'][Math.floor(rng() * 6)];
  const funny = Object.keys(COSMETICS.skin).filter((id) => COSMETICS.skin[id].funny);
  const armors = ARMOR_ORDER.filter((a) => !ARMOR[a].admin && a !== 'none');
  return sanitizeLook({ armor: rng() < 0.6 ? armors[Math.floor(rng() * armors.length)] : 'none', weapons, skin: rng() < 0.8 ? funny[Math.floor(rng() * funny.length)] : rng() < 0.5 ? 'default' : pick('skin'), trail: rng() < 0.6 ? 'none' : pick('trail'), kill: pick('kill'), banner: pick('banner'), bannerColor: Math.floor(rng() * BANNER_COLORS.length), title: TITLE_ORDER[Math.floor(rng() * 4)], emotes: DEFAULT_EMOTES });
}

/* =========================== 11. GAME SERVER ============================ */
/**
 * Authoritative game state. In this prototype it lives in the page; for multiplayer the same class runs on a
 * Node server and `handle()` is fed by sockets. Clients only ever *ask*; the server decides.
 * It simulates every player/bot/entity at a fixed step through update(dt).
 */
const PVP_PHASES = new Set(['war', 'chaos', 'sandbox']);
/** Clears the divider cells. Used by the host's server and by every joined client (the generator is deterministic, so they hold the same list). */
function removePlotWalls(world, cells, server) {
  if (server) { server.suppressSupport = true; server.removingWalls = true; }
  for (let i = 0; i < cells.length; i += 3) if (world.get(cells[i], cells[i + 1], cells[i + 2]) === ID.plotwall) world.set(cells[i], cells[i + 1], cells[i + 2], AIR);
  if (server) { server.suppressSupport = false; server.removingWalls = false; }
}
/** Flood / lava-rise layers: fill every empty cell of one layer with still liquid, or drain it again. */
function fillFluidLayer(world, y, id, meta) { for (let z = 0; z < world.sizeZ; z++) for (let x = 0; x < world.sizeX; x++) if (world.get(x, y, z) === AIR) world.set(x, y, z, id, false, meta); }
function drainFluidLayer(world, y, id) { for (let z = 0; z < world.sizeZ; z++) for (let x = 0; x < world.sizeX; x++) if (world.get(x, y, z) === id && (world.getMeta(x, y, z) & 32)) world.set(x, y, z, AIR); }
const IFRAME_KINDS = new Set(['melee', 'arrow', 'trap']);
const DEADLY_WATER = 32 | 64;
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
    name: 'CREEPER & ZOMBIE ATTACK', duration: 26,
    start(s, ev) { ev.data.waves = 2; ev.data.next = 0; },
    tick(s, ev, dt) {
      ev.data.next -= dt;
      if (ev.data.waves > 0 && ev.data.next <= 0) { ev.data.waves--; ev.data.next = 9; for (let i = 0; i < 4; i++) s.spawnMobAtEdge(i < 2 ? 'creeper' : 'zombie'); }
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

/** Deterministic land assignment shared by the server, the lobby and joining clients. */
function assignLandList(seed) {
  const rng = mulberry32(seed * 2654435761 >>> 0), a = LAND_ORDER.slice();
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

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
    this.machines = new MachineSystem(this);
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
    this.vault = { progress: 0, team: -1, cooldown: 0, capturing: false, captured: 0, stage: 0, stageT: 0 }; this.drops = [];
    this.drops = []; this.dropClock = CONFIG.MATCH.DROP_FIRST;
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
    if (!player.look) player.look = sanitizeLook(null);
    this.players[player.index] = player;
    this.playerMap.set(player.id, player);
    return player;
  }
  playerBySlot(i) { return this.players[i] || null; }
  playerById(id) { return this.playerMap.get(id) || null; }
  /** The local player: the first human who is not a remote connection (the host, or the only player). */
  get human() { return this.players.find((p) => !p.isBot && !p.isRemote) || this.players.find((p) => !p.isBot) || null; }
  areAllies(a, b) { return !!a && !!b && a !== b && a.team === b.team; }

  /**
   * Builds a new match. cfg: { mode:'war'|'alliance'|'sandbox', name, classId, botCount, seed, lands:[6], botClasses }
   * Returns the generated map info.
   */
  startMatch(cfg = {}) {
    this.resetState();
    const mode = cfg.mode || 'war';
    // The roster is the full list of competitors (humans and bots). A plain {name, classId, botCount} config builds one.
    let roster = cfg.roster;
    if (!roster) {
      const botCount = clamp(cfg.botCount == null ? 3 : cfg.botCount, 0, 5);
      roster = [{ id: 'p0', name: cfg.name || 'PLAYER', classId: cfg.classId || 'builder', isBot: false, look: cfg.look }];
      for (let i = 0; i < botCount; i++) roster.push({ isBot: true, classId: cfg.botClasses && cfg.botClasses[i], name: null });
    }
    roster = roster.slice(0, 6);
    const n = roster.length;
    this.difficulty = DIFFICULTIES[cfg.difficulty] ? cfg.difficulty : 'normal';
    this.mode = mode; this.unlimited = mode === 'sandbox'; this.allianceMode = mode === 'alliance';
    const seed = cfg.seed != null ? cfg.seed : 1;
    const rng = mulberry32(seed * 7919 + 13);
    const lands = cfg.lands || this.assignLands(seed);
    this.lands = lands;
    this.suspendTracking = true;                                   // do not run per-block systems while generating
    const mapId = cfg.mapId === 'random' ? MAP_ORDER[Math.floor(rng() * MAP_ORDER.length)] : (MAPS[cfg.mapId] ? cfg.mapId : 'plains');
    this.mapId = mapId;
    this.map = MapGenerator.generate(this.world, { seed: cfg.seed != null ? cfg.seed : 1337, mapId, lands, owners: [0, 1, 2, 3, 4, 5].map((i) => (i < n ? i : -1)), walls: cfg.mode !== 'sandbox', cores: cfg.mode !== 'sandbox' });
    this.suspendTracking = false;
    this.wallCells = this.map.wallCells || []; this.wallsDropped = false;
    this.plots = this.map.plots;
    this.fluids.pending.clear(); this.fire.fires.clear(); this.redstone.mechs.clear(); this.machines.clear(); this.gravity.pending.clear();
    this.scanWorldForSystems();

    const botNames = BOT_NAMES.slice().sort(() => rng() - 0.5).filter((nm) => !roster.some((r) => r.name === nm));
    // bot classes: shuffled without repeats for as long as possible, so every match is a different mix
    let classPool = [];
    const nextClass = () => { if (!classPool.length) classPool = CLASS_ORDER.slice().sort(() => rng() - 0.5); return classPool.pop(); };
    let botIdx = 0;
    for (let i = 0; i < n; i++) {
      const r = roster[i], isBot = !!r.isBot;
      const p = new Player(r.id || (isBot ? 'b' + i : 'p' + i), r.name || botNames[botIdx++ % botNames.length] || 'BOT' + i);
      this.addPlayer(p);
      p.isBot = isBot; p.isRemote = !isBot && i > 0; p.inQueue = p.isRemote ? [] : null;
      p.classId = CLASSES[r.classId] ? r.classId : (isBot ? nextClass() : 'builder');
      p.look = isBot ? sanitizeLook(r.look || randomLook(rng)) : sanitizeLook(r.look);
      p.landId = lands[i];
      p.team = this.nextTeam++;
      this.applyClass(p);
      const plot = this.plots[i];
      p.spawn = { x: plot.spawn.x, y: plot.spawn.y, z: plot.spawn.z };
      p.resources = startResources(p.classId, p.landId, this.unlimited);
      this.respawn(p, true);
      p.yaw = Math.atan2(-(this.map.center.x - p.spawn.x), -(this.map.center.z - p.spawn.z));
      p.pitch = -0.1;
      if (isBot) p.bot = new Bot(this, p, rng);
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
  assignLands(seed) { return assignLandList(seed); }
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
      if (d.machine) this.machines.register(keyOf(x, y, z));
      if (id === ID.fire) this.fire.fires.add(keyOf(x, y, z));
    }
  }
  respawn(p, initial = false) {
    p.teleport(p.spawn.x, p.spawn.y, p.spawn.z);
    p.health = p.maxHealth; p.alive = true; p.burnTime = 0; p.chillT = 0; p.streak = 0; p.buffs = {}; p.air = null; p.waterCause = null;
    if (!this.unlimited && p.resources) p.resources.arrow = Math.max(p.resources.arrow || 0, QUIVER.REFILL_TO); p.sinceDamage = 99;
    p.invulnerable = initial ? 0 : 2.5; p.hurtT = 0; p.lastDmg = 0; p.blocking = false; p.blockCd = 0; p.respawnTimer = 0; p.lastHits.length = 0; p.lastCause = null;
    if (!initial) this.emit({ type: 'respawn', player: p });
  }

  /* ----------------------------- rules ----------------------------- */
  pvpEnabled() { return PVP_PHASES.has(this.phase); }
  plotOf(p) { return this.plots[p.index]; }
  nearestPlot(x, z) { let bi = 0, bd = 1e9; for (let i = 0; i < this.plots.length; i++) { const d = (x + 0.5 - this.plots[i].x) ** 2 + (z + 0.5 - this.plots[i].z) ** 2; if (d < bd) { bd = d; bi = i; } } return bi; }
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
      case 'emote': return this.emote(p, msg);
      case 'hold': if (ITEMS[msg.item]) p.held = msg.item; return { ok: true };
      case 'block': return this.setBlock(p, !!msg.on);
      case 'swing': return this.swingAir(p, msg);
      case 'scoop': return this.scoop(p, msg);
      default: return { ok: false, reason: 'unknown-action' };
    }
  }
  /**
   * Lava poured into water: the water around the splash hardens into stone (something to stand on) and the rest of
   * that body of water boils away. A flood is too big to boil: only a patch around the splash dries up.
   */
  neutralizeWater(p, x, y, z) {
    const w = this.world, LIMIT = 900, seen = new Set(), list = [], q = [];
    const push = (a, b, c) => { const k = keyOf(a, b, c); if (seen.has(k) || !w.inBounds(a, b, c) || w.get(a, b, c) !== ID.water) return; seen.add(k); q.push([a, b, c]); };
    push(x, y, z); for (const d of DIRS6) push(x + d[0], y + d[1], z + d[2]);
    let flood = false;
    while (q.length) {
      const c = q.pop(); list.push(c);
      if (w.getMeta(c[0], c[1], c[2]) & 32) flood = true;
      if (list.length >= LIMIT) { flood = true; break; }
      for (const d of DIRS6) push(c[0] + d[0], c[1] + d[1], c[2] + d[2]);
    }
    const R = flood ? 5 : Infinity;
    let stone = 0, dried = 0;
    this.cause = p.index;
    if (w.get(x, y, z) === ID.water || w.get(x, y, z) === AIR) { w.set(x, y, z, ID.stone, false, 0, 0); stone++; }
    for (const [a, b, c] of list) {
      const dist = Math.hypot(a - x, b - y, c - z);
      if (dist > R || w.get(a, b, c) !== ID.water) continue;
      if (dist <= 1.5 || (dist <= 2.6 && b <= y)) { w.set(a, b, c, ID.stone, false, 0, 0); stone++; }       // a crust to stand on
      else { w.set(a, b, c, AIR); dried++; }
    }
    this.cause = null;
    for (const b of this.players) if (b.alive && Math.hypot(b.pos.x - x - 0.5, b.pos.z - z - 0.5) < R + 1) b.waterCause = null;
    this.emit({ type: 'neutralize', by: p.id, x, y, z, stone, dried, flood });
    return { ok: true, neutralized: true, flood };
  }
  /** Bucket: scoop one cell of water or lava (even flood water) into your supplies. */
  scoop(p, { x, y, z }) {
    const w = this.world;
    if (![x, y, z].every(Number.isInteger) || !w.inBounds(x, y, z)) return { ok: false, reason: 'out-of-bounds' };
    const id = w.get(x, y, z), kind = id === ID.water ? 'water' : id === ID.lava ? 'lava' : null;
    if (!kind) return { ok: false, reason: 'no-fluid' };
    if (p.cooldowns.place > 0) return { ok: false, reason: 'cooldown' };
    if (!this.withinReach(p, x, y, z, 1.5)) return { ok: false, reason: 'too-far' };
    if (!this.unlimited && (p.resources[kind] || 0) >= resourceCap(kind, p.mods)) return { ok: false, reason: 'bucket-full' };
    w.set(x, y, z, AIR);
    this.addResource(p, kind, 1); p.bucketFluid = kind; p.cooldowns.place = 0.3;
    if (p.swing <= 0.2) { p.swing = 1; p.swingKind = 'pickaxe'; }
    this.emit({ type: 'scoop', by: p.id, x, y, z, fluid: kind });
    return { ok: true, fluid: kind };
  }
  /** A swing that hits nothing (air, or a mining stroke). Weapons still pay their cooldown on an air swing, like Minecraft. */
  swingAir(p, { tool, mining }) {
    const T = TOOLS[tool];
    if (!mining && T && T.cd && T.dmg != null) {
      const full = T.cd * p.mods.attackCooldown * (weaponBoost(p.look, tool).speed || 1);
      if (p.cooldowns.attack > 0.05) return { ok: false, reason: 'cooldown' };
      p.cooldowns.attack = full;
    }
    if (p.swing <= 0.15) { p.swing = 1; p.swingKind = TOOLS[tool] ? tool : 'pickaxe'; }
    return { ok: true };
  }
  /** Equipped emotes appear as a speech bubble and a feed line. Rate limited. */
  emote(p, { slot }) {
    if (this.clock - (p.lastEmote == null ? -9 : p.lastEmote) < 1.5) return { ok: false, reason: 'cooldown' };
    const id = p.look.emotes[clamp(slot | 0, 0, 3)], def = COSMETICS.emote[id];
    if (!def) return { ok: false, reason: 'unknown' };
    p.lastEmote = this.clock;
    this.emit({ type: 'emote', player: p, text: def.text });
    return { ok: true };
  }
  withinReach(p, x, y, z, extra = 1.0) {
    const e = p.eyePosition();
    return Math.hypot(x + 0.5 - e.x, y + 0.5 - e.y, z + 0.5 - e.z) <= CONFIG.PLAYER.REACH + extra;
  }

  breakBlock(p, { x, y, z }) {
    const w = this.world;
    if (p.isRemote) { if (this.clock - (p.lastBreak == null ? -9 : p.lastBreak) < 0.06) return { ok: false, reason: 'cooldown' }; p.lastBreak = this.clock; }
    if (!w.inBounds(x, y, z)) return { ok: false, reason: 'out-of-bounds' };
    const id = w.get(x, y, z);
    if (id === AIR) return { ok: false, reason: 'empty' };
    const def = BLOCKS[id];
    if (!def.breakable) return { ok: false, reason: 'unbreakable' };
    if (id === ID.core) { const o = this.players[w.getOwner(x, y, z) - 1]; if (o && (o === p || this.areAllies(o, p))) return { ok: false, reason: 'own-core' }; if (this.coreShielded()) return { ok: false, reason: 'core-shielded' }; }
    if (!this.withinReach(p, x, y, z)) return { ok: false, reason: 'too-far' };
    if (!this.canModify(p, x, y, z)) return { ok: false, reason: 'not-allowed' };
    this.cause = p.index;
    w.set(x, y, z, AIR);
    this.cause = null;
    const pk = p.held === 'pickaxe' ? weaponBoost(p.look, 'pickaxe') : {};
    if (!(pk.scorch && Math.random() < pk.scorch)) this.dropFor(p, def);
    if (pk.double) this.dropFor(p, def);
    if (pk.mineHeal && p.alive) p.health = Math.min(p.maxHealth, p.health + pk.mineHeal);
    p.stats.blocksDestroyed++; p.stats.score += 1;
    if (p.swing <= 0.2) { p.swing = 1; p.swingKind = 'pickaxe'; }
    this.emit({ type: 'blockBroken', x, y, z, block: def, by: p.id });
    if (pk.deep) {                                                       // Titan pickaxe: also breaks the block behind (along the dominant look axis)
      const d = p.lookDirection(), ax = Math.abs(d.x), ay = Math.abs(d.y), az = Math.abs(d.z);
      const bx = x + (ax >= ay && ax >= az ? Math.sign(d.x) : 0), by = y + (ay > ax && ay >= az ? Math.sign(d.y) : 0), bz = z + (az > ax && az > ay ? Math.sign(d.z) : 0);
      const id2 = w.inBounds(bx, by, bz) ? w.get(bx, by, bz) : AIR, d2 = BLOCKS[id2];
      if (id2 !== AIR && d2.breakable && id2 !== ID.core && d2.shape !== 'fluid' && this.canModify(p, bx, by, bz)) {
        this.cause = p.index; w.set(bx, by, bz, AIR); this.cause = null;
        this.dropFor(p, d2); p.stats.blocksDestroyed++;
        this.emit({ type: 'blockBroken', x: bx, y: by, z: bz, block: d2, by: p.id });
      }
    }
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
    if (this.mode !== 'sandbox' && this.inVaultZone(x, y, z)) return { ok: false, reason: 'vault-zone' };
    if (def.id === ID.lava && (w.get(x, y, z) === ID.water || DIRS6.some((d) => w.get(x + d[0], y + d[1], z + d[2]) === ID.water))) {   // lava into water: neutralize it
      if (!this.hasResource(p, 'lava', 1)) return { ok: false, reason: 'no-resource' };
      this.spend(p, 'lava', 1);
      p.cooldowns.place = CONFIG.MINE.PLACE_COOLDOWN * p.mods.placeCooldown;
      return this.neutralizeWater(p, x, y, z);
    }
    if (def.solid && p.submerged && p.inWater && p.deadlyWater && this.mode !== 'sandbox') return { ok: false, reason: 'underwater' };   // you cannot build your way out of deep water
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
    } else if (def.id === ID.conveyor) {                                // conveyors run the way you look
      const l = p.lookDirection(); meta = Math.abs(l.x) > Math.abs(l.z) ? (l.x > 0 ? 0 : 1) : (l.z > 0 ? 2 : 3);
    } else if (def.id === ID.door && against) {                      // doors copy the look of the block they are built against
      const ad = w.def(against.x, against.y, against.z);
      if (ad.shape === 'cube' && ad.opaque && ad.id !== ID.door) meta = ad.id << 8;
    } else if (def.shape === 'fluid') meta = def.id === ID.water ? 16 | CONFIG.WATER.POUR_LEVEL | 64 : 16 | def.fluid.maxLevel;   // a bucket makes a small pool, not a sea
    this.spend(p, it.res, cost);
    this.cause = p.index;
    w.set(x, y, z, def.id, false, meta, p.index + 1);
    this.cause = null;
    if (lift) { p.pos.y = y + 1; p.prev.y = p.pos.y; p.vel.y = Math.max(p.vel.y, 0); }
    if (def.id === ID.water) for (const b of this.players) if (b !== p && b.alive && !this.areAllies(b, p) && Math.hypot(b.pos.x - x - 0.5, b.pos.z - z - 0.5) < 4 && Math.abs(b.pos.y - y) < 4) b.waterCause = p.index;   // drowning credits the pourer
    p.cooldowns.place = CONFIG.MINE.PLACE_COOLDOWN * p.mods.placeCooldown * (it.kind === 'mech' ? 0.8 : 1);
    p.stats.blocksPlaced = (p.stats.blocksPlaced || 0) + 1;
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
    if (w.get(x, y, z) === ID.tnt) { this.primeTnt(x, y, z, 4, p.index, 'tnt'); return { ok: true, tnt: true }; }
    if (w.get(x + nx, y + ny, z + nz) === AIR && (nx || ny || nz) && this.fire.ignite(x + nx, y + ny, z + nz, p.index)) { this.emit({ type: 'ignite', x: x + nx, y: y + ny, z: z + nz }); return { ok: true }; }
    return { ok: false, reason: 'nothing' };
  }

  /**
   * Minecraft-style melee. Damage scales with the attack charge (swinging early is weak), falling hits are critical (x1.5),
   * knockback halves the victim's own momentum and shoves along the attacker's facing; hitting while sprinting adds a big extra knock.
   */
  /** Hold right-click with a melee weapon to block: front hits do 65% less damage and little knockback. Limited to 2.5s, then a cooldown. */
  setBlock(p, on) {
    if (!on) { if (p.blocking) { p.blocking = false; p.blockCd = Math.max(p.blockCd, 0.35); } return { ok: true }; }
    const it = ITEMS[p.held];
    if (!p.alive || p.blocking || p.blockCd > 0 || !it || it.kind !== 'tool' || p.held === 'bow' || p.held === 'lighter') return { ok: false, reason: 'cooldown' };
    p.blocking = true; p.blockT = 0; p.blockStart = this.clock;
    return { ok: true };
  }
  attack(p, { targetId, tool = 'sword' }) {
    const t = TOOLS[tool];
    if (!t || t.dmg == null) return { ok: false, reason: 'bad-tool' };
    const wb = weaponBoost(p.look, tool), full = t.cd * p.mods.attackCooldown * (wb.speed || 1);
    if (p.cooldowns.attack > 0.05) return { ok: false, reason: 'cooldown' };          // no spam: a weapon swings only once it has fully recovered
    const target = this.playerMap.get(targetId) || this.mobs.find((m) => m.id === targetId);
    if (!target || !target.alive || target === p) return { ok: false, reason: 'no-target' };
    const e = p.eyePosition(), c = target.center();
    if (Math.hypot(c.x - e.x, c.y - e.y, c.z - e.z) > t.reach + 0.9) return { ok: false, reason: 'too-far' };
    if (this.world.lineBlocked(e.x, e.y, e.z, c.x, c.y, c.z)) return { ok: false, reason: 'blocked' };
    const frac = clamp(1 - p.cooldowns.attack / full, 0, 1);
    p.cooldowns.attack = full;
    p.swing = 1; p.swingKind = tool; p.held = tool;
    if (p.blocking) { p.blocking = false; p.blockCd = 0.3; }
    const strong = frac > 0.9, sprint = !!(p.controls && p.controls.sprint && p.controls.forward && !p.inWater);
    let dmg = t.dmg * p.mods.meleeDamage * (wb.dmg || 1) * (0.2 + 0.8 * frac * frac) * (p.bot && !p.proxy ? this.diff().botMelee : 1);
    if (wb.backstab && target.yaw != null) {                            // Phantom: the victim is facing away from the attacker
      const ax = p.pos.x - target.pos.x, az = p.pos.z - target.pos.z, l = Math.hypot(ax, az) || 1;
      if ((ax * -Math.sin(target.yaw) + az * -Math.cos(target.yaw)) / l < -0.3) dmg *= wb.backstab;
    }
    // crits: always on a falling (jump) hit, sometimes on any full-strength sword/axe hit. The axe hits hardest but swings slowest.
    const crit = strong && !p.onGround && p.vel.y < -0.5 && !sprint && !p.inWater && !p.inLava;   // Minecraft rule: jump-hits only
    const purist = !p.look || !p.look.weapons || (p.look.weapons[tool] || 'default') === 'default';
    if (crit) dmg *= (t.crit || 1.5) * (purist ? CONFIG.COMBAT.PURIST : 1);   // the free Standard skin rewards skill: bigger crits
    if (p.buffs && p.buffs.rage > 0) dmg *= 1.3;
    target.lastBlocked = false;
    const dealt = this.damage(target, dmg, { kind: 'melee', by: p.index, direct: true, pierce: !!crit });
    if (dealt !== null) {
      const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw);
      const tap = armorPerk(target.look), kb = (t.kb * (0.4 + 0.6 * frac) * (wb.kb || 1) + (sprint && strong ? 4 : 0)) * (target.lastBlocked ? 0.4 : 1) * (tap.kbRes || 1);
      if (tap.chillBack && dealt > 0) { p.chillT = Math.max(p.chillT || 0, tap.chillBack); }
      target.vel.x = target.vel.x * 0.5 + fx * kb; target.vel.z = target.vel.z * 0.5 + fz * kb;
      target.vel.y = (Math.min(target.vel.y * 0.5 + 6, 6) + (sprint && strong ? 1.5 : 0)) * (wb.launch || 1);
      target.onGround = false;
      const perkFx = target.lastBlocked ? null : this.weaponPerks(p, target, wb, dealt, frac);
      this.emit({ type: 'hit', target, by: p.id, tool, crit, sprint: sprint && strong, blocked: !!target.lastBlocked, charge: frac, skin: p.look && p.look.weapons ? p.look.weapons[tool] : null, fx: perkFx });
      if (crit) this.emit({ type: 'crit', target });
    }
    return { ok: true };
  }

  /** On-hit skin perks (chill, burn, lifesteal). `frac` = attack charge, so spam-clicking does not freeze or ignite. Returns the effects for the client. */
  weaponPerks(p, target, wb, dealt, frac) {
    if (!wb || frac < 0.6) return null;
    const fx = [];
    if (wb.chill && target instanceof Player) { target.chillT = Math.max(target.chillT || 0, wb.chill); fx.push('chill'); }
    if (wb.burn && !target.inWater) { target.burnTime = Math.max(target.burnTime || 0, wb.burn); target.burnCause = p.index; fx.push('burn'); }
    if (wb.leech && dealt > 0 && p.alive) { p.health = Math.min(p.maxHealth, p.health + dealt * wb.leech); fx.push('leech'); }
    return fx.length ? fx : null;
  }
  diff() { return DIFFICULTIES[this.difficulty] || DIFFICULTIES.normal; }
  shoot(p, { charge = 1 }) {
    if (p.cooldowns.shoot > 0) return { ok: false, reason: 'cooldown' };
    if (!this.hasResource(p, 'arrow', 1)) return { ok: false, reason: 'no-arrows' };
    this.spend(p, 'arrow', 1); p.sinceShot = 0;
    const T = TOOLS.bow, ch = clamp(charge, 0.15, 1);
    p.cooldowns.shoot = T.cd; p.swing = 0.6; p.swingKind = 'bow'; p.held = 'bow';
    const wb = weaponBoost(p.look, 'bow'), e = p.eyePosition(), d = p.lookDirection(), speed = T.speed * (0.5 + 0.5 * ch) * (wb.arrowSpeed || 1);
    const a = new Arrow(this.nextId(), e.x + d.x * 0.6, e.y + d.y * 0.6, e.z + d.z * 0.6, d.x * speed, d.y * speed, d.z * speed, p.index, T.dmg * (0.4 + 0.6 * ch) * p.mods.meleeDamage * (weaponBoost(p.look, 'bow').arrow || 1) * (p.bot && !p.proxy ? this.diff().botBow : 1));
    a.perk = wb; a.skin = p.look && p.look.weapons ? p.look.weapons.bow : null; a.charge = ch;
    if (p.buffs && p.buffs.rage > 0) a.damage *= 1.3;
    this.arrows.push(a);
    this.emit({ type: 'shoot', by: p.id, arrow: a });
    return { ok: true };
  }

  /* ------------------------ health and damage ------------------------ */
  /** Applies damage with class modifiers and phase rules. Returns the damage dealt, or null if nothing happened. */
  damage(target, amount, src) {
    if (!target.alive || amount <= 0 || target.adminGod) return null;
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
    target.lastBlocked = false;
    if (target.blocking && src.direct && attacker && (src.kind === 'melee' || src.kind === 'arrow')) {     // only hits from the front are blocked
      const ax = attacker.pos.x - target.pos.x, az = attacker.pos.z - target.pos.z, l = Math.hypot(ax, az) || 1;
      if ((ax * -Math.sin(target.yaw) + az * -Math.cos(target.yaw)) / l > 0.2) {
        if (src.kind === 'melee' && target.blockStart != null && this.clock - target.blockStart < CONFIG.COMBAT.PARRY_WINDOW) {   // PARRY: blocked at the last moment - no damage, attacker staggered
          attacker.chillT = Math.max(attacker.chillT || 0, 1); attacker.cooldowns.attack = Math.max(attacker.cooldowns.attack, 0.6);
          attacker.vel.x += ax / l * 6; attacker.vel.z += az / l * 6; attacker.vel.y = Math.max(attacker.vel.y, 3);
          target.blockStart = null;
          this.emit({ type: 'parry', target, by: attacker.id });
          return null;
        }
        amount *= 0.35; target.lastBlocked = true; this.emit({ type: 'blocked', target, by: attacker.id });
      }
    }
    if (target.buffs && target.buffs.armor > 0) amount *= 0.6;
    if (target.look) {                                                    // armor sets
      const ap = armorPerk(target.look);
      if (src.pierce) amount *= ap.critWeak || 1;                         // crits and headshots go straight through armor (heavy plate even takes extra)
      else if (ap.guard && src.kind !== 'drown') amount *= ap.guard;
      if (ap.fireproof && (src.kind === 'fire' || src.kind === 'lava')) amount *= ap.fireproof;
      if (ap.fall && src.kind === 'fall') amount *= ap.fall;
    }
    if (src.kind === 'explosion') amount *= target.mods.explosionTaken;
    else if (src.kind === 'fall') amount *= target.mods.fall;
    else if (HAZARD_KINDS.has(src.kind)) amount *= target.mods.hazardTaken;
    amount = Math.max(0, amount);
    if (IFRAME_KINDS.has(src.kind)) {                                  // Minecraft hurt-time: after a hit, only a STRONGER hit within 0.5s lands (for the difference)
      if (target.hurtT > 0) { if (amount <= target.lastDmg) return null; const extra = amount - target.lastDmg; target.lastDmg = amount; amount = extra; }
      else { target.hurtT = 0.5; target.lastDmg = amount; }
    }
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
    let loot = null;
    if (killer && killer !== target && !this.unlimited) {                // spoils of war: take a share of the victim's supplies
      loot = {};
      for (const k of RESOURCE_ORDER) {
        const take = Math.floor((target.resources[k] || 0) * 0.35);
        if (take > 0) { const got = this.addResource(killer, k, take); if (got > 0) { loot[k] = got; target.resources[k] -= take; } }
      }
      if (!Object.keys(loot).length) loot = null;
    }
    target.bounty = 0; target.bountyTime = 0; target.lastHits.length = 0; target.streak = 0;
    if (killer && killer !== target && killer.alive && this.phase !== 'build') this.addStreak(killer);
    target.respawnTimer = this.mode === 'sandbox' ? CONFIG.MATCH.SANDBOX_RESPAWN : (this.phase === 'war' || this.phase === 'chaos') && this.coreAlive(target.index) ? CONFIG.MATCH.CORE_RESPAWN : 0;
    this.emit({ type: 'death', victim: target, killer, kind: src.kind, detail: src.detail || null, bounty, tnt: viaTnt, loot });
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
      if (id === ID.core && (this.phase === 'build' || this.phase === 'countdown' || this.coreShielded())) continue;
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
    this.machines.onChange(x, y, z, old, nw);
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
    if (old === ID.core && oldOwner > 0) this.coreDestroyed(oldOwner - 1, this.inSuddenDeath);
    // base integrity bookkeeping (blocks owned by a player and standing above their pad)
    if (oldOwner > 0 && od.solid && od.shape !== 'fluid') this.integrityDelta(oldOwner - 1, x, y, z, -1);
    const no = this.world.getOwner(x, y, z);
    if (no > 0 && nd.solid && nd.shape !== 'fluid') this.integrityDelta(no - 1, x, y, z, +1);
  }
  integrityDelta(slot, x, y, z, delta) {
    const plot = this.plots[slot];
    if (!plot || y <= plot.baseY || Math.hypot(x + 0.5 - plot.x, z + 0.5 - plot.z) > PLOT_BASE_RADIUS) return;
    this.baseCount[slot] += delta;
  }
  /** Cores cannot be damaged during the first minute of the war, so nobody is knocked out the moment the walls drop. */
  coreShielded() { return this.phase === 'war' && this.phaseTime < CONFIG.MATCH.CORE_SHIELD; }
  /** Is this player's core still standing (so they respawn)? */
  coreAlive(slot) { const pl = this.plots[slot]; return !!(pl && pl.core) && !this.baseDestroyed[slot]; }
  /** The base falls when its core does: no more respawns for that player. */
  coreDestroyed(slot, quiet) {
    if (this.baseDestroyed[slot] || !this.players[slot]) return;
    this.baseDestroyed[slot] = true;
    const by = this.cause != null && this.cause !== slot && !this.areAllies(this.players[this.cause], this.players[slot]) ? this.players[this.cause] : null;
    if (by) { by.stats.score += 400; by.stats.structuresDestroyed++; by.stats.objectives++; }
    this.emit({ type: 'baseDestroyed', player: this.players[slot], by, quiet: !!quiet });
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
  /** Whole-layer flood. Bulk mode: these cells are still liquid, so they skip the flow / gravity queues and are not streamed block by block. */
  fillLayer(y, id, meta) {
    this.bulkFluid = true;
    fillFluidLayer(this.world, y, id, meta);
    this.bulkFluid = false;
    this.emit({ type: 'layerFilled', y, id, meta });
  }
  spawnMobAtEdge(type = 'zombie') {
    const w = this.world, side = Math.floor(Math.random() * 4), t = 4 + Math.random() * (w.sizeX - 8);
    const x = side === 0 ? 2 : side === 1 ? w.sizeX - 3 : t, z = side === 2 ? 2 : side === 3 ? w.sizeZ - 3 : t;
    const m = new Mob('m' + this.nextId(), x + 0.5, w.getSolidHeight(Math.floor(x), Math.floor(z)) + 1, z + 0.5, type);
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
      else if (p.isRemote) this.consumeInput(p, dt);
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
    this.machines.update(dt);
    this.updateDrains(dt);
    if (this.phase === 'chaos') this.updateEvents(dt);
    if (live) { this.updateVault(dt); this.updateBounties(dt); this.updateProposals(); this.updateDrops(dt); }
    this.winCheckClock -= dt;
    if (this.winCheckClock <= 0) { this.winCheckClock = 0.5; this.checkWinner(false); }
  }

  updatePhase(dt) {
    const M = CONFIG.MATCH;
    if (this.hold && this.phase === 'countdown') { this.phaseTime = 0; return; }          // hosting: wait until every player has loaded the map
    if (this.phase === 'countdown' && this.phaseTime >= M.COUNTDOWN) this.setPhase('build');
    else if (this.phase === 'build' && this.phaseTime >= M.BUILD) { this.setPhase('war'); for (let i = 0; i < 6; i++) { this.baseRef[i] = Math.max(this.baseCount[i], 1); } }
    else if (this.phase === 'war' && this.phaseTime >= M.WAR - M.CHAOS) { this.setPhase('chaos'); this.eventGap = 2; }
    else if (this.phase === 'chaos' && this.phaseTime >= M.CHAOS) this.checkWinner(true);
  }
  setPhase(name) {
    this.phase = name; this.phaseTime = 0;
    this.emit({ type: 'phase', phase: name });
    if (name === 'war') this.dropPlotWalls();
    if (name === 'chaos') this.suddenDeath();
  }
  /** CHAOS begins: all remaining cores crumble, so from now on every death is final. */
  suddenDeath() {
    const w = this.world; let any = false;
    this.inSuddenDeath = true;
    for (const pl of this.plots) {
      if (!pl.core || this.baseDestroyed[pl.owner] || pl.owner < 0) continue;
      any = true; this.cause = null;
      if (w.get(pl.core[0], pl.core[1], pl.core[2]) === ID.core) w.set(pl.core[0], pl.core[1], pl.core[2], AIR);
      this.coreDestroyed(pl.owner, true);
    }
    this.inSuddenDeath = false;
    if (any) this.emit({ type: 'suddenDeath' });
  }
  /** The dividers between plots vanish when the war begins. Hosts do not stream these block changes: every client removes the same cells itself. */
  dropPlotWalls() {
    if (this.wallsDropped || !this.wallCells || !this.wallCells.length) return;
    this.wallsDropped = true;
    removePlotWalls(this.world, this.wallCells, this);
    this.emit({ type: 'wallsDown' });
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

  /** Remote players send one input per client step; the server applies them in order (and tells the client which it has used). */
  consumeInput(p, dt) {
    const q = p.inQueue, c = p.controls;
    if (q && q.length) {
      if (q.length > 10) q.splice(0, q.length - 4);                    // client ran ahead: drop the oldest
      const i = q.shift(), b = i.bits;
      c.forward = !!(b & 1); c.back = !!(b & 2); c.left = !!(b & 4); c.right = !!(b & 8); c.jump = !!(b & 16); c.crouch = !!(b & 32); c.sprint = !!(b & 64);
      p.yaw = i.yaw; p.pitch = clamp(i.pitch, -1.57, 1.57); p.ackSeq = i.seq; p.idleInput = 0;
    } else if ((p.idleInput = (p.idleInput || 0) + dt) > 0.3) { c.forward = c.back = c.left = c.right = c.jump = c.crouch = c.sprint = false; }
  }
  updateDead(p, dt) {
    if (p.respawnTimer > 0) { p.respawnTimer -= dt; if (p.respawnTimer <= 0) this.respawn(p); }
  }

  tickPlayer(p, dt, env, live) {
    const wasAir = !p.onGround;
    for (const k in p.buffs) if (p.buffs[k] > 0) p.buffs[k] = Math.max(0, p.buffs[k] - dt);
    p.sinceShot += dt;
    if (!this.unlimited && p.sinceShot > QUIVER.REFILL_AFTER && (p.resources.arrow || 0) < QUIVER.REFILL_TO) {
      p.quiverT += dt;
      if (p.quiverT >= QUIVER.REFILL_EVERY) { p.quiverT = 0; p.resources.arrow = (p.resources.arrow || 0) + 1; }
    } else p.quiverT = 0;
    p.update(dt, p.controls, this.world, env);
    p.invulnerable = Math.max(0, p.invulnerable - dt);
    if (p.blocking) { p.blockT += dt; if (p.blockT > 2.5) { p.blocking = false; p.blockCd = 1.6; } } else p.blockCd = Math.max(0, p.blockCd - dt);
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
    const ap = armorPerk(p.look), deadly = p.deadlyWater, maxAir = (deadly ? CONFIG.WATER.AIR : CONFIG.WATER.NATURAL_AIR) * (ap.air || 1);
    const headWater = this.world.get(Math.floor(p.pos.x), Math.floor(p.pos.y + p.eyeHeight), Math.floor(p.pos.z)) === ID.water;
    const belly = this.world.get(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.9), Math.floor(p.pos.z)) === ID.water;
    const under = headWater || (deadly && p.inWater && belly && !p.onGround);   // treading deadly water still drowns you; standing in shallow water does not
    if (p.air == null || (!under && p.air > maxAir)) p.air = maxAir; else if (p.air > maxAir) p.air = maxAir;
    p.air = under ? Math.max(-1, p.air - dt * (headWater ? 1 : 0.6)) : Math.min(maxAir, p.air + dt * 3);
    if (p.air <= 0) this.damage(p, (deadly ? CONFIG.WATER.DROWN_DPS : 5) * (ap.drown || 1) * dt, { kind: 'drown', by: p.waterCause != null ? p.waterCause : undefined, direct: false });
    if (!under) p.waterCause = null;
    if (!p.alive) return;
    // stuck inside blocks (landed groups, pistons): pop up, otherwise suffocate
    if (this.world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.9), Math.floor(p.pos.z))) {
      let moved = false;
      for (let k = 1; k <= 4 && !moved; k++) if (!this.world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y + 0.9 + k), Math.floor(p.pos.z)) && !this.world.isSolid(Math.floor(p.pos.x), Math.floor(p.pos.y + 1.9 + k), Math.floor(p.pos.z))) { p.pos.y += k; moved = true; }
      if (!moved) this.damage(p, 8 * dt, { kind: 'crush', detail: 'suffocation' });
    }
    p.sinceDamage += dt;
    if (p.alive && p.health < p.maxHealth && p.sinceDamage > CONFIG.HEALTH.REGEN_DELAY * p.mods.regenDelay) p.health = Math.min(p.maxHealth, p.health + CONFIG.HEALTH.REGEN_RATE * p.mods.regenRate * (armorPerk(p.look).regen || 1) * dt);
    if (live && (this.phase === 'war' || this.phase === 'chaos')) { p.stats.surviveSeconds += dt; p.stats.score += 10 * dt; }
  }

  updateMobs(dt, env) {
    for (const m of this.mobs) {
      if (!m.alive) continue;
      let target = null, best = 1e9;
      for (const p of this.players) if (p.alive) { const d = Math.hypot(p.pos.x - m.pos.x, p.pos.z - m.pos.z); if (d < best) { best = d; target = p; } }
      m.update(dt, target, this.world, env);
      if (m.type === 'creeper') {                                     // hiss, swell, boom
        if (m.fuse > 0) {
          m.fuse -= dt;
          if (best > 6) m.fuse = 0;                                   // the target got away: fuse goes out
          else if (m.fuse <= 0) { m.alive = false; this.explode(m.pos.x, m.pos.y + 0.8, m.pos.z, { radius: 3.6, power: 1.15, owner: null, cause: 'creeper' }); this.emit({ type: 'mobDeath', mob: m }); continue; }
        } else if (target && best < 2.8 && Math.abs(target.pos.y - m.pos.y) < 2.5) { m.fuse = 1.4; this.emit({ type: 'creeperHiss', mob: m }); }
        if (m.burnTime > 0) { m.burnTime -= dt; this.damage(m, 3 * dt, { kind: 'fire' }); }
        if (m.inLava) this.damage(m, 30 * dt, { kind: 'lava' });
        if (m.life > 90 || m.pos.y < -5) m.alive = false;
        continue;
      }
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
      a.vel.y -= 14 * dt * (a.perk && a.perk.grav || 1);
      const dx = a.vel.x * dt, dy = a.vel.y * dt, dz = a.vel.z * dt, n = Math.max(1, Math.ceil(Math.hypot(dx, dy, dz) / 0.35));
      for (let i = 0; i < n && !a.stuck && a.alive; i++) {
        a.pos.x += dx / n; a.pos.y += dy / n; a.pos.z += dz / n;
        if (w.isSolid(Math.floor(a.pos.x), Math.floor(a.pos.y), Math.floor(a.pos.z))) { a.stuck = true; a.age = 8; this.emit({ type: 'arrowStuck', arrow: a }); break; }
        for (const b of this.bodies()) {
          if (b instanceof Player && b.index === a.owner && a.age < 0.4) continue;
          if (a.machine && b instanceof Player && (b.index === a.owner || this.areAllies(b, this.players[a.owner]))) continue;
          const bb = b.aabb(), m = 0.18;
          if (a.pos.x > bb.minX - m && a.pos.x < bb.maxX + m && a.pos.y > bb.minY - m && a.pos.y < bb.maxY + m && a.pos.z > bb.minZ - m && a.pos.z < bb.maxZ + m) {
            const head = b instanceof Player && a.pos.y - bb.minY > 1.42;                  // HEADSHOT: ignores armor, bigger damage
            const pur = !a.skin || a.skin === 'default';
            const dealt = this.damage(b, a.damage * (head ? CONFIG.COMBAT.HEADSHOT * (pur ? CONFIG.COMBAT.PURIST : 1) : 1), { kind: 'arrow', by: a.owner, direct: true, pierce: head });
            if (dealt !== null && head) this.emit({ type: 'crit', target: b, headshot: true, by: a.owner });
            if (dealt !== null) {
              const s = Math.hypot(a.vel.x, a.vel.z) || 1, k = 3 * (a.perk && a.perk.kb || 1) * (armorPerk(b.look).kbRes || 1); b.vel.x += a.vel.x / s * k; b.vel.z += a.vel.z / s * k; b.vel.y += 1.5;
              const fx = a.perk && !b.lastBlocked && this.players[a.owner] ? this.weaponPerks(this.players[a.owner], b, a.perk, dealt, a.charge || 1) : null;
              this.emit({ type: 'hit', target: b, by: a.owner, tool: 'bow', skin: a.skin, fx, crit: head }); a.alive = false;
            }
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
      this.bulkFluid = true; drainFluidLayer(w, d.y, d.id); this.bulkFluid = false;
      this.emit({ type: 'layerDrained', y: d.y, id: d.id });
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
    if (v.stage == null) { v.stage = 0; v.stageT = 0; }
    if (v.cooldown > 0) { v.cooldown -= dt; v.progress = 0; v.capturing = false; return; }
    if (v.stage > 0 && (v.stageT += dt) > 75) { v.stage = 0; v.stageT = 0; v.progress = 0; this.emit({ type: 'vaultReset' }); }   // the course resets if nobody pushes on
    const pad = m.pads[v.stage], st = VAULT_STAGES[v.stage];
    const inside = this.players.filter((p) => p.alive && Math.hypot(p.pos.x - pad.x, p.pos.z - pad.z) <= pad.r && Math.abs(p.pos.y - pad.y) < 1.3);
    const teams = new Set(inside.map((p) => p.team));
    if (teams.size === 1) {
      const team = inside[0].team;
      if (v.team !== team) { v.team = team; v.progress = 0; }
      v.progress += dt / st.time; v.capturing = true;
      if (v.progress >= 1) {
        v.progress = 0; v.capturing = false; v.captured++;
        for (const p of inside) {
          p.stats.objectives++; p.stats.score += st.score;
          for (const [k, a] of Object.entries(st.give)) this.addResource(p, k, a);
          if (st.buffs) for (const [k, t] of st.buffs) this.giveBuff(p, k, t);
        }
        const stage = v.stage;
        v.stage = (v.stage + 1) % VAULT_STAGES.length; v.stageT = 0;
        if (v.stage === 0) v.cooldown = 50;                              // conquered the spire: the vault recharges
        this.emit({ type: 'vaultCaptured', players: inside, stage, final: stage === VAULT_STAGES.length - 1 });
      }
    } else {
      v.capturing = false;
      v.progress = Math.max(0, v.progress - dt / 6);
    }
  }
  /** Inside the vault course nothing can be built: it has to be run, not pillared. */
  inVaultZone(x, y, z) { const m = this.map && this.map.vault; return !!m && m.cx != null && Math.max(Math.abs(x - m.cx), Math.abs(z - m.cz)) <= 9 && y >= m.floorY; }
  /* ---------------- supply drops, buffs and kill streaks ---------------- */
  /** War and chaos: a crate parachutes onto neutral ground every so often. Standing on it (uncontested) claims the loot. */
  updateDrops(dt) {
    if (this.mode === 'sandbox' || (this.phase !== 'war' && this.phase !== 'chaos')) return;
    this.dropClock -= dt;
    if (this.dropClock <= 0 && this.drops.length < 2) { this.dropClock = CONFIG.MATCH.DROP_EVERY; this.spawnDrop(); }
    for (const d of this.drops) {
      d.t += dt;
      if (d.state === 'falling') {
        d.y -= 5 * dt;
        if (d.y <= d.ground) { d.y = d.ground; d.state = 'landed'; d.t = 0; this.emit({ type: 'dropLanded', drop: { id: d.id, x: d.x, y: d.y, z: d.z } }); }
        continue;
      }
      const near = this.players.filter((p) => p.alive && Math.hypot(p.pos.x - d.x, p.pos.z - d.z) < 1.9 && Math.abs(p.pos.y - d.y) < 2.6);
      const teams = new Set(near.map((p) => p.team));
      if (teams.size === 1) {
        const team = near[0].team;
        if (d.team !== team) { d.team = team; d.prog = 0; }
        d.prog += dt / 2.5;
        if (d.prog >= 1) { this.claimDrop(d, near.find((p) => !p.isBot) || near[0]); continue; }
      } else if (!teams.size) d.prog = Math.max(0, d.prog - dt / 4);
      if (d.t > 75) d.dead = true;
    }
    if (this.drops.some((d) => d.dead)) this.drops = this.drops.filter((d) => !d.dead);
  }
  spawnDrop() {
    const w = this.world, v = this.map.vault, r = mulberry32((this.clock * 1000) | 0);
    for (let tries = 0; tries < 40; tries++) {
      const a = r() * Math.PI * 2, dist = 14 + r() * 20, x = Math.floor(v.x + Math.cos(a) * dist), z = Math.floor(v.z + Math.sin(a) * dist);
      if (x < 2 || z < 2 || x >= w.sizeX - 2 || z >= w.sizeZ - 2) continue;
      if (this.plots.some((pl) => this.inPlot(pl, x, z))) continue;                 // neutral ground only
      let g = -1;
      for (let y = w.sizeY - 2; y > 1; y--) if (w.isSolid(x, y, z)) { g = y + 1; break; }
      if (g < 2 || w.get(x, g, z) !== AIR || w.get(x, g + 1, z) !== AIR) continue;
      const loot = DROP_LOOT[Math.floor(r() * DROP_LOOT.length)];
      const d = { id: 'd' + this.nextId(), x: x + 0.5, z: z + 0.5, ground: g, y: g + 45, state: 'falling', t: 0, prog: 0, team: -1, loot: loot.id };
      this.drops.push(d);
      this.emit({ type: 'dropIncoming', drop: { id: d.id, x: d.x, y: g, z: d.z, loot: loot.id } });
      return d;
    }
    return null;
  }
  claimDrop(d, p) {
    d.dead = true;
    const L = DROP_LOOT_BY_ID[d.loot];
    if (L.give) for (const [k, a] of Object.entries(L.give)) this.addResource(p, k, a);
    if (L.heal) p.health = p.maxHealth;
    if (L.buff) this.giveBuff(p, L.buff[0], L.buff[1]);
    p.stats.objectives++; p.stats.score += 200;
    this.emit({ type: 'dropClaimed', player: p, loot: d.loot, x: d.x, y: d.y, z: d.z });
  }
  giveBuff(p, k, t) { p.buffs[k] = Math.max(p.buffs[k] || 0, t); this.emit({ type: 'buff', player: p, buff: k, time: t }); }
  addStreak(p) {
    p.streak = (p.streak || 0) + 1;
    const n = p.streak; let reward = null;
    if (n === 2) { this.addResource(p, 'arrow', 5); reward = '+5 arrows'; }
    else if (n === 3) { this.giveBuff(p, 'rage', 15); reward = 'RAGE: +30% damage'; }
    else if (n === 5) reward = this.tntStrike(p) ? 'TNT STRIKE incoming' : null;
    else if (n >= 7 && n % 2 === 1) { this.giveBuff(p, 'swift', 20); this.giveBuff(p, 'armor', 20); reward = 'UNSTOPPABLE: speed + iron skin'; }
    if (n >= 2) this.emit({ type: 'streak', player: p, n, reward });
  }
  /** Kill streak reward: four TNT fall on the nearest standing enemy core (or the nearest enemy if no core is left). */
  tntStrike(p) {
    let best = null, bd = 1e9;
    for (const pl of this.plots) {
      const o = this.players[pl.owner];
      if (!pl.core || !o || o === p || this.areAllies(p, o) || !this.coreAlive(pl.owner)) continue;
      const d = Math.hypot(pl.core[0] - p.pos.x, pl.core[2] - p.pos.z);
      if (d < bd) { bd = d; best = { x: pl.core[0] + 0.5, y: pl.core[1], z: pl.core[2] + 0.5 }; }
    }
    if (!best) for (const q of this.players) {
      if (!q.alive || q === p || this.areAllies(p, q)) continue;
      const d = Math.hypot(q.pos.x - p.pos.x, q.pos.z - p.pos.z);
      if (d < bd) { bd = d; best = { x: q.pos.x, y: q.pos.y, z: q.pos.z }; }
    }
    if (!best) return false;
    for (let i = 0; i < 4; i++) this.spawnTnt(best.x + (Math.random() - 0.5) * 4, best.y + 16 + i * 2, best.z + (Math.random() - 0.5) * 4, 3.2 + i * 0.3, p.index, 'strike', -6);
    this.emit({ type: 'tntStrike', by: p, x: best.x, y: best.y, z: best.z });
    return true;
  }
  updateBounties(dt) { for (const p of this.players) if (p.bounty > 0) { p.bountyTime -= dt; if (p.bountyTime <= 0) { p.bounty = 0; this.emit({ type: 'bountyExpired', target: p }); } } }
  updateProposals() { this.proposals = this.proposals.filter((q) => q.from.alive && q.to.alive && this.clock - q.time < 60); }

  /* ------------------------------ win / results ------------------------------ */
  alivePlayers() { return this.players.filter((p) => p.alive); }
  /** Still in the match: alive, or dead but about to respawn at their core. */
  contenders() { return this.players.filter((p) => p.alive || p.respawnTimer > 0); }
  checkWinner(timeUp) {
    if (this.phase === 'sandbox' || this.phase === 'ended' || this.phase === 'countdown' || this.phase === 'idle') return;
    if (this.phase === 'build' && !timeUp) return;
    const alive = this.mode === 'sandbox' ? this.alivePlayers() : this.contenders(), teams = new Set(alive.map((p) => p.team));
    if (!timeUp && this.phase === 'war' && teams.size === 2 && this.players.length > 2 && this.phaseTime < CONFIG.MATCH.WAR - CONFIG.MATCH.CHAOS) { this.setPhase('chaos'); this.eventGap = 3; this.emit({ type: 'finalDuel' }); return; }
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
        coins: Math.round(p.stats.score * 0.022 + (won ? 110 : 0) + p.stats.kills * 5 + 10),   // a grind on purpose: ~100 coins a match, ~220 for a win
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
      players: this.players.map((p) => ({ id: p.id, index: p.index, name: p.name, color: p.color, classId: p.classId, alive: p.alive, health: p.health, x: L(p, 'x'), y: L(p, 'y'), z: L(p, 'z'), yaw: p.yaw, pitch: p.pitch, walk: p.walkPhase, swing: p.swing, crouch: p.crouching, burning: p.burnTime > 0, isBot: p.isBot, team: p.team, bounty: p.bounty, look: p.look, moving: Math.hypot(p.vel.x, p.vel.z) > 1.2 && p.onGround, held: p.held, sk: p.swingKind, blocking: p.blocking, sprinting: p.sprinting, chilled: p.chillT > 0 })),
      tnts: this.tnts.map((t) => ({ x: L(t, 'x'), y: L(t, 'y'), z: L(t, 'z'), fuse: t.fuse })),
      groups: this.groups.map((g) => ({ g, off: g.off })),
      arrows: this.arrows.filter((a) => a.alive).map((a) => ({ x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: a.yaw, pitch: a.pitch, skin: a.skin || 'default', stuck: a.stuck })),
      mobs: this.mobs.filter((m) => m.alive).map((m) => ({ id: m.id, type: m.type, fuse: m.fuse, x: L(m, 'x'), y: L(m, 'y'), z: L(m, 'z'), yaw: m.yaw, walk: m.walkPhase, swing: m.swing })),
      meteors: this.meteors.map((m) => ({ x: m.pos.x, y: m.pos.y, z: m.pos.z })),
      drops: (this.drops || []).map((d) => ({ id: d.id, x: d.x, y: d.y, z: d.z, landed: d.state === 'landed', prog: d.prog })),
      banners: this.plots.filter((pl) => pl.owner >= 0 && this.players[pl.owner]).map((pl) => { const q = this.players[pl.owner]; return { x: pl.x + 3.5, y: pl.baseY + 1, z: pl.z + 3.5, color: q.color, banner: q.look.banner, bc: q.look.bannerColor }; }),
    };
  }
}
/* ============================ 11b. MULTIPLAYER ============================ */
/**
 * Host-authoritative multiplayer.
 *
 *   HOST   runs the real GameServer (world, physics, rules). Remote humans are ordinary Players whose controls are fed by
 *          the inputs they send; their actions go through GameServer.handle() exactly like local ones.
 *   CLIENT generates the same map from the seed, then only applies what the host says: block changes, entity snapshots
 *          and events (NetServerView). It predicts its own movement and the host corrects it.
 *
 * Two interchangeable transports carry the messages: 'online' (WebRTC through PeerJS, loaded on demand from a CDN, a game
 * code is the room name) and 'local' (BroadcastChannel: another tab on the same computer, works offline).
 */
const NET = { VERSION: 2, TICK_STEPS: 3, MAX_PLAYERS: 6, TIMEOUT: 9000, CODE_CHARS: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789', PEER_PREFIX: 'mpw-' };
const newGameCode = () => { let c = ''; for (let i = 0; i < 5; i++) c += NET.CODE_CHARS[Math.floor(Math.random() * NET.CODE_CHARS.length)]; return c; };
const cleanCode = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);

/* ---------- compact world transfer (only used when the generated maps differ, which should never happen) ---------- */
function rleEncode(arr) {
  const out = []; let i = 0;
  while (i < arr.length) { const v = arr[i]; let j = i + 1; while (j < arr.length && arr[j] === v) j++; out.push(v, j - i); i = j; }
  return out;
}
function rleDecode(rle, target) {
  let k = 0; for (let i = 0; i < rle.length; i += 2) { const v = rle[i], n = rle[i + 1]; target.fill(v, k, k + n); k += n; }
}
function hashWorld(world) {
  let h = 2166136261 >>> 0;
  const b = world.blocks, m = world.meta, o = world.owner;
  for (let i = 0; i < b.length; i += 7) { h = Math.imul(h ^ b[i], 16777619) >>> 0; h = Math.imul(h ^ m[i] ^ (o[i] << 8), 16777619) >>> 0; }
  return h;
}

/* ============================== transports ============================== */
class Channel {
  constructor() { this.onmessage = () => {}; this.onclose = () => {}; this.alive = true; }
  send() {}
  close() { this._closed(); }
  _closed() { if (!this.alive) return; this.alive = false; try { this.onclose(); } catch (e) { /* ignore */ } }
}

/** One endpoint of a BroadcastChannel conversation. Messages are addressed {to, from, d}. */
class BCChannel extends Channel {
  constructor(bc, me, peer, ownsBc = false) { super(); this.bc = bc; this.me = me; this.peer = peer; this.ownsBc = ownsBc; }
  _closed() { const was = this.alive; super._closed(); if (was && this.ownsBc) try { this.bc.close(); } catch (e) { /* ignore */ } }
  send(msg) { if (this.alive) try { this.bc.postMessage({ to: this.peer, from: this.me, d: msg }); } catch (e) { /* closed */ } }
  _recv(m) { if (this.alive) this.onmessage(m.d); }
  close() { if (this.alive) { try { this.bc.postMessage({ to: this.peer, from: this.me, d: { t: 'bye' } }); } catch (e) { /* ignore */ } } this._closed(); }
}
const LocalProvider = {
  name: 'local',
  available() { return typeof BroadcastChannel !== 'undefined'; },
  host(code, onchannel) {
    const bc = new BroadcastChannel('mpw:' + code), chans = new Map();
    bc.onmessage = (ev) => {
      const m = ev.data;
      if (!m || m.to !== 'host') return;
      if (m.d === undefined && m.t === 'hi') {
        const old = chans.get(m.cid); if (old) old._closed();
        const ch = new BCChannel(bc, 'host', m.cid); chans.set(m.cid, ch);
        bc.postMessage({ to: m.cid, t: 'ok' });
        onchannel(ch);
      } else { const ch = chans.get(m.from); if (ch) ch._recv(m); }
    };
    return Promise.resolve({ name: 'local', close() { for (const c of chans.values()) c._closed(); chans.clear(); bc.close(); } });
  },
  connect(code, timeout = 1500) {
    return new Promise((resolve, reject) => {
      const bc = new BroadcastChannel('mpw:' + code), cid = 'c' + Math.random().toString(36).slice(2, 10), ch = new BCChannel(bc, cid, 'host', true);
      let done = false;
      const timer = setTimeout(() => { if (!done) { done = true; bc.close(); reject(new Error('no host on this device')); } }, timeout);
      bc.onmessage = (ev) => {
        const m = ev.data;
        if (!m || m.to !== cid) return;
        if (!done && m.t === 'ok') { done = true; clearTimeout(timer); resolve(ch); }
        else if (done && m.d) ch._recv(m);
      };
      bc.postMessage({ to: 'host', t: 'hi', cid });
    });
  },
};

/** WebRTC through PeerJS. The library is fetched only when someone hosts or joins online. */
// Optional local copy first (drop peerjs.min.js next to index.html to work on networks that block CDNs), then two CDNs.
const PEERJS_URLS = ['peerjs.min.js', 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js', 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js'];
class PeerChannel extends Channel {
  constructor(conn, peer) {
    super(); this.conn = conn; this.peer = peer || null;
    conn.on('data', (d) => { if (this.alive) this.onmessage(d); });
    conn.on('close', () => this._closed());
    conn.on('error', () => this._closed());
  }
  send(msg) { if (this.alive) try { this.conn.send(msg); } catch (e) { /* ignore */ } }
  close() { try { this.conn.close(); } catch (e) { /* ignore */ } if (this.peer) try { this.peer.destroy(); } catch (e) { /* ignore */ } this._closed(); }
}
/** STUN servers find your public address. They are enough for most home networks. */
const ICE_SERVERS = [
  { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302', 'stun:stun.cloudflare.com:3478', 'stun:global.stun.twilio.com:3478'] },
];
/**
 * TURN relay: carries the game when a router or firewall blocks the direct link (school, mobile, strict NAT).
 * Fill in ONE of these (both work too):
 *   TURN_CREDENTIALS_URL : a URL that returns a JSON array of ICE servers, e.g. Metered's
 *                          'https://YOURAPP.metered.live/api/v1/turn/credentials?apiKey=YOUR_KEY'
 *   TURN_SERVERS         : fixed entries, e.g. [{ urls: ['turn:host:3478', 'turns:host:443?transport=tcp'], username: '...', credential: '...' }]
 * Leave both empty to play with STUN only.
 */
const TURN_CREDENTIALS_URL = '';
const TURN_SERVERS = [                                           // Metered free relay (dashboard: TURN Server > Credentials)
  {
    urls: ['turn:global.relay.metered.ca:80', 'turn:global.relay.metered.ca:80?transport=tcp', 'turn:global.relay.metered.ca:443', 'turns:global.relay.metered.ca:443?transport=tcp'],
    username: '3592d25850ce0b9db7ffbd84', credential: 'nostK+5fN24wl141',
  },
];
let iceCache = null, iceCacheAt = 0;
/** STUN + TURN, fetching relay credentials when configured (cached for 30 minutes; falls back to STUN only on failure). */
async function getIceServers() {
  if (iceCache && Date.now() - iceCacheAt < 30 * 60 * 1000) return iceCache;
  let fetched = [];
  if (TURN_CREDENTIALS_URL && typeof fetch !== 'undefined') {
    try {
      const ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
      const timer = setTimeout(() => ctl && ctl.abort(), 6000);
      const res = await fetch(TURN_CREDENTIALS_URL, ctl ? { signal: ctl.signal } : {});
      clearTimeout(timer);
      const data = res.ok ? await res.json() : null;
      const list = Array.isArray(data) ? data : data && Array.isArray(data.iceServers) ? data.iceServers : [];
      fetched = list.filter((s) => s && s.urls);
      if (!fetched.length && typeof console !== 'undefined') console.warn('net: TURN credentials URL returned no servers', res.status);
    } catch (e) { if (typeof console !== 'undefined') console.warn('net: could not fetch TURN credentials', e); }
  }
  const servers = ICE_SERVERS.concat(TURN_SERVERS, fetched);
  if (fetched.length || !TURN_CREDENTIALS_URL) { iceCache = servers; iceCacheAt = Date.now(); }
  return servers;
}
const PEER_OPTS = (iceServers) => ({ debug: 0, config: { iceServers, iceCandidatePoolSize: 4 } });
const netErr = (code, msg) => { const e = new Error(msg); e.code = code; return e; };
let peerLoading = null;
function loadPeerJS() {
  if (typeof window === 'undefined') return Promise.reject(new Error('no window'));
  if (window.Peer) return Promise.resolve(window.Peer);
  if (peerLoading) return peerLoading;
  peerLoading = new Promise((resolve, reject) => {
    let i = 0;
    const next = () => {
      if (i >= PEERJS_URLS.length) { peerLoading = null; reject(netErr('lib', 'Could not load the online multiplayer library (offline, or unpkg.com / jsdelivr.net is blocked on this network).')); return; }
      const s = document.createElement('script');
      s.src = PEERJS_URLS[i++]; s.async = true; s.referrerPolicy = 'no-referrer';
      s.onload = () => (window.Peer ? resolve(window.Peer) : next());
      s.onerror = () => { s.remove(); next(); };
      document.head.appendChild(s);
    };
    next();
  });
  return peerLoading;
}
const PeerProvider = {
  name: 'online',
  available() { return typeof window !== 'undefined'; },
  async host(code, onchannel) {
    const Peer = await loadPeerJS(), ice = await getIceServers();
    return new Promise((resolve, reject) => {
      const peer = new Peer(NET.PEER_PREFIX + code, PEER_OPTS(ice));
      let opened = false, closed = false;
      const timer = setTimeout(() => { if (!opened) { try { peer.destroy(); } catch (e) { /* ignore */ } reject(netErr('signal', 'The matchmaking service did not answer (PeerJS server down or blocked).')); } }, 15000);
      peer.on('open', () => { opened = true; clearTimeout(timer); resolve({ name: 'online', close() { closed = true; try { peer.destroy(); } catch (e) { /* ignore */ } } }); });
      // the signalling link drops now and then; without this the game code silently stops working for new players
      peer.on('disconnected', () => { if (opened && !closed) { const retry = () => { if (closed || !peer.disconnected) return; try { peer.reconnect(); } catch (e) { /* ignore */ } setTimeout(retry, 4000); }; setTimeout(retry, 500); } });
      peer.on('error', (e) => { if (!opened) { clearTimeout(timer); const t = e && e.type; reject(t === 'unavailable-id' ? e : netErr('signal', 'Could not reach the matchmaking service (' + (t || 'error') + ').')); } });
      peer.on('connection', (conn) => { conn.on('open', () => onchannel(new PeerChannel(conn))); });
    });
  },
  async connect(code, timeout = 16000) {
    const Peer = await loadPeerJS(), ice = await getIceServers();
    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_OPTS(ice));
      let done = false, signalled = false;
      const fail = (e) => {
        if (done) return; done = true; clearTimeout(timer); try { peer.destroy(); } catch (x) { /* ignore */ }
        if (e && e.type === 'peer-unavailable') reject(netErr('nohost', 'No game with that code was found. Check the code, and that the host is still on the lobby screen.'));
        else if (e && e.code) reject(e);
        else reject(netErr('signal', 'Could not reach the matchmaking service (' + ((e && e.type) || (e && e.message) || 'error') + ').'));
      };
      const timer = setTimeout(() => fail(signalled ? netErr('direct', 'Found the host but could not open a direct connection. A firewall or router (school, work, some mobile networks) is blocking it.') : netErr('signal', 'The matchmaking service did not answer (PeerJS server down or blocked).')), timeout);
      peer.on('error', fail);
      peer.on('open', () => {
        signalled = true;
        const conn = peer.connect(NET.PEER_PREFIX + code, { reliable: true });
        conn.on('open', () => { if (done) return; done = true; clearTimeout(timer); resolve(new PeerChannel(conn, peer)); });
        conn.on('error', fail);
      });
    });
  },
};
/** Registered providers (tests add an in-memory one). */
const NET_PROVIDERS = [LocalProvider, PeerProvider];

/* ============================== CHAT HELPERS ============================== */
const CHAT = { MAX: 140, BURST: 4, WINDOW: 6000 };
const LEET = { a: '[a4@]', e: '[e3]', i: '[i1!|]', o: '[o0]', s: '[s5$]', t: '[t7]' };
const BAD_SUB = ['fuck', 'shit', 'bitch', 'asshole', 'bastard', 'whore', 'slut', 'nigger', 'nigga', 'faggot', 'retard', 'dickhead', 'wanker'];
const BAD_WORD = ['cunt', 'cunts', 'dick', 'piss', 'cock', 'twat', 'fag', 'rape', 'raped'];
const badRegex = (w, whole) => new RegExp((whole ? '\\b' : '') + w.split('').map((c) => (LEET[c] || c) + '+').join('[\\W_]{0,2}') + (whole ? '\\b' : ''), 'gi');
const BAD_RES = [...BAD_SUB.map((w) => badRegex(w, false)), ...BAD_WORD.map((w) => badRegex(w, true))];
/** Basic profanity filter: swaps bad words (including l33t spellings) for asterisks. */
function chatFilter(text) { let t = text; for (const re of BAD_RES) t = t.replace(re, (m) => '*'.repeat(m.length)); return t; }
function chatClean(text) { return String(text == null ? '' : text).replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CHAT.MAX); }
/** Simple sliding-window rate limiter: at most BURST messages per WINDOW ms. */
function chatAllowed(rec) { const now = Date.now(); rec.times = (rec.times || []).filter((t) => now - t < CHAT.WINDOW); if (rec.times.length >= CHAT.BURST) return false; rec.times.push(now); return true; }


/** Host: listen on every available provider. Resolves with { code, providers:[names that work], close() }. */
async function netHost(onchannel, providers = NET_PROVIDERS) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const code = newGameCode(), handles = [], errors = {};
    const results = await Promise.all(providers.filter((p) => p.available()).map((p) => p.host(code, onchannel).then((h) => { handles.push(h); return h.name; }, (e) => { errors[p.name] = e; return null; })));
    const names = results.filter(Boolean);
    const taken = Object.values(errors).some((e) => e && (e.type === 'unavailable-id' || /taken|unavailable/i.test(String(e.message || e))));
    if (names.length && !taken) return { code, providers: names, errors, close() { for (const h of handles) h.close(); } };
    for (const h of handles) h.close();
    if (!taken) throw new Error('Could not start a game: ' + Object.values(errors).map((e) => e && (e.message || e.type)).join('; '));
  }
  throw new Error('Could not find a free game code, try again.');
}
/** Client: try every provider at once, the first one to connect wins. */
function netConnect(code, providers = NET_PROVIDERS) {
  return new Promise((resolve, reject) => {
    const list = providers.filter((p) => p.available());
    let pending = list.length, won = false; const errs = [];
    if (!pending) { reject(new Error('Multiplayer is not available in this browser.')); return; }
    for (const p of list) p.connect(code).then((ch) => {
      if (won) { ch.close(); return; }
      won = true; resolve(ch);
    }, (e) => {
      errs.push(e);
      if (--pending === 0 && !won) {
        const order = ['nohost', 'direct', 'lib', 'signal'], best = order.map((c) => errs.find((x) => x && x.code === c)).find(Boolean);
        reject(best ? new Error(best.message + (best.code === 'nohost' ? '' : ' Press TEST CONNECTION to see what is blocked.')) : new Error('Could not connect. Check the code and that the host is still in the lobby.'));
      }
    });
  });
}

/** Step-by-step connection check shown on the multiplayer screen, so a failure says exactly what is blocked. */
async function netDiagnose(report) {
  const step = (ok, label, detail) => report({ ok, label, detail: detail || '' });
  step(typeof RTCPeerConnection !== 'undefined', 'Browser supports WebRTC', typeof RTCPeerConnection !== 'undefined' ? '' : 'Use a recent Chrome, Edge, Firefox or Safari.');
  step(typeof BroadcastChannel !== 'undefined', 'Same-computer play (two tabs)', 'Works without internet.');
  let Peer = null;
  try { Peer = await loadPeerJS(); step(true, 'Multiplayer library loaded'); } catch (e) { step(false, 'Multiplayer library loaded', 'unpkg.com and cdn.jsdelivr.net are unreachable here (blocked network, offline, or an ad blocker).'); }
  const ice = await getIceServers();
  if (Peer) {
    const ok = await new Promise((res) => { const p = new Peer(PEER_OPTS(ice)); const t = setTimeout(() => { try { p.destroy(); } catch (e) { /* ignore */ } res(false); }, 9000); p.on('open', () => { clearTimeout(t); try { p.destroy(); } catch (e) { /* ignore */ } res(true); }); p.on('error', () => { clearTimeout(t); res(false); }); });
    step(ok, 'Matchmaking service reachable (PeerJS)', ok ? '' : 'The free PeerJS server did not answer. It is sometimes down; try again later, or from another network.');
  }
  if (typeof RTCPeerConnection !== 'undefined') {
    const found = await new Promise((res) => {
      const types = new Set(); let pc;
      try { pc = new RTCPeerConnection({ iceServers: ice }); pc.createDataChannel('x'); } catch (e) { res(types); return; }
      const t = setTimeout(() => { try { pc.close(); } catch (e) { /* ignore */ } res(types); }, 6000);
      pc.onicecandidate = (ev) => { if (!ev.candidate) { clearTimeout(t); try { pc.close(); } catch (e) { /* ignore */ } res(types); return; } const m = / typ (\w+)/.exec(ev.candidate.candidate); if (m) types.add(m[1]); };
      pc.createOffer().then((o) => pc.setLocalDescription(o)).catch(() => { clearTimeout(t); res(types); });
    });
    step(found.has('srflx'), 'Public address found (STUN)', found.has('srflx') ? '' : 'STUN is blocked, so direct links to friends on other networks will fail.');
    const turnSet = ice.length > ICE_SERVERS.length;
    step(found.has('relay'), 'Relay available (TURN)', found.has('relay') ? 'Backup route if the direct link is blocked.' : turnSet ? 'A relay is configured but did not answer (wrong credentials, used-up quota, or blocked).' : 'No relay is configured (TURN_CREDENTIALS_URL in game.js). If a direct link fails, play on the same network or use two tabs.');
  }
}

/* ============================ event serialisation ============================ */
const isBlockDef = (v) => typeof v.type === 'string' && typeof v.id === 'number' && v.tiles !== undefined;
function netPack(v, depth = 0) {
  if (v == null || typeof v !== 'object') return v;
  if (v instanceof Player) return { $p: v.index };
  if (v instanceof Mob) return { $m: v.id, type: v.type, x: v.pos.x, y: v.pos.y, z: v.pos.z, fuse: v.fuse };
  if (v instanceof PrimedTnt) return { $t: v.id, x: v.pos.x, y: v.pos.y, z: v.pos.z, fuse: v.fuse };
  if (v instanceof Arrow) return { $a: 1, x: v.pos.x, y: v.pos.y, z: v.pos.z };
  if (v instanceof FallingGroup) return { $g: v.id };
  if (isBlockDef(v)) return { $b: v.id };
  if (Array.isArray(v)) return v.map((x) => netPack(x, depth + 1));
  if (depth > 5) return null;
  const o = {};
  for (const k in v) if (typeof v[k] !== 'function') o[k] = netPack(v[k], depth + 1);
  return o;
}
function netUnpack(v, view) {
  if (v == null || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map((x) => netUnpack(x, view));
  if (v.$p !== undefined) return view.players[v.$p] || null;
  if (v.$b !== undefined) return BLOCKS[v.$b];
  if (v.$m !== undefined) { let m = view.mobById.get(v.$m); if (!m) { m = new Mob(v.$m, v.x, v.y, v.z, v.type); } return m; }
  if (v.$t !== undefined) return { id: v.$t, pos: { x: v.x, y: v.y, z: v.z }, fuse: v.fuse };
  if (v.$a !== undefined) return { pos: { x: v.x, y: v.y, z: v.z } };
  if (v.$g !== undefined) return view.groupById.get(v.$g) || { id: v.$g, cells: [], bounds: { minX: 0, maxX: 1, minY: 0, maxY: 1, minZ: 0, maxZ: 1 }, off: 0 };
  const o = {};
  for (const k in v) o[k] = netUnpack(v[k], view);
  return o;
}
const LOW_PRIORITY_EVENTS = new Set(['debris', 'blockBroken', 'blockPlaced', 'quakeTick']);   // layerFilled/layerDrained must never be dropped: clients rebuild the flood from them

/* ============================== HOST SESSION ============================== */
/** Lobby + match relay on the host. `game` supplies the local GameServer and the host's own profile. */
class HostSession {
  constructor(server, hooks = {}) {
    this.server = server; this.hooks = hooks;
    this.peers = new Map();                  // channel -> peer
    this.state = 'lobby';                    // lobby | playing | closed
    this.cfg = { mode: 'war', mapId: 'plains', bots: 3, seed: 1, difficulty: 'normal' };
    this.hostInfo = { name: 'HOST', classId: 'builder', look: sanitizeLook(null) };
    this.ai = [];                            // preview of the AI opponents (same list shown to everyone)
    this.code = null; this.providers = [];
    this.step = 0; this.tickNo = 0; this.blockQ = []; this.evQ = []; this.nextId = 1;
    this.lastBroadcast = 0; this.holdSince = 0;
    this.blockListener = (x, y, z, o, n) => { if (this.state === 'playing' && !server.removingWalls && !server.bulkFluid) this.blockQ.push(x, y, z, n, server.world.getMeta(x, y, z), server.world.getOwner(x, y, z)); };
    this.eventListener = (e) => { if (this.state === 'playing') this.captureEvent(e); };
    this.reroll();
  }
  async open(providers) {
    const r = await netHost((ch) => this.onChannel(ch), providers || NET_PROVIDERS);
    this.code = r.code; this.providers = r.providers; this.closer = r;
    this.server.world.listeners.push(this.blockListener);
    this.server.subscribe(this.eventListener);
    this.sweeper = setInterval(() => this.sweep(), 1000);
    return r;
  }
  close(why) {
    if (this.state === 'closed') return;
    for (const peer of this.peers.keys()) { try { peer.send({ t: 'closed', why: why || 'The host closed the game.' }); } catch (e) { /* ignore */ } }
    this.state = 'closed';
    clearInterval(this.sweeper);
    const i = this.server.world.listeners.indexOf(this.blockListener); if (i >= 0) this.server.world.listeners.splice(i, 1);
    const j = this.server.listeners.indexOf(this.eventListener); if (j >= 0) this.server.listeners.splice(j, 1);
    for (const ch of Array.from(this.peers.keys())) { try { ch.close(); } catch (e) { /* ignore */ } }
    this.peers.clear();
    if (this.closer) this.closer.close();
  }

  /* ---------- lobby ---------- */
  humans() { return [{ id: 'p0', ...this.hostInfo, ready: true, host: true }, ...Array.from(this.peers.values()).filter((p) => p.joined).map((p) => ({ id: p.id, name: p.name, classId: p.classId, look: p.look, ready: p.ready, host: false }))]; }
  maxBots() { return Math.max(0, NET.MAX_PLAYERS - this.humans().length); }
  minBots() { return this.humans().length < 2 ? 1 : 0; }
  reroll() {
    this.cfg.seed = 1 + Math.floor(Math.random() * 9998);
    this.ai = []; const used = new Set(), pool = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    let classes = CLASS_ORDER.slice().sort(() => Math.random() - 0.5);
    for (let i = 0; i < 5; i++) { if (!classes.length) classes = CLASS_ORDER.slice().sort(() => Math.random() - 0.5); this.ai.push({ id: 'ai' + i, name: pool[i % pool.length], classId: classes.pop(), look: randomLook(), isBot: true, ready: true }); used.add(i); }
  }
  roster() {
    const humans = this.humans(), botsWanted = clamp(this.cfg.bots, this.minBots(), this.maxBots());
    return [...humans, ...this.ai.slice(0, botsWanted)];
  }
  lobbyMessage() {
    const roster = this.roster();
    return { t: 'lobby', cfg: { ...this.cfg, bots: clamp(this.cfg.bots, this.minBots(), this.maxBots()) }, code: this.code, roster: roster.map((r) => ({ id: r.id, name: r.name, classId: r.classId, look: r.look, ready: !!r.ready, host: !!r.host, isBot: !!r.isBot })), min: this.minBots(), max: this.maxBots(), providers: this.providers };
  }
  broadcastLobby() {
    this.hooks.onLobby && this.hooks.onLobby(this.lobbyMessage());
    const m = this.lobbyMessage();
    for (const peer of this.peers.values()) if (peer.joined) peer.ch.send({ ...m, you: peer.id });
  }
  setConfig(patch) {
    if (patch.mode && ['war', 'alliance', 'sandbox'].includes(patch.mode)) this.cfg.mode = patch.mode;
    if (patch.mapId && (MAPS[patch.mapId] || patch.mapId === 'random')) this.cfg.mapId = patch.mapId;
    if (patch.bots != null) this.cfg.bots = clamp(patch.bots | 0, 0, 5);
    if (patch.difficulty && DIFFICULTIES[patch.difficulty]) this.cfg.difficulty = patch.difficulty;
    if (patch.reroll) this.reroll();
    this.broadcastLobby();
  }
  /** After a match: everybody goes back to the lobby (a new seed and a fresh AI line-up). */
  returnToLobby() {
    if (this.state === 'closed') return;
    this.state = 'lobby'; this.endSent = false; this.step = 0; this.server.hold = false;
    for (const peer of this.peers.values()) { peer.ready = false; peer.loaded = false; }
    this.reroll(); this.broadcastLobby();
  }
  setHostInfo(info) { Object.assign(this.hostInfo, info); this.broadcastLobby(); }
  allReady() { return Array.from(this.peers.values()).every((p) => !p.joined || p.ready); }
  canStart() { const n = this.roster().length; return this.state === 'lobby' && this.allReady() && (this.cfg.mode === 'sandbox' ? n >= 1 : n >= 2); }

  onChannel(ch) {
    const peer = { ch, id: null, name: 'PLAYER', classId: 'builder', look: sanitizeLook(null), ready: false, joined: false, loaded: false, lastSeen: Date.now() };
    this.peers.set(ch, peer);
    ch.onmessage = (m) => this.onMessage(peer, m);
    ch.onclose = () => this.drop(peer);
  }
  onMessage(peer, m) {
    if (!m || typeof m !== 'object' || this.state === 'closed') return;
    peer.lastSeen = Date.now();
    try {
      switch (m.t) {
        case 'join': {
          if (m.v !== NET.VERSION) { peer.ch.send({ t: 'rejected', why: 'Game versions differ. Reload the page and try again.' }); return peer.ch.close(); }
          if (this.state !== 'lobby') { peer.ch.send({ t: 'rejected', why: 'That match has already started.' }); return peer.ch.close(); }
          if (this.humans().length >= NET.MAX_PLAYERS) { peer.ch.send({ t: 'rejected', why: 'That game is full (6 players).' }); return peer.ch.close(); }
          peer.id = 'p' + (this.nextId++); peer.joined = true;
          this.profile(peer, m);
          peer.ch.send({ t: 'welcome', id: peer.id });
          this.cfg.bots = Math.min(this.cfg.bots, this.maxBots());
          this.hooks.onJoin && this.hooks.onJoin(peer);
          this.broadcastLobby();
          break;
        }
        case 'prof': if (peer.joined && this.state === 'lobby') { this.profile(peer, m); this.broadcastLobby(); } break;
        case 'ready': if (peer.joined && this.state === 'lobby') { peer.ready = !!m.r; this.broadcastLobby(); } break;
        case 'loaded': this.onLoaded(peer, m); break;
        case 'in': this.onInputs(peer, m); break;
        case 'act': this.onAction(peer, m); break;
        case 'chat': if (peer.joined) this.onChat(peer, m); break;
        case 'ping': peer.ch.send({ t: 'pong', c: m.c }); break;
        case 'bye': peer.ch.close(); break;
        default: break;
      }
    } catch (err) { if (typeof console !== 'undefined') console.error('net:', err); }
  }
  /** Chat: filtered and rate-limited here so every player sees the same clean text. Team chat only reaches allies. */
  onChat(peer, m) {
    if (!chatAllowed(peer)) { peer.ch.send({ t: 'chat', sys: 1, x: 'Slow down: you are sending messages too fast.' }); return; }
    this.relayChat(peer.id, peer.name, m.x, !!m.tm, !!m.me);
  }
  sendChat(text, team, me) { this.relayChat('p0', this.hostInfo.name, text, !!team, !!me); }
  relayChat(id, name, text, team, me) {
    const x = chatFilter(chatClean(text)); if (!x) return;
    const msg = { t: 'chat', id, n: name, x, tm: team ? 1 : 0, me: me ? 1 : 0 };
    const sender = this.state === 'playing' ? this.server.playerById(id) : null;
    const sees = (pid) => { if (!team || !sender) return true; const q = this.server.playerById(pid); return !!q && (q === sender || this.server.areAllies(sender, q)); };
    for (const peer of this.peers.values()) if (peer.joined && sees(peer.id)) peer.ch.send(msg);
    if (sees('p0')) this.hooks.onChat && this.hooks.onChat(msg);
  }
  profile(peer, m) {
    if (typeof m.name === 'string') peer.name = m.name.replace(/[^\w \-]/g, '').slice(0, 12) || 'PLAYER';
    if (CLASSES[m.classId]) peer.classId = m.classId;
    if (m.look) peer.look = sanitizeLook(m.look);
    const dup = Array.from(this.peers.values()).filter((p) => p !== peer && p.joined && p.name === peer.name).length + (this.hostInfo.name === peer.name ? 1 : 0);
    if (dup) peer.name = (peer.name.slice(0, 10) + (dup + 1));
  }
  sweep() {
    const now = Date.now();
    for (const peer of Array.from(this.peers.values())) if (now - peer.lastSeen > NET.TIMEOUT) peer.ch.close();
    if (this.state === 'lobby') this.broadcastLobby();                       // doubles as keep-alive for clients
    if (this.state === 'playing' && this.server.hold) {
      const loadedAll = Array.from(this.peers.values()).every((p) => !p.joined || p.loaded);
      if (loadedAll || Date.now() - this.holdSince > 20000) { this.server.hold = false; }
    }
  }

  /* ---------- match ---------- */
  /** Starts the match on the host. Returns the config clients need to rebuild the same world. */
  startMatch(extra = {}) {
    if (!this.canStart()) return null;
    const roster = this.roster().map((r) => ({ id: r.isBot ? undefined : r.id, name: r.name, classId: r.classId, isBot: !!r.isBot, look: r.look }));
    const cfg = { mode: this.cfg.mode, seed: this.cfg.seed, mapId: this.cfg.mapId, difficulty: this.cfg.difficulty, roster, ...extra };
    this.blockQ.length = 0; this.evQ.length = 0;
    this.server.startMatch(cfg);
    this.state = 'playing';
    // the generated roster has final names/ids/classes for the bots as well
    const final = this.server.players.map((p) => ({ id: p.id, name: p.name, classId: p.classId, isBot: p.isBot, look: p.look }));
    this.startMsg = { t: 'start', cfg: { mode: cfg.mode, seed: cfg.seed, mapId: this.server.mapId, lands: this.server.lands, roster: final }, hash: hashWorld(this.server.world) };
    for (const p of this.server.players) if (!p.isBot && p.id !== 'p0') { p.isRemote = true; p.inQueue = []; }
    this.server.hold = this.peers.size > 0; this.holdSince = Date.now();
    this.blockQ.length = 0; this.evQ.length = 0;
    for (const peer of this.peers.values()) if (peer.joined) { peer.loaded = false; peer.ch.send({ ...this.startMsg, you: this.server.players.findIndex((p) => p.id === peer.id) }); }
    return this.startMsg;
  }
  onLoaded(peer, m) {
    if (this.state !== 'playing' || !peer.joined) return;
    if (m.hash !== this.startMsg.hash) {                                     // generator disagreement: send the world itself
      const w = this.server.world;
      peer.ch.send({ t: 'world', blocks: rleEncode(w.blocks), meta: rleEncode(w.meta), owner: rleEncode(w.owner) });
    }
    peer.loaded = true;
    if (Array.from(this.peers.values()).every((p) => !p.joined || p.loaded)) this.server.hold = false;
  }
  onInputs(peer, m) {
    const p = this.server.playerById(peer.id);
    if (!p || !p.isRemote || !Array.isArray(m.s)) return;
    for (const i of m.s.slice(0, 20)) {
      if (!Array.isArray(i) || i.length < 4) continue;
      const [seq, bits, yaw, pitch] = i;
      if (!Number.isFinite(seq) || !Number.isFinite(yaw) || !Number.isFinite(pitch)) continue;
      p.inQueue.push({ seq, bits: bits | 0, yaw, pitch });
    }
    if (p.inQueue.length > 40) p.inQueue.splice(0, p.inQueue.length - 20);
  }
  onAction(peer, m) {
    const p = this.server.playerById(peer.id);
    if (!p || !p.isRemote || !m.m || typeof m.m !== 'object' || this.state !== 'playing') return;
    const msg = m.m;
    if (!['break', 'place', 'use', 'attack', 'shoot', 'ignite', 'propose', 'respond', 'leaveAlliance', 'bounty', 'emote', 'hold', 'block', 'swing', 'scoop'].includes(msg.type)) return;
    for (const k of ['x', 'y', 'z']) if (k in msg && !Number.isInteger(msg[k])) return;
    if (msg.type === 'place' && !ITEMS[msg.item]) return;
    if (msg.type === 'shoot') msg.charge = clamp(+msg.charge || 0, 0, 1);
    const r = this.server.handle(p.id, msg);
    if (r && !r.ok && r.reason !== 'cooldown') peer.ch.send({ t: 'res', r: r.reason, a: msg.type, item: msg.item });
  }
  drop(peer) {
    if (!this.peers.has(peer.ch)) return;
    this.peers.delete(peer.ch);
    if (this.state === 'lobby') { this.broadcastLobby(); this.hooks.onLeave && this.hooks.onLeave(peer); return; }
    const p = this.server.playerById(peer.id);
    if (p && this.state === 'playing') {                                       // the AI takes over the abandoned character
      p.isRemote = false; p.isBot = true; p.inQueue = null; p.bot = new Bot(this.server, p);
      this.server.emit({ type: 'playerLeft', player: p });
    }
    this.hooks.onLeave && this.hooks.onLeave(peer);
  }

  /* ---------- per-tick streaming ---------- */
  captureEvent(e) {
    if (e.type === 'matchEnd' || e.type === 'matchStart') return;
    if (this.evQ.length > 500 && LOW_PRIORITY_EVENTS.has(e.type)) return;
    const o = netPack(e);
    if (e.type === 'groupFormed') {                                            // clients need the blocks of the new falling group
      const cells = []; for (const c of e.group.cells) cells.push(c.x, c.y, c.z, c.id, c.meta || 0, c.owner || 0);
      o.cells = cells; o.group = { $g: e.group.id };
    }
    this.evQ.push(o);
  }
  /** Called once per simulation step (after GameServer.update). */
  afterStep() {
    if (this.state !== 'playing') return;
    const s = this.server;
    if (s.phase === 'ended' && !this.endSent) { this.endSent = true; this.sendEnd(); }
    if (++this.step % NET.TICK_STEPS) return;
    const snap = this.makeSnap(), bl = this.blockQ.splice(0), ev = this.evQ.splice(0);
    this.tickNo++;
    for (const peer of this.peers.values()) {
      if (!peer.joined || !peer.loaded) continue;
      peer.ch.send({ t: 'tick', n: this.tickNo, s: snap, me: this.makeMe(peer), bl, ev });
    }
  }
  sendEnd() {
    const R = this.server.results;
    const msg = { t: 'end', winners: R.winners.map((p) => p.index), reason: R.reason, rows: R.rows.map((r) => { const { player, ...rest } = r; return { ...rest, pi: player.index }; }) };
    for (const peer of this.peers.values()) if (peer.joined) peer.ch.send(msg);
  }
  makeSnap() {
    const s = this.server;
    return {
      c: s.clock, ph: s.phase, pt: s.phaseTime, dk: s.darkness, gs: s.gravityScale,
      ev: s.event ? { type: s.event.type, name: s.event.name, state: s.event.state, duration: s.event.duration, t: s.event.t } : null,
      v: { progress: s.vault.progress, team: s.vault.team, cooldown: s.vault.cooldown, capturing: s.vault.capturing, captured: s.vault.captured, stage: s.vault.stage || 0 },
      p: s.players.map((p) => ({
        i: p.index, x: p.pos.x, y: p.pos.y, z: p.pos.z, yw: p.yaw, pt: p.pitch, hp: p.health, al: p.alive ? 1 : 0, cr: p.crouching ? 1 : 0, bu: p.burnTime > 0 ? 1 : 0,
        wk: p.walkPhase, sw: p.swing, bo: p.bounty, tm: p.team, bot: p.isBot ? 1 : 0, mv: Math.hypot(p.vel.x, p.vel.z) > 1.2 && p.onGround ? 1 : 0, hd: p.held, sk: p.swingKind, bk: p.blocking ? 1 : 0, sp: p.sprinting ? 1 : 0, ci: p.chillT > 0 ? 1 : 0, bf: (p.buffs.rage > 0 ? 1 : 0) | (p.buffs.swift > 0 ? 2 : 0) | (p.buffs.armor > 0 ? 4 : 0), ks: p.streak || 0,
        st: [p.stats.score, p.stats.kills, p.stats.assists, p.stats.deaths, p.stats.damageDealt, p.stats.blocksDestroyed, p.stats.structuresDestroyed, p.stats.tntKills, p.stats.objectives],
      })),
      tn: s.tnts.filter((t) => t.alive).map((t) => [t.id, t.pos.x, t.pos.y, t.pos.z, t.fuse]),
      ar: s.arrows.filter((a) => a.alive).map((a) => [a.pos.x, a.pos.y, a.pos.z, a.yaw, a.pitch, WEAPON_SKIN_ORDER.indexOf(a.skin || 'default'), a.stuck ? 1 : 0]),
      dr: (s.drops || []).map((d) => [d.id, d.x, d.y, d.z, d.state === 'landed' ? 1 : 0, +d.prog.toFixed(2)]),
      mb: s.mobs.filter((m) => m.alive).map((m) => [m.id, m.type, m.pos.x, m.pos.y, m.pos.z, m.yaw, m.walkPhase, m.swing, m.fuse]),
      mt: s.meteors.map((m) => [m.pos.x, m.pos.y, m.pos.z]),
      pm: s.pendingMeteors.filter((q) => !q.done).map((q) => [q.x, q.y, q.z, q.t]),
      gr: s.groups.filter((g) => g.alive !== false).map((g) => [g.id, g.off]),
      ig: s.players.map((p) => s.integrity(p.index)), bd: s.baseDestroyed.slice(0, 6).map((b) => (b ? 1 : 0)),
      pr: s.proposals.map((q) => [q.from.index, q.to.index]),
    };
  }
  makeMe(peer) {
    const p = this.server.playerById(peer.id);
    if (!p) return null;
    return { x: p.pos.x, y: p.pos.y, z: p.pos.z, vx: p.vel.x, vy: p.vel.y, vz: p.vel.z, og: p.onGround ? 1 : 0, ack: p.ackSeq | 0, res: p.resources, cd: [p.cooldowns.attack, p.cooldowns.place, p.cooldowns.shoot], inv: p.invulnerable, ch: p.chillT || 0, bf: p.buffs, air: p.air };
  }
}

/* ============================== CLIENT SESSION ============================== */
/** The joining side of a lobby/match. Callbacks are filled in by the game controller. */
class ClientSession {
  constructor(ch) {
    this.ch = ch; this.id = null; this.closed = false; this.lastRecv = Date.now();
    this.on = { chat() {}, lobby() {}, start() {}, tick() {}, end() {}, closed() {}, rejected() {}, world() {}, res() {} };
    ch.onmessage = (m) => this.recv(m);
    ch.onclose = () => this.finish('Connection lost.');
    this.pinger = setInterval(() => { if (this.closed) return; this.ch.send({ t: 'ping', c: Date.now() }); if (Date.now() - this.lastRecv > NET.TIMEOUT) { this.finish('Lost contact with the host.'); this.ch.close(); } }, 1500);
  }
  send(m) { if (!this.closed) this.ch.send(m); }
  join(profile) { this.send({ t: 'join', v: NET.VERSION, name: profile.name, classId: profile.classId, look: profile.look }); }
  recv(m) {
    if (!m || typeof m !== 'object') return;
    this.lastRecv = Date.now();
    switch (m.t) {
      case 'welcome': this.id = m.id; break;
      case 'chat': this.on.chat(m); break;
      case 'lobby': this.on.lobby(m); break;
      case 'start': this.on.start(m); break;
      case 'tick': this.on.tick(m); break;
      case 'world': this.on.world(m); break;
      case 'end': this.on.end(m); break;
      case 'res': this.on.res(m); break;
      case 'rejected': this.closed = true; this.done = true; clearInterval(this.pinger); this.on.rejected(m.why); break;
      case 'closed': this.finish(m.why || 'The host closed the game.'); break;
      case 'bye': this.finish('The host left.'); break;
      case 'pong': this.rtt = Date.now() - m.c; break;
      default: break;
    }
  }
  finish(why) { if (this.done) return; this.closed = true; this.done = true; clearInterval(this.pinger); this.on.closed(why); }
  leave() { if (!this.closed) { try { this.ch.send({ t: 'bye' }); } catch (e) { /* ignore */ } } this.closed = true; this.done = true; clearInterval(this.pinger); try { this.ch.close(); } catch (e) { /* ignore */ } }
}

/* ============================== CLIENT-SIDE SERVER VIEW ============================== */
const INPUT_BITS = { forward: 1, back: 2, left: 4, right: 8, jump: 16, crouch: 32, sprint: 64 };
/**
 * Looks like a GameServer to the rest of the client (UI, renderer, replay), but only mirrors what the host sends.
 * The local player is predicted with the same physics and corrected by the host (input sequence numbers).
 */
class NetServerView {
  constructor(world, session) {
    this.world = world; this.session = session; this.listeners = [];
    this.players = []; this.playerMap = new Map(); this.mobs = []; this.mobById = new Map(); this.tnts = []; this.arrows = []; this.meteors = []; this.pendingMeteors = [];
    this.groups = []; this.groupById = new Map(); this.droppedGroups = [];
    this.fluids = { pending: { size: 0 } }; this.fire = { fires: new Set() }; this.redstone = { mechs: new Set() };
    this.phase = 'countdown'; this.phaseTime = 0; this.clock = 0; this.darkness = 0; this.gravityScale = 1; this.mode = 'war'; this.allianceMode = false; this.unlimited = false;
    this.event = null; this.vault = { progress: 0, team: -1, cooldown: 0, capturing: false, captured: 0 }; this.drops = [];
    this.proposals = []; this.baseDestroyed = [false, false, false, false, false, false]; this.integ = [100, 100, 100, 100, 100, 100];
    this.map = null; this.plots = []; this.results = null; this.replayAvailable = false;
    this.seq = 0; this.pending = []; this.outInputs = []; this.me = null; this.lastTickNo = 0;
    this.snapAt = 0; this.snapInterval = 0.05; this.stepCount = 0;
    this.worldListener = (x, y, z, o, n) => {
      const d = BLOCKS[n];
      const k = keyOf(x, y, z);
      if (n === ID.fire) this.fire.fires.add(k); else if (o === ID.fire) this.fire.fires.delete(k);
      if (d.mech) this.redstone.mechs.add(k); else if (BLOCKS[o].mech) this.redstone.mechs.delete(k);
    };
    world.listeners.push(this.worldListener);
  }
  dispose() { const i = this.world.listeners.indexOf(this.worldListener); if (i >= 0) this.world.listeners.splice(i, 1); }
  subscribe(fn) { this.listeners.push(fn); }
  emit(e) {
    if (e.type === 'phase' && e.phase === 'war' && !this.wallsDropped) { this.wallsDropped = true; removePlotWalls(this.world, this.wallCells, null); }
    else if (e.type === 'layerFilled' && e.meta != null) fillFluidLayer(this.world, e.y, e.id, e.meta);
    else if (e.type === 'layerDrained') drainFluidLayer(this.world, e.y, e.id);
    for (const fn of this.listeners) fn(e);
  }
  get human() { return this.me; }
  areAllies(a, b) { return !!a && !!b && a !== b && a.team === b.team; }
  alivePlayers() { return this.players.filter((p) => p.alive); }
  bodies() { const r = []; for (const p of this.players) if (p.alive) r.push(p); for (const m of this.mobs) if (m.alive) r.push(m); return r; }
  scoreboard() { return this.players.slice().sort((a, b) => b.stats.score - a.stats.score); }
  integrity(slot) { return this.integ[slot] == null ? 100 : this.integ[slot]; }
  coreShielded() { return this.phase === 'war' && this.phaseTime < CONFIG.MATCH.CORE_SHIELD; }
  timeLeft(total = false) {
    const M = CONFIG.MATCH, left = { countdown: M.COUNTDOWN, build: M.BUILD, war: M.WAR - M.CHAOS, chaos: M.CHAOS }[this.phase];
    if (left == null) return 0;
    const cur = Math.max(0, left - this.phaseTime);
    if (!total) return cur;
    return this.phase === 'build' ? cur + M.WAR : this.phase === 'war' ? cur + M.CHAOS : cur;
  }
  assignLands(seed) { return assignLandList(seed); }

  /** Builds the same map the host built, plus a Player object per competitor. */
  start(msg) {
    const cfg = msg.cfg, n = cfg.roster.length;
    this.mode = cfg.mode; this.unlimited = cfg.mode === 'sandbox'; this.allianceMode = cfg.mode === 'alliance';
    this.mapId = cfg.mapId; this.lands = cfg.lands;
    this.world.clear();
    this.map = MapGenerator.generate(this.world, { seed: cfg.seed != null ? cfg.seed : 1337, mapId: cfg.mapId, lands: cfg.lands, owners: [0, 1, 2, 3, 4, 5].map((i) => (i < n ? i : -1)), walls: cfg.mode !== 'sandbox', cores: cfg.mode !== 'sandbox' });
    this.plots = this.map.plots; this.wallCells = this.map.wallCells || []; this.wallsDropped = false;
    this.fire.fires.clear(); this.redstone.mechs.clear();
    const w = this.world;
    for (let y = 0; y < w.sizeY; y++) for (let z = 0; z < w.sizeZ; z++) for (let x = 0; x < w.sizeX; x++) {
      const id = w.blocks[w.index(x, y, z)]; if (id === AIR) continue;
      if (BLOCKS[id].mech) this.redstone.mechs.add(keyOf(x, y, z)); if (id === ID.fire) this.fire.fires.add(keyOf(x, y, z));
    }
    this.players = []; this.playerMap.clear(); this.mobs = []; this.mobById.clear(); this.tnts = []; this.arrows = []; this.meteors = []; this.pendingMeteors = []; this.groups = []; this.groupById.clear();
    cfg.roster.forEach((r, i) => {
      const p = new Player(r.id || ('b' + i), r.name);
      p.index = i; p.color = CONFIG.COLORS[i % CONFIG.COLORS.length]; p.isBot = !!r.isBot; p.classId = r.classId; p.look = sanitizeLook(r.look); p.landId = cfg.lands[i];
      p.mods = DEFAULT_MODS(); Object.assign(p.mods, CLASSES[p.classId].mods);
      const plot = this.plots[i]; p.spawn = { x: plot.spawn.x, y: plot.spawn.y, z: plot.spawn.z };
      p.teleport(p.spawn.x, p.spawn.y, p.spawn.z); p.team = 1000 + i;
      p.resources = startResources(p.classId, p.landId, this.unlimited);
      this.players.push(p); this.playerMap.set(p.id, p);
    });
    this.me = this.players[msg.you]; this.me.isRemote = false;
    this.me.yaw = Math.atan2(-(this.map.center.x - this.me.spawn.x), -(this.map.center.z - this.me.spawn.z)); this.me.pitch = -0.1;
    this.phase = 'countdown'; this.phaseTime = 0; this.clock = 0; this.event = null; this.darkness = 0; this.gravityScale = 1;
    this.results = null; this.baseDestroyed = [false, false, false, false, false, false]; this.integ = [100, 100, 100, 100, 100, 100];
    this.vault = { progress: 0, team: -1, cooldown: 0, capturing: false, captured: 0 }; this.drops = [];
    this.seq = 0; this.pending.length = 0; this.outInputs.length = 0; this.proposals = []; this.snapAt = performance_now(); this.hasSnap = false;
    return hashWorld(this.world);
  }
  /** Replaces the world with the host's copy (used only if the two generators ever disagree). */
  loadWorld(msg) { rleDecode(msg.blocks, this.world.blocks); rleDecode(msg.meta, this.world.meta); rleDecode(msg.owner, this.world.owner); }

  /** One packet from the host: block changes, then events, then the entity snapshot. */
  applyTick(m) {
    if (!this.me) return;
    const w = this.world, bl = m.bl;
    for (let i = 0; i < bl.length; i += 6) w.set(bl[i], bl[i + 1], bl[i + 2], bl[i + 3], false, bl[i + 4], bl[i + 5]);
    this.applySnap(m.s, m.me);
    for (const e of m.ev) {
      if (e.type === 'groupFormed' && e.cells) this.addGroup(e.group.$g, e.cells);
      const ev = netUnpack(e, this);
      if (e.type === 'groupFormed') ev.group = this.groupById.get(e.group.$g) || ev.group;
      this.emit(ev);
    }
  }
  addGroup(id, flat) {
    const cells = [];
    for (let i = 0; i < flat.length; i += 6) cells.push({ x: flat[i], y: flat[i + 1], z: flat[i + 2], id: flat[i + 3], meta: flat[i + 4], owner: flat[i + 5] });
    let minX = 1e9, maxX = -1e9, minY = 1e9, maxY = -1e9, minZ = 1e9, maxZ = -1e9;
    for (const c of cells) { minX = Math.min(minX, c.x); maxX = Math.max(maxX, c.x); minY = Math.min(minY, c.y); maxY = Math.max(maxY, c.y); minZ = Math.min(minZ, c.z); maxZ = Math.max(maxZ, c.z); }
    const g = { id, cells, off: 0, bounds: { minX, maxX: maxX + 1, minY, maxY: maxY + 1, minZ, maxZ: maxZ + 1 } };
    this.groupById.set(id, g);
    return g;
  }
  applySnap(s, mine) {
    const now = performance_now();
    this.snapInterval = clamp((now - this.snapAt) / 1000, 0.02, 0.2); this.snapAt = now; this.hasSnap = true;
    this.clock = s.c; this.phase = s.ph; this.phaseTime = s.pt; this.darkness = s.dk; this.gravityScale = s.gs;
    this.event = s.ev; this.vault = s.v;
    this.integ = s.ig; this.baseDestroyed = s.bd.map((b) => !!b);
    for (const q of s.p) {
      const p = this.players[q.i]; if (!p) continue;
      const mineP = p === this.me;
      if (!mineP) { p.prev.x = p.pos.x; p.prev.y = p.pos.y; p.prev.z = p.pos.z; p.pos.x = q.x; p.pos.y = q.y; p.pos.z = q.z; p.yaw = q.yw; p.pitch = q.pt; }
      if (p.alive && !q.al) p.alive = false; else if (!p.alive && q.al) { p.alive = true; if (mineP) { p.teleport(q.x, q.y, q.z); this.pending.length = 0; } }
      p.health = q.hp; p.crouching = !!q.cr; p.burnTime = q.bu ? 1 : 0; p.walkPhase = q.wk; if (!mineP) p.swing = q.sw; p.bounty = q.bo; p.team = q.tm; p.isBot = !!q.bot;
      p.moving = !!q.mv; p.held = q.hd || 'pickaxe'; p.swingKind = q.sk || 'sword'; p.sprinting = !!q.sp; if (!mineP) { p.blocking = !!q.bk; p.chillT = q.ci ? 1 : 0; p.buffs = { rage: q.bf & 1 ? 1 : 0, swift: q.bf & 2 ? 1 : 0, armor: q.bf & 4 ? 1 : 0 }; }
      p.streak = q.ks || 0;
      const st = p.stats; [st.score, st.kills, st.assists, st.deaths, st.damageDealt, st.blocksDestroyed, st.structuresDestroyed, st.tntKills, st.objectives] = q.st;
    }
    // other bodies
    const seenT = new Set();
    this.tnts = s.tn.map((t) => { const old = this.tnts.find((x) => x.id === t[0]); const o = old || { id: t[0], pos: { x: t[1], y: t[2], z: t[3] }, prev: { x: t[1], y: t[2], z: t[3] }, vel: { x: 0, y: 0, z: 0 }, alive: true }; o.prev.x = o.pos.x; o.prev.y = o.pos.y; o.prev.z = o.pos.z; o.pos.x = t[1]; o.pos.y = t[2]; o.pos.z = t[3]; o.fuse = t[4]; seenT.add(o.id); return o; });
    this.arrows = s.ar.map((a) => ({ pos: { x: a[0], y: a[1], z: a[2] }, yaw: a[3], pitch: a[4], alive: true, skin: WEAPON_SKIN_ORDER[a[5]] || 'default', stuck: !!a[6] }));
    this.drops = (s.dr || []).map((d) => ({ id: d[0], x: d[1], y: d[2], z: d[3], state: d[4] ? 'landed' : 'falling', prog: d[5] }));
    this.meteors = s.mt.map((m) => ({ pos: { x: m[0], y: m[1], z: m[2] } }));
    this.pendingMeteors = s.pm.map((q) => ({ x: q[0], y: q[1], z: q[2], t: q[3] }));
    const mobs = [];
    for (const r of s.mb) {
      let m = this.mobById.get(r[0]);
      if (!m) { m = new Mob(r[0], r[2], r[3], r[4], r[1]); this.mobById.set(r[0], m); }
      m.prev.x = m.pos.x; m.prev.y = m.pos.y; m.prev.z = m.pos.z; m.pos.x = r[2]; m.pos.y = r[3]; m.pos.z = r[4]; m.yaw = r[5]; m.walkPhase = r[6]; m.swing = r[7]; m.fuse = r[8]; m.alive = true;
      mobs.push(m);
    }
    for (const [id, m] of this.mobById) if (!mobs.includes(m)) { m.alive = false; this.mobById.delete(id); }
    this.mobs = mobs;
    this.groups = s.gr.map((g) => { const grp = this.groupById.get(g[0]); if (grp) { grp.off = g[1]; grp.seen = true; } return grp; }).filter(Boolean);
    const live = new Set(s.gr.map((g) => g[0]));
    for (const [id, g] of this.groupById) { g.age = (g.age || 0) + 1; if (!live.has(id) && (g.seen || g.age > 6)) { this.groupById.delete(id); this.droppedGroups.push(g); } }
    this.proposals = s.pr.map(([a, b]) => ({ from: this.players[a], to: this.players[b], time: this.clock }));
    // ---- own player: authoritative state, then replay the inputs the host has not seen yet ----
    if (mine && this.me) this.reconcile(mine);
  }
  reconcile(a) {
    const me = this.me;
    me.resources = a.res; me.invulnerable = a.inv; me.chillT = a.ch || 0; me.buffs = a.bf || {}; me.air = a.air;
    me.cooldowns.attack = Math.max(me.cooldowns.attack, a.cd[0]); me.cooldowns.place = Math.max(me.cooldowns.place, a.cd[1]); me.cooldowns.shoot = Math.max(me.cooldowns.shoot, a.cd[2]);
    while (this.pending.length && this.pending[0].seq <= a.ack) this.pending.shift();
    if (!me.alive) { me.pos.x = a.x; me.pos.y = a.y; me.pos.z = a.z; me.prev.x = a.x; me.prev.y = a.y; me.prev.z = a.z; return; }
    const px = me.pos.x, py = me.pos.y, pz = me.pos.z;
    me.pos.x = a.x; me.pos.y = a.y; me.pos.z = a.z; me.vel.x = a.vx; me.vel.y = a.vy; me.vel.z = a.vz; me.onGround = !!a.og;
    const env = { gravityScale: this.gravityScale }, yaw = me.yaw, pitch = me.pitch;
    for (const i of this.pending) { me.yaw = i.yaw; me.update(CONFIG.STEP, i.c, this.world, env); }
    me.yaw = yaw; me.pitch = pitch;
    const err = Math.hypot(me.pos.x - px, me.pos.y - py, me.pos.z - pz);
    if (err < 0.02) { me.pos.x = px; me.pos.y = py; me.pos.z = pz; }                      // already agreed: keep the smooth path
    else if (err > 4) { me.prev.x = me.pos.x; me.prev.y = me.pos.y; me.prev.z = me.pos.z; }  // big correction (teleport, explosion): snap
  }

  /** Fixed-step update from the game loop. Predicts the local player and queues its input for the host. */
  update(dt) {
    if (!this.me) return;
    this.stepCount++; this.clock += dt; this.phaseTime += dt;
    const me = this.me;
    if (me.alive && this.phase !== 'ended') {
      const c = me.controls; let bits = 0;
      for (const k in INPUT_BITS) if (c[k]) bits |= INPUT_BITS[k];
      const copy = { forward: !!c.forward, back: !!c.back, left: !!c.left, right: !!c.right, jump: !!c.jump, crouch: !!c.crouch, sprint: !!c.sprint };
      this.seq++;
      this.pending.push({ seq: this.seq, c: copy, yaw: me.yaw });
      if (this.pending.length > 240) this.pending.shift();
      this.outInputs.push([this.seq, bits, me.yaw, me.pitch]);
      me.update(dt, copy, this.world, { gravityScale: this.gravityScale });
      me.invulnerable = Math.max(0, me.invulnerable - dt);
    } else for (const k in me.cooldowns) me.cooldowns[k] = Math.max(0, me.cooldowns[k] - dt);
    if (me.blocking) { me.blockT += dt; if (me.blockT > 2.5) { me.blocking = false; me.blockCd = 1.6; } } else me.blockCd = Math.max(0, me.blockCd - dt);
    if (this.outInputs.length >= NET.TICK_STEPS) this.session.send({ t: 'in', s: this.outInputs.splice(0) });
  }
  /** Client requests: the host decides. Returns optimistically; refusals come back as 'rejected' events. */
  handle(playerId, msg) {
    if (!this.me || this.me.id !== playerId) return { ok: false, reason: 'unknown-player' };
    if (!this.me.alive) return { ok: false, reason: 'dead' };
    if (msg.type === 'hold') this.me.held = msg.item;
    else if (msg.type === 'block') { if (msg.on) { if (this.me.blockCd <= 0 && !this.me.blocking) { this.me.blocking = true; this.me.blockT = 0; } } else if (this.me.blocking) { this.me.blocking = false; this.me.blockCd = 0.35; } }
    if (msg.type === 'swing' && !msg.mining) { const T = TOOLS[msg.tool]; if (T && T.cd && T.dmg != null) this.me.cooldowns.attack = T.cd * this.me.mods.attackCooldown * (weaponBoost(this.me.look, msg.tool).speed || 1); }
    if (msg.type === 'attack') { const T = TOOLS[msg.tool]; this.me.cooldowns.attack = T && T.cd ? T.cd * this.me.mods.attackCooldown * (weaponBoost(this.me.look, msg.tool).speed || 1) : 0.5; }
    else if (msg.type === 'place') this.me.cooldowns.place = Math.max(this.me.cooldowns.place, 0.15 * this.me.mods.placeCooldown);
    else if (msg.type === 'shoot') this.me.cooldowns.shoot = Math.max(this.me.cooldowns.shoot, 0.4);
    this.session.send({ t: 'act', m: msg });
    return { ok: true, pending: true };
  }
  /** Interpolated entity positions for rendering (same shape as GameServer.snapshot). */
  snapshot(alpha = 1) {
    const f = this.hasSnap ? clamp((performance_now() - this.snapAt) / 1000 / Math.max(this.snapInterval, 0.04), 0, 1) : 1;
    const A = (b, k) => lerp(b.prev[k], b.pos[k], f), me = this.me;
    const L = (b, k) => (b === me ? lerp(b.prev[k], b.pos[k], alpha) : A(b, k));
    return {
      time: this.clock,
      players: this.players.map((p) => ({ id: p.id, index: p.index, name: p.name, color: p.color, classId: p.classId, alive: p.alive, health: p.health, x: L(p, 'x'), y: L(p, 'y'), z: L(p, 'z'), yaw: p.yaw, pitch: p.pitch, walk: p.walkPhase, swing: p.swing, crouch: p.crouching, burning: p.burnTime > 0, isBot: p.isBot, team: p.team, bounty: p.bounty, look: p.look, held: p.held, sk: p.swingKind, blocking: p.blocking, sprinting: p.sprinting, chilled: p.chillT > 0, moving: p === me ? Math.hypot(p.vel.x, p.vel.z) > 1.2 && p.onGround : !!p.moving })),
      tnts: this.tnts.map((t) => ({ x: A(t, 'x'), y: A(t, 'y'), z: A(t, 'z'), fuse: t.fuse })),
      groups: this.groups.map((g) => ({ g, off: g.off })),
      arrows: this.arrows.map((a) => ({ x: a.pos.x, y: a.pos.y, z: a.pos.z, yaw: a.yaw, pitch: a.pitch, skin: a.skin, stuck: a.stuck })),
      drops: (this.drops || []).map((d) => ({ id: d.id, x: d.x, y: d.y, z: d.z, landed: d.state === 'landed', prog: d.prog })),
      mobs: this.mobs.filter((m) => m.alive).map((m) => ({ id: m.id, type: m.type, fuse: m.fuse, x: A(m, 'x'), y: A(m, 'y'), z: A(m, 'z'), yaw: m.yaw, walk: m.walkPhase, swing: m.swing })),
      meteors: this.meteors.map((m) => ({ x: m.pos.x, y: m.pos.y, z: m.pos.z })),
      banners: this.plots.filter((pl) => pl.owner >= 0 && this.players[pl.owner]).map((pl) => { const q = this.players[pl.owner]; return { x: pl.x + 3.5, y: pl.baseY + 1, z: pl.z + 3.5, color: q.color, banner: q.look.banner, bc: q.look.bannerColor }; }),
    };
  }
  /** Final results from the host, rebuilt with local Player objects. */
  setResults(m) {
    this.results = { winners: m.winners.map((i) => this.players[i]), reason: m.reason, rows: m.rows.map((r) => { const { pi, ...rest } = r; return { player: this.players[pi], ...rest }; }) };
    this.phase = 'ended';
  }
}
const performance_now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/* ============================== 12. BOTS ================================ */
/**
 * Bots drive their Player exactly like a human would: they only set controls/yaw/pitch and send requests to
 * GameServer.handle(). No bot code touches the world directly, so bots obey every rule (reach, phase, resources).
 */
const TAU = Math.PI * 2;
const angleDiff = (a, b) => { let d = (b - a) % TAU; if (d > Math.PI) d -= TAU; if (d < -Math.PI) d += TAU; return d; };

/**
 * Every AI opponent rolls a personality (archetype) that is biased by its class but never fixed by it, jitters every number,
 * and re-rolls its tactical "mood" every half minute or so. Two bots of the same class rarely behave the same twice.
 */
const ARCHETYPES = {
  rusher:      { label: 'Rusher',      aggr: 0.9,  greed: 0.25, range: 0.2, tnt: 0.7, home: 0.1, approach: ['ground', 'ground', 'sky'], build: ['ring', 'keep'],  melee: ['sword', 'sword', 'axe'] },
  turtle:      { label: 'Turtle',      aggr: 0.3,  greed: 0.35, range: 0.5, tnt: 0.3, home: 0.9, approach: ['ground', 'tunnel'],        build: ['keep', 'moat', 'ring'], melee: ['sword', 'axe'] },
  trapper:     { label: 'Trapper',     aggr: 0.45, greed: 0.3,  range: 0.5, tnt: 0.8, home: 0.7, approach: ['tunnel', 'ground'],        build: ['trapfield', 'ring'],    melee: ['staff', 'sword'] },
  bomber:      { label: 'Bomber',      aggr: 0.7,  greed: 0.2,  range: 0.4, tnt: 1.0, home: 0.3, approach: ['ground', 'sky', 'tunnel'], build: ['ring', 'trapfield'],    melee: ['axe', 'sword'] },
  sniper:      { label: 'Sniper',      aggr: 0.55, greed: 0.3,  range: 1.0, tnt: 0.3, home: 0.5, approach: ['sky', 'ground'],           build: ['keep', 'ring'],         melee: ['sword', 'staff'] },
  digger:      { label: 'Digger',      aggr: 0.6,  greed: 0.35, range: 0.3, tnt: 0.6, home: 0.4, approach: ['tunnel', 'tunnel', 'ground'], build: ['moat', 'ring'],       melee: ['axe', 'sword'] },
  opportunist: { label: 'Opportunist', aggr: 0.6,  greed: 0.6,  range: 0.5, tnt: 0.5, home: 0.3, approach: ['ground', 'sky', 'tunnel'], build: ['ring', 'keep', 'moat'], melee: ['sword', 'axe', 'staff'] },
  vaulter:     { label: 'Vault runner', aggr: 0.45, greed: 1.0, range: 0.4, tnt: 0.4, home: 0.3, approach: ['ground', 'sky'],          build: ['ring', 'keep'],         melee: ['sword', 'staff'] },
};
const CLASS_BIAS = {
  builder: ['turtle', 'trapper', 'turtle', 'digger', 'opportunist'], fighter: ['rusher', 'rusher', 'opportunist', 'sniper', 'bomber'],
  engineer: ['trapper', 'digger', 'trapper', 'bomber', 'turtle'], demolitionist: ['bomber', 'bomber', 'rusher', 'trapper', 'digger'],
  scout: ['sniper', 'vaulter', 'opportunist', 'rusher', 'sniper'], survivalist: ['turtle', 'opportunist', 'vaulter', 'digger', 'sniper'],
};
const pickOf = (a, r = Math.random) => a[Math.floor(r() * a.length)];

class Bot {
  constructor(server, player, rng) {
    this.s = server; this.p = player;
    const r = Math.random;
    // 70% class-flavoured archetype, 30% completely random: bots of one class still surprise you
    const keys = Object.keys(ARCHETYPES);
    this.archetype = r() < 0.7 ? pickOf(CLASS_BIAS[player.classId] || keys, r) : pickOf(keys, r);
    const A = ARCHETYPES[this.archetype], jit = (v, a) => clamp(v + (r() - 0.5) * a, 0.02, 1);
    this.traits = { aggr: jit(A.aggr, 0.5), greed: jit(A.greed, 0.5), range: jit(A.range, 0.5), tnt: jit(A.tnt, 0.5), home: jit(A.home, 0.5), nerve: 0.15 + r() * 0.3, sloppy: r() * 0.35, react: 0.15 + r() * 0.45 };
    this.buildStyle = pickOf(A.build, r); this.approach = pickOf(A.approach, r); this.meleeTool = pickOf(A.melee, r);
    this.mood = 0; this.moodClock = 8 + r() * 14; this.emoteClock = 10 + r() * 20; this.lastKills = 0; this.hitRun = 0; this.warClock = 0;
    this.aggression = this.traits.aggr;        // how eagerly it leaves home to fight
    this.greed = this.traits.greed;            // interest in the vault
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
  /** Difficulty settings for this bot. A test stand-in for a human (p.proxy) always plays at Normal. */
  diff() { return this.p.proxy ? DIFFICULTIES.normal : this.s.diff(); }
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
  /** Fall damage this bot would take dropping `h` blocks (same formula as the server). */
  fallDamage(h) { const v = Math.sqrt(2 * CONFIG.PLAYER.GRAVITY * Math.max(0, h)); return Math.max(0, v - CONFIG.HEALTH.FALL_SAFE) * CONFIG.HEALTH.FALL_DMG * this.p.mods.fall; }
  /** Would stepping into column (x, z) at feet level fy hurt? A wall is not a drop; landing in water is safe. */
  unsafeAt(x, fy, z) {
    const w = this.s.world;
    if (w.isSolid(x, fy, z)) return false;
    if (this.dangerous(x, fy, z) || this.dangerous(x, fy - 1, z)) return true;
    let drop = 0;
    while (drop < 16 && !w.isSolid(x, fy - 1 - drop, z) && BLOCKS[w.get(x, fy - 1 - drop, z)].shape !== 'fluid') drop++;
    const landing = w.get(x, fy - 1 - drop, z);
    if (landing === ID.lava) return true;
    if (landing === ID.water) return false;
    return this.fallDamage(drop) > Math.min(12, this.p.health * 0.25);
  }
  /**
   * Edge guard, run after every decision: if the keys the bot is holding would carry it off a harmful drop (strafing,
   * walking backwards, sprinting), cancel the move. Covers every mode, not just walkTo.
   */
  guardEdges() {
    const p = this.p, c = p.controls;
    if (this.followingPath) { this.followingPath = false; return; }       // escape paths are checked cell by cell already
    if (p.inWater || p.inLava) return;
    const fy0 = Math.floor(p.pos.y + 0.05), spd = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround && spd > 1.5) {                                          // sliding (knockback, momentum) toward a harmful drop: push back against it
      const vx = p.vel.x / spd, vz = p.vel.z / spd;
      for (const r of [0.5, 1.0]) {
        if (this.unsafeAt(Math.floor(p.pos.x + vx * r), fy0, Math.floor(p.pos.z + vz * r))) {
          const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), rx = Math.cos(p.yaw), rz = -Math.sin(p.yaw);
          const along = vx * fx + vz * fz, side = vx * rx + vz * rz;
          c.forward = along < -0.3; c.back = along > 0.3; c.right = side < -0.3; c.left = side > 0.3; c.jump = false; c.sprint = false;
          return;
        }
      }
    }
    const f = (c.forward ? 1 : 0) - (c.back ? 1 : 0), sd = (c.right ? 1 : 0) - (c.left ? 1 : 0);
    if (!f && !sd) return;
    let wx = f * -Math.sin(p.yaw) + sd * Math.cos(p.yaw), wz = f * -Math.cos(p.yaw) + sd * -Math.sin(p.yaw);
    const l = Math.hypot(wx, wz) || 1; wx /= l; wz /= l;
    const fy = Math.floor(p.pos.y + 0.05), reach = c.sprint || c.jump || !p.onGround ? [0.55, 1.0, 1.5, 2.0] : [0.55, 1.0];
    for (const r of reach) for (const side of [-0.28, 0, 0.28]) {
      const x = Math.floor(p.pos.x + wx * r - wz * side), z = Math.floor(p.pos.z + wz * r + wx * side);
      if ((x !== Math.floor(p.pos.x) || z !== Math.floor(p.pos.z)) && this.unsafeAt(x, fy, z)) {
        c.forward = c.back = c.left = c.right = c.jump = c.sprint = false;
        if (this.detourT <= 0) { this.detour = (Math.random() < 0.5 ? 1 : -1) * 1.6; this.detourT = 0.8; }
        this.strafe = -this.strafe;
        return;
      }
    }
  }
  /**
   * Walkable cells around the bot (breadth-first, up to 16 steps): flat moves, 1-block step-ups and safe drops.
   * Cached for a quarter second, since the bot asks several times while choosing where to put a TNT.
   */
  reachable() {
    const p = this.p, w = this.s.world, sx = Math.floor(p.pos.x), sz = Math.floor(p.pos.z), sy = Math.floor(p.pos.y + 0.05);
    const c = this.bfsCache;
    if (c && c.x === sx && c.y === sy && c.z === sz && this.s.clock - c.t < 0.25) return c.cells;
    const cells = new Map(), queue = [[sx, sy, sz]];
    cells.set(sx + ',' + sz, { x: sx, y: sy, z: sz, prev: null, n: 0 });
    for (let qi = 0; qi < queue.length; qi++) {
      const [x, y, z] = queue[qi], cur = cells.get(x + ',' + z);
      if (cur.n >= 16) continue;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = x + dx, nz = z + dz, k = nx + ',' + nz;
        if (cells.has(k) || !w.inBounds(nx, y, nz)) continue;
        let ny = null;
        if (!w.isSolid(nx, y, nz) && !w.isSolid(nx, y + 1, nz)) {
          if (this.unsafeAt(nx, y, nz)) continue;
          ny = y; while (ny > 1 && !w.isSolid(nx, ny - 1, nz) && BLOCKS[w.get(nx, ny - 1, nz)].shape !== 'fluid' && y - ny < 4) ny--;
        } else if (w.isSolid(nx, y, nz) && !w.isSolid(nx, y + 1, nz) && !w.isSolid(nx, y + 2, nz) && !w.isSolid(x, y + 2, z) && !this.dangerous(nx, y + 1, nz)) ny = y + 1;
        if (ny == null) continue;
        cells.set(k, { x: nx, y: ny, z: nz, prev: cur, n: cur.n + 1 });
        queue.push([nx, ny, nz]);
      }
    }
    this.bfsCache = { x: sx, y: sy, z: sz, t: this.s.clock, cells };
    return cells;
  }
  /** Best reachable spot at least 7.5 blocks from (fromX, fromZ), with the path to it; null if there is none. */
  escapeRoute(fromX, fromZ) {
    const p = this.p, d0 = Math.hypot(p.pos.x - fromX, p.pos.z - fromZ), cand = [];
    for (const c of this.reachable().values()) {
      const d = Math.hypot(c.x + 0.5 - fromX, c.z + 0.5 - fromZ);
      if (d >= 7.5 && c.n <= 15) cand.push({ c, d, score: d - c.n * 0.35 });
    }
    cand.sort((a, b) => b.score - a.score);
    for (const k of cand.slice(0, 12)) {                                        // never run past the bomb on the way out
      const path = []; let ok = true;
      for (let c = k.c; c && c.prev; c = c.prev) { if (Math.hypot(c.x + 0.5 - fromX, c.z + 0.5 - fromZ) < Math.min(d0, 2.5) - 0.01) { ok = false; break; } path.unshift([c.x + 0.5, c.z + 0.5, c.y]); }
      if (ok && path.length) return { path, d: k.d };
    }
    return null;
  }
  /** True if a TNT lit at (x, z) can be outrun along a real walkable path. */
  canEscapeFrom(x, z) { return !!this.escapeRoute(x, z); }

  /* ---------- movement ---------- */
  /** Steers toward (x, z), jumping steps, digging walls and bridging gaps. `stopAt` = distance at which it stops. */
  /** Standing in lava: head for the nearest neighbouring cell that is not lava and jump out. */
  escapeLava() {
    const p = this.p, c = p.controls, w = this.s.world, fy = Math.floor(p.pos.y + 0.05), px = Math.floor(p.pos.x), pz = Math.floor(p.pos.z);
    let best = null, bd = 9;
    for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
      if (!dx && !dz) continue;
      for (const y of [fy, fy + 1]) {
        const x = px + dx, z = pz + dz;
        if (w.get(x, y, z) === ID.lava || w.isSolid(x, y, z) || w.isSolid(x, y + 1, z) || !w.isSolid(x, y - 1, z) || w.get(x, y - 1, z) === ID.lava) continue;
        const d = Math.hypot(x + 0.5 - p.pos.x, z + 0.5 - p.pos.z) + (y - fy) * 0.3;
        if (d < bd) { bd = d; best = { x: x + 0.5, z: z + 0.5 }; }
      }
    }
    if (!best) return;
    p.yaw = Math.atan2(-(best.x - p.pos.x), -(best.z - p.pos.z));
    c.forward = true; c.sprint = true; c.jump = true; c.back = c.left = c.right = false;
    this.followingPath = true;
  }
  /** Runs the vault obstacle course: waypoint by waypoint, jumping up pillars and over gaps. Restarts from the nearest point after a fall. */
  runCourse(dt, m, stage) {
    const p = this.p, c = p.controls, w = this.s.world;
    if (this.courseStage !== stage || !this.course) { this.course = vaultCourse(m, stage, p.pos.x, p.pos.z); this.courseStage = stage; this.cwp = -1; }
    const C = this.course;
    if (this.cwp < 0 || (p.onGround && p.pos.y < C[this.cwp].y - 1.5)) {        // (re)join: nearest waypoint at or below our height
      let best = 0, bd = 1e9;
      for (let i = 0; i < C.length; i++) { if (C[i].y > p.pos.y + 0.6) continue; const d = Math.hypot(C[i].x - p.pos.x, C[i].z - p.pos.z) + Math.abs(C[i].y - p.pos.y) * 3 - i * 0.05; if (d < bd) { bd = d; best = i; } }
      this.cwp = best;
    }
    let wp = C[this.cwp];
    const hd = Math.hypot(wp.x - p.pos.x, wp.z - p.pos.z);
    if (hd < 0.45 && Math.abs(p.pos.y - wp.y) < 0.6 && p.onGround) { if (this.cwp < C.length - 1) { this.cwp++; wp = C[this.cwp]; } else { c.forward = false; return; } }
    const dx = wp.x - p.pos.x, dz = wp.z - p.pos.z, d = Math.hypot(dx, dz) || 1, up = wp.y - p.pos.y;
    p.yaw = Math.atan2(-dx, -dz); p.pitch *= 0.8;
    const next = C[this.cwp + 1], hop = up > 0.4 || (next && next.y > wp.y + 0.4);   // short precise hops: no sprinting
    c.forward = d > 0.15; c.sprint = !hop && d > 0.8;
    const spd = Math.hypot(p.vel.x, p.vel.z);
    if (p.onGround && c.forward && spd < 0.8) this.courseStuck = (this.courseStuck || 0) + dt; else this.courseStuck = 0;
    if (this.courseStuck > 0.5) { this.courseSide = Math.random() < 0.5 ? 1 : -1; this.courseSideT = 0.45; this.courseStuck = 0; }
    if ((this.courseSideT = (this.courseSideT || 0) - dt) > 0) { if (this.courseSide > 0) c.right = true; else c.left = true; }
    const ux = dx / d, uz = dz / d, fy = Math.floor(p.pos.y + 0.05);
    const toward = p.vel.x * ux + p.vel.z * uz;                                       // speed toward the waypoint
    const blocked = w.isSolid(Math.floor(p.pos.x + ux * 0.6), fy, Math.floor(p.pos.z + uz * 0.6)) && !w.isSolid(Math.floor(p.pos.x + ux * 0.6), fy + 1, Math.floor(p.pos.z + uz * 0.6));
    const gapAhead = !w.isSolid(Math.floor(p.pos.x + ux * 0.65), fy - 1, Math.floor(p.pos.z + uz * 0.65)) && up > -0.5;
    if (p.onGround && (blocked || (up > 0.4 && d < 1.55 && toward > 2) || (gapAhead && d > 1 && toward > 2.5))) c.jump = true;
    if (!p.onGround) { c.forward = true; c.sprint = false; }   // in the air keep steering at the pillar: this also brakes an overshoot
    this.followingPath = true;
  }
  walkTo(x, z, dt, stopAt = 0.6, allowDig = true, goalY = null) {
    const p = this.p, w = this.s.world, c = p.controls;
    const dx = x - p.pos.x, dz = z - p.pos.z, d = Math.hypot(dx, dz);
    if (d <= stopAt) return true;
    this.detourT -= dt; if (this.detourT <= 0) this.detour = 0;
    const want = Math.atan2(-dx, -dz) + this.detour;
    p.yaw += clamp(angleDiff(p.yaw, want), -0.2, 0.2);
    p.pitch += (0 - p.pitch) * 0.2;
    c.forward = true;
    c.sprint = d > 7 && !this.mine && !p.inWater;
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
      // gap / drop / hazard check: bridge a harmful drop with any building block, otherwise steer around it
      if (this.unsafeAt(ax, fy, az)) {
        const item = !this.dangerous(ax, fy, az) && this.s.canModify(p, ax, fy - 1, az) && p.cooldowns.place <= 0 ? this.pickMaterial() : null;
        if (item) { this.face(ax + 0.5, fy - 0.5, az + 0.5, true); this.s.handle(p.id, { type: 'place', x: ax, y: fy - 1, z: az, item }); }
        c.forward = false; this.detour = (Math.random() < 0.5 ? 1 : -1) * 1.5; this.detourT = 0.9;
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
    if (below === AIR || !BLOCKS[below].breakable || !s.canModify(p, fx, fy, fz)) return false;
    let floor = false;                                                   // never dig into a cave, a long drop or liquid
    for (let k = 1; k <= 3; k++) { const id = w.get(fx, fy - k, fz); if (id === ID.lava || id === ID.water) return false; if (w.isSolid(fx, fy - k, fz)) { floor = true; break; } }
    if (!floor) return false;
    this.face(fx + 0.5, fy + 0.5, fz + 0.5, true);
    if (!this.mine || this.mine.y !== fy || this.mine.x !== fx || this.mine.z !== fz) this.mine = { x: fx, y: fy, z: fz, t: 0, need: mineTime(BLOCKS[below], 'pickaxe', p.mods, p.look) };
    this.mine.t += dt; if (this.p.swing <= 0) { this.p.swing = 1; this.p.swingKind = 'pickaxe'; }
    if (this.mine.t >= this.mine.need) { s.handle(p.id, { type: 'break', x: fx, y: fy, z: fz }); this.mine = null; }
    return true;
  }
  /** Builds a block under its own feet (pillar jumping), mining the ceiling first if needed. Returns true if it acted. */
  pillarUp(dt) {
    const p = this.p, s = this.s, w = s.world, c = p.controls;
    const fx = Math.floor(p.pos.x), fy = Math.floor(p.pos.y + 0.01), fz = Math.floor(p.pos.z);
    if (!p.onGround) return true;
    if (w.isSolid(fx, fy + 2, fz)) {                                    // ceiling in the way: dig up first
      if (!s.canModify(p, fx, fy + 2, fz) || !BLOCKS[w.get(fx, fy + 2, fz)].breakable) return false;
      this.face(fx + 0.5, fy + 2.5, fz + 0.5, true);
      if (!this.mine || this.mine.y !== fy + 2 || this.mine.x !== fx || this.mine.z !== fz) this.mine = { x: fx, y: fy + 2, z: fz, t: 0, need: mineTime(BLOCKS[w.get(fx, fy + 2, fz)], 'pickaxe', p.mods, p.look) };
      this.mine.t += dt; if (this.p.swing <= 0) { this.p.swing = 1; this.p.swingKind = 'pickaxe'; }
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
    if (!this.mine || this.mine.x !== x || this.mine.y !== ty || this.mine.z !== z) this.mine = { x, y: ty, z, t: 0, need: mineTime(def, 'pickaxe', p.mods, p.look) };
    this.face(x + 0.5, ty + 0.5, z + 0.5);
    this.mine.t += dt; if (this.p.swing <= 0) { this.p.swing = 1; this.p.swingKind = 'pickaxe'; }
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
    if (w.get(px, py, pz) !== AIR || !this.canEscapeFrom(px + 0.5, pz + 0.5)) return false;
    const r = this.s.handle(p.id, { type: 'place', x: px, y: py, z: pz, item: 'tnt' });
    if (!r.ok) return false;
    this.s.handle(p.id, { type: 'ignite', x: px, y: py, z: pz });
    this.startFlee(px + 0.5, pz + 0.5, 4.2);
    this.tntCooldown = 14 + Math.random() * 12;
    return true;
  }
  startFlee(fromX, fromZ, seconds) {
    const p = this.p, r = this.escapeRoute(fromX, fromZ);
    this.bfsCache = null;
    if (r && r.path.length) this.flee = { path: r.path, i: 0, x: r.path[r.path.length - 1][0], z: r.path[r.path.length - 1][1], t: seconds };
    else { const dx = p.pos.x - fromX, dz = p.pos.z - fromZ, l = Math.hypot(dx, dz) || 1; this.flee = { x: p.pos.x + dx / l * 18, z: p.pos.z + dz / l * 18, t: seconds }; }
    this.mine = null;
  }

  /* ---------- building ---------- */
  planBuild() {
    const s = this.s, w = s.world, p = this.p, plot = s.plotOf(p), q = [], style = this.buildStyle;
    const half = style === 'keep' ? 3 : style === 'moat' ? 4 : 3 + Math.floor(Math.random() * 3);
    const cx = Math.floor(plot.x), cz = Math.floor(plot.z);
    const dxm = s.map.center.x - plot.x, dzm = s.map.center.z - plot.z;
    const axisX = Math.abs(dxm) > Math.abs(dzm);
    let sign = (axisX ? dxm : dzm) > 0 ? 1 : -1;
    if (Math.random() < 0.25) sign = -sign;                                         // sometimes the gate faces away from the centre
    const gap = axisX ? [cx + sign * half, cz] : [cx, cz + sign * half];
    this.gap = gap; this.out = axisX ? [sign, 0] : [0, sign];
    const ring = [];
    for (let x = -half; x <= half; x++) for (let z = -half; z <= half; z++) if (Math.max(Math.abs(x), Math.abs(z)) === half) ring.push([cx + x, cz + z]);
    ring.sort((a, b) => Math.atan2(a[1] - cz, a[0] - cx) - Math.atan2(b[1] - cz, b[0] - cx));
    if (Math.random() < 0.5) ring.reverse();
    const layers = style === 'keep' ? 5 : 3 + Math.floor(Math.random() * 2);
    if (plot.core) {                                                                 // first job: encase our own core
      const [kx, ky, kz] = plot.core;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) q.push({ kind: 'wall', x: kx + dx, z: kz + dz, layer: 0, y0: ky });
      q.push({ kind: 'wall', x: kx, z: kz, layer: 1, y0: ky });
      if (style === 'keep' || this.archetype === 'turtle') for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) q.push({ kind: 'wall', x: kx + dx, z: kz + dz, layer: 1, y0: ky });
    }
    if (style === 'moat') {                                                          // a trench outside the wall first
      const m = half + 2;
      for (let x = -m; x <= m; x++) for (let z = -m; z <= m; z++) if (Math.max(Math.abs(x), Math.abs(z)) === m && !(cx + x === gap[0] + this.out[0] * 2 && cz + z === gap[1] + this.out[1] * 2) && Math.random() < 0.85) q.push({ kind: 'dig', x: cx + x, z: cz + z });
    }
    const trap = (dist) => {                                                         // pressure plate with TNT on both sides
      const px = gap[0] + this.out[0] * dist, pz = gap[1] + this.out[1] * dist, sx = this.out[1], sz = this.out[0];
      q.push({ kind: 'plate', x: px, z: pz }, { kind: 'tnt', x: px + sx, z: pz + sz }, { kind: 'tnt', x: px - sx, z: pz - sz });
    };
    for (let layer = 0; layer < Math.min(layers, 3); layer++) for (const [x, z] of ring) {
      if (x === gap[0] && z === gap[1] && layer < 2) continue;
      q.push({ kind: 'wall', x, z, layer, y0: this.groundY(x, z) });
    }
    trap(3);
    if (style === 'trapfield') { trap(5); if (Math.random() < 0.6) trap(7); }
    for (let layer = 3; layer < layers + 1; layer++) for (const [x, z] of ring) q.push({ kind: 'wall', x, z, layer, y0: this.groundY(x, z) });
    // automatic machines, by personality
    const ox = this.out[0], oz = this.out[1], sx = oz, sz = ox, at = (f, side) => ({ x: gap[0] + ox * f + sx * side, z: gap[1] + oz * f + sz * side });
    const add = (kind, pos) => q.push({ kind, x: pos.x, z: pos.z });
    const A = this.archetype;
    if (A === 'trapper' || A === 'bomber' || style === 'trapfield') { add('mine', at(4, 0)); add('mine', at(4, 2)); add('mine', at(5, -2)); add('turret', at(-2, 2)); }
    if (A === 'turtle' || style === 'keep') { add('turret', { x: cx + half - 1, z: cz + half - 1 }); add('turret', { x: cx - half + 1, z: cz - half + 1 }); add('healer', { x: cx, z: cz + 1 }); }
    if (A === 'bomber' || A === 'demolitionist') add('cannon', { x: cx + 1, z: cz - 1 });
    if (A === 'digger' || style === 'moat') { add('spikes', at(2, 0)); add('spikes', at(3, 1)); add('sprinkler', { x: cx - 1, z: cz }); }
    if (A === 'sniper' || A === 'opportunist' || A === 'vaulter') { add('turret', at(-1, -2)); add('jumppad', { x: cx + 2, z: cz }); }
    if (Math.random() < 0.35) add('flamer', at(-2, -2));
    this.queue = q; this.queueIndex = 0;
  }
  /** Extra defences queued during the war (trap fields and patches for holes in the wall). */
  planExtra() {
    const s = this.s, p = this.p, plot = s.plotOf(p), q = [];
    const a = Math.random() * TAU, d = 5 + Math.random() * 6, px = Math.floor(plot.x + Math.cos(a) * d), pz = Math.floor(plot.z + Math.sin(a) * d), sx = Math.floor(Math.random() * 3) - 1 || 1;
    q.push({ kind: 'plate', x: px, z: pz }, { kind: 'tnt', x: px + sx, z: pz }, { kind: 'tnt', x: px - sx, z: pz });
    this.queue = q; this.queueIndex = 0; this.extra = true;
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
    if (job.kind === 'dig') {                                              // trench cell: mine the ground block
      const gy = this.groundY(job.x, job.z) - 1, def = BLOCKS[w.get(job.x, gy, job.z)];
      if (!def || !def.breakable || !w.isSolid(job.x, gy, job.z) || !s.canModify(p, job.x, gy, job.z)) { this.queueIndex++; return; }
      const e0 = p.eyePosition();
      if (Math.hypot(job.x + 0.5 - e0.x, gy + 0.5 - e0.y, job.z + 0.5 - e0.z) > 4.4) { this.walkTo(job.x + 0.5, job.z + 0.5, dt, 3, false); return; }
      this.face(job.x + 0.5, gy + 0.5, job.z + 0.5, true);
      if (!this.mine || this.mine.x !== job.x || this.mine.z !== job.z) this.mine = { x: job.x, y: gy, z: job.z, t: 0, need: mineTime(def, 'pickaxe', p.mods, p.look) };
      this.mine.t += dt; if (this.p.swing <= 0) { this.p.swing = 1; this.p.swingKind = 'pickaxe'; }
      if (this.mine.t >= this.mine.need) { s.handle(p.id, { type: 'break', x: job.x, y: gy, z: job.z }); this.mine = null; this.queueIndex++; }
      return;
    }
    let y, item;
    if (job.kind === 'wall') { y = job.y0 + job.layer; item = this.pickMaterial(); }
    else { y = this.groundY(job.x, job.z); item = job.kind; }
    if (job.kind === 'wall') {                                           // skip cells that are already filled
      if (w.isSolid(job.x, y, job.z)) { this.queueIndex++; return; }
    } else if (w.get(job.x, y, job.z) !== AIR) { this.queueIndex++; return; }
    if (job.kind === 'tnt' && !s.hasResource(p, 'tnt', 1)) { this.queueIndex++; return; }
    if (ITEMS[job.kind] && ITEMS[job.kind].kind === 'mech' && !s.hasResource(p, 'mech', ITEMS[job.kind].cost * p.mods.mechCost)) { this.queueIndex++; return; }
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
      if (this.s.phase === 'build' && this.s.nearestPlot(x, z) !== p.index) continue;       // the divider walls keep us in our own cell
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
    if (!this.mine || this.mine.x !== t.x || this.mine.y !== t.y || this.mine.z !== t.z) this.mine = { x: t.x, y: t.y, z: t.z, t: 0, need: mineTime(def, def.sound === 'wood' ? 'axe' : 'pickaxe', p.mods, p.look) };
    this.face(t.x + 0.5, t.y + 0.5, t.z + 0.5);
    this.mine.t += dt; if (this.p.swing <= 0) { this.p.swing = 1; this.p.swingKind = 'pickaxe'; }
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
    if (this.flee) {                                                      // run away from a lit fuse, along the searched path
      const F = this.flee; F.t -= dt;
      if (F.path) {                                                         // every cell on the path is known to be safe: face the next one and run
        while (F.i < F.path.length - 1 && Math.hypot(F.path[F.i][0] - p.pos.x, F.path[F.i][1] - p.pos.z) < 0.45) F.i++;
        const wp = F.path[F.i], dx = wp[0] - p.pos.x, dz = wp[1] - p.pos.z;
        this.followingPath = true;
        if (Math.hypot(dx, dz) > 0.3) { p.yaw = Math.atan2(-dx, -dz); p.pitch *= 0.8; c.forward = true; c.sprint = true; if (wp[2] > Math.floor(p.pos.y + 0.05) && p.onGround) c.jump = true; }
      } else this.walkTo(F.x, F.z, dt, 1, false);
      c.jump = c.jump || false;
      if (this.flee.t <= 0) this.flee = null;
      return;
    }
    const foes = this.enemies();
    this.thinkClock -= dt; this.warClock += dt;
    if (this.thinkClock <= 0) {
      const T = this.traits;
      const D = this.diff();
      this.thinkClock = (0.25 + Math.random() * 0.25 + T.react * 0.35) * D.think;       // slower thinkers react later
      this.target = this.pickTarget(foes);
      const intruder = this.coreIntruder(foes);
      if (intruder) this.target = intruder;                                     // someone is at our core: deal with them first
      const t = this.target, d = t ? this.dist(t) : 99;
      const siege = intruder ? null : this.pickSiege();
      const aggr = clamp(T.aggr + D.aggr + this.mood * 0.3 + (s.phase === 'chaos' ? 0.25 : 0) + Math.min(0.5, this.warClock / 120), 0, 1);
      const hurt = p.health < p.maxHealth * (T.nerve + (p.classId === 'survivalist' ? 0.12 : 0));
      const vaultReady = s.vault.cooldown <= 0 && s.phase !== 'build';
      const toVault = Math.hypot(s.map.vault.x - p.pos.x, s.map.vault.z - p.pos.z);
      const wantRange = T.range > 0.45, hasArrows = s.unlimited || (p.resources.arrow || 0) >= 1;
      let drop = null, dDrop = 1e9;                                             // supply crates draw everyone in
      for (const dr of s.drops || []) { const dd = Math.hypot(dr.x - p.pos.x, dr.z - p.pos.z); if (dd < dDrop && (dr.state === 'landed' || dr.y - dr.ground < 25)) { dDrop = dd; drop = dr; } }
      const prev = this.mode;
      const keepSiege = prev === 'siege' && this.siegeCore && s.coreAlive(this.siegeCore.slot) && this.modeT < 70 && !intruder && !(t && d < 3.4 && this.hasLOS(t));
      if (keepSiege && !hurt) this.mode = 'siege';
      else if (hurt && t && d < 16) this.mode = 'retreat';
      else if (this.hitRun > 0 && t) this.mode = 'retreat';
      else if (t && d < 3.4 && this.hasLOS(t)) this.mode = 'melee';
      else if (hasArrows && t && d < Math.min(D.bowRange, wantRange ? 36 : 22) && d > (wantRange ? 8 : 6) && this.hasLOS(t) && aggr > 0.25 && (wantRange || Math.random() < 0.6)) this.mode = 'shoot';
      else if (drop && dDrop < 60 && (!t || d > 9) && (prev === 'drop' || Math.random() < 0.45 + T.greed * 0.4)) { this.mode = 'drop'; this.drop = drop; }
      else if (vaultReady && T.greed > 0.4 && toVault < 70 && (!t || d > 12 || T.greed > 0.85)) this.mode = 'vault';
      else if (this.extra && this.queueIndex < this.queue.length) this.mode = 'fortify';
      else if (!s.unlimited && (p.resources.stone || 0) < 4 && (p.resources.wood || 0) < 4) this.mode = 'gather';
      else if (this.archetype === 'turtle' || this.archetype === 'trapper') {
        // homebodies defend, lay traps, and only venture out once they feel strong (or when chaos comes)
        if (Math.random() < 0.18 * T.tnt && !this.extra && (s.hasResource(p, 'tnt', 2) || s.unlimited)) { this.planExtra(); this.mode = 'fortify'; }
        else if (t && (aggr > 0.62 || d < 14)) this.mode = 'hunt';
        else this.mode = 'gather';
      }
      else if (siege && (!t || d > 10 || !this.hasLOS(t)) && Math.random() < 0.25 + 0.35 * T.tnt + 0.25 * aggr) { this.mode = 'siege'; this.siegeCore = siege; }
      else if (t && (aggr > 0.45 || d < 30)) this.mode = 'hunt';
      else this.mode = 'gather';
      if (this.mode !== prev) { this.modeT = 0; this.course = null; if (this.mode === 'hunt') { this.approach = pickOf(ARCHETYPES[this.archetype].approach); this.tunnelT = 0; } }
    }
    this.modeT = (this.modeT || 0) + dt;
    this.hitRun = Math.max(0, this.hitRun - dt);
    this.moodClock -= dt;
    if (this.moodClock <= 0) {                                              // re-roll the mood and sometimes the whole plan
      this.moodClock = 18 + Math.random() * 30; this.mood = Math.random() * 2 - 1;
      if (Math.random() < 0.35) { this.meleeTool = pickOf(['sword', 'axe', 'staff', ...ARCHETYPES[this.archetype].melee]); this.approach = pickOf(['ground', 'sky', 'tunnel', ...ARCHETYPES[this.archetype].approach]); }
      this.strafe = Math.random() < 0.5 ? 1 : -1;
    }
    this.emoteClock -= dt;
    const kills = p.stats ? p.stats.kills : 0;
    if (kills > this.lastKills) { this.lastKills = kills; if (Math.random() < 0.55) s.handle(p.id, { type: 'emote', slot: pickOf([0, 2, 3]) }); }
    else if (this.emoteClock <= 0) { this.emoteClock = 25 + Math.random() * 40; if (Math.random() < 0.4) s.handle(p.id, { type: 'emote', slot: Math.floor(Math.random() * 4) }); }
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
        this.strafeT -= dt; if (this.strafeT <= 0) { this.strafe = -this.strafe; this.strafeT = 1.2 + Math.random() * 1.4; this.strafeOn = Math.random() < 0.55; }
        if (this.dist(t) > 2.4) { c.forward = true; c.sprint = this.dist(t) > 4.5; } else if (this.dist(t) < 1.3) c.back = true;
        if (this.strafeOn) { if (this.strafe > 0) c.right = true; else c.left = true; }
        const tool = Math.random() < 0.15 ? pickOf(['sword', 'axe', 'staff']) : this.meleeTool;
        if (p.held !== tool) s.handle(p.id, { type: 'hold', item: tool });
        this.blockT = (this.blockT || 0) - dt;
        if (p.blocking && this.blockT <= 0) s.handle(p.id, { type: 'block', on: false });
        else if (!p.blocking && t.swing > 0.5 && Math.random() < 0.05 * this.diff().block * (1 - this.traits.sloppy) && tool !== 'bow') { if (s.handle(p.id, { type: 'block', on: true }).ok) this.blockT = 0.4 + Math.random() * 0.5; }
        // Minecraft-style crit: hop as the swing recovers and strike on the way down
        if (tool !== 'staff' && p.onGround && p.cooldowns.attack < 0.3 && this.dist(t) < 3 && Math.random() < 0.08 * this.diff().rate) { c.jump = true; this.critJump = 0.8; }
        this.critJump = Math.max(0, (this.critJump || 0) - dt);
        const waitCrit = this.critJump > 0 && !p.onGround && p.vel.y > -0.6;
        if (!waitCrit && !p.blocking && p.cooldowns.attack <= 0 && Math.random() < this.diff().rate) {
          s.handle(p.id, { type: 'attack', targetId: t.id, tool });
          if (p.classId === 'scout' && Math.random() < 0.35) this.hitRun = 0.8 + Math.random() * 0.8;      // scouts strike and slip away
          else if (Math.random() < 0.08 * this.traits.sloppy) this.hitRun = 0.6;
        }
        break;
      }
      case 'shoot': {
        if (!t) break;
        if (!s.unlimited && (p.resources.arrow || 0) < 1) { this.thinkClock = 0; this.mode = 'hunt'; break; }   // quiver empty
        const D = this.diff(), dist = this.dist(t);
        // one aiming error per arrow (re-rolled after each shot), not a fresh jitter every frame: this is what makes archers miss
        if (!this.aimErr) { const mag = D.aim * (0.4 + this.traits.sloppy) * (1 + dist / 18); this.aimErr = { x: (Math.random() - 0.5) * mag * 2, y: (Math.random() - 0.5) * mag, z: (Math.random() - 0.5) * mag * 2, lead: D.lead * (0.7 + Math.random() * 0.5) }; }
        const E = this.aimErr, flight = dist / (TOOLS.bow.speed * 0.82);
        this.face(t.pos.x + t.vel.x * flight * E.lead + E.x, t.pos.y + 1.2 + dist * 0.035 + E.y, t.pos.z + t.vel.z * flight * E.lead + E.z, true);
        if (dist < 10 && this.traits.range > 0.45) c.back = true;                  // snipers keep their distance
        if (p.held !== 'bow') s.handle(p.id, { type: 'hold', item: 'bow' });
        this.shootWait = (this.shootWait || 0) - dt;
        if (this.shootWait <= 0) this.shootCharge += dt;
        this.strafeT -= dt; if (this.strafeT <= 0) { this.strafe = -this.strafe; this.strafeT = 1.5 + Math.random() * 1.5; this.strafeOn = Math.random() < 0.5; }
        if (this.strafeOn) { if (this.strafe > 0) c.right = true; else c.left = true; }
        if (this.shootCharge >= TOOLS.bow.draw * p.mods.bowDraw * (weaponBoost(p.look, 'bow').draw || 1) * D.draw && p.cooldowns.shoot <= 0) { s.handle(p.id, { type: 'shoot', charge: 1 }); this.shootCharge = 0; this.aimErr = null; this.shootWait = D.shootGap * (0.7 + Math.random() * 0.6); }
        break;
      }
      case 'drop': {
        const dr = this.drop;
        if (!dr || dr.dead || !(s.drops || []).includes(dr) || this.modeT > 45) { this.drop = null; this.thinkClock = 0; this.mode = 'hunt'; break; }
        if (dr.ground + 1 - p.pos.y > 2.2 && Math.hypot(dr.x - p.pos.x, dr.z - p.pos.z) < 6 && this.pillarUp(dt)) break;
        this.walkTo(dr.x, dr.z, dt, 0.6, true, dr.ground);
        break;
      }
      case 'vault': {
        const m = s.map.vault;
        if (!m.pads) { this.walkTo(m.x, m.z, dt, 1.2, true, m.y + 1); break; }
        this.runCourse(dt, m, s.vault.stage || 0);
        break;
      }
      case 'fortify': {                                                    // lay traps / patch the base while the war rages
        if (!(this.extra && this.queueIndex < this.queue.length) || this.modeT > 40) { this.extra = false; this.thinkClock = 0; break; }
        this.buildUpdate(dt);
        break;
      }
      case 'siege': {                                                      // go to an enemy core and break it (TNT if we can get away, pickaxe otherwise)
        const sc = this.siegeCore, w = s.world;
        if (!sc || w.get(sc.x, sc.y, sc.z) !== ID.core) { this.siegeCore = null; this.thinkClock = 0; this.mode = 'hunt'; break; }
        const e = p.eyePosition(), reachD = Math.hypot(sc.x + 0.5 - e.x, sc.y + 0.5 - e.y, sc.z + 0.5 - e.z);
        if (reachD > 4.2) { this.walkTo(sc.x + 0.5, sc.z + 0.5, dt, 2.2, true, sc.y); break; }
        if (this.tntCooldown <= 0 && s.hasResource(p, 'tnt', 1)) {
          for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
            const x = sc.x + dx, y = sc.y + dy, z = sc.z + dz;
            if (w.get(x, y, z) !== AIR || (!dy && !w.isSolid(x, y - 1, z)) || !this.canEscapeFrom(x + 0.5, z + 0.5)) continue;
            this.face(x + 0.5, y + 0.5, z + 0.5, true);
            if (s.handle(p.id, { type: 'place', x, y, z, item: 'tnt' }).ok) { s.handle(p.id, { type: 'ignite', x, y, z }); this.startFlee(x + 0.5, z + 0.5, 4.6); this.tntCooldown = 10 + Math.random() * 10; }
            break;
          }
          if (this.flee) break;
        }
        if (!this.digTowardPoint(sc.x + 0.5, sc.y + 0.5, sc.z + 0.5, dt)) this.walkTo(sc.x + 0.5, sc.z + 0.5, dt, 1.2, true, sc.y);
        break;
      }
      case 'raid': {                                                       // bomber: carry TNT to the enemy base and light it
        if (!t) break;
        const plot = s.plots[t.index], d = Math.hypot(plot.x - p.pos.x, plot.z - p.pos.z);
        if (this.modeT > 40 || !s.hasResource(p, 'tnt', 1)) { this.thinkClock = 0; this.mode = 'hunt'; break; }
        if (d > 7) { this.walkTo(plot.x, plot.z, dt, 6, true, plot.baseY + 1); break; }
        const fx = -Math.sin(p.yaw), fz = -Math.cos(p.yaw), px = Math.floor(p.pos.x + fx * 1.3), pz = Math.floor(p.pos.z + fz * 1.3), py = Math.floor(p.pos.y);
        this.face(plot.x, p.pos.y + 1, plot.z, true);
        if (s.world.get(px, py, pz) === AIR && this.canEscapeFrom(px + 0.5, pz + 0.5) && s.handle(p.id, { type: 'place', x: px, y: py, z: pz, item: 'tnt' }).ok) {
          s.handle(p.id, { type: 'ignite', x: px, y: py, z: pz }); this.startFlee(px + 0.5, pz + 0.5, 4.5); this.tntCooldown = 10 + Math.random() * 12; this.thinkClock = 0; this.mode = 'hunt';
        } else this.walkTo(plot.x, plot.z, dt, 3, true);
        break;
      }
      case 'hunt': {
        if (!t) break;
        // drop TNT on the target when close and exposed
        const d = this.dist(t);
        if (d < 9 && d > 5.5 && this.tntCooldown <= 0 && s.hasResource(p, 'tnt', 1) && this.aggression > 0.4 && Math.abs(t.pos.y - p.pos.y) < 3) {
          const tx = Math.floor(t.pos.x), tz = Math.floor(t.pos.z), ty = Math.floor(t.pos.y);
          this.face(tx + 0.5, ty + 0.5, tz + 0.5, true);
          const k = Math.min(0.8, (d - 1.2) / d), px = Math.floor(p.pos.x + (t.pos.x - p.pos.x) * k), pz = Math.floor(p.pos.z + (t.pos.z - p.pos.z) * k), py = Math.floor(p.pos.y);
          if (Math.hypot(px + 0.5 - p.pos.x, pz + 0.5 - p.pos.z) <= 5.2 && this.canEscapeFrom(px + 0.5, pz + 0.5) && s.handle(p.id, { type: 'place', x: px, y: py, z: pz, item: 'tnt' }).ok) { s.handle(p.id, { type: 'ignite', x: px, y: py, z: pz }); this.startFlee(px + 0.5, pz + 0.5, 4); this.tntCooldown = 12 + Math.random() * 10; break; }
        }
        // go for their base spawn when they are not visible, otherwise straight at them
        const plot = s.plots[t.index], vis = this.hasLOS(t);
        const gx = vis || d < 14 ? t.pos.x : plot.x, gz = vis || d < 14 ? t.pos.z : plot.z, gy = vis || d < 14 ? t.pos.y : plot.spawn.y;
        const dy = gy - p.pos.y;
        if (this.approach === 'sky' && d > 5 && d < 24 && this.modeT < 20 && p.pos.y < t.pos.y + 4.5 && (this.skyBase == null || p.pos.y < this.skyBase + 6) && this.pillarUp(dt)) { if (this.skyBase == null) this.skyBase = p.pos.y; break; }
        if (this.approach === 'tunnel' && d > 10 && !vis && (this.tunnelT = (this.tunnelT || 0) + dt) < 25) {      // go under their defences
          const surf = s.world.getSolidHeight(Math.floor(p.pos.x), Math.floor(p.pos.z)) + 1;
          if (p.pos.y > surf - 2.2 && p.onGround) { if (this.digDown(dt)) break; this.approach = 'ground'; }
          this.walkTo(gx, gz, dt, 1.8, true, p.pos.y); break;
        }
        if (d < 3.2 && !vis && this.digToward(t, dt)) break;                    // close but a block is in the way: dig through it
        if (dy > 2.2 && d < 8 && this.pillarUp(dt)) break;                      // enemy is above us: build upward
        if (dy < -1.5 && d < 2.5 && this.digDown(dt)) break;                   // enemy is just below: dig down to them
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

  /* ---------- getting unstuck ---------- */
  /** Climbs out of water by placing a block at its feet (lifts the bot), or swims toward the nearest bank. */
  waterEscape() {
    const p = this.p, s = this.s, w = s.world, c = p.controls, fx = Math.floor(p.pos.x), fy = Math.floor(p.pos.y + 0.05), fz = Math.floor(p.pos.z);
    if (p.submerged && p.deadlyWater && p.cooldowns.place <= 0 && (s.unlimited || (p.resources.lava || 0) >= 1) && (p.air == null || p.air < 3)) {     // drowning: boil the water with lava
      for (const [dx, dy, dz] of [[1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        if (w.get(fx + dx, fy + dy, fz + dz) !== ID.water) continue;
        this.face(fx + dx + 0.5, fy + dy + 0.5, fz + dz + 0.5, true);
        if (s.handle(p.id, { type: 'place', x: fx + dx, y: fy + dy, z: fz + dz, item: 'lava' }).ok) return;
      }
    }
    const item = this.pickMaterial();
    if (item && p.cooldowns.place <= 0 && s.canModify(p, fx, fy, fz) && BLOCKS[w.get(fx, fy, fz)].shape === 'fluid' && w.isSolid(fx, fy - 1, fz)) {
      this.face(p.pos.x, p.pos.y - 3, p.pos.z, true);
      if (s.handle(p.id, { type: 'place', x: fx, y: fy, z: fz, item }).ok) return;
    }
    let best = null;
    for (let r = 1; r <= 6 && !best; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = fx + dx, z = fz + dz, gy = w.getSolidHeight(x, z) + 1;
      if (BLOCKS[w.get(x, gy, z)].shape === 'fluid' || gy - p.pos.y > 2.2) continue;
      if (!best || dx * dx + dz * dz < best.d) best = { x: x + 0.5, z: z + 0.5, d: dx * dx + dz * dz };
    }
    if (best) { this.face(best.x, p.pos.y + 1, best.z, true); c.forward = true; c.jump = true; }
  }
  /** Mines the first block between the bot and a nearby target it cannot see, so the two can actually fight. */
  digToward(t, dt) { const cc = t.center(); return this.digTowardPoint(cc.x, cc.y, cc.z, dt); }
  /** Nearest enemy core still standing: { slot, x, y, z, d } or null. */
  pickSiege() {
    const p = this.p, s = this.s; let best = null;
    for (const q of s.players) {
      if (q === p || s.areAllies(q, p) || !s.coreAlive(q.index)) continue;
      const [x, y, z] = s.plots[q.index].core, d = Math.hypot(x + 0.5 - p.pos.x, z + 0.5 - p.pos.z);
      if (!best || d < best.d) best = { slot: q.index, x, y, z, d };
    }
    return best;
  }
  /** An enemy standing next to our own core (we defend it), or null. */
  coreIntruder(foes) {
    const p = this.p, s = this.s;
    if (!s.coreAlive(p.index)) return null;
    const [x, , z] = s.plots[p.index].core;
    if (Math.hypot(x - p.pos.x, z - p.pos.z) > 45) return null;
    let best = null, bd = 9;
    for (const q of foes) { const d = Math.hypot(q.pos.x - x - 0.5, q.pos.z - z - 0.5); if (d < bd) { bd = d; best = q; } }
    return best;
  }
  digTowardPoint(tx, ty, tz, dt) {
    const p = this.p, s = this.s, w = s.world, e = p.eyePosition(), cc = { x: tx, y: ty, z: tz };
    const dx = cc.x - e.x, dy = cc.y - e.y, dz = cc.z - e.z, l = Math.hypot(dx, dy, dz) || 1;
    const hit = w.raycast(e, { x: dx / l, y: dy / l, z: dz / l }, Math.min(l, 5));
    if (!hit || !BLOCKS[w.get(hit.x, hit.y, hit.z)].breakable || !s.canModify(p, hit.x, hit.y, hit.z)) return false;
    this.face(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5, true);
    if (!this.mine || this.mine.x !== hit.x || this.mine.y !== hit.y || this.mine.z !== hit.z) this.mine = { x: hit.x, y: hit.y, z: hit.z, t: 0, need: mineTime(w.def(hit.x, hit.y, hit.z), 'pickaxe', p.mods, p.look) };
    this.mine.t += dt; if (this.p.swing <= 0) { this.p.swing = 1; this.p.swingKind = 'pickaxe'; }
    if (this.mine.t >= this.mine.need) { s.handle(p.id, { type: 'break', x: hit.x, y: hit.y, z: hit.z }); this.mine = null; }
    return true;
  }
  /** Last resort: the nearest dry standing spot within 10 blocks (not where the bot already is). */
  safeSpot() {
    const p = this.p, w = this.s.world, fx = Math.floor(p.pos.x), fz = Math.floor(p.pos.z);
    for (let r = 2; r <= 10; r++) for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
      const x = fx + dx, z = fz + dz, gy = w.getSolidHeight(x, z) + 1;
      if (!w.inBounds(x, gy + 1, z) || w.isSolid(x, gy, z) || w.isSolid(x, gy + 1, z)) continue;
      const floor = w.get(x, gy - 1, z);
      if (BLOCKS[floor].shape === 'fluid' || floor === ID.fire || BLOCKS[w.get(x, gy, z)].shape === 'fluid' || this.dangerous(x, gy, z)) continue;
      return { x: x + 0.5, y: gy, z: z + 0.5 };
    }
    return null;
  }
  /**
   * Progress watchdog for the war. "Progress" is moving 1.5 blocks (any direction, so tunnelling and pillaring count) or
   * changing blocks. After 6 s without progress the bot rethinks and takes a detour, after 12 s it tries to dig or climb
   * out, and after 20 s it is moved to the nearest safe ground (losing a little health, so it is never a free teleport).
   */
  watchStall(dt) {
    const p = this.p, s = this.s;
    if (this.mode === 'melee' || this.mode === 'shoot' || this.flee) return;   // fighting or fleeing: pause the stall clock (do not reset it)
    const work = p.stats.blocksDestroyed + (p.stats.blocksPlaced || 0);
    const r = this.stallRef;
    if (!r || Math.hypot(p.pos.x - r.x, p.pos.z - r.z) > 1.5 || (p.onGround && Math.abs(p.pos.y - r.y) > 2.5) || Math.abs(work - r.work) >= 3) { this.stallRef = { x: p.pos.x, y: p.pos.y, z: p.pos.z, work }; this.stallT = 0; this.unstick = 0; return; }
    this.stallT = (this.stallT || 0) + dt;
    const c = p.controls;
    if (this.stallT > 20) {
      const spot = this.safeSpot();
      if (spot) { p.teleport(spot.x, spot.y, spot.z); p.health = Math.max(1, p.health - 10); s.emit({ type: 'botUnstuck', player: p }); }
      this.stallT = 0; this.stallRef = null; this.unstick = 0;
      return;
    }
    if (this.stallT > 12) {                                                 // stage 2: dig or climb out
      if (p.inWater) { this.waterEscape(); return; }
      if (this.unstick !== 2) { this.unstick = 2; this.mine = null; }
      const w = s.world, fx = Math.floor(p.pos.x), fy = Math.floor(p.pos.y + 0.05), fz = Math.floor(p.pos.z);
      const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => w.isSolid(fx + dx, fy, fz + dz) || w.isSolid(fx + dx, fy + 1, fz + dz)).length;
      if (walls >= 3 && this.pillarUp(dt)) return;                          // in a hole: build up and out
      c.forward = true; c.jump = p.onGround; this.digAhead(Math.floor(p.pos.x - Math.sin(p.yaw) * 0.75), fy, Math.floor(p.pos.z - Math.cos(p.yaw) * 0.75), dt);
      return;
    }
    if (this.stallT > 6 && this.unstick !== 1) {                            // stage 1: rethink and take a detour
      this.unstick = 1;
      this.gatherTarget = null; this.mine = null; this.approach = 'ground'; this.thinkClock = 0; this.skyBase = null;
      if (this.extra && this.queue) this.queueIndex++;
      this.detour = (Math.random() < 0.5 ? 1 : -1) * (1.2 + Math.random()); this.detourT = 2.5;
    }
    if (this.stallT > 6 && p.inWater) this.waterEscape();
  }

  update(dt) {
    const p = this.p, s = this.s, c = p.controls;
    c.forward = c.back = c.left = c.right = c.jump = c.crouch = false;
    if (!p.alive) return;
    this.diplomacy(dt);
    if (s.phase === 'build') this.buildUpdate(dt);
    else if (s.phase === 'war' || s.phase === 'chaos' || s.phase === 'sandbox') { this.warUpdate(dt); this.watchStall(dt); }
    if (p.inLava || p.inWater) c.jump = true;
    if (p.inLava) this.escapeLava();
    this.guardEdges();
    if (p.onGround && this.skyBase != null && this.mode !== 'hunt') this.skyBase = null;
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
const CREEPER_SKIN = [0.27, 0.66, 0.27];

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
    this.blockMeshes = new Map(); this.iconQuads = new Map(); this.groupMeshes = new WeakMap(); this.voxMeshes = new Map(); this.heldQueue = [];
    this.atlasPx = atlasCanvas.getContext('2d').getImageData(0, 0, atlasCanvas.width, atlasCanvas.height).data;
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
  /** An icon tile turned into a 3D pixel model: one cube per opaque pixel, one pixel thick (like Minecraft's held items). */
  iconVoxel(tile) {
    let m = this.voxMeshes.get(tile);
    if (m) return m;
    const T = CONFIG.ATLAS.TILES, PX = CONFIG.ATLAS.TILE_PX, W = T * PX, tx = (tile % T) * PX, ty = Math.floor(tile / T) * PX, d = this.atlasPx;
    const solid = (x, y) => x >= 0 && y >= 0 && x < PX && y < PX && d[((ty + y) * W + tx + x) * 4 + 3] > 127;
    const out = [], s = 1 / PX, h = s * 0.5;
    const quad = (q, u, v, sh) => { for (const i of [0, 1, 2, 0, 2, 3]) out.push(q[i][0], q[i][1], q[i][2], u, v, sh); };
    for (let y = 0; y < PX; y++) for (let x = 0; x < PX; x++) {
      if (!solid(x, y)) continue;
      const x0 = x * s - 0.5, x1 = x0 + s, y1 = 0.5 - y * s, y0 = y1 - s, u = (tx + x + 0.5) / W, v = (ty + y + 0.5) / W;
      quad([[x0, y0, h], [x1, y0, h], [x1, y1, h], [x0, y1, h]], u, v, 1);
      quad([[x1, y0, -h], [x0, y0, -h], [x0, y1, -h], [x1, y1, -h]], u, v, 0.8);
      if (!solid(x, y - 1)) quad([[x0, y1, h], [x1, y1, h], [x1, y1, -h], [x0, y1, -h]], u, v, 0.92);
      if (!solid(x, y + 1)) quad([[x0, y0, -h], [x1, y0, -h], [x1, y0, h], [x0, y0, h]], u, v, 0.6);
      if (!solid(x - 1, y)) quad([[x0, y0, -h], [x0, y0, h], [x0, y1, h], [x0, y1, -h]], u, v, 0.72);
      if (!solid(x + 1, y)) quad([[x1, y0, h], [x1, y0, -h], [x1, y1, -h], [x1, y1, h]], u, v, 0.84);
    }
    const gl = this.gl, buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(out), gl.STATIC_DRAW);
    m = { buf, count: out.length / VERTEX_FLOATS }; this.voxMeshes.set(tile, m);
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
  /** An arrow in its bow's skin: shaft, glowing head and fletching in the skin colours. */
  arrow(a, time) {
    const sk = WEAPON_SKINS[a.skin] || WEAPON_SKINS.default, P = sk.pal, c = (v) => [v[0] / 255, v[1] / 255, v[2] / 255, 1], fx = !!P.fx;
    const base = Mat4.chain(Mat4.translation(a.x, a.y, a.z), Mat4.rotationY(a.yaw), Mat4.rotationX(a.pitch));
    const part = (z, sx, sy, sz, col, lit = 1) => this.box(Mat4.chain(base, Mat4.translation(0, 0, z), Mat4.scaling(sx, sy, sz)), col, lit);
    const shaft = a.skin && a.skin !== 'default' ? c(P.h1) : [0.55, 0.4, 0.25, 1];
    part(0, 0.05, 0.05, 0.8, shaft);
    const head = a.skin && a.skin !== 'default' ? c(P.hi) : [0.78, 0.78, 0.84, 1];
    part(-0.46, 0.12, 0.12, 0.16, head, fx ? 0 : 1);
    if (fx) part(-0.46, 0.17, 0.17, 0.08, c(P.mid), 0);                 // glowing collar behind the head
    const fl = a.skin && a.skin !== 'default' ? c(P.mid) : [0.95, 0.95, 0.95, 1];
    part(0.36, 0.2, 0.02, 0.18, fl); part(0.36, 0.02, 0.2, 0.18, fl);
    if (a.skin === 'admin') part(-0.46, 0.14, 0.14, 0.14, [0.5 + 0.5 * Math.sin(time * 6), 0.4, 1, 1], 0);
  }
  /** Supply crate: wooden box with gold bands, a parachute while it falls. */
  crate(d, time) {
    const y = d.y, sw = d.landed ? 0 : Math.sin(time * 1.5) * 0.15;
    this.boxAt(d.x, y + 0.45, d.z, 0.9, 0.9, 0.9, [0.62, 0.42, 0.22, 1], 1);
    for (const h of [0.12, 0.78]) this.boxAt(d.x, y + h, d.z, 0.94, 0.1, 0.94, [0.95, 0.76, 0.2, 1], 1);
    this.boxAt(d.x, y + 0.45, d.z, 0.94, 0.9, 0.12, [0.95, 0.76, 0.2, 1], 1); this.boxAt(d.x, y + 0.45, d.z, 0.12, 0.9, 0.94, [0.95, 0.76, 0.2, 1], 1);
    this.boxAt(d.x, y + 0.92, d.z, 0.3, 0.06, 0.3, [0.35, 0.95, 1, 1], 0);
    if (!d.landed) {
      const cx = d.x + sw, cy = y + 3.4;
      this.boxAt(cx, cy, d.z, 2.8, 0.22, 2.8, [0.92, 0.28, 0.22, 1], 1);
      this.boxAt(cx, cy + 0.2, d.z, 1.8, 0.2, 1.8, [0.98, 0.95, 0.92, 1], 1);
      for (const [ox, oz] of [[-1.2, -1.2], [1.2, -1.2], [-1.2, 1.2], [1.2, 1.2]]) {
        const m = Mat4.chain(Mat4.translation((d.x + cx + ox) / 2, y + 2.1, d.z + oz / 2), Mat4.rotationZ(-ox * 0.22), Mat4.rotationX(oz * 0.22), Mat4.scaling(0.03, 2.6, 0.03));
        this.box(m, [0.9, 0.9, 0.9, 1], 1);
      }
    }
  }
  /** Player banner planted at the base: a pole, a team-coloured top bar and the equipped pattern. */
  banner(b, time) {
    const base = BANNER_COLORS[b.bc] || BANNER_COLORS[0], pat = COSMETICS.banner[b.banner] || COSMETICS.banner.solid, acc = pat.a || [1, 1, 1], acc2 = pat.b || [0.1, 0.1, 0.12], team = hexToRgb(b.color);
    this.boxAt(b.x, b.y + 2.2, b.z, 0.14, 4.4, 0.14, [0.42, 0.3, 0.18, 1], 1);
    this.boxAt(b.x, b.y + 4.5, b.z, 0.26, 0.26, 0.26, [0.95, 0.8, 0.25, 1], 1);
    const wave = Math.sin(time * 2.4 + b.x) * 0.08, fx = b.x + 0.84 + wave, fy = b.y + 3.7, W = 1.4, H = 1.5;
    const cell = (cx, cy, w, h, c, d = 0.075) => this.boxAt(fx - W / 2 + cx + w / 2 - 0.1 + wave * (cx / W), fy + H / 2 - cy - h / 2, b.z, w, h, d, [c[0], c[1], c[2], 1], 1);
    cell(0, 0, W, H, base, 0.06);
    switch (pat.pattern) {
      case 'stripes': cell(0, H * 0.2, W, H * 0.16, acc); cell(0, H * 0.6, W, H * 0.16, acc); break;
      case 'cross': cell(W * 0.4, 0, W * 0.2, H, acc); cell(0, H * 0.4, W, H * 0.2, acc); break;
      case 'diag': for (let i = 0; i < 5; i++) cell(W * (0.1 + i * 0.16), H * (0.08 + i * 0.17), W * 0.22, H * 0.2, acc); break;
      case 'chevron': for (let i = 0; i < 4; i++) { cell(W * (0.05 + i * 0.12), H * (0.1 + i * 0.12), W * 0.12, H * 0.14, acc); cell(W * (0.05 + i * 0.12), H * (0.76 - i * 0.12), W * 0.12, H * 0.14, b.bc % 2 ? acc2 : acc); } break;
      case 'skull': cell(W * 0.25, H * 0.2, W * 0.5, H * 0.4, acc); cell(W * 0.32, H * 0.36, W * 0.12, H * 0.12, acc2); cell(W * 0.56, H * 0.36, W * 0.12, H * 0.12, acc2); cell(W * 0.38, H * 0.6, W * 0.24, H * 0.14, acc); break;
      default: break;
    }
    cell(0, 0, W, H * 0.12, team, 0.09);
  }
  /** A walking green bomb. While its fuse burns it swells and flashes white. */
  creeper(e, time) {
    const lit = e.fuse > 0, flash = lit && Math.sin(e.fuse * 24) > 0 ? 0.55 : 0, sw = Math.sin((e.walk || 0) * 3.2) * 0.7, k = lit ? 1 + (1.4 - e.fuse) * 0.18 : 1;
    const c = [CREEPER_SKIN[0] + flash, CREEPER_SKIN[1] + flash * 0.4, CREEPER_SKIN[2] + flash], dk = [0.1, 0.22, 0.1];
    const base = Mat4.chain(Mat4.translation(e.x, e.y, e.z), Mat4.rotationY(e.yaw), Mat4.scaling(k, k, k));
    for (const [lx, lz, s] of [[-0.16, -0.2, sw], [0.16, -0.2, -sw], [-0.16, 0.2, -sw], [0.16, 0.2, sw]]) this.part(base, lx, 0.5, lz, s, -0.25, 0.26, 0.5, 0.26, dk);
    this.part(base, 0, 0.5, 0, 0, 0.45, 0.5, 0.9, 0.34, c);
    this.part(base, 0, 1.4, 0, 0, 0.25, 0.46, 0.46, 0.46, c);
    this.part(base, -0.1, 1.5, -0.235, 0, 0, 0.1, 0.1, 0.03, [0.02, 0.02, 0.02]);
    this.part(base, 0.1, 1.5, -0.235, 0, 0, 0.1, 0.1, 0.03, [0.02, 0.02, 0.02]);
    this.part(base, 0, 1.4, -0.235, 0, 0, 0.12, 0.16, 0.03, [0.02, 0.02, 0.02]);
  }
  /** A face on the FRONT of a head (so you can always tell which way someone is looking), plus silly hats. H = head-centre matrix. */
  face(H, f, tint, time) {
    const Z = -0.213;                                                    // the front of the head (models face -z)
    const B = (x, y, w, h, c, z = 0, d = 0.02, lit = 1) => this.box(Mat4.chain(H, Mat4.translation(x, y, Z - z), Mat4.scaling(w, h, d)), lit ? tint(c) : c, lit);
    const R = (x, y, z, w, h, d, c, rz = 0, lit = 1) => this.box(Mat4.chain(H, Mat4.translation(x, y, z), Mat4.rotationZ(rz), Mat4.scaling(w, h, d)), lit ? tint(c) : c, lit);
    const W = [0.97, 0.97, 0.97], K = [0.06, 0.06, 0.08], blink = (time * 0.37 + (H[12] * 0.13)) % 4 < 0.12;
    const eyes = (ew, eh, px, py, pw, ph) => { for (const sx of [-1, 1]) { B(sx * 0.09, 0.03, ew, blink ? 0.015 : eh, W); if (!blink) B(sx * 0.09 + px * sx, py, pw, ph, K, 0.006); } };
    switch (f.eyes || 'dot') {
      case 'big': eyes(0.13, 0.12, -0.015, 0.045, 0.06, 0.07); break;
      case 'derp': B(-0.09, 0.03, 0.11, 0.1, W); B(0.09, 0.03, 0.11, 0.1, W); B(-0.06, 0.0, 0.05, 0.05, K, 0.006); B(0.12, 0.06, 0.05, 0.05, K, 0.006); break;
      case 'shades': B(0, 0.04, 0.34, 0.03, K); B(-0.09, 0.03, 0.13, 0.08, K); B(0.09, 0.03, 0.13, 0.08, K); break;
      case 'visor': B(0, 0.03, 0.36, 0.09, [0.3, 0.95, 1], 0, 0.02, 0); break;
      case 'sleepy': B(-0.09, 0.02, 0.1, 0.04, W); B(0.09, 0.02, 0.1, 0.04, W); B(-0.08, 0.01, 0.05, 0.025, K, 0.006); B(0.08, 0.01, 0.05, 0.025, K, 0.006); break;
      case 'angry': eyes(0.1, 0.07, -0.015, 0.02, 0.05, 0.05); R(-0.09, 0.1, Z - 0.004, 0.12, 0.03, 0.02, K, -0.4); R(0.09, 0.1, Z - 0.004, 0.12, 0.03, 0.02, K, 0.4); break;
      case 'glasses': B(-0.09, 0.03, 0.14, 0.12, K); B(0.09, 0.03, 0.14, 0.12, K); B(-0.09, 0.03, 0.1, 0.08, [0.85, 0.95, 1], 0.004); B(0.09, 0.03, 0.1, 0.08, [0.85, 0.95, 1], 0.004); B(-0.08, 0.025, 0.04, 0.05, K, 0.008); B(0.08, 0.025, 0.04, 0.05, K, 0.008); break;
      case 'zombie': B(-0.09, 0.03, 0.1, 0.06, K); B(0.09, 0.03, 0.1, 0.06, K); break;
      default: eyes(0.1, 0.08, -0.015, 0.025, 0.05, 0.06);
    }
    const RED = [0.55, 0.08, 0.1];
    switch (f.mouth || 'line') {
      case 'smile': B(0, -0.11, 0.1, 0.03, K); B(-0.065, -0.09, 0.03, 0.03, K); B(0.065, -0.09, 0.03, 0.03, K); break;
      case 'grin': B(0, -0.1, 0.24, 0.06, RED); B(0, -0.09, 0.2, 0.02, W, 0.004); break;
      case 'o': B(0, -0.11, 0.07, 0.07, K); break;
      case 'teeth': B(0, -0.09, 0.14, 0.03, K); B(-0.018, -0.12, 0.03, 0.04, W); B(0.018, -0.12, 0.03, 0.04, W); break;
      case 'beak': R(0, -0.04, Z - 0.06, 0.12, 0.07, 0.12, [1, 0.62, 0.1]); R(0, -0.12, Z - 0.015, 0.05, 0.07, 0.03, [0.9, 0.12, 0.1]); break;
      case 'mustache': B(0, -0.07, 0.2, 0.045, [0.88, 0.88, 0.86].map((v, i) => (f.top === 'chef' ? [0.25, 0.15, 0.08][i] : v))); B(-0.11, -0.095, 0.04, 0.05, f.top === 'chef' ? [0.25, 0.15, 0.08] : [0.88, 0.88, 0.86]); B(0.11, -0.095, 0.04, 0.05, f.top === 'chef' ? [0.25, 0.15, 0.08] : [0.88, 0.88, 0.86]); break;
      case 'tongue': B(0, -0.1, 0.14, 0.03, K); B(0.035, -0.13, 0.05, 0.05, [0.95, 0.45, 0.55], 0.004); break;
      case 'frown': B(0, -0.09, 0.1, 0.03, K); B(-0.065, -0.11, 0.03, 0.03, K); B(0.065, -0.11, 0.03, 0.03, K); break;
      case 'none': break;
      default: B(0, -0.1, 0.14, 0.03, K);
    }
    if (f.nose === 'snout') { R(0, -0.04, Z - 0.035, 0.15, 0.1, 0.07, [0.95, 0.55, 0.62]); B(-0.035, -0.04, 0.03, 0.04, [0.45, 0.15, 0.2], 0.072); B(0.035, -0.04, 0.03, 0.04, [0.45, 0.15, 0.2], 0.072); }
    else if (f.nose) R(0, -0.03, Z - 0.04, 0.08, 0.08, 0.08, f.nose);
    const tc = f.topColor || [0.9, 0.15, 0.12];
    switch (f.top) {
      case 'comb': for (const [z, h] of [[-0.12, 0.08], [-0.04, 0.11], [0.04, 0.09]]) R(0, 0.21 + h / 2, z, 0.05, h, 0.07, [0.92, 0.12, 0.1]); break;
      case 'stem': R(0.02, 0.27, 0, 0.05, 0.12, 0.05, [0.4, 0.28, 0.12], 0.2); break;
      case 'hair': R(0, 0.235, 0.01, 0.46, 0.07, 0.46, tc); R(0, 0.1, 0.215, 0.46, 0.28, 0.04, tc); R(-0.225, 0.13, 0.05, 0.03, 0.22, 0.36, tc); R(0.225, 0.13, 0.05, 0.03, 0.22, 0.36, tc); break;
      case 'ears': R(-0.15, 0.24, 0, 0.09, 0.09, 0.05, tc, 0.3); R(0.15, 0.24, 0, 0.09, 0.09, 0.05, tc, -0.3); break;
      case 'party': [[0.25, 0.2, [0.3, 0.6, 1]], [0.33, 0.14, [1, 0.85, 0.2]], [0.4, 0.08, [0.95, 0.3, 0.6]], [0.46, 0.04, [1, 1, 1]]].forEach(([y, w, c]) => R(0, y, 0, w, 0.08, w, c)); break;
      case 'antenna': R(0, 0.29, 0, 0.025, 0.16, 0.025, [0.3, 0.3, 0.32]); R(0, 0.39, 0, 0.06, 0.06, 0.06, Math.sin(time * 6) > 0 ? [1, 0.2, 0.2] : [0.5, 0.1, 0.1], 0, 0); break;
      case 'crown': R(0, 0.245, 0, 0.3, 0.07, 0.3, [1, 0.82, 0.2]); for (const [x, z] of [[-0.12, -0.12], [0.12, -0.12], [-0.12, 0.12], [0.12, 0.12], [0, -0.12]]) R(x, 0.3, z, 0.05, 0.06, 0.05, [1, 0.82, 0.2]); R(0, 0.25, -0.155, 0.05, 0.04, 0.02, [0.9, 0.1, 0.2], 0, 0); break;
      case 'horns': R(-0.14, 0.27, -0.02, 0.06, 0.12, 0.06, [0.15, 0.05, 0.05], 0.35); R(0.14, 0.27, -0.02, 0.06, 0.12, 0.06, [0.15, 0.05, 0.05], -0.35); break;
      case 'chef': R(0, 0.24, 0, 0.36, 0.05, 0.36, [0.98, 0.98, 0.98]); R(0, 0.34, 0, 0.32, 0.16, 0.32, [0.98, 0.98, 0.98]); break;
    }
  }
  /** Matrix of an arm: shoulder pivot, swung out sideways (rz) then forward/back (rx). */
  limb(base, px, py, rx, rz) { return Mat4.chain(base, Mat4.translation(px, py, 0), Mat4.rotationZ(rz || 0), Mat4.rotationX(-rx)); }   // negative rx = raised FORWARD (models face -z)
  /** A held item at the end of an arm. Tools are 3D pixel models (queued, drawn after the solid pass); blocks are small cubes. */
  heldProp(arm, id, thrust, roll, tint, look) {
    const it = ITEMS[id];
    if (it && it.kind === 'tool') {
      const tile = WEAPON_TOOLS.includes(id) ? weaponTile(id, look && look.weapons ? look.weapons[id] : 'default') : TILE['ICON_' + String(id).toUpperCase()];
      if (tile == null) return;
      const bow = id === 'bow', sc = bow ? 0.8 : 0.72, g = bow ? [0.156, -0.156] : [0.28, 0.28];
      this.heldQueue.push({ tile, m: Mat4.chain(arm, Mat4.translation(0, -0.6 - thrust, -0.02), Mat4.rotationY(Math.PI / 2), Mat4.rotationZ(-Math.PI / 4 + (roll || 0)), Mat4.scaling(sc, bow ? -sc : sc, sc), Mat4.translation(g[0], g[1], 0)) });
      return;
    }
    if (it && it.block) { const d = BlockRegistry.byType(it.block); if (d) this.box(Mat4.chain(arm, Mat4.translation(0, -0.78 - thrust, 0.08), Mat4.scaling(0.22, 0.22, 0.22)), tint(d.color || [0.6, 0.6, 0.6]), 1); }
  }
  humanoid(e, skin, shirt, legs, zombie, time, accent, face) {
    const swing = zombie ? 0 : e.swing || 0, ph = (e.walk || 0) * 3.2, fl = e.flash || 0;
    const crouch = e.crouch ? 0.14 : 0, burn = e.burning ? 0.25 + 0.25 * Math.sin(time * 18) : 0, chill = e.chilled ? 0.35 : 0;
    const tint = (c) => {
      let r = c[0], g = c[1], b = c[2];
      if (burn) { r = Math.min(1, r + burn); g *= 1 - burn * 0.4; b *= 1 - burn * 0.6; }
      if (chill) { r *= 1 - chill; g = Math.min(1, g * (1 - chill * 0.3) + chill * 0.3); b = Math.min(1, b + chill); }
      if (fl) { r = Math.min(1, r + fl * 0.75); g *= 1 - fl * 0.65; b *= 1 - fl * 0.65; }
      return [r, g, b];
    };
    const lean = e.sprinting ? 0.18 : 0;
    const base = Mat4.chain(Mat4.translation(e.x, e.y, e.z), Mat4.rotationY(e.yaw));
    const sw = Math.sin(ph) * (e.moving === false ? 0 : 0.85) * (e.sprinting ? 1.25 : 1);
    const armSwing = zombie ? -1.35 + Math.sin(ph) * 0.15 : null;
    this.part(base, -0.14, 0.7, 0, sw, -0.35, 0.27, 0.7, 0.27, tint(legs));
    this.part(base, 0.14, 0.7, 0, -sw, -0.35, 0.27, 0.7, 0.27, tint(legs));
    this.part(base, 0, 1.05 - crouch, 0, -(crouch * 2 + lean), 0, 0.58, 0.7, 0.3, tint(shirt));          // sneaking and sprinting lean forward
    if (accent) this.part(base, 0, 0.8 - crouch * 0.6, 0, -crouch * 2, 0, 0.6, 0.12, 0.32, tint(accent));
    this.part(base, 0, 1.4 - crouch, 0, (e.pitch ? clamp(e.pitch, -1.2, 1.2) : 0), 0.21, 0.42, 0.42, 0.42, tint(skin));
    this.face(Mat4.chain(base, Mat4.translation(0, 1.4 - crouch, 0), Mat4.rotationX((e.pitch ? clamp(e.pitch, -1.2, 1.2) : 0)), Mat4.translation(0, 0.21, 0)), zombie ? { eyes: 'zombie', mouth: 'frown' } : face || {}, tint, time);
    let ra, la, raz = 0, laz = 0, roll = 0, thrust = 0, rp = e.held || 'pickaxe', lp = null;
    if (zombie) { ra = la = armSwing; }
    else {
      const t = swing > 0 ? 1 - swing : 1, sk = e.sk || 'sword', ease = (x) => 1 - Math.pow(1 - x, 3), k = (x) => clamp(x, 0, 1);
      /** Keyframed pose: frames = [[t, ra, raz, roll], ...], smoothly blended. */
      const keys = (frames) => { let i = 0; while (i < frames.length - 2 && t > frames[i + 1][0]) i++; const a = frames[i], b = frames[i + 1], u = ease(k((t - a[0]) / Math.max(0.001, b[0] - a[0]))); ra = a[1] + (b[1] - a[1]) * u; raz = a[2] + (b[2] - a[2]) * u; roll = a[3] + (b[3] - a[3]) * u; };
      ra = -sw * 0.5 - 0.25; la = sw; raz = 0.05;
      if (rp === 'bow') { ra = -1.45; la = -1.5; laz = -0.15; raz = 0.25; lp = 'bow'; rp = null; if (swing > 0) ra = -1.45 + 0.7 * Math.sin(t * Math.PI); }
      else if (e.blocking) { ra = -1.15; raz = -0.35; roll = 0.9; la = -0.55; }
      else if (swing > 0) {
        const idle = -sw * 0.5 - 0.25;
        if (sk === 'axe') keys([[0, idle, 0.05, 0], [0.4, -2.75, 0.15, 0.2], [0.62, -0.35, -0.1, -0.15], [1, idle, 0.05, 0]]);                    // heavy overhead chop
        else if (sk === 'staff') { ra = -1.55; thrust = Math.sin(t * Math.PI) * 0.4; }
        else if (sk === 'pickaxe') keys([[0, idle, 0.05, 0], [0.25, -2.45, 0.1, 0], [0.62, -0.45, 0, 0], [1, idle, 0.05, 0]]);
        else keys([[0, idle, 0.05, 0], [0.18, -2.0, 0.85, 0.7], [0.55, -1.15, -0.55, -0.5], [1, idle, 0.05, 0]]);                             // sword: diagonal slash across the body
        la = sw * 0.3;
      }
    }
    const rArm = this.limb(base, 0.4, 1.38 - crouch, ra, raz), lArm = this.limb(base, -0.4, 1.38 - crouch, la, laz);
    this.box(Mat4.chain(rArm, Mat4.translation(0, -0.3, 0), Mat4.scaling(0.22, 0.68, 0.22)), tint(zombie ? skin : shirt), 1);
    this.box(Mat4.chain(lArm, Mat4.translation(0, -0.3, 0), Mat4.scaling(0.22, 0.68, 0.22)), tint(zombie ? skin : shirt), 1);
    const A = !zombie && e.look && ARMOR[e.look.armor] && e.look.armor !== 'none' ? ARMOR[e.look.armor] : null;
    if (A) {                                                              // armor: chest plate, belt in team colour, shoulder pads, greaves, open-faced helmet
      const bodyRx = -(crouch * 2 + lean);
      this.part(base, 0, 1.05 - crouch, 0, bodyRx, 0.04, 0.62, 0.6, 0.34, tint(A.c1));
      this.part(base, 0, 1.05 - crouch, 0, bodyRx, 0.12, 0.3, 0.2, 0.35, tint(A.trim));
      this.part(base, 0, 0.82 - crouch * 0.6, 0, bodyRx, 0, 0.64, 0.1, 0.36, tint(accent || shirt));
      for (const arm of [rArm, lArm]) this.box(Mat4.chain(arm, Mat4.translation(0, -0.06, 0), Mat4.scaling(0.29, 0.2, 0.29)), tint(A.c2), 1);
      this.part(base, -0.14, 0.7, 0, sw, -0.42, 0.29, 0.34, 0.29, tint(A.c2));
      this.part(base, 0.14, 0.7, 0, -sw, -0.42, 0.29, 0.34, 0.29, tint(A.c2));
      const H = Mat4.chain(base, Mat4.translation(0, 1.4 - crouch, 0), Mat4.rotationX(e.pitch ? clamp(e.pitch, -1.2, 1.2) : 0), Mat4.translation(0, 0.21, 0));
      const R = (x, y, z, w, h, d, c) => this.box(Mat4.chain(H, Mat4.translation(x, y, z), Mat4.scaling(w, h, d)), tint(c), 1);
      R(0, 0.235, 0.01, 0.47, 0.07, 0.47, A.c1); R(0, 0.06, 0.226, 0.47, 0.36, 0.04, A.c1); R(-0.226, 0.1, 0.03, 0.04, 0.28, 0.42, A.c1); R(0.226, 0.1, 0.03, 0.04, 0.28, 0.42, A.c1);
      R(0, 0.19, -0.222, 0.47, 0.05, 0.03, A.trim);
      if (A.visor) { R(0, -0.17, -0.222, 0.47, 0.05, 0.03, A.trim); R(-0.215, 0, -0.222, 0.05, 0.36, 0.03, A.trim); R(0.215, 0, -0.222, 0.05, 0.36, 0.03, A.trim); }
      if (e.look.armor === 'titan') { R(0, 0.29, 0, 0.06, 0.08, 0.4, A.trim); }
      if (e.look.armor === 'phantom') { R(0, 0.26, 0.04, 0.5, 0.06, 0.5, A.c2); }
    }
    if (!zombie) {
      if (rp) this.heldProp(rArm, rp, thrust, roll, tint, e.look);
      if (lp) this.heldProp(lArm, lp, 0, 0, tint, e.look);
      if (e.blocking && !lp) this.box(Mat4.chain(lArm, Mat4.translation(0, -0.85, 0), Mat4.scaling(0.34, 0.1, 0.34)), tint([0.55, 0.38, 0.2]), 1);       // off-hand guard plate
    }
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
        const col = hexToRgb(p.color), sk = p.look && p.look.skin !== 'default' ? COSMETICS.skin[p.look.skin] : null;
        if (sk) this.humanoid(p, sk.skin, sk.shirt, sk.legs, false, time, col, sk.face);
        else this.humanoid(p, HUMAN_SKIN, col, [0.2, 0.22, 0.4], false, time, null, null);
      }
      for (const m of snap.mobs) { if (m.type === 'creeper') this.creeper(m, time); else this.humanoid({ x: m.x, y: m.y, z: m.z, yaw: m.yaw, walk: m.walk, swing: m.swing, pitch: 0 }, ZOMBIE_SKIN, [0.2, 0.42, 0.5], [0.22, 0.25, 0.5], true, time); }
      if (this.heldQueue.length) {                                     // held weapons: textured pixel models, so switch to the world shader briefly
        this.useProgram(wp); gl.disable(gl.CULL_FACE);
        for (const q of this.heldQueue) this.drawMesh(this.iconVoxel(q.tile), q.m);
        gl.enable(gl.CULL_FACE); this.heldQueue.length = 0; this.useProgram(sp);
      }
      if (snap.banners) for (const b of snap.banners) this.banner(b, time);
      for (const a of snap.arrows) this.arrow(a, time);
      if (snap.drops) for (const d of snap.drops) this.crate(d, time);
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
    if (snap && snap.drops) for (const d of snap.drops) {                 // supply drop beacons
      gl.depthMask(false);
      this.boxAt(d.x, d.y + 20, d.z, 0.5, 40, 0.5, [0.35, 0.95, 1, 0.16 + 0.06 * Math.sin(time * 4)], 0);
      if (d.landed && d.prog > 0) this.boxAt(d.x, d.y + 0.06, d.z, 3.8 * d.prog, 0.08, 3.8 * d.prog, [1, 0.85, 0.3, 0.5], 0);
      gl.depthMask(true);
    }
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
      const id = held.id, t = swing, on = swing > 0;
      // pose = [X, Y, Z, RX, RY, RZ]; each swing is a few keyframes blended smoothly, so it reads as a real motion
      // blade angle on screen = 45 deg + RZ: idle points up-left from the bottom-right corner, like Minecraft
      const IDLE = id === 'bow' ? [0.3, -0.26, -0.7, 0, -0.5, 0.8] : [0.42, -0.36, -0.72, 0.1, -0.45, 1.35];
      const ANIM = {
        sword:   [[0, IDLE], [0.15, [0.55, 0.02, -0.74, 0.2, -0.4, 0.35]], [0.45, [-0.06, -0.3, -0.8, -0.3, 0.3, 2.6]], [1, IDLE]],
        axe:     [[0, IDLE], [0.38, [0.42, -0.02, -0.66, 0.95, -0.45, 0.95]], [0.58, [0.26, -0.56, -0.8, -1.2, -0.45, 1.55]], [1, IDLE]],
        pickaxe: [[0, IDLE], [0.25, [0.42, -0.08, -0.68, 0.75, -0.45, 1.0]], [0.6, [0.3, -0.5, -0.8, -1.0, -0.45, 1.5]], [1, IDLE]],
        staff:   [[0, IDLE], [0.3, [0.26, -0.26, -1.0, -0.3, -0.3, 1.2]], [1, IDLE]],
        lighter: [[0, IDLE], [0.3, [0.32, -0.24, -0.7, -0.5, -0.45, 1.35]], [1, IDLE]],
      }[id];
      const poseAt = (tt) => {
        if (!ANIM || tt <= 0) return IDLE.slice();
        let i = 0; while (i < ANIM.length - 2 && tt > ANIM[i + 1][0]) i++;
        const A = ANIM[i], B = ANIM[i + 1], u0 = clamp((tt - A[0]) / Math.max(0.001, B[0] - A[0]), 0, 1), u = u0 * u0 * (3 - 2 * u0);
        return A[1].map((v, j) => v + (B[1][j] - v) * u);
      };
      const matFor = (P) => Mat4.chain(Mat4.translation(P[0], P[1], P[2]), Mat4.rotationY(P[4]), Mat4.rotationZ(P[5]), Mat4.rotationX(P[3]), Mat4.translation(0.06, 0.06, 0), Mat4.scaling(0.36, 0.36, 0.36));
      const P = poseAt(on ? t : 0); P[1] += bob;
      const bk = held.block || 0;
      if (bk > 0 && id !== 'bow') { P[0] += -0.28 * bk; P[1] += 0.14 * bk; P[5] += 0.35 * bk; P[4] += 0.7 * bk; P[3] += 0.2 * bk; }
      if (id === 'bow') { const ch = held.charge || 0; P[0] += -0.2 * ch; P[2] += 0.06 * ch; P[4] += 0.3 * ch; P[1] += Math.sin(time * 40) * 0.003 * ch; }
      P[1] -= (1 - (held.equip == null ? 1 : held.equip)) * 0.55;
      this.drawMesh(this.iconVoxel(held.tile), matFor(P));
      gl.enable(gl.CULL_FACE);
      // swoosh trail behind the blade tip while the strike is moving
      const hitPart = id === 'sword' ? [0.12, 0.5] : id === 'axe' ? [0.4, 0.62] : null;
      if (on && hitPart && t > hitPart[0] && t < hitPart[1] + 0.12) {
        const sp = this.solidProg, sk = WEAPON_SKINS[held.skin], fx = sk && sk.pal.fx ? sk.pal.fx : [1, 1, 1], tip = [0.41, 0.41, 0];
        this.useProgram(sp);
        gl.uniformMatrix4fv(sp.u.uVP, false, proj); gl.uniform3f(sp.u.uCam, 0, 0, 0); gl.uniform1f(sp.u.uFogStart, 500); gl.uniform1f(sp.u.uFogEnd, 600); gl.uniform1f(sp.u.uBright, 1);
        gl.enable(gl.BLEND); gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA); gl.depthMask(false);
        const t1 = Math.min(t, hitPart[1]), t0 = Math.max(hitPart[0], t1 - 0.22), fade = t > hitPart[1] ? 1 - (t - hitPart[1]) / 0.12 : 1;
        for (let i = 0; i <= 14; i++) {
          const tt = t0 + (t1 - t0) * i / 14, M = matFor(poseAt(tt)), x = M[0] * tip[0] + M[4] * tip[1] + M[12], y = M[1] * tip[0] + M[5] * tip[1] + M[13], z = M[2] * tip[0] + M[6] * tip[1] + M[14];
          this.boxAt(x, y + bob, z, 0.03, 0.03, 0.03, [fx[0], fx[1], fx[2], 0.55 * fade * (i / 14)], 0);
        }
        gl.depthMask(true); gl.disable(gl.BLEND);
        this.useProgram(this.worldProg);
      }
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
      case 'slash': this.noise(0.14, 'bandpass', 2200, 0.28 * v, 2, 5200); this.tone(520, 260, 0.1, 0.08 * v, 'triangle'); break;
      case 'chop': this.noise(0.16, 'lowpass', 700, 0.5 * v, 1, 200); this.tone(130, 55, 0.16, 0.3 * v, 'square'); break;
      case 'crit': this.noise(0.1, 'bandpass', 1500, 0.4 * v, 3); this.tone(880, 1320, 0.12, 0.2 * v, 'triangle'); this.tone(1760, 1760, 0.14, 0.12 * v, 'sine', 0.05); break;
      case 'block': this.noise(0.08, 'highpass', 3000, 0.35 * v); this.tone(760, 700, 0.12, 0.2 * v, 'square'); this.tone(1140, 1000, 0.1, 0.1 * v, 'square'); break;
      case 'thump': this.noise(0.2, 'lowpass', 300, 0.6 * v, 1, 80); this.tone(70, 40, 0.25, 0.4 * v, 'sine'); break;
      case 'twang': this.tone(220, 180, 0.2, 0.18 * v, 'triangle'); this.noise(0.08, 'bandpass', 2500, 0.2 * v, 3); break;
      case 'kill': this.tone(520, 520, 0.1, 0.2 * v, 'square'); this.tone(780, 780, 0.1, 0.2 * v, 'square', 0.09); this.tone(1040, 1040, 0.2, 0.2 * v, 'square', 0.18); break;
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
      if (e.target && e.target.tagName === 'INPUT') return;                       // typing in a text box (chat, join code)
      if (e.repeat) return;
      this.keys.add(e.code);
      if (e.code === 'KeyW') { const now = performance.now(); if (now - (this.lastW || 0) < 300) this.sprintLatch = true; this.lastW = now; }      // double-tap W = sprint
      for (const fn of this.keyHandlers) fn(e);
    });
    window.addEventListener('keyup', (e) => { this.keys.delete(e.code); if (e.code === 'KeyW') this.sprintLatch = false; for (const fn of this.keyUpHandlers) fn(e); });
    window.addEventListener('blur', () => { this.sprintLatch = false; this.keys.clear(); this.mouse.left = this.mouse.right = false; });
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
  releaseAll() { this.sprintLatch = false; this.keys.clear(); this.mouse.left = this.mouse.right = false; this.dx = this.dy = this.wheel = 0; }
  controls() {
    const k = this.keys;
    return { forward: k.has('KeyW'), back: k.has('KeyS'), left: k.has('KeyA'), right: k.has('KeyD'), jump: k.has('Space'), crouch: k.has('ShiftLeft') || k.has('ShiftRight'), sprint: !!this.sprintLatch || k.has('ControlLeft') };
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
const RES_ICON = { wood: 'W', stone: 'S', iron: 'I', glass: 'G', tnt: 'T', water: '~', lava: 'L', mech: 'M', earth: 'E', arrow: '&#8599;' };

class UI {
  constructor() {
    const $ = (id) => document.getElementById(id);
    this.$ = $;
    this.panels = { main: $('panelMain'), pause: $('panelPause'), multi: $('panelMulti'), lobby: $('panelLobby'), locker: $('panelLocker'), how: $('panelHow'), settings: $('panelSettings'), stats: $('panelStats'), admin: $('panelAdmin') };
    this.slotEls = [];
    this.cache = {};
    this.bannerTimer = 0;
  }
  /** Writes innerHTML/text only when it changed (HUD updates run several times a second). */
  setHTML(id, html) { if (this.cache[id] !== html) { this.cache[id] = html; this.$(id).innerHTML = html; } }
  setText(id, text) { if (this.cache['t' + id] !== text) { this.cache['t' + id] = text; this.$(id).textContent = text; } }
  setWidth(id, pct) { const k = 'w' + id, v = Math.round(clamp(pct, 0, 100)); if (this.cache[k] !== v) { this.cache[k] = v; this.$(id).style.width = v + '%'; } }

  showPanel(name) { for (const [k, el] of Object.entries(this.panels)) el.classList.toggle('hidden', k !== name); const compact = name === 'lobby' || name === 'how' || name === 'locker' || name === 'multi' || name === 'admin'; this.$('title').classList.toggle('compact', compact); this.$('subtitle').classList.toggle('hidden', compact); }
  showOverlay(panel) { this.$('overlay').classList.remove('hidden'); this.showPanel(panel); }
  hideOverlay() { this.$('overlay').classList.add('hidden'); }
  showHud(v) { this.$('hud').classList.toggle('hidden', !v); }
  showError(msg) { const e = this.$('errorBox'); e.textContent = msg; e.classList.remove('hidden'); this.$('btnPlay').disabled = true; }

  /* ---------- icons ---------- */
  setAtlas(canvas) { document.documentElement.style.setProperty('--atlas', 'url(' + canvas.toDataURL() + ')'); }
  itemTile(itemId, look) {
    const it = ITEMS[itemId];
    if (it.kind === 'tool') return weaponTile(itemId, look && look.weapons ? look.weapons[itemId] : 'default');
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
        this.iconStyle(icon, this.itemTile(id, player && player.look));
        const it = ITEMS[id];
        let q = '', low = false;
        if (it.kind !== 'tool' && !server.unlimited) { const have = player.resources[it.res] || 0; q = Math.floor(have / (it.cost * (it.res === 'mech' ? player.mods.mechCost : 1) || 1)); low = q < 1; }
        else if (id === 'bow' && !server.unlimited) { q = Math.floor(player.resources.arrow || 0); low = q < 1; }
        else if (id === 'bucket' && !server.unlimited) { const f = player.bucketFluid || 'water'; q = Math.floor(player.resources[f] || 0) + (f === 'lava' ? 'L' : 'W'); low = !(player.resources[f] >= 1); }
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
  /**
   * v = { kind:'single'|'host'|'client', mode, mapId, bots, maxBots, name, classId, lands:[ids], roster:[{name,classId,isBot,ready,host,you,color,title}],
   *       edit (may change settings), me (my slot index), code, canStart, myReady, hint }
   * on = { change(patch), ready(), toggleReady }
   */
  renderLobby(v, on) {
    const modes = [['war', 'WAR', 'Free-for-all: last one standing'], ['alliance', 'ALLIANCE WAR', 'Pairs form at the start; alliances can be made or broken'], ['sandbox', 'SANDBOX', 'Unlimited resources, no timers, respawn']];
    this.$('lobbyTitle').textContent = v.kind === 'single' ? 'SINGLE PLAYER' : v.kind === 'host' ? 'MULTIPLAYER - YOU ARE HOSTING' : 'MULTIPLAYER - JOINED GAME';
    const inv = this.$('inviteBox'); inv.classList.toggle('hidden', v.kind === 'single');
    if (v.kind !== 'single') this.$('inviteCode').textContent = v.code || '-----';
    const seg = this.$('segMode');
    seg.innerHTML = modes.map(([id, label, tip]) => `<button class="segbtn ${v.mode === id ? 'on' : ''}" data-mode="${id}" title="${esc(tip)}" ${v.edit ? '' : 'disabled'}>${label}</button>`).join('');
    if (v.edit) seg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => on.change({ mode: b.dataset.mode })));
    const dseg = this.$('segDiff'), showD = v.kind !== 'client'; dseg.classList.toggle('hidden', !showD); this.$('diffLabel').classList.toggle('hidden', !showD);
    dseg.innerHTML = DIFF_ORDER.map((id) => `<button class="segbtn ${v.difficulty === id ? 'on' : ''}" data-diff="${id}" title="${esc(DIFFICULTIES[id].blurb)}">${DIFFICULTIES[id].name.toUpperCase()}</button>`).join('');
    dseg.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => on.change({ difficulty: b.dataset.diff })));
    const bots = this.$('setBots'); bots.min = v.minBots; bots.max = v.maxBots; bots.value = v.bots; bots.disabled = !v.edit;
    this.$('outBots').textContent = v.bots; this.$('setName').value = v.name;
    this.$('mapCards').innerHTML = [...MAP_ORDER, 'random'].map((id) => {
      const m = MAPS[id] || { name: 'Random', icon: '#8a7acb', blurb: 'A surprise map every match.' };
      return `<div class="mapcard ${v.mapId === id ? 'on' : ''} ${v.edit ? '' : 'locked'}" data-map="${id}" style="--c:${m.icon}"><div class="swatch"></div><h4>${esc(m.name)}</h4><p>${esc(m.blurb)}</p></div>`;
    }).join('');
    if (v.edit) this.$('mapCards').querySelectorAll('.mapcard').forEach((el) => el.addEventListener('click', () => on.change({ mapId: el.dataset.map })));
    // roster: always six slots so it is obvious how full the match is
    const rows = [];
    for (let i = 0; i < 6; i++) {
      const r = v.roster[i];
      if (!r) { rows.push(`<div class="rrow empty" style="--c:#555"><span class="nm">Empty slot</span></div>`); continue; }
      const st = r.isBot ? '<span class="st bot">AI</span>' : r.ready ? '<span class="st ok">READY</span>' : '<span class="st wait">NOT READY</span>';
      const ttl = r.title && TITLES[r.title] ? `<small>${esc(TITLES[r.title].name)}</small>` : '';
      rows.push(`<div class="rrow" style="--c:${CONFIG.COLORS[i]}"><span class="nm">${esc(r.name)}${r.host ? ' <small>HOST</small>' : ''}${r.you ? ' <small>YOU</small>' : ''}${ttl}</span><span class="cls">${esc(CLASSES[r.classId].name)}</span><span class="cls" style="color:${LANDS[v.lands[i]].icon}">${esc(LANDS[v.lands[i]].name)}</span>${st}</div>`);
    }
    this.$('rosterList').innerHTML = rows.join('');
    this.$('rosterCount').textContent = `(${v.roster.length}/6)`;
    this.$('classCards').innerHTML = CLASS_ORDER.map((id) => {
      const c = CLASSES[id];
      return `<div class="card ${v.classId === id ? 'on' : ''}" data-class="${id}"><h4>${esc(c.name)}</h4><p>${esc(c.blurb)}</p><ul>${c.perks.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>`;
    }).join('');
    this.$('classCards').querySelectorAll('.card').forEach((el) => el.addEventListener('click', () => on.change({ classId: el.dataset.class })));
    const myLand = v.lands[v.me] || v.lands[0], L = LANDS[myLand], syn = SYNERGIES[v.classId + ':' + myLand];
    this.$('landInfo').innerHTML = `<div class="landcard" style="--c:${L.icon}"><h4>${esc(L.name)} <small>${esc(L.blurb)}</small></h4>
      <div class="pc"><ul class="pros">${L.pros.map((p) => `<li>${esc(p)}</li>`).join('')}</ul><ul class="cons">${L.cons.map((p) => `<li>${esc(p)}</li>`).join('')}</ul></div>
      ${syn ? `<div class="syn">SYNERGY &middot; ${esc(syn)}</div>` : ''}</div>`;
    this.$('matchup').innerHTML = 'Lands this match: ' + v.roster.map((r, i) => `<span class="tag" style="--c:${LANDS[v.lands[i]].icon}">${esc(r.you ? 'YOU' : r.name)}: ${esc(LANDS[v.lands[i]].name)}</span>`).join(' ');
    const rr = this.$('btnReroll'); rr.classList.toggle('hidden', !v.edit);
    const start = this.$('btnStart'); start.classList.toggle('hidden', !v.edit); start.disabled = !v.canStart;
    const ready = this.$('btnReady'); ready.classList.toggle('hidden', v.kind === 'single' || v.kind === 'host'); ready.textContent = v.myReady ? 'NOT READY' : 'READY';
    const hint = this.$('lobbyHint'); hint.textContent = v.hint || ''; hint.className = 'netmsg ' + (v.hintClass || '');
    this.$('setName').disabled = false;
  }

  /* ---------- profile / locker / stats ---------- */
  renderProfileBar(career) {
    const L = levelFor(career.xp);
    this.$('profileBar').innerHTML = `<div class="ver">VERSION ${GAME_VERSION}</div><div class="lv"><span>LEVEL ${L.level}</span><span>${career.coins} coins</span></div><div class="xpbar"><i style="width:${Math.round(L.into / L.need * 100)}%"></i></div>`;
    const box = this.$('dailyBox'), d = career.daily;
    if (box && d && d.list) {
      const now = new Date(), mid = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1), hrs = Math.max(1, Math.ceil((mid - now) / 3600000));
      box.innerHTML = `<h5>DAILY CHALLENGES <small>new in ${hrs}h</small></h5>` + d.list.map((c) => { const D = DAILY_BY_ID[c.id]; return D ? `<div class="dc ${c.done ? 'done' : ''}"><span>${esc(D.text)} ${c.done ? '' : '(' + Math.min(c.p, D.n) + '/' + D.n + ')'}</span><em>${c.done ? 'DONE' : '+' + D.coins}</em></div>` : ''; }).join('');
    }
  }
  renderStats(career, rows) {
    const L = levelFor(career.xp);
    this.$('statsLevel').innerHTML = `LEVEL ${L.level} <small style="font-weight:400;color:var(--muted)">${L.into} / ${L.need} XP to next</small><div class="xpbar"><i style="width:${Math.round(L.into / L.need * 100)}%"></i></div>`;
    this.$('statsTable').innerHTML = rows.map(([k, v]) => `<tr><td>${k}</td><td>${v}</td></tr>`).join('');
    this.$('titleList').innerHTML = TITLE_ORDER.map((id) => { const t = TITLES[id], ok = t.ok(career); return `<div class="ttl ${ok ? 'ok' : ''}"><b>${esc(t.name)}</b>${ok ? ' &#10003;' : ''}<small>${esc(t.desc)}</small></div>`; }).join('');
  }
  /**
   * Locker: tabs per cosmetic slot. state = { tab, profile, career }, on = { buy(slot,id), equip(slot,id), color(i), title(id), emote(slot,id) }.
   */
  renderLocker(state, on) {
    const { tab, profile, career } = state, L = levelFor(career.xp), eq = profile.equipped;
    const tabs = [['skin', 'SKINS'], ['weapon', 'WEAPONS'], ['armor', 'ARMOR'], ['trail', 'TRAILS'], ['kill', 'KILL EFFECTS'], ['emote', 'EMOTES'], ['banner', 'BANNERS'], ['title', 'TITLES']];
    this.$('lockerBar').innerHTML = `<span><b>LEVEL ${L.level}</b> <span class="xpbar"><i style="width:${Math.round(L.into / L.need * 100)}%"></i></span></span><span><b>${career.coins}</b> coins</span>`;
    const tabEl = this.$('lockerTabs');
    tabEl.innerHTML = tabs.map(([id, label]) => `<button class="segbtn ${tab === id ? 'on' : ''}" data-tab="${id}">${label}</button>`).join('');
    tabEl.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => on.tab(b.dataset.tab)));
    const grid = this.$('lockerGrid'); let html = '';
    const hex = (c) => `rgb(${Math.round(c[0] * 255)},${Math.round(c[1] * 255)},${Math.round(c[2] * 255)})`;
    if (tab === 'armor') {
      html = `<div style="grid-column:1/-1"><span class="req">Armor sets protect you in different ways. Each has a <b class="pk-good">perk</b> and a <b class="pk-bad">drawback</b>. <b>Skill beats gear:</b> crits (jump hits) and arrow headshots go straight through armor, heavy plate even takes extra crit damage, and a last-moment block parries any swing.</span></div>`;
      html += ARMOR_ORDER.filter((id) => !ARMOR[id].admin || state.admin).map((id) => {
        const A = ARMOR[id], owned = id === 'none' || (profile.owned.armor || []).includes(id) || (A.admin && state.admin), lvlOk = L.level >= A.level, on2 = (eq.armor || 'none') === id;
        const btn = owned ? `<button class="btn tiny" data-act="aequip" data-id="${id}">${on2 ? 'EQUIPPED' : 'EQUIP'}</button>`
          : lvlOk ? `<button class="btn tiny" data-act="abuy" data-id="${id}" ${career.coins >= A.cost ? '' : 'disabled'}>BUY ${A.cost}</button>` : `<span class="req">Unlocks at level ${A.level}</span>`;
        const perks = armorPerkLines(A.perk).map(([t, good]) => `<li class="${good ? 'pk-good' : 'pk-bad'}">${good ? '+' : '-'} ${esc(t)}</li>`).join('');
        return `<div class="lk wsk ${on2 ? 'on' : ''} ${owned || lvlOk ? '' : 'locked'}"><div class="wsk-h">${this.iconHTML(armorTile(id), 48)}<div><h4>${esc(A.name)}</h4><span class="req">${esc(A.tag)}</span></div></div>${perks ? `<ul class="pk">${perks}</ul>` : ''}${btn}</div>`;
      }).join('');
    } else if (tab === 'weapon') {
      html = `<div style="grid-column:1/-1"><span class="req">Every collection plays differently: each skin has a <b class="pk-good">perk</b> and a <b class="pk-bad">drawback</b>. Buy each skin per weapon with coins you earn by playing.</span></div>`;
      for (const tool of WEAPON_TOOLS) {
        html += `<div style="grid-column:1/-1"><h3 style="margin:6px 0 0">${esc(ITEMS[tool].label.toUpperCase())}</h3></div>`;
        html += WEAPON_SKIN_ORDER.filter((sk) => !WEAPON_SKINS[sk].admin || state.admin).map((sk) => {
          const W = WEAPON_SKINS[sk], key = tool + ':' + sk, owned = sk === 'default' || profile.owned.weapon.includes(key), lvlOk = L.level >= W.level, on2 = (eq.weapons || {})[tool] === sk;
          const btn = owned ? `<button class="btn tiny" data-act="wequip" data-id="${key}">${on2 ? 'EQUIPPED' : 'EQUIP'}</button>`
            : W.admin ? '<span class="req">Admin only</span>'
            : lvlOk ? `<button class="btn tiny" data-act="wbuy" data-id="${key}" ${career.coins >= W.cost ? '' : 'disabled'}>BUY ${W.cost}</button>` : `<span class="req">Unlocks at level ${W.level}</span>`;
          const perks = perkLines(W.perk[tool] || {}).map(([t, good]) => `<li class="${good ? 'pk-good' : 'pk-bad'}">${good ? '+' : '-'} ${esc(t)}</li>`).join('');
          return `<div class="lk wsk ${on2 ? 'on' : ''} ${owned || lvlOk ? '' : 'locked'}"><div class="wsk-h">${this.iconHTML(weaponTile(tool, sk), 48)}<div><h4>${esc(W.name)}</h4><span class="req">${esc(tool === 'pickaxe' && W.pickTag ? W.pickTag : tool === 'staff' && W.staffTag ? W.staffTag : W.tag)}</span></div></div>${perks ? `<ul class="pk">${perks}</ul>` : ''}${btn}</div>`;
        }).join('');
      }
    } else if (tab === 'title') {
      html = TITLE_ORDER.map((id) => { const t = TITLES[id], ok = t.ok(career); return `<div class="lk ${eq.title === id ? 'on' : ''} ${ok ? '' : 'locked'}"><h4>${esc(t.name)}</h4><span class="req">${esc(t.desc)}</span>${ok ? `<button class="btn tiny" data-act="title" data-id="${id}">${eq.title === id ? 'EQUIPPED' : 'EQUIP'}</button>` : '<span class="req"><br>Locked</span>'}</div>`; }).join('');
    } else {
      const items = COSMETICS[tab];
      if (tab === 'banner') {
        html += `<div style="grid-column:1/-1"><span class="req">Banner colour</span><div class="swatches">${BANNER_COLORS.map((c, i) => `<i class="sw ${eq.bannerColor === i ? 'on' : ''}" data-act="color" data-id="${i}" style="background:${hex(c)}"></i>`).join('')}</div></div>`;
      }
      if (tab === 'emote') {
        html += `<div style="grid-column:1/-1"><span class="req">Keys <b>Z X C V</b> use these four slots. Pick a slot, then click an emote you own.</span><div class="emslots">${eq.emotes.map((id, i) => `<span class="emslot ${state.emoteSlot === i ? 'on' : ''}" data-act="slot" data-id="${i}">${'ZXCV'[i]}: ${esc(COSMETICS.emote[id].name)}</span>`).join('')}</div></div>`;
      }
      html += Object.keys(items).filter((id) => !items[id].admin || state.admin).map((id) => {
        const it = items[id], owned = profile.owned[tab].includes(id), lvlOk = L.level >= it.level, canBuy = !owned && lvlOk && career.coins >= it.cost;
        let btn;
        if (tab === 'emote') btn = owned ? `<button class="btn tiny" data-act="emote" data-id="${id}">USE IN SLOT ${'ZXCV'[state.emoteSlot]}</button>` : lvlOk ? `<button class="btn tiny" data-act="buy" data-id="${id}" ${canBuy ? '' : 'disabled'}>BUY ${it.cost}</button>` : `<span class="req">Level ${it.level}</span>`;
        else if (owned) btn = `<button class="btn tiny" data-act="equip" data-id="${id}">${eq[tab] === id ? 'EQUIPPED' : 'EQUIP'}</button>`;
        else btn = lvlOk ? `<button class="btn tiny" data-act="buy" data-id="${id}" ${canBuy ? '' : 'disabled'}>BUY ${it.cost}</button>` : `<span class="req">Unlocks at level ${it.level}</span>`;
        const prev = tab === 'skin' && it.shirt ? `style="--c1:${hex(it.shirt)};--c2:${hex(it.skin)};--c3:${hex(it.legs)}"` : tab === 'banner' ? `style="--c1:${hex(BANNER_COLORS[eq.bannerColor])};--c2:${hex(it.a || [1, 1, 1])};--c3:${hex(BANNER_COLORS[eq.bannerColor])}"` : tab === 'trail' && it.color ? `style="--c1:#222;--c2:${hex(it.color)};--c3:#222"` : '';
        return `<div class="lk ${(tab === 'emote' ? false : eq[tab] === id) ? 'on' : ''} ${owned || lvlOk ? '' : 'locked'}"><div class="prev" ${prev}></div><h4>${esc(it.name)}</h4>${it.joke ? `<span class="req" style="display:block">${esc(it.joke)}</span>` : ''}${btn}</div>`;
      }).join('');
    }
    grid.innerHTML = html;
    grid.querySelectorAll('[data-act]').forEach((el) => el.addEventListener('click', () => {
      const act = el.dataset.act, id = el.dataset.id;
      if (act === 'abuy') on.abuy(id); else if (act === 'aequip') on.aequip(id);
      else if (act === 'wbuy') on.wbuy(id); else if (act === 'wequip') on.wequip(id);
      else if (act === 'buy') on.buy(tab, id); else if (act === 'equip') on.equip(tab, id); else if (act === 'color') on.color(+id);
      else if (act === 'title') on.title(id); else if (act === 'slot') on.slot(+id); else if (act === 'emote') on.emote(state.emoteSlot, id);
    }));
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
      <span class="hpb"><i style="width:${r.alive ? Math.round(r.hp) : 0}%"></i></span><span class="int ${r.core === false ? 'low' : ''}" title="${r.core === false ? 'Core destroyed: no respawns' : 'Core standing'} - base integrity ${r.integ}%">${r.core === false ? '&#10007;' : '&#9670;'}${r.integ}%</span><b class="sc">${r.score}</b></div>`).join(''));
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
  hitMarker(kind) { const el = this.$('hitmarker'); el.className = ''; void el.offsetWidth; el.className = 'on ' + (kind || ''); }
  dirIndicator(angle) { const d = document.createElement('div'); d.className = 'dd'; d.style.transform = `rotate(${angle}rad)`; this.$('dmgdir').appendChild(d); setTimeout(() => d.remove(), 950); }
  updateFloaters(list) {
    const box = this.$('floaters');
    while (box.children.length < list.length) { const d = document.createElement('div'); d.className = 'fl'; box.appendChild(d); }
    for (let i = 0; i < box.children.length; i++) {
      const el = box.children[i], n = list[i];
      if (!n) { el.style.display = 'none'; continue; }
      el.style.display = 'block'; el.style.opacity = n.alpha.toFixed(2);
      el.style.transform = `translate(-50%,-50%) translate(${n.x.toFixed(0)}px,${n.y.toFixed(0)}px) scale(${n.scale.toFixed(2)})`;
      if (el._t !== n.text) { el._t = n.text; el.textContent = n.text; }
      el.className = 'fl ' + (n.cls || '');
    }
  }
  /** Swing cooldown ticker around the crosshair: v = recovery 0..1 (hidden when ready). */
  setCooldown(v) {
    const el = this.$('cdring'); if (!el) return;
    const show = v > 0 && v < 1;
    if (show) el.style.setProperty('--p', Math.round(v * 100));
    if (!show && !el.classList.contains('hidden') && !el.classList.contains('deny')) { el.classList.add('ready'); el.style.setProperty('--p', 100); clearTimeout(this.cdT); this.cdT = setTimeout(() => { el.classList.add('hidden'); el.classList.remove('ready'); }, 140); return; }
    if (show) { clearTimeout(this.cdT); el.classList.remove('hidden', 'ready'); }
  }
  denySwing() { const el = this.$('cdring'); if (!el) return; el.classList.remove('deny'); void el.offsetWidth; el.classList.add('deny'); clearTimeout(this.denyT); this.denyT = setTimeout(() => el.classList.remove('deny'), 320); }
  setBuffs(p) {
    const out = [];
    if (p && p.alive) {
      for (const k in BUFF_INFO) if (p.buffs && p.buffs[k] > 0) out.push(`<span style="--c:${BUFF_INFO[k].color}">${BUFF_INFO[k].name} ${Math.ceil(p.buffs[k])}s</span>`);
      if (p.streak >= 2) out.push(`<span class="streak">${p.streak} KILL STREAK</span>`);
    }
    this.setHTML('buffs', out.join(''));
  }
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
      el.style.display = 'block'; el.classList.toggle('hot', !!n.hot);
      el.style.transform = `translate(-50%,-100%) translate(${n.x.toFixed(0)}px,${n.y.toFixed(0)}px) scale(${n.scale.toFixed(2)})`;
      const html = `${n.say ? '<span class="say">' + esc(n.say) + '</span>' : ''}<span class="nn" style="--c:${n.color}">${esc(n.name)}${n.ally ? ' <em>ALLY</em>' : ''}${n.bounty ? ' <em class="bty">$' + n.bounty + '</em>' : ''}</span>${n.title ? '<span class="ttlTag">' + esc(n.title) + '</span>' : ''}<span class="nb"><i style="width:${n.hp}%"></i></span>`;
      if (el._h !== html) { el._h = html; el.innerHTML = html; }
    }
  }

  /* ---------- scoreboard / diplomacy / results ---------- */
  renderScoreboard(server, me) {
    const rows = server.scoreboard().map((p, i) => {
      const ally = server.areAllies(p, me);
      return `<tr class="${p === me ? 'me' : ''} ${p.alive ? '' : 'dead'}" style="--c:${p.color}"><td>${i + 1}</td><td><i class="dot"></i>${esc(p.name)}${p.look && TITLES[p.look.title] ? ' <small>' + esc(TITLES[p.look.title].name) + '</small>' : ''}${ally ? ' <em>ALLY</em>' : ''}${p.bounty ? ' <em class="bty">$' + p.bounty + '</em>' : ''}</td><td>${CLASSES[p.classId].name}</td><td>${LANDS[p.landId].name}</td>
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
    const ln = (k, v) => `<div class="line"><span>${k}</span><span>${v}</span></div>`;
    const summary = myRow ? `<div class="summary"><h3>${won ? 'VICTORY!' : R.winners.length ? 'DEFEAT' : 'DRAW'}</h3><div style="font-size:18px;font-weight:900;margin-bottom:6px">${esc(me.name)}</div>
      ${ln('Kills', myRow.kills)}${ln('Damage Dealt', Math.round(myRow.damageDealt))}${ln('Blocks Destroyed', myRow.blocksDestroyed)}${ln('Structures Destroyed', myRow.structuresDestroyed)}${ln('TNT Eliminations', myRow.tntKills)}
      <div class="reward">+${myRow.xp} XP &nbsp; +${myRow.coins} Coins</div>${extra && extra.levelUp ? `<div class="lvup">LEVEL UP! You are now level ${extra.levelUp}</div>` : ''}${extra && extra.titles && extra.titles.length ? `<div class="lvup">New title: ${esc(extra.titles.join(', '))}</div>` : ''}</div>` : '';
    this.$('results').innerHTML = `<div class="panel wide ${won ? 'win' : 'lose'}"><h1>${title}</h1><p class="sub">${esc(who)} &mdash; ${esc(reason)}</p>${summary}
      <table class="grid"><tr><th>#</th><th>Player</th><th>Class</th><th>Kills</th><th>Ast</th><th>Deaths</th><th>Structures</th><th>TNT kills</th><th>Blocks</th><th>Objectives</th><th>Score</th><th>XP</th><th>Coins</th></tr>${rows}</table>
      <p class="sub">${extra && extra.text || ''}</p>
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
const INTERACTIVE = new Set(['lever', 'button', 'door', 'timer', 'turret']);
const DEFAULT_HOTBAR = ['pickaxe', 'sword', 'bow', 'stone', 'wood', 'tnt', 'lighter', 'water', 'bucket'];
const KILL_VERB = { trap: 'impaled', melee: 'slew', arrow: 'shot', explosion: 'blew up', crush: 'crushed', mob: 'was mauled by a zombie', lava: 'swam in lava', fire: 'burned', fall: 'hit the ground too hard', drown: 'drowned', flood: 'was swept away' };

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
    this.career = Object.assign({ matches: 0, wins: 0, kills: 0, deaths: 0, xp: 0, coins: 0, blocks: 0, best: 0, playSeconds: 0, tntKills: 0, structures: 0, damage: 0, totalCoins: 0 }, Storage.load('mpw.career', {}));
    this.profile = sanitizeProfile(Storage.load('mpw.profile', null));
    this.admin = Object.assign({}, ADMIN_DEFAULTS, { unlocked: false, enabled: true }, Storage.load('mpw.admin', {}));
    this.lobby = Object.assign({ difficulty: 'normal', mode: 'war', bots: 3, classId: 'builder', name: 'PLAYER', seed: 1, mapId: 'plains' }, Storage.load('mpw.lobby', {}));
    if (!CLASSES[this.lobby.classId]) this.lobby.classId = 'builder';
    if (!MAPS[this.lobby.mapId] && this.lobby.mapId !== 'random') this.lobby.mapId = 'plains';
    this.lobby.bots = clamp(this.lobby.bots | 0, 1, 5);
    this.kind = 'single';              // single | host | client
    this.host = null; this.client = null; this.clientLobby = null; this.ai = []; this.lockerTab = 'skin'; this.emoteSlot = 0;
    this.chatLog = []; this.chatMuted = new Set(); this.chatOpen = false; this.bubbles = new Map(); this.trailClock = 0; this.netNotice = '';
    this.hotbar = Storage.load('mpw.hotbar', { slots: DEFAULT_HOTBAR }).slots;
    if (!Array.isArray(this.hotbar) || this.hotbar.length !== 9 || this.hotbar.some((h) => h && !ITEMS[h])) this.hotbar = DEFAULT_HOTBAR.slice();
    this.selected = 0;
    this.state = 'menu';            // menu | paused | playing | panel | results
    this.backPanel = 'main';
    this.target = null; this.entityTarget = null; this.mining = null; this.charge = 0; this.leftWas = false; this.rightWas = false;
    this.accumulator = 0; this.lastTime = 0; this.fps = 0; this.fpsFrames = 0; this.fpsClock = 0; this.hudClock = 0; this.time = 0;
    this.floats = []; this.flashT = new Map(); this.hotT = new Map(); this.kick = 0; this.blockAmt = 0; this.blockSent = false; this.heldSent = null; this.equip = 1; this.lastDmgEvt = null;
    this.debugVisible = false; this.shake = 0; this.hurt = 0; this.dark = 0; this.hints = []; this.hintClock = 0; this.stepSound = 0;
    this.spectateIndex = -1; this.replay = null; this.pendingHighlight = null; this.lastHighlight = null; this.highlightCool = 0; this.pendingKillcam = null;
    this.killDeathTimes = []; this.resultsShown = false; this.statsSaved = false; this.scoreboardHeld = false;

    this.world = new World();
    this.localServer = new GameServer(this.world);          // runs single-player matches and hosted matches
    this.server = this.localServer;                         // becomes a NetServerView while joined to someone else's game
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
    this.ensureDaily(); this.ui.renderProfileBar(this.career);
    this.ui.showOverlay('main');
    const jc = new URLSearchParams(location.search).get('join');
    if (jc) { this.ui.showPanel('multi'); this.ui.$('joinCode').value = cleanCode(jc); this.setNet('Invite code ' + cleanCode(jc) + ' loaded. Press JOIN.'); }
    requestAnimationFrame((t) => { this.lastTime = t; this.frame(t); });
    window.addEventListener('beforeunload', () => this.saveCareer());
  }

  get player() { return this.server.human; }
  saveCareer() { Storage.save('mpw.career', this.career); Storage.save('mpw.lobby', this.lobby); Storage.save('mpw.hotbar', { slots: this.hotbar }); Storage.save('mpw.settings', this.settings); Storage.save('mpw.profile', this.profile); Storage.save('mpw.admin', this.admin); }

  /** A frozen sample map shown behind the main menu. */
  demoMatch() {
    const ids = Object.keys(MAPS), ai = [];
    for (let i = 0; i < 6; i++) ai.push({ name: BOT_NAMES[i % BOT_NAMES.length], classId: CLASS_ORDER[i % CLASS_ORDER.length], isBot: i > 0, look: randomLook() });
    this.localServer.startMatch({ mode: 'sandbox', seed: 1 + Math.floor(Math.random() * 999), mapId: ids[Math.floor(Math.random() * ids.length)], roster: ai });
    this.localServer.phase = 'idle';
    if (this.chunks) { this.chunks.chunks.forEach((c) => { c.dirty = true; }); this.chunks.buildAll(); }
  }



  /* ------------------------------ tutorial (optional, started from the main menu only) ------------------------------ */
  startTutorial() {
    this.kind = 'single'; this.chatLog = []; this.renderChat();
    const L = this.lobby, ai = this.ai.length ? this.ai : (this.rerollAI(), this.ai);
    const roster = [{ id: 'p0', name: L.name, classId: 'builder', isBot: false, look: this.myLook() }, { name: 'DUMMY', classId: 'fighter', isBot: true, look: ai[0] ? ai[0].look : randomLook() }];
    this.launch(() => this.localServer.startMatch({ mode: 'sandbox', seed: 11, mapId: 'plains', roster }));
    const p = this.player, b = this.server.players.find((q) => q !== p);
    if (b) { b.bot = null; b.teleport(p.pos.x + 5, p.pos.y + 1, p.pos.z); }          // a harmless practice dummy
    this.hotbar[0] = 'pickaxe'; this.hotbar[1] = 'sword';
    this.tut = { i: 0, start: { x: p.pos.x, z: p.pos.z }, flags: {}, done: false, hidden: false, clock: 0 };
    this.renderTutorial();
  }
  tutSteps() {
    const me = this.player;
    return [
      { t: 'Look and walk', d: 'Move with W A S D and look with the mouse. Walk about 6 blocks.', ok: () => Math.hypot(me.pos.x - this.tut.start.x, me.pos.z - this.tut.start.z) > 6 },
      { t: 'Jump', d: 'Press SPACE to jump.', ok: () => this.tut.flags.jump },
      { t: 'Sprint', d: 'Double-tap W (or hold CTRL) while moving to sprint. Sprinting makes your hits knock enemies back further.', ok: () => me.sprinting },
      { t: 'Break a block', d: 'Select the pickaxe (1), aim at a block and HOLD left click.', ok: () => this.tut.flags.broke },
      { t: 'Place a block', d: 'Pick a block slot (4-9) and RIGHT CLICK on a surface.', ok: () => this.tut.flags.placed },
      { t: 'Place a machine', d: 'Press E for the inventory, click Arrow Turret, Land Mine or Spike Trap, then place it. Machines work on their own against enemies.', ok: () => this.tut.flags.machine },
      { t: 'Hit the dummy', d: 'Select the sword (2) and left click the DUMMY. Wait for the charge bar: a full swing hurts more and a hit while falling is a critical.', ok: () => this.tut.flags.hit },
      { t: 'Block', d: 'With the sword selected, HOLD right click to block. Blocking cuts front damage a lot (up to 2.5 s, then it cools down).', ok: () => me.blocking },
      { t: 'Use chat', d: 'Press ENTER, type a message and press ENTER again. (/help lists commands.)', ok: () => this.tut.flags.chat },
    ];
  }
  renderTutorial() {
    const box = this.ui.$('tutorial'), t = this.tut;
    if (!t || t.hidden) { box.classList.add('hidden'); return; }
    const steps = this.tutSteps(); box.classList.remove('hidden');
    const rows = steps.map((st, i) => `<div class="ts ${i < t.i ? 'done' : i === t.i && !t.done ? 'cur' : ''}"><span>${i < t.i ? '&#10003;' : i + 1}</span>${esc(st.t)}</div>`).join('');
    const cur = steps[t.i];
    box.innerHTML = `<h4>TUTORIAL <small>(optional)</small></h4>${rows}` + (t.done ? '<p class="tdesc">All done! Keep experimenting here, or press Esc and LEAVE MATCH when you are ready to play.</p>' : `<p class="tdesc">${esc(cur.d)}</p>`) +
      `<div class="tkeys">${t.done ? '' : '<button class="btn tiny" data-tut="skip">SKIP STEP [K]</button> '}<button class="btn tiny" data-tut="close">${t.done ? 'CLOSE [L]' : 'HIDE TUTORIAL [L]'}</button></div>`;
  }
  tutAdvance() {
    const t = this.tut; t.i++; this.audio.play('chime', null, 0.5);
    if (t.i >= this.tutSteps().length) { t.done = true; Storage.save('mpw.tutorial', { done: true }); this.ui.banner('TUTORIAL COMPLETE', 'Nice work! Go play a real match whenever you like.', '', 3500); }
    this.renderTutorial();
  }
  tutorialTick(dt) {
    const t = this.tut; if (!t || t.done || t.hidden) return;
    const me = this.player; if (!me) return;
    if (!me.onGround && me.vel.y > 3) t.flags.jump = true;
    t.clock -= dt; if (t.clock > 0) return; t.clock = 0.15;
    const st = this.tutSteps()[t.i]; if (st && st.ok()) this.tutAdvance();
  }
  tutKey(code) {
    const t = this.tut; if (!t) return false;
    if (code === 'KeyL') { t.hidden = !t.hidden; this.renderTutorial(); if (t.hidden) this.ui.toast('Tutorial hidden. Press L to show it again.', '', 2500); return true; }
    if (code === 'KeyK' && !t.done && !t.hidden) { this.tutAdvance(); return true; }
    return false;
  }
  tutEvent(e) {
    const t = this.tut; if (!t || !this.player || e.by !== this.player.id) return;
    if (e.type === 'blockBroken') t.flags.broke = true;
    else if (e.type === 'blockPlaced') { t.flags.placed = true; const d = e.block; if (d && ['turret', 'cannon', 'mine', 'spikes', 'flamer', 'jumppad', 'conveyor', 'sprinkler', 'healer', 'dropper'].includes(d.type)) t.flags.machine = true; }
    else if (e.type === 'hit') t.flags.hit = true;
  }

  /* ------------------------------ chat ------------------------------ */
  chatColor(id) {
    const q = this.server && this.server.playerById ? this.server.playerById(id) : null; if (q && q.color) return q.color;
    const m = this.kind === 'host' && this.host ? this.host.lobbyMessage() : this.clientLobby; const i = m ? m.roster.findIndex((r) => r.id === id) : -1;
    return ['#ff6b5a', '#58a6ff', '#6bd36b', '#ffd23f', '#c78bff', '#ff9a3c'][i >= 0 ? i % 6 : 0];
  }
  myChatId() { return this.kind === 'client' && this.client && this.client.id ? this.client.id : 'p0'; }
  onChatMsg(m) {
    if (!m || typeof m.x !== 'string') return;
    if (m.id && this.chatMuted.has(m.id)) return;
    if (this.tut && m.id && m.id === this.myChatId() && !m.sys) this.tut.flags.chat = true;
    this.chatLog.push({ id: m.id, name: m.n, text: m.x.slice(0, CHAT.MAX), team: !!m.tm, me: !!m.me, sys: !!m.sys, color: m.sys ? '#ffd23f' : this.chatColor(m.id) });
    if (this.chatLog.length > 60) this.chatLog.shift();
    this.renderChat();
    if (!m.sys && m.id !== this.myChatId()) this.audio.play('click', null, 0.25);
  }
  sysChat(text) { this.onChatMsg({ sys: 1, x: text }); }
  renderChat() {
    const html = (n) => this.chatLog.slice(-n).map((c) => {
      if (c.sys) return `<div class="cl sys">${esc(c.text)}</div>`;
      const who = `<b class="chatname" data-id="${esc(c.id)}" style="color:${c.color}" title="Click to mute / unmute">${esc(c.name)}</b>`;
      return `<div class="cl ${c.team ? 'team' : ''}">${c.team ? '<i>[TEAM]</i> ' : ''}${c.me ? '* ' + who + ' ' + esc(c.text) : who + ': ' + esc(c.text)}</div>`;
    }).join('');
    const hud = this.ui.$('chatLog'), lob = this.ui.$('lobbyChatLog');
    if (hud) hud.innerHTML = html(10);
    if (lob) { lob.innerHTML = html(40); lob.scrollTop = lob.scrollHeight; }
  }
  toggleMute(id) {
    if (!id || id === this.myChatId()) return;
    const name = this.chatNameOf(id);
    if (this.chatMuted.has(id)) { this.chatMuted.delete(id); this.sysChat('Unmuted ' + name + '.'); } else { this.chatMuted.add(id); this.sysChat('Muted ' + name + ' (their messages are hidden for you).'); }
  }
  chatNameOf(id) {
    const q = this.server && this.server.playerById ? this.server.playerById(id) : null; if (q) return q.name;
    const m = this.kind === 'host' && this.host ? this.host.lobbyMessage() : this.clientLobby; const r = m && m.roster.find((x) => x.id === id); return r ? r.name : id;
  }
  /** Handles /commands, then sends (host relays to everyone). Single-player just echoes locally. */
  submitChat(raw) {
    let text = chatClean(raw); if (!text) return;
    let team = false, me = false;
    if (text[0] === '/') {
      const [cmd, ...rest] = text.slice(1).split(' '), arg = rest.join(' ').trim(), c = cmd.toLowerCase();
      if (c === 'help' || c === '?') { this.sysChat('Commands: /team (or /t) <msg>, /all <msg>, /me <action>, /mute <name>, /unmute <name>, /mutes. Click a name to mute them.'); return; }
      if (c === 'mute' || c === 'unmute') {
        const m = this.kind === 'host' && this.host ? this.host.lobbyMessage() : this.clientLobby;
        const ids = new Set([...(m ? m.roster.map((r) => [r.id, r.name]) : []), ...(this.server && this.server.players ? this.server.players.map((q) => [q.id, q.name]) : [])].filter(([id, n]) => id !== this.myChatId() && String(n).toLowerCase() === arg.toLowerCase()).map(([id]) => id));
        if (!ids.size) { this.sysChat('No player called "' + arg + '".'); return; }
        for (const id of ids) { if (this.chatMuted.has(id) === (c === 'unmute')) this.toggleMute(id); }
        return;
      }
      if (c === 'mutes') { this.sysChat(this.chatMuted.size ? 'Muted: ' + Array.from(this.chatMuted).map((id) => this.chatNameOf(id)).join(', ') : 'Nobody is muted.'); return; }
      if (c === 'team' || c === 't') { team = true; text = arg; } else if (c === 'all' || c === 'a') text = arg; else if (c === 'me') { me = true; text = arg; } else { this.sysChat('Unknown command. Type /help.'); return; }
      if (!text) return;
    }
    if (this.kind === 'host' && this.host) { if (!chatAllowed(this)) { this.sysChat('Slow down: you are sending messages too fast.'); return; } this.host.sendChat(text, team, me); }
    else if (this.kind === 'client' && this.client) this.client.send({ t: 'chat', x: text, tm: team ? 1 : 0, me: me ? 1 : 0 });
    else { if (!chatAllowed(this)) { this.sysChat('Slow down: you are sending messages too fast.'); return; } this.onChatMsg({ id: 'p0', n: this.lobby.name, x: chatFilter(text), tm: 0, me: me ? 1 : 0 }); }
  }
  openChat(prefill) {
    if (this.chatOpen) return;
    this.chatOpen = true; this.input.releaseAll();
    const box = this.ui.$('chat'), inp = this.ui.$('chatIn'); box.classList.add('open'); inp.value = prefill || '';
    try { document.exitPointerLock(); } catch (e) { /* ignore */ }
    setTimeout(() => inp.focus(), 0);
  }
  closeChat() {
    if (!this.chatOpen) return;
    this.chatOpen = false; const inp = this.ui.$('chatIn'); inp.blur(); this.ui.$('chat').classList.remove('open');
    if (this.state === 'playing') { try { const pr = this.canvas.requestPointerLock(); if (pr && pr.catch) pr.catch(() => { this.state = 'paused'; this.ui.showOverlay('pause'); }); } catch (e) { /* ignore */ } }
  }
  bindChat() {
    const $ = this.ui.$;
    $('chatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.submitChat($('chatIn').value); $('chatIn').value = ''; this.closeChat(); } else if (e.key === 'Escape') { e.preventDefault(); this.closeChat(); } e.stopPropagation(); });
    $('lobbyChatIn').addEventListener('keydown', (e) => { if (e.key === 'Enter') { this.submitChat($('lobbyChatIn').value); $('lobbyChatIn').value = ''; } e.stopPropagation(); });
    for (const id of ['chatLog', 'lobbyChatLog']) $(id).addEventListener('click', (e) => { const t = e.target.closest && e.target.closest('.chatname'); if (t) this.toggleMute(t.dataset.id); });
  }

  /* ---------------------------- menu wiring ---------------------------- */
  bindUI() {
    const ui = this.ui, $ = ui.$, click = (id, fn) => $(id).addEventListener('click', () => { this.audio.unlock(); this.audio.play('click'); fn(); });
    this.bindChat();
    ui.buildHotbar(9, (i) => this.selectSlot(i));
    ui.buildInventory((item) => { this.hotbar[this.selected] = item; this.audio.play('click'); this.saveCareer(); });
    click('btnTutorial', () => this.startTutorial());
    $('tutorial').addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('[data-tut]'); if (b) this.tutKey(b.dataset.tut === 'skip' ? 'KeyK' : 'KeyL'); });
    click('btnPlay', () => { this.backPanel = 'main'; this.openLobby('single'); });
    click('btnMulti', () => { this.backPanel = 'main'; this.setNet(''); ui.showPanel('multi'); $('joinCode').focus(); });
    click('btnNetTest', async () => {
      const box = $('netDiag'); box.innerHTML = ''; this.setNet('Testing...');
      await netDiagnose((r) => { const d = document.createElement('div'); d.className = r.ok ? 'ok' : 'bad'; d.innerHTML = (r.ok ? '&#10003; ' : '&#10007; ') + esc(r.label) + (r.detail ? '<small>' + esc(r.detail) + '</small>' : ''); box.appendChild(d); });
      this.setNet('Test finished.');
    });
    click('btnHost', () => this.hostGame());
    click('btnJoin', () => this.joinGame($('joinCode').value));
    $('joinCode').addEventListener('input', () => { $('joinCode').value = cleanCode($('joinCode').value); });
    $('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') this.joinGame($('joinCode').value); });
    click('btnLocker', () => { this.backPanel = 'main'; this.openLocker(); });
    click('btnHow', () => { this.backPanel = 'main'; ui.showPanel('how'); });
    click('btnHow2', () => { this.backPanel = 'pause'; ui.showPanel('how'); });
    click('btnSettings', () => { this.backPanel = 'main'; ui.showPanel('settings'); });
    click('btnSettings2', () => { this.backPanel = 'pause'; ui.showPanel('settings'); });
    click('btnStats', () => { this.backPanel = 'main'; this.renderCareer(); ui.showPanel('stats'); });
    click('btnResume', () => this.startPlay());
    click('btnQuit', () => this.leaveMatch());
    click('btnStart', () => this.startFromLobby());
    click('btnReady', () => { const r = this.lobbyView(); this.client && this.client.send({ t: 'ready', r: !r.myReady }); this.myReady = !r.myReady; this.refreshLobby(); });
    click('btnReroll', () => this.onLobbyChange({ reroll: true }));
    click('btnLobbyBack', () => { if (this.kind === 'single') { this.backToMain(); } else this.leaveSession(); });
    click('btnCopyCode', () => this.copyText(this.inviteCode(), 'Game code copied'));
    click('btnCopyLink', () => this.copyText(this.inviteLink(), 'Invite link copied'));
    document.querySelectorAll('.back').forEach((b) => { if (b.id === 'btnLobbyBack') return; b.addEventListener('click', () => { this.audio.play('click'); this.backPanel === 'pause' ? ui.showPanel('pause') : this.backToMain(); this.saveCareer(); }); });
    click('invClose', () => this.setPanel(null));
    click('diploClose', () => this.setPanel(null));
    $('setBots').addEventListener('input', () => this.onLobbyChange({ bots: parseInt($('setBots').value, 10) }));
    $('setName').addEventListener('input', () => { const nm = $('setName').value.replace(/[^\w \-]/g, '').slice(0, 12) || 'PLAYER'; this.lobby.name = nm; this.onLobbyChange({ name: nm }); });

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
      if (b.dataset.act === 'again') { $('results').classList.add('hidden'); this.afterResults(); }
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
        if (this.state === 'playing' && !this.chatOpen) { this.state = 'paused'; ui.showOverlay('pause'); }
      }
    });
    document.addEventListener('pointerlockerror', () => { if (this.state === 'paused' || this.state === 'menu') ui.showOverlay('pause'); });
    window.addEventListener('resize', () => this.renderer && this.renderer.resize());
  }
  /** Picks today's three challenges (seeded by the date) the first time the game opens each day. */
  ensureDaily() {
    const n = new Date(), day = n.getFullYear() + '-' + (n.getMonth() + 1) + '-' + n.getDate(), c = this.career;
    if (c.daily && c.daily.day === day && Array.isArray(c.daily.list)) return;
    let h = 0; for (const ch of day) h = (h * 31 + ch.charCodeAt(0)) | 0;
    const r = mulberry32(h), ids = DAILY_POOL.map((d) => d.id).sort(() => r() - 0.5).slice(0, 3);
    c.daily = { day, list: ids.map((id) => ({ id, p: 0, done: false })) };
    this.saveCareer();
  }
  /** Counts progress toward today's challenges; pays coins the moment one is finished. */
  dailyBump(kind, n = 1) {
    if (!n || this.tut) return;
    this.ensureDaily();
    for (const c of this.career.daily.list) {
      const D = DAILY_BY_ID[c.id];
      if (!D || c.done || D.kind !== kind) continue;
      c.p += n;
      if (c.p >= D.n) {
        c.done = true; this.career.coins += D.coins; this.career.totalCoins = (this.career.totalCoins || 0) + D.coins;
        this.ui.toast(`<b>CHALLENGE COMPLETE</b> ${esc(D.text)} <em>+${D.coins} coins</em>`, 'good', 4000); this.audio.play('chime', null, 1);
        this.saveCareer();
      }
    }
  }
  backToMain() { this.ui.showOverlay('main'); this.ensureDaily(); this.ui.renderProfileBar(this.career); this.state = 'menu'; }
  setNet(text, cls = '') { const el = this.ui.$('netMsg'); el.textContent = text; el.className = 'netmsg ' + cls; }
  copyText(text, ok) {
    const done = () => this.ui.toast(ok, 'good', 1800), fallback = () => { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); try { document.execCommand('copy'); done(); } catch (e) { /* ignore */ } t.remove(); };
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback); else fallback();
  }
  inviteCode() { return this.host ? this.host.code : this.client && this.clientLobby ? this.clientLobby.code : ''; }
  inviteLink() { const u = new URL(location.href); u.search = ''; u.hash = ''; u.searchParams.set('join', this.inviteCode()); return u.toString(); }

  /* ---------------------------- profile, stats, locker ---------------------------- */
  renderCareer() {
    const c = this.career;
    this.ui.renderStats(c, [['Matches', c.matches], ['Wins', c.wins], ['Kills', c.kills], ['Deaths', c.deaths], ['TNT eliminations', c.tntKills], ['Structures destroyed', c.structures], ['Damage dealt', Math.round(c.damage)], ['Blocks destroyed', c.blocks], ['Best score', c.best], ['XP', c.xp], ['Coins', c.coins], ['Time played', Math.floor(c.playSeconds / 60) + ' min']]);
  }
  openLocker() { this.ui.showPanel('locker'); this.refreshLocker(); }
  refreshLocker() {
    const pr = this.profile, c = this.career;
    this.ui.renderLocker({ tab: this.lockerTab, profile: pr, career: c, emoteSlot: this.emoteSlot, admin: !!this.admin.unlocked }, {
      wbuy: (key) => { const [tool, sk] = key.split(':'), W = WEAPON_SKINS[sk]; if (W && !W.admin && c.coins >= W.cost && levelFor(c.xp).level >= W.level && !pr.owned.weapon.includes(key)) { c.coins -= W.cost; pr.owned.weapon.push(key); pr.equipped.weapons[tool] = sk; this.audio.play('chime', null, 0.6); this.saveCareer(); this.pushLook(); } this.refreshLocker(); },
      abuy: (id) => { const A = ARMOR[id]; pr.owned.armor = pr.owned.armor || ['none']; if (A && !A.admin && c.coins >= A.cost && levelFor(c.xp).level >= A.level && !pr.owned.armor.includes(id)) { c.coins -= A.cost; pr.owned.armor.push(id); pr.equipped.armor = id; this.audio.play('chime', null, 0.6); this.saveCareer(); this.pushLook(); } this.refreshLocker(); },
      aequip: (id) => { const A = ARMOR[id]; if (A && (id === 'none' || (pr.owned.armor || []).includes(id) || (A.admin && this.admin.unlocked))) { pr.equipped.armor = id; this.audio.play('click'); this.saveCareer(); this.pushLook(); } this.refreshLocker(); },
      wequip: (key) => { const [tool, sk] = key.split(':'); if (sk === 'default' || pr.owned.weapon.includes(key)) { pr.equipped.weapons[tool] = sk; this.audio.play('click'); this.saveCareer(); this.pushLook(); } this.refreshLocker(); },
      tab: (t) => { this.lockerTab = t; this.audio.play('click'); this.refreshLocker(); },
      slot: (i) => { this.emoteSlot = i; this.refreshLocker(); },
      buy: (slot, id) => { const it = COSMETICS[slot][id]; if (c.coins >= it.cost && levelFor(c.xp).level >= it.level && !pr.owned[slot].includes(id)) { c.coins -= it.cost; pr.owned[slot].push(id); if (slot !== 'emote') pr.equipped[slot] = id; this.audio.play('chime', null, 0.6); this.saveCareer(); this.pushLook(); } this.refreshLocker(); },
      equip: (slot, id) => { pr.equipped[slot] = id; this.audio.play('click'); this.saveCareer(); this.pushLook(); this.refreshLocker(); },
      color: (i) => { pr.equipped.bannerColor = i; this.saveCareer(); this.pushLook(); this.refreshLocker(); },
      title: (id) => { pr.equipped.title = id; this.saveCareer(); this.pushLook(); this.refreshLocker(); },
      emote: (slot, id) => { pr.equipped.emotes[slot] = id; this.saveCareer(); this.pushLook(); this.refreshLocker(); },
    });
  }
  /** Tells a hosted/joined lobby about changed cosmetics. */
  pushLook() { const look = publicLook(this.profile); if (this.host) this.host.setHostInfo({ look }); else if (this.client) this.client.send({ t: 'prof', look }); }
  myLook() { return publicLook(this.profile); }

  /* ---------------------------- admin panel (type LN1 as a join code) ---------------------------- */
  openAdmin() {
    if (!this.admin.unlocked) { this.admin.unlocked = true; this.saveCareer(); }
    this.backPanel = 'main'; this.ui.showPanel('admin'); this.renderAdmin();
  }
  renderAdmin() {
    const A = this.admin, $ = this.ui.$;
    $('adminNote').textContent = 'Powers apply to you in single player and when you host (other players get a chat line saying admin is on). They do nothing when you join someone else\'s game.';
    const sliders = ADMIN_SLIDERS.map(([k, label, min, max, step, fmt]) => `<label>${esc(label)} <output id="adm_o_${k}">${fmt(A[k])}</output><input type="range" data-k="${k}" min="${min}" max="${max}" step="${step}" value="${A[k]}"></label>`).join('');
    const toggles = [['enabled', 'Admin powers ON'], ['god', 'God mode (take no damage)'], ['infinite', 'Infinite resources']].map(([k, label]) => `<label class="inline adm-t"><input type="checkbox" data-t="${k}" ${A[k] ? 'checked' : ''}> ${esc(label)}</label>`).join('');
    $('adminBody').innerHTML = `<div class="cols"><div>${sliders}</div><div class="adm-side">${toggles}<h3>COSMETICS</h3>
      <button class="btn tiny" data-a="unlock">UNLOCK ALL COSMETICS + ADMIN SKINS</button> <button class="btn tiny" data-a="coins">+10,000 COINS</button>
      <h3>SLIDERS</h3><button class="btn tiny" data-a="reset">RESET SLIDERS</button><p class="hint" id="adminMsg"></p></div></div>`;
    $('adminBody').querySelectorAll('input[type=range]').forEach((el) => el.addEventListener('input', () => {
      const k = el.dataset.k, def = ADMIN_SLIDERS.find((x) => x[0] === k); A[k] = parseFloat(el.value); $('adm_o_' + k).textContent = def[5](A[k]); this.saveCareer(); this.applyAdmin();
    }));
    $('adminBody').querySelectorAll('input[type=checkbox]').forEach((el) => el.addEventListener('change', () => { A[el.dataset.t] = el.checked; this.saveCareer(); this.applyAdmin(); }));
    $('adminBody').querySelectorAll('[data-a]').forEach((el) => el.addEventListener('click', () => {
      const a = el.dataset.a, pr = this.profile, msg = $('adminMsg');
      this.audio.play('chime', null, 0.5);
      if (a === 'unlock') {
        for (const slot of [...COSMETIC_SLOTS, 'emote']) pr.owned[slot] = Object.keys(COSMETICS[slot]);
        pr.owned.weapon = WEAPON_TOOLS.flatMap((t) => WEAPON_SKIN_ORDER.filter((sk) => sk !== 'default').map((sk) => t + ':' + sk));
      } else if (a === 'coins') { this.career.coins += 10000; this.career.totalCoins += 10000; }
      else if (a === 'reset') { Object.assign(A, ADMIN_DEFAULTS); this.saveCareer(); this.renderAdmin(); this.applyAdmin(); $('adminMsg').textContent = 'Sliders reset.'; return; }
      msg.textContent = a === 'unlock' ? 'Everything is unlocked, including the Admin skin and Admin weapons. Equip them in the Locker.' : 'Added 10,000 coins.';
      this.saveCareer(); this.pushLook(); this.ensureDaily(); this.ui.renderProfileBar(this.career);
    }));
  }
  /** Re-applies class stats, then the admin multipliers, to the local player. Only on a server we run (single player or host). */
  applyAdmin(atStart) {
    const p = this.player, s = this.server, A = this.admin;
    if (!p || s !== this.localServer || !s.players.length || s.phase === 'idle') return;
    s.applyClass(p);
    const on = !!(A.unlocked && A.enabled);
    if (on) {
      p.mods.speed *= A.speed; p.mods.jump *= A.jump; p.mods.meleeDamage *= A.damage; p.mods.mineSpeed *= A.mine; p.mods.bowDraw /= A.draw; p.mods.regenRate *= A.regen;
      p.maxHealth = A.health;
    }
    p.adminGod = on && A.god; p.adminInfinite = on && A.infinite;
    if (atStart || p.health > p.maxHealth) p.health = p.maxHealth;
    if (atStart && on && this.kind === 'host' && this.host) this.host.relayChat('p0', this.lobby.name, 'has admin powers on', false, true);
  }

  /* ---------------------------- lobby ---------------------------- */
  /** AI opponents shown in the lobby: random classes (no repeats), random names and cosmetics. Re-rolled every time. */
  rerollAI() {
    const names = BOT_NAMES.slice().sort(() => Math.random() - 0.5);
    let classes = CLASS_ORDER.slice().sort(() => Math.random() - 0.5);
    this.ai = [];
    for (let i = 0; i < 5; i++) { if (!classes.length) classes = CLASS_ORDER.slice().sort(() => Math.random() - 0.5); this.ai.push({ id: 'ai' + i, name: names[i % names.length], classId: classes.pop(), look: randomLook(), isBot: true, ready: true }); }
    this.lobby.seed = 1 + Math.floor(Math.random() * 9998);
  }
  openLobby(kind = this.kind) {
    this.kind = kind; this.state = 'menu';
    if (kind === 'single' && (!this.ai.length || this.freshLobby !== false)) { this.rerollAI(); this.freshLobby = false; }
    this.myReady = false;
    this.ui.showHud(false); this.ui.$('results').classList.add('hidden');
    this.ui.$('lobbyChat').classList.toggle('hidden', kind === 'single');
    this.ui.showOverlay('lobby'); this.refreshLobby(); this.renderChat();
  }
  /** Everything the lobby screen needs, for all three kinds of session. */
  lobbyView() {
    const L = this.lobby, me = { name: L.name, classId: L.classId, look: this.myLook(), ready: true, you: true };
    if (this.kind === 'host' && this.host) {
      const m = this.host.lobbyMessage(), roster = m.roster.map((r) => ({ ...r, you: r.id === 'p0' }));
      return { kind: 'host', difficulty: m.cfg.difficulty || 'normal', mode: m.cfg.mode, mapId: m.cfg.mapId, bots: m.cfg.bots, minBots: m.min, maxBots: m.max, name: L.name, classId: L.classId, lands: assignLandList(m.cfg.seed), roster, edit: true, me: 0, code: this.host.code, canStart: this.host.canStart(), myReady: true,
        hint: this.host.canStart() ? 'Everybody is ready: start when you like. Share the code or invite link to bring friends in.' : this.host.allReady() ? 'You need at least 2 players: add AI players or wait for a friend.' : 'Waiting for players to press READY...', hintClass: this.host.canStart() ? 'good' : '',
        providers: m.providers };
    }
    if (this.kind === 'client' && this.clientLobby) {
      const m = this.clientLobby, myIdx = Math.max(0, m.roster.findIndex((r) => r.id === this.client.id)), roster = m.roster.map((r, i) => ({ ...r, you: i === myIdx }));
      return { kind: 'client', mode: m.cfg.mode, mapId: m.cfg.mapId, bots: m.cfg.bots, minBots: m.min, maxBots: m.max, name: L.name, classId: L.classId, lands: assignLandList(m.cfg.seed), roster, edit: false, me: myIdx, code: m.code, canStart: false, myReady: !!(roster[myIdx] && roster[myIdx].ready), hint: this.myReady ? 'Waiting for the host to start...' : 'Pick your class, then press READY.' };
    }
    const bots = clamp(L.bots, 1, 5), roster = [me, ...this.ai.slice(0, bots)];
    return { kind: 'single', difficulty: DIFFICULTIES[L.difficulty] ? L.difficulty : 'normal', mode: L.mode, mapId: L.mapId, bots, minBots: 1, maxBots: 5, name: L.name, classId: L.classId, lands: assignLandList(L.seed), roster, edit: true, me: 0, code: '', canStart: true, myReady: true, hint: '' };
  }
  refreshLobby() {
    const v = this.lobbyView();
    this.ui.renderLobby(v, { change: (patch) => { this.audio.unlock(); this.audio.play('click'); this.onLobbyChange(patch); } });
    if (v.kind !== 'single') this.ui.$('netStatus').textContent = v.kind === 'host' ? (v.providers && v.providers.includes('online') ? 'online + this computer' : 'this computer only (online service unavailable)') : '';
  }
  onLobbyChange(patch) {
    const L = this.lobby;
    if (patch.classId) { L.classId = patch.classId; if (this.host) this.host.setHostInfo({ classId: patch.classId }); else if (this.client) this.client.send({ t: 'prof', classId: patch.classId }); }
    if (patch.name) { L.name = patch.name; if (this.host) this.host.setHostInfo({ name: patch.name }); else if (this.client) this.client.send({ t: 'prof', name: patch.name }); }
    if (this.kind === 'host' && this.host) { const hp = {}; for (const k of ['mode', 'mapId', 'bots', 'reroll', 'difficulty']) if (k in patch) hp[k] = patch[k]; if (Object.keys(hp).length) this.host.setConfig(hp); }
    else if (this.kind === 'single') {
      if (patch.mode) L.mode = patch.mode;
      if (DIFFICULTIES[patch.difficulty]) L.difficulty = patch.difficulty;
      if (patch.mapId) L.mapId = patch.mapId;
      if (patch.bots != null) L.bots = clamp(patch.bots | 0, 1, 5);
      if (patch.reroll) this.rerollAI();
    }
    this.saveCareer();
    if (!patch.name) this.refreshLobby();
  }
  toMenu() {
    this.releaseLock();
    this.clearReplay();
    this.leaveSession(true); this.tut = null; this.ui.$('tutorial').classList.add('hidden');
    this.state = 'menu'; this.ui.showHud(false); this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false);
    this.demoMatch(); this.ensureDaily(); this.ui.renderProfileBar(this.career); this.ui.showOverlay('main');
  }
  leaveMatch() { this.toMenu(); }
  releaseLock() { try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) { /* ignore */ } }

  /* ---------------------------- starting a match ---------------------------- */
  /** Common client-side preparation around whatever actually starts the match (local server, hosted, or joined). */
  launch(startFn) {
    this.audio.unlock();
    this.clearReplay();
    this.recorder.suspended = true;
    startFn();
    this.recorder.reset();
    if (this.chunks) { this.chunks.chunks.forEach((c) => { c.dirty = true; }); this.chunks.buildAll(); }
    this.particles.items.length = 0; this.bubbles.clear();
    const p = this.player;
    this.floats.length = 0; this.flashT.clear(); this.hotT.clear(); this.kick = 0; this.blockAmt = 0; this.blockSent = false; this.heldSent = null; this.equip = 0;
    this.selected = 0; this.mining = null; this.charge = 0; this.hurt = 0; this.shake = 0; this.dark = 0;
    this.spectateIndex = -1; this.lastHighlight = null; this.pendingHighlight = null; this.pendingKillcam = null; this.highlightCool = 15;
    this.resultsShown = false; this.statsSaved = false; this.server.replayAvailable = false;
    this.ui.$('killfeed').innerHTML = ''; this.ui.$('toasts').innerHTML = '';
    this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false);
    this.state = 'paused';
    this.saveCareer();
    this.startPlay();
    this.applyAdmin(true);
    const land = LANDS[p.landId], cls = CLASSES[p.classId], map = MAPS[this.server.mapId];
    this.ui.banner(land.name.toUpperCase() + ' · ' + cls.name.toUpperCase(), (map ? map.name + '. ' : '') + (this.server.mode === 'sandbox' ? 'Sandbox: unlimited resources' : 'Build phase: edit only your own land.'), '', 3800);
  }
  startFromLobby() {
    const L = this.lobby;
    if (this.kind === 'host' && this.host) {
      if (!this.host.canStart()) return;
      this.launch(() => this.host.startMatch());
    } else if (this.kind === 'single') {
      const bots = clamp(L.bots, 1, 5);
      const roster = [{ id: 'p0', name: L.name, classId: L.classId, isBot: false, look: this.myLook() }, ...this.ai.slice(0, bots).map((a) => ({ name: a.name, classId: a.classId, isBot: true, look: a.look }))];
      this.launch(() => this.localServer.startMatch({ mode: L.mode, seed: L.seed, mapId: L.mapId, difficulty: L.difficulty, roster }));
    }
  }
  /** After the results screen: back to the lobby for another round (or the menu). */
  afterResults() {
    this.clearReplay();
    if (this.kind === 'host' && this.host) { this.host.returnToLobby(); this.openLobby('host'); }
    else if (this.kind === 'client' && this.client && !this.client.done) { this.restoreLocal(); this.myReady = false; this.openLobby('client'); }
    else if (this.kind === 'single') { this.freshLobby = true; this.openLobby('single'); }
    else this.toMenu();
  }

  /* ---------------------------- multiplayer flows ---------------------------- */
  async hostGame() {
    if (this.busyNet) return; this.busyNet = true;
    this.setNet('Creating a game...'); this.chatLog = []; this.chatMuted.clear();
    try {
      this.kind = 'host';
      const hs = new HostSession(this.localServer, { onChat: (m) => this.onChatMsg(m), onLobby: () => { if (this.kind === 'host' && this.ui.$('panelLobby') && !this.ui.$('panelLobby').classList.contains('hidden')) this.refreshLobby(); }, onJoin: (peer) => this.ui.toast(esc(peer.name) + ' joined', 'good', 2500), onLeave: (peer) => { if (this.state === 'playing' || this.state === 'paused') this.ui.toast(esc(peer.name) + ' left (AI takes over)', 'warn', 3500); } });
      hs.hostInfo = { name: this.lobby.name, classId: this.lobby.classId, look: this.myLook() };
      const opened = await hs.open(); const onlineErr = opened && opened.errors && opened.errors.online;
      this.host = hs;
      hs.cfg.mode = this.lobby.mode; hs.cfg.mapId = this.lobby.mapId; hs.cfg.bots = this.lobby.bots;
      this.openLobby('host');
      if (!hs.providers.includes('online')) this.ui.toast('Online hosting failed, so only tabs on this computer can join. ' + (onlineErr && onlineErr.message ? onlineErr.message : '') + ' Use TEST CONNECTION on the Multiplayer screen.', 'warn', 9000);
    } catch (err) { this.kind = 'single'; this.setNet(err.message || 'Could not create a game.', 'bad'); }
    this.busyNet = false;
  }
  async joinGame(rawCode) {
    if (this.busyNet) return;
    const code = cleanCode(rawCode);
    if (code === ADMIN_CODE) { this.ui.$('joinCode').value = ''; this.setNet(''); this.openAdmin(); return; }
    if (code.length < 4) { this.setNet('Enter the game code your friend gave you.', 'bad'); return; }
    this.busyNet = true; this.setNet('Connecting to ' + code + '...'); this.chatLog = []; this.chatMuted.clear();
    let ch;
    try { ch = await netConnect(code); } catch (err) { this.setNet(err.message, 'bad'); this.busyNet = false; return; }
    const cs = new ClientSession(ch);
    this.client = cs; this.kind = 'client'; this.clientLobby = null; this.myReady = false;
    cs.on.lobby = (m) => { this.clientLobby = m; if (this.state === 'menu') { if (this.ui.$('panelLobby').classList.contains('hidden') && this.netJoining) { this.netJoining = false; this.openLobby('client'); } else this.refreshLobby(); } };
    cs.on.chat = (m) => this.onChatMsg(m);
    cs.on.start = (m) => this.beginClientMatch(m);
    cs.on.tick = (m) => { if (this.server.applyTick) this.server.applyTick(m); };
    cs.on.world = (m) => { if (this.server.loadWorld) { this.server.loadWorld(m); if (this.chunks) { this.chunks.chunks.forEach((c) => { c.dirty = true; }); this.chunks.buildAll(); } } };
    cs.on.res = (m) => { if (this.server.emit) this.server.emit({ type: 'rejected', reason: m.r, action: m.a, item: m.item }); };
    cs.on.end = (m) => { if (this.server.setResults) { this.server.setResults(m); this.server.emit({ type: 'matchEnd', winners: this.server.results.winners, reason: m.reason, results: this.server.results }); } };
    cs.on.rejected = (why) => { this.onNetClosed(why, true); };
    cs.on.closed = (why) => this.onNetClosed(why);
    this.netJoining = true;
    cs.join({ name: this.lobby.name, classId: this.lobby.classId, look: this.myLook() });
    this.setNet('Connected. Waiting for the host...');
    setTimeout(() => { if (this.netJoining && this.client === cs) { this.setNet('The host did not answer. Is the code right and the lobby still open?', 'bad'); this.leaveSession(); } }, 9000);
    this.busyNet = false;
  }
  /** Joined players rebuild the host's map from the seed, report ready-to-play, then follow the host's stream. */
  beginClientMatch(msg) {
    this.netJoining = false;
    this.launch(() => {
      this.localServer.suspendTracking = true; this.localServer.phase = 'idle';
      if (this.server !== this.localServer && this.server.dispose) this.server.dispose();
      const view = new NetServerView(this.world, this.client);
      view.subscribe((e) => this.onServerEvent(e));
      this.server = view;
      const hash = view.start(msg);
      this.client.send({ t: 'loaded', hash });
    });
    this.me0 = this.player;
  }
  restoreLocal() {
    if (this.server !== this.localServer) { if (this.server.dispose) this.server.dispose(); this.server = this.localServer; }
    this.localServer.suspendTracking = false;
  }
  leaveSession(quiet) {
    if (this.host) { this.host.close(); this.host = null; }
    if (this.client) { this.client.leave(); this.client = null; }
    this.restoreLocal();
    this.kind = 'single'; this.clientLobby = null; this.netJoining = false; this.freshLobby = true;
  }
  onNetClosed(why, rejected) {
    const was = this.kind === 'client';
    this.client = null;
    if (!was) return;
    this.restoreLocal(); this.kind = 'single'; this.netJoining = false;
    this.releaseLock(); this.clearReplay();
    this.state = 'menu'; this.ui.showHud(false); this.ui.$('results').classList.add('hidden'); this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false);
    this.demoMatch(); this.ui.showOverlay('multi'); this.setNet(why || 'Disconnected.', 'bad');
  }

  startPlay() {
    this.audio.unlock();
    try { const pr = this.canvas.requestPointerLock(); if (pr && pr.catch) pr.catch(() => {}); } catch (e) { /* handled by pointerlockerror */ }
  }
  selectSlot(i) { const old = this.selected; this.selected = ((i % 9) + 9) % 9; if (old !== this.selected) this.equip = 0; this.audio.play('click', null, 0.4); }
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
    if (this.tut && this.tutKey(e.code)) return;
    if (e.code === 'Enter' || e.code === 'Slash') { e.preventDefault(); this.openChat(e.code === 'Slash' ? '/' : ''); return; }
    if (e.code === 'Tab') { this.scoreboardHeld = true; this.ui.renderScoreboard(s, p); this.ui.$('scoreboard').classList.remove('hidden'); return; }
    if (e.code.startsWith('Digit')) { const n = parseInt(e.code.slice(5), 10); if (n >= 1 && n <= 9) this.selectSlot(n - 1); return; }
    if (e.code === 'KeyM') { this.audio.toggleMute(); return; }
    const em = { KeyZ: 0, KeyX: 1, KeyC: 2, KeyV: 3 }[e.code];
    if (em != null && p.alive) { s.handle(p.id, { type: 'emote', slot: em }); return; }
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
    if (this.tut) this.tutEvent(e);
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
        const t = e.target, mine = me && (e.by === me.id || e.by === me.index);
        const snd = e.blocked ? 'block' : { axe: 'chop', staff: 'thump', bow: 'twang', sword: 'slash' }[e.tool] || 'hit';
        this.sfx(snd, t.pos.x, t.pos.y + 1, t.pos.z, 40);
        if (!e.blocked) this.sfx('hit', t.pos.x, t.pos.y + 1, t.pos.z, 40);
        if (e.crit) this.sfx('crit', t.pos.x, t.pos.y + 1, t.pos.z, 40);
        if (e.sprint) P.puff(t.pos.x, t.pos.y + 0.3, t.pos.z, [0.9, 0.9, 0.9], 6, 1.2, 0.3, 0.2, 0.5, false);
        const wsk = WEAPON_SKINS[e.skin], hx = t.pos.x, hy = t.pos.y + 1.1, hz = t.pos.z;
        if (!e.blocked && wsk && wsk.pal.fx) P.burst(hx, hy, hz, wsk.pal.fx, 6, 2.2, 0.08);
        if (e.fx) {                                                        // skin perks that landed
          if (e.fx.includes('chill')) { P.burst(hx, hy, hz, [0.78, 0.94, 1], 12, 2.6, 0.1); if (t === me) this.ui.toast('FROZEN: you are slowed', 'warn', 1200); }
          if (e.fx.includes('burn')) P.puff(hx, hy, hz, [1, 0.5, 0.1], 8, 0.6, 1.8, 0.2, 0.6);
          if (e.fx.includes('leech')) { const pl = this.server.players, a = typeof e.by === 'number' ? pl[e.by] : pl.find((q) => q.id === e.by); if (a && a.pos) P.puff(a.pos.x, a.pos.y + 1.2, a.pos.z, [0.95, 0.1, 0.2], 6, 0.5, 1.2, 0.12, 0.6); }
        }
        if (mine && t !== me && !e.blocked) {
          if (e.crit) this.dailyBump('crit', 1);
          if (e.tool === 'bow') this.dailyBump('arrowHit', 1);
          if (e.fx) for (const f of e.fx) this.dailyBump(f, 1);
        }
        if (mine && t !== me) {
          this.ui.hitMarker(e.blocked ? 'block' : e.crit ? 'crit' : '');
          const d = this.lastDmgEvt && this.lastDmgEvt.target === t ? this.lastDmgEvt.amount : 0;
          this.addFloat(t, d, e.blocked ? 'blocked' : e.crit ? 'crit' : '');
          if (t.index != null) this.hotT.set(t.index, this.time + 2.5);
          if (e.crit) this.shake = Math.max(this.shake, 0.3);
        }
        if (t === me) { this.hurt = Math.min(1, this.hurt + 0.35); this.audio.play('hurt', null, 0.8); this.kick = Math.min(1, this.kick + 0.6 + (e.crit ? 0.3 : 0)); }
        break;
      }
      case 'parry': { const t = e.target; if (t.pos) P.burst(t.pos.x, t.pos.y + 1.3, t.pos.z, [1, 1, 0.6], 16, 4, 0.1); this.sfx('block', t.pos.x, t.pos.y + 1, t.pos.z, 40); if (t === me) { this.ui.hitMarker('block'); this.ui.toast('<b>PARRY!</b> Perfect block: the attacker is staggered.', 'good', 1400); } else if (me && (e.by === me.id)) this.ui.toast('PARRIED! You are staggered.', 'bad', 1400); break; }
      case 'blocked': { const t = e.target; if (t.pos) P.burst(t.pos.x, t.pos.y + 1.2, t.pos.z, [0.9, 0.9, 1], 8, 3, 0.08); if (t === me) this.ui.hitMarker('block'); break; }
      case 'damage': {
        const t = e.target;
        this.lastDmgEvt = { target: t, amount: e.amount };
        if (t.index != null) this.flashT.set(t.index, this.time + 0.25);
        if (t === me && e.src && e.src.by != null && e.src.by >= 0 && e.src.by !== me.index) {
          const a = this.server.players[e.src.by];
          if (a) { const rel = angleDiff(me.yaw, Math.atan2(-(a.pos.x - me.pos.x), -(a.pos.z - me.pos.z))); this.ui.dirIndicator(-rel); }
        }
        if (e.target === me && e.src.kind !== 'melee' && e.src.kind !== 'arrow') { this.hurt = Math.min(1, this.hurt + clamp(e.amount / 40, 0.1, 0.6)); if (e.amount > 3) this.audio.play('hurt', null, 0.7); }
        break;
      }
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
        const names = e.players.map((p) => p.name).join(' & '), st = VAULT_STAGES[e.stage || 0] || VAULT_STAGES[0], pad = this.server.map.vault.pads ? this.server.map.vault.pads[e.stage || 0] : this.server.map.vault;
        this.ui.killfeed(`<b>${esc(names)}</b> beat VAULT STAGE ${(e.stage || 0) + 1}: ${st.name} <em>+${st.score}</em>`, 'good'); this.audio.play('chime', null, 0.8);
        if (e.players.includes(me)) this.ui.banner(e.final ? 'VAULT CONQUERED!' : 'STAGE ' + ((e.stage || 0) + 1) + ' CLEARED', vaultRewardText(st) + (e.final ? '' : '. Next: ' + VAULT_STAGES[(e.stage || 0) + 1].name), 'good', 3200);
        this.noteHighlight(pad.x, pad.y, pad.z, 'STAGE ' + ((e.stage || 0) + 1), 40);
        break;
      }
      case 'streak': {
        const q = e.player, mine = q === me;
        this.ui.killfeed(`<b>${esc(q.name)}</b> is on a <b>${e.n} KILL STREAK</b>${e.reward ? ' <em>' + esc(e.reward) + '</em>' : ''}`, mine ? 'good' : '');
        if (mine && e.reward) { this.ui.banner(e.n + ' KILL STREAK', e.reward, 'good', 2600); this.audio.play('chime', null, 0.9); }
        if (mine && this.dailyBump) this.dailyBump('streak', e.n >= 3 ? 1 : 0);
        break;
      }
      case 'tntStrike': {
        const near = me && me.alive && Math.hypot(me.pos.x - e.x, me.pos.z - e.z) < 18;
        if (e.by !== me) this.ui.killfeed(`<b>${esc(e.by.name)}</b> called a <b>TNT STRIKE</b>`, near ? 'bad' : '');
        if (near && e.by !== me) { this.ui.banner('TNT STRIKE', 'TNT is falling on you. Move!', 'bad', 2400); this.audio.play('alarm', null, 0.7); }
        break;
      }
      case 'neutralize': {
        for (let i = 0; i < 6; i++) P.puff(e.x + 0.5 + (Math.random() - 0.5) * 4, e.y + 1, e.z + 0.5 + (Math.random() - 0.5) * 4, [0.9, 0.9, 0.92], 3, 1.2, 2.2, 0.35, 1.2, false);
        this.sfx('sizzle', e.x, e.y, e.z, 40);
        if (me && e.by === me.id) this.ui.toast(e.flood ? 'The flood is too big: you dried a patch around you.' : 'Hiss! The water hardened into stone and boiled away.', 'good', 2200);
        break;
      }
      case 'dropIncoming': {
        this.ui.banner('SUPPLY DROP', 'A crate is parachuting in. Stand on it to claim the loot!', 'good', 3000); this.audio.play('chime', null, 0.7);
        break;
      }
      case 'dropClaimed': {
        const L = DROP_LOOT_BY_ID[e.loot] || { name: 'loot', desc: '' };
        this.ui.killfeed(`<b>${esc(e.player.name)}</b> claimed a SUPPLY DROP <em>${esc(L.name)}</em>`, e.player === me ? 'good' : '');
        P.burst(e.x, e.y + 0.8, e.z, [1, 0.85, 0.3], 22, 4, 0.12);
        if (e.player === me) { this.ui.banner(L.name.toUpperCase(), L.desc, 'good', 2600); this.audio.play('chime', null, 1); if (this.dailyBump) this.dailyBump('drop', 1); }
        break;
      }
      case 'suddenDeath': this.ui.banner('SUDDEN DEATH', 'Every core has crumbled. From now on, death is final.', 'bad', 3800); this.audio.play('crash', null, 0.8); this.shake = Math.max(this.shake, 1); break;
      case 'finalDuel': this.ui.killfeed('Only two teams left: <b>CHAOS starts now</b>', 'warn'); break;
      case 'botUnstuck': break;
      case 'baseDestroyed': {
        if (e.by && e.by === me && !e.quiet) this.dailyBump('core', 1);
        if (e.quiet) break;
        const who = e.player; this.ui.killfeed(`<b style="color:${who.color}">${esc(who.name)}</b>'s CORE was destroyed${e.by ? ' by <b style="color:' + e.by.color + '">' + esc(e.by.name) + '</b> <em>+400</em>' : ''}`, 'bad');
        if (who === me) this.ui.banner('YOUR CORE IS DESTROYED', 'No more respawns. Stay alive.', 'bad', 3500);
        else if (e.by === me) this.ui.banner('CORE DESTROYED', esc(who.name) + ' can no longer respawn. +400', 'good', 2600);
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
      case 'crit': { const t = e.target; if (e.headshot && me && (e.by === me.index || e.by === me.id)) this.ui.toast('<b>HEADSHOT!</b>', 'good', 900); P.burst(t.pos.x, t.pos.y + 1.4, t.pos.z, [1, 0.95, 0.5], 14, 4.2, 0.1); this.sfx('hit', t.pos.x, t.pos.y + 1, t.pos.z, 40); break; }
      case 'wallsDown': this.ui.toast('The plot walls came down. Everyone can see your base now!', 'warn', 4500); this.audio.play('rumble', null, 0.9); this.shake = Math.max(this.shake, 1.1); break;
      case 'machineFx': this.machineFx(e); break;
      case 'creeperHiss': this.sfx('fuse', e.mob.pos.x, e.mob.pos.y, e.mob.pos.z, 30); break;
      case 'mobDeath': break;
      case 'emote': this.say(e.player, e.text); break;
      case 'playerLeft': this.ui.killfeed(`<b style="color:${e.player.color}">${esc(e.player.name)}</b> left &mdash; the AI took over`, 'warn'); break;
      case 'rejected': this.onRejected(e); break;
      case 'matchEnd': this.onMatchEnd(e); break;
      default: break;
    }
  }
  onPhase(e) {
    const U = this.ui, M = CONFIG.MATCH, s = this.server;
    this.audio.play('phase', null, 0.7);
    if (e.phase === 'build') U.banner('BUILD PHASE', `Fortify your land · walls hide you until war · ${fmtTime(M.BUILD)}`, '', 3400);
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
    if (k && k === me && v !== me) { this.dailyBump('kill', 1); if (e.tnt && e.kind === 'explosion') this.dailyBump('tntKill', 1); }
    const vn = `<b style="color:${v.color}">${esc(v.name)}</b>`;
    let txt;
    if (k) txt = `<b style="color:${k.color}">${esc(k.name)}</b> ${e.tnt && e.kind === 'explosion' ? 'blew up' : (KILL_VERB[e.kind] || 'killed')} ${vn}`;
    else if (e.kind === 'mob') txt = `${vn} was mauled by a zombie`;
    else if (e.detail === 'creeper') txt = `${vn} was blown up by a creeper`;
    else txt = `${vn} ${e.kind === 'explosion' ? 'was blown up' : e.kind === 'crush' ? (e.detail === 'collapse' ? 'was crushed by a collapse' : e.detail === 'suffocation' ? 'suffocated' : 'was crushed') : (KILL_VERB[e.kind] || 'died')}`;
    if (e.bounty) txt += ` <em>+$${e.bounty}</em>`;
    U.killfeed(txt, k === me || v === me ? 'me' : '');
    this.sfx('death', v.pos.x, v.pos.y, v.pos.z, 50);
    this.killEffect(k, v);
    const t = this.server.clock;
    this.killDeathTimes.push(t);
    this.killDeathTimes = this.killDeathTimes.filter((x) => t - x < 3.5);
    if (this.killDeathTimes.length >= 2) this.noteHighlight(v.pos.x, v.pos.y, v.pos.z, 'DOUBLE KILL', 60);
    else if (e.tnt && k) this.noteHighlight(v.pos.x, v.pos.y, v.pos.z, 'TNT KILL', 45);
    if (k === me && v !== me) {
      U.hitMarker('kill'); this.audio.play('kill', null, 0.8);
      U.banner('ELIMINATED ' + v.name, '+500' + (e.bounty ? ' +$' + e.bounty + ' bounty' : ''), 'good', 1800);
      if (e.loot) U.toast('LOOT: ' + Object.entries(e.loot).map(([r, n]) => '+' + n + ' ' + RESOURCES[r].label.toLowerCase()).join(', '), 'good', 3500);
    }
    if (v === me) {
      this.deathReplay = { victim: v, killer: k };
      this.mining = null; this.charge = 0;
      if (this.server.mode !== 'sandbox' && this.server.phase !== 'ended' && this.myCoreAlive()) {
        U.banner('YOU DIED', (k ? 'Killed by ' + k.name + '. ' : '') + 'Respawning in ' + CONFIG.MATCH.CORE_RESPAWN + ' s at your core.', 'bad', 2400);
        this.spectateIndex = k && k.alive ? k.index : -1;
        U.setPanelOpen('inventory', false); U.setPanelOpen('diplomacy', false);
        if (this.state === 'panel') { this.state = 'playing'; this.startPlay(); }
      } else if (this.server.mode !== 'sandbox' && this.server.phase !== 'ended') {
        U.banner('YOU DIED', k ? 'Killed by ' + k.name : 'Eliminated', 'bad', 2400);
        this.spectateIndex = k && k.alive ? k.index : -1;
        this.pendingKillcam = { at: this.server.clock + 1.0, victim: v, killer: k };
        U.setPanelOpen('inventory', false); U.setPanelOpen('diplomacy', false);
        if (this.state === 'panel') { this.state = 'playing'; this.startPlay(); }
      } else U.banner('YOU DIED', 'Respawning...', 'bad', 1800);
    }
  }
  /** Will the local player respawn? (their core still stands, during the war) */
  myCoreAlive() {
    const s = this.server, p = this.player;
    return !!p && (s.phase === 'war' || s.phase === 'chaos') && !!(s.plots[p.index] && s.plots[p.index].core) && !s.baseDestroyed[p.index];
  }
  onMatchEnd(e) {
    this.matchEndAt = this.time + 2.2;
    this.ui.banner(e.winners.length ? (e.winners.includes(this.player) ? 'VICTORY!' : 'MATCH OVER') : 'DRAW', e.winners.length ? e.winners.map((p) => p.name).join(' & ') + ' wins' : 'Nobody survived', e.winners.includes(this.player) ? 'good' : 'bad', 2400);
    this.audio.play('chime', null, 0.9);
  }
  /** Rejected requests from a hosted match come back as events; same wording as a local refusal. */
  onRejected(e) {
    const r = e.reason, it = e.item && ITEMS[e.item], phase = this.server.phase;
    const msg = { 'no-resource': it && it.res ? 'Out of ' + RESOURCES[it.res].label.toLowerCase() + '!' : 'Not enough resources.', 'not-allowed': phase === 'build' ? 'Build phase: you can only edit your own land.' : 'You cannot do that right now.', 'no-support': 'Needs something to attach to.', 'no-floor': 'Needs solid ground below it.', 'player-in-way': 'Someone is in the way.', 'own-core': 'That is your own core: protect it!', 'core-shielded': 'Cores are shielded for the first minute of the war.' }[r];
    if (msg && (e.action === 'place' || e.action === 'break' || e.action === 'ignite')) this.ui.toast(msg, 'bad', 1500);
  }
  addFloat(t, amount, cls) {
    const txt = cls === 'blocked' ? 'BLOCKED ' + Math.round(amount) : String(Math.max(1, Math.round(amount)));
    this.floats.push({ x: t.pos.x + (Math.random() - 0.5) * 0.5, y: t.pos.y + 2.1, z: t.pos.z + (Math.random() - 0.5) * 0.5, text: txt, cls, t0: this.time });
    if (this.floats.length > 24) this.floats.shift();
  }
  machineFx(e) {
    const P = this.particles, x = e.x + 0.5, y = e.y + 0.5, z = e.z + 0.5;
    switch (e.kind) {
      case 'turret': this.sfx('shoot', x, y, z, 45); P.puff(x, y + 1, z, [0.8, 0.8, 0.8], 3, 0.2, 0.5, 0.1, 0.4, false); break;
      case 'cannon': this.sfx('explode', x, y, z, 60); P.puff(x, y + 1.2, z, [0.45, 0.45, 0.45], 14, 0.6, 2.2, 0.3, 0.9, false); P.puff(x, y + 1.2, z, [1, 0.7, 0.2], 6, 0.4, 1.5, 0.2, 0.4, true); break;
      case 'spikes': this.sfx('hit', x, y, z, 30); P.burst(x, y + 0.3, z, [0.8, 0.8, 0.85], 6, 2.5, 0.08); break;
      case 'pad': this.sfx('jump', x, y, z, 30); P.puff(x, y + 0.3, z, [0.4, 1, 0.5], 10, 0.5, 3, 0.15, 0.6, true); break;
      case 'sprinkle': if (e.did) { this.sfx('splash', x, y, z, 30); P.puff(x, y + 0.9, z, [0.45, 0.65, 1], 14, 3, 1, 0.18, 0.8, true); } break;
      case 'heal': P.puff(e.x, e.y + 1, e.z, [0.4, 1, 0.5], 8, 0.5, 1.8, 0.14, 0.9, true); break;
      case 'flame': { this.sfx('sizzle', x, y, z, 30); for (let i = 1; i <= 9; i++) { const f = i / 9; P.puff(x + (e.tx - x) * f, y + 0.4 + (e.ty - y - 0.4) * f, z + (e.tz - z) * f, Math.random() < 0.5 ? [1, 0.5, 0.1] : [1, 0.8, 0.2], 2, 0.25, 0.6, 0.22, 0.5, true); } break; }
      case 'drop': this.sfx('place', x, y, z, 30); break;
      default: break;
    }
  }
  say(player, text) { this.bubbles.set(player.id, { text, until: this.time + 3 }); }
  /** Trails behind moving players (cosmetic, from the public look). */
  trails(dt) {
    this.trailClock -= dt; if (this.trailClock > 0) return; this.trailClock = 0.07;
    const l = this.cam || this.listener();
    for (const q of this.server.players) {
      if (!q.alive || !q.look || q.look.trail === 'none') continue;
      if (Math.hypot(q.vel.x, q.vel.z) < 1.5 && q.onGround) continue;
      if (Math.abs(q.pos.x - l.x) > 45 || Math.abs(q.pos.z - l.z) > 45) continue;
      const t = COSMETICS.trail[q.look.trail]; if (!t) continue;
      const c = t.color || (() => { const h = (this.time * 1.5 + q.index) % 1; return [0.55 + 0.45 * Math.sin(h * 6.28), 0.55 + 0.45 * Math.sin(h * 6.28 + 2.1), 0.55 + 0.45 * Math.sin(h * 6.28 + 4.2)]; })();
      this.particles.puff(q.pos.x, q.pos.y + 0.15, q.pos.z, c, 1, 0.3, t.rise, t.size, 0.7, t.glow);
    }
  }
  /** The killer's equipped kill effect plays at the victim. */
  killEffect(k, v) {
    const kind = k && k.look ? k.look.kill : 'none', P = this.particles, x = v.pos.x, y = v.pos.y + 1, z = v.pos.z;
    if (kind === 'confetti') for (let i = 0; i < 5; i++) P.burst(x, y, z, [Math.random(), Math.random(), Math.random()], 8, 4.5, 0.11);
    else if (kind === 'lightning') { for (let h = 0; h < 14; h++) P.puff(x + (Math.random() - 0.5) * 0.4, y + h * 0.9, z + (Math.random() - 0.5) * 0.4, [0.85, 0.9, 1], 3, 0.2, 0, 0.3, 0.45, true); this.sfx('crash', x, y, z, 60); }
    else if (kind === 'ghost') P.puff(x, y, z, [0.9, 0.95, 1], 22, 0.5, 3.2, 0.3, 1.6, true);
    else if (kind === 'pixels') P.burst(x, y, z, [v.color ? 1 : 1, 0.9, 0.3], 26, 5.5, 0.18);
  }
  showResults() {
    const s = this.server, me = this.player, row = s.results.rows.find((r) => r.player === me);
    let extra = { text: '' };
    if (!this.statsSaved && row) {
      this.statsSaved = true;
      const c = this.career, before = levelFor(c.xp).level, had = TITLE_ORDER.filter((id) => TITLES[id].ok(c));
      this.dailyBump('play', 1); if (row.won) this.dailyBump('win', 1);
      c.matches++; if (row.won) c.wins++; c.kills += row.kills; c.deaths += row.deaths; c.xp += row.xp; c.coins += row.coins; c.totalCoins += row.coins; c.blocks += row.blocksDestroyed;
      c.tntKills += row.tntKills || 0; c.structures += row.structuresDestroyed || 0; c.damage += row.damageDealt || 0; c.best = Math.max(c.best, row.score);
      const after = levelFor(c.xp).level, now = TITLE_ORDER.filter((id) => TITLES[id].ok(c) && !had.includes(id));
      this.lastExtra = { levelUp: after > before ? after : 0, titles: now.map((id) => TITLES[id].name) };
      this.saveCareer();
    }
    extra = Object.assign({ text: `Career: ${this.career.wins} wins in ${this.career.matches} matches &middot; level ${levelFor(this.career.xp).level} &middot; ${this.career.coins} coins` }, this.lastExtra || {});
    this.clearReplay(); this.state = 'results'; this.releaseLock(); this.ui.showHud(false);
    this.ui.setPanelOpen('inventory', false); this.ui.setPanelOpen('diplomacy', false); this.ui.$('scoreboard').classList.add('hidden');
    s.replayAvailable = !!this.lastHighlight;
    this.ui.renderResults(s, me, extra);
    if (this.kind === 'client') this.ui.$('results').querySelector('[data-act="again"]').textContent = 'BACK TO LOBBY';
    if (this.kind === 'host') this.ui.$('results').querySelector('[data-act="again"]').textContent = 'BACK TO LOBBY';
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
    if (this.host && s === this.localServer) this.host.afterStep();
    this.recorder.tick(dt);
    this.trails(dt);
    if (s.phase === 'ended' && this.state !== 'results' && !this.resultsShown && this.time >= (this.matchEndAt || 0)) { this.resultsShown = true; this.showResults(); return; }
    if (playing) {
      if (p.jumped) this.audio.play('jump', null, 0.8);
      if (p.impactSpeed > 9) this.audio.play('land', null, clamp(p.impactSpeed / 20, 0.3, 1));
      if (p.stepDistance > (p.crouching ? 1.6 : 2.3)) { p.stepDistance = 0; this.audio.play('step', null, 0.9); }
      this.updateInteraction(dt);
    } else { this.mining = null; this.target = null; this.entityTarget = null; this.charge = 0; if (this.blockSent) { this.blockSent = false; s.handle(p.id, { type: 'block', on: false }); } }
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
    const hid = item ? item.id : null;
    if (hid && this.heldSent !== hid) { this.heldSent = hid; s.handle(p.id, { type: 'hold', item: hid }); }
    const meleeHeld = !!(item && item.def.kind === 'tool' && hid !== 'bow' && hid !== 'lighter');
    const overInteractive = !!(this.target && INTERACTIVE.has(w.def(this.target.x, this.target.y, this.target.z).type));
    const wantBlock = meleeHeld && inp.mouse.right && !overInteractive;
    if (wantBlock !== this.blockSent) { this.blockSent = wantBlock; s.handle(p.id, { type: 'block', on: wantBlock }); }
    const left = inp.mouse.left, right = inp.mouse.right, leftEdge = left && !this.leftWas, rightEdge = right && !this.rightWas;
    this.leftWas = left; this.rightWas = right;
    const tgt = this.target;

    // ---- left button ----
    this.charge = 0;
    if (item && item.id === 'bow') {
      if (left) { this.bowHeld = (this.bowHeld || 0) + dt; this.charge = clamp(this.bowHeld / (TOOLS.bow.draw * p.mods.bowDraw * (weaponBoost(p.look, 'bow').draw || 1)), 0, 1); }
      else if (this.bowHeld) { const ch = clamp(this.bowHeld / (TOOLS.bow.draw * p.mods.bowDraw * (weaponBoost(p.look, 'bow').draw || 1)), 0, 1); this.bowHeld = 0; if (ch > 0.2) { if (!s.unlimited && (p.resources.arrow || 0) < 1) this.ui.toast('Out of arrows! Your quiver refills when you stop shooting.', 'bad', 1800); else { s.handle(p.id, { type: 'shoot', charge: ch }); p.cooldowns.shoot = Math.max(p.cooldowns.shoot, 0.05); } } }
      this.mining = null;
    } else {
      this.bowHeld = 0;
      if (item && item.id === 'bucket') {
        this.mining = null;
        if (leftEdge) {
          const f = this.fluidRay(p);
          if (f) { const r = s.handle(p.id, { type: 'scoop', x: f.x, y: f.y, z: f.z }); p.swing = 1; p.swingKind = 'pickaxe'; if (r.ok && !r.pending) p.bucketFluid = r.fluid; else if (r.pending) p.bucketFluid = f.fluid; if (!r.ok && r.reason === 'bucket-full') this.ui.toast('Your bucket supplies are full.', 'bad', 1400); }
          else this.ui.toast('Aim at water or lava to scoop it up.', '', 1400);
        }
      } else if (item && item.id === 'lighter') {
        this.mining = null;
        if (leftEdge && tgt) { const r = s.handle(p.id, { type: 'ignite', x: tgt.x, y: tgt.y, z: tgt.z, nx: tgt.nx, ny: tgt.ny, nz: tgt.nz }); if (!r.ok && r.reason === 'not-allowed') this.ui.toast('You cannot do that here right now.', 'bad', 1500); }
      } else if (left && ent) {
        this.mining = null;
        if (p.cooldowns.attack <= 0.05) { s.handle(p.id, { type: 'attack', targetId: ent.id, tool: T && T.dmg != null ? item.id : 'pickaxe' }); p.swing = 1; p.swingKind = T && T.dmg != null ? item.id : 'pickaxe'; }
        else if (leftEdge) { this.ui.denySwing(); this.audio.play('click', null, 0.25); }                // still recovering: no swing
      } else if (leftEdge && !tgt && !ent && item && T && T.dmg != null) {             // swinging at thin air: the animation plays and weapons pay their cooldown
        this.mining = null;
        if (p.cooldowns.attack <= 0.05) { s.handle(p.id, { type: 'swing', tool: item.id }); p.swing = 1; p.swingKind = item.id; }
        else { this.ui.denySwing(); }
      } else if (left && tgt) {
        const key = tgt.x + ',' + tgt.y + ',' + tgt.z, def = w.def(tgt.x, tgt.y, tgt.z);
        if (!this.mining || this.mining.key !== key) this.mining = { key, progress: 0 };
        if (def.breakable) {
          if (p.swing <= 0) { p.swing = 1; p.swingKind = item && TOOLS[item.id] && item.id !== 'bow' ? item.id : 'pickaxe'; s.handle(p.id, { type: 'swing', tool: p.swingKind, mining: true }); }   // chop, chop, chop
          const plot = (s.plots || []).find((pl) => Math.hypot(tgt.x + 0.5 - pl.x, tgt.z + 0.5 - pl.z) <= CONFIG.PLOT_RADIUS), foe = plot && plot.owner >= 0 && plot.owner !== p.index && !s.areAllies(p, s.players[plot.owner]);
          this.mining.progress += dt / mineTime(def, item && item.def.kind === 'tool' ? item.id : null, p.mods, p.look, { enemy: !!foe });
          if (this.mining.progress >= 1) {
            const r = s.handle(p.id, { type: 'break', x: tgt.x, y: tgt.y, z: tgt.z });
            if (!r.ok && r.reason === 'not-allowed') this.ui.toast(s.phase === 'build' ? 'Build phase: you can only edit your own land.' : 'You cannot do that right now.', 'bad', 1800);
            else if (!r.ok && r.reason === 'own-core') this.ui.toast('That is your own core: protect it!', 'bad', 1800);
            else if (!r.ok && r.reason === 'core-shielded') this.ui.toast('Cores are shielded for the first minute of the war.', 'bad', 1800);
            this.mining = null;
          }
        }
      } else this.mining = null;
    }


    // ---- right button ----
    if (right && tgt) {
      const def = w.def(tgt.x, tgt.y, tgt.z);
      if (INTERACTIVE.has(def.type) && !p.crouching) { if (rightEdge) s.handle(p.id, { type: 'use', x: tgt.x, y: tgt.y, z: tgt.z }); }
      else if (item && item.id === 'bucket' && rightEdge && (tgt.nx || tgt.ny || tgt.nz)) {           // pour what you scooped last (or whatever you have)
        const pref = p.bucketFluid || 'water', other = pref === 'water' ? 'lava' : 'water', fl = s.unlimited || (p.resources[pref] || 0) >= 1 ? pref : (p.resources[other] || 0) >= 1 ? other : null;
        if (!fl) this.ui.toast('Your bucket is empty: scoop up water or lava first.', 'bad', 1600);
        else { const r = s.handle(p.id, { type: 'place', x: tgt.x + tgt.nx, y: tgt.y + tgt.ny, z: tgt.z + tgt.nz, item: fl, against: { x: tgt.x, y: tgt.y, z: tgt.z } }); if (r.ok) { p.swing = 1; p.swingKind = 'pickaxe'; } }
      }
      else if (item && item.def.kind !== 'tool' && (tgt.nx || tgt.ny || tgt.nz)) {
        const r = s.handle(p.id, { type: 'place', x: tgt.x + tgt.nx, y: tgt.y + tgt.ny, z: tgt.z + tgt.nz, item: item.id, against: { x: tgt.x, y: tgt.y, z: tgt.z } });
        if (!r.ok && rightEdge) {
          const msg = { 'no-resource': 'Out of ' + RESOURCES[item.def.res].label.toLowerCase() + '!', 'not-allowed': s.phase === 'build' ? 'Build phase: you can only edit your own land.' : 'You cannot build yet.', 'no-support': 'Needs something to attach to.', 'no-floor': 'Needs solid ground below it.', 'player-in-way': 'Someone is in the way.', 'vault-zone': 'No building inside the vault: run the course!', 'underwater': 'You cannot build while swimming. Pour lava (bucket) to escape!' }[r.reason];
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
      this.arrowFx();
    } else if (this.state === 'results') { this.particles.update(dt, this.world); }
    if (this.replay) { this.replay.update(dt); if (this.replay.done) this.endReplay(); }
    this.shake = Math.max(0, this.shake - dt * 2.2); this.hurt = Math.max(0, this.hurt - dt * 1.3);
    this.dark = lerp(this.dark, s.darkness, clamp(dt * 1.5, 0, 1));
    this.kick = Math.max(0, this.kick - dt * 5); this.equip = Math.min(1, this.equip + dt * 5.5);
    this.blockAmt = lerp(this.blockAmt, p && p.blocking ? 1 : 0, clamp(dt * 14, 0, 1));
    this.fovAdd = lerp(this.fovAdd || 0, this.state === 'playing' && p && p.sprinting ? 7 : 0, clamp(dt * 8, 0, 1));
    { const id = this.hotbar[this.selected], T = TOOLS[id];                                 // swing cooldown ticker, every frame
      this.cdFrac = this.state === 'playing' && p && p.alive && T && T.dmg != null && id !== 'bow' && p.cooldowns.attack > 0 ? clamp(1 - p.cooldowns.attack / (T.cd * p.mods.attackCooldown * (weaponBoost(p.look, id).speed || 1)), 0, 1) : 0;
      this.ui.setCooldown(this.cdFrac); }
    if (this.state === 'playing' || this.state === 'panel') {
      this.hudClock -= dt;
      if (this.hudClock <= 0) { this.hudClock = 0.2; this.updateHud(); }
      if (this.tut && this.state === 'playing') this.tutorialTick(dt);
      if (p && p.adminInfinite) for (const k of RESOURCE_ORDER) p.resources[k] = 999;
      if (this.scoreboardHeld && Math.floor(this.time * 2) !== this.sbTick) { this.sbTick = Math.floor(this.time * 2); this.ui.renderScoreboard(s, p); }
      this.ui.refreshHotbar(this.hotbar, this.selected, s, p);
      if (this.state === 'panel') this.ui.refreshInventoryRes(s, p);
    }
    this.render(dt);
    this.fpsFrames++; this.fpsClock += dt;
    if (this.fpsClock >= 0.5) { this.fps = Math.round(this.fpsFrames / this.fpsClock); this.fpsFrames = 0; this.fpsClock = 0; }
  }

  /** Fire and smoke over burning blocks, trails behind meteors and lit TNT. */
  /** First water/lava cell along the view ray within reach (the normal block ray skips fluids). */
  fluidRay(p) {
    const w = this.server.world, e = p.eyePosition(), d = p.lookDirection();
    for (let t = 0.2; t <= CONFIG.PLAYER.REACH + 1; t += 0.1) {
      const x = Math.floor(e.x + d.x * t), y = Math.floor(e.y + d.y * t), z = Math.floor(e.z + d.z * t), id = w.get(x, y, z);
      if (id === ID.water || id === ID.lava) return { x, y, z, fluid: id === ID.water ? 'water' : 'lava' };
      if (w.isSolid(x, y, z)) return null;
    }
    return null;
  }
  /** Flying arrows leave a trail in their skin's colour. */
  arrowFx() {
    const P = this.particles, arrows = this.server.arrows || [];
    this.fxFlip = !this.fxFlip;
    for (const a of arrows) {
      if (!a.alive || a.stuck || !a.pos) continue;
      const sk = WEAPON_SKINS[a.skin], c = sk && sk.pal.fx;
      if (c) P.puff(a.pos.x, a.pos.y, a.pos.z, a.skin === 'inferno' && Math.random() < 0.5 ? [1, 0.85, 0.3] : c, 1, 0.04, a.skin === 'blood' ? -0.6 : 0.15, 0.08, 0.4, a.skin !== 'blood');
      else if (this.fxFlip) P.puff(a.pos.x, a.pos.y, a.pos.z, [0.9, 0.9, 0.9], 1, 0.02, 0, 0.04, 0.25, false);
    }
  }
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
    for (const p of s.players) {                                       // buffs glow around players
      if (!p.alive || !p.buffs) continue;
      for (const k in BUFF_INFO) if (p.buffs[k] > 0) P.puff(p.pos.x, p.pos.y + 0.3 + Math.random() * 1.4, p.pos.z, hexToRgb(BUFF_INFO[k].color), 1, 0.6, 0.6, 0.09, 0.5);
    }
    for (const p of s.players) {                                       // weapon skins glow in other players' hands
      if (!p.alive || p === this.player || !p.look || !p.look.weapons || Math.abs(p.pos.x - l.x) > 30 || Math.abs(p.pos.z - l.z) > 30) continue;
      const sk = p.look.weapons[p.held]; if (!sk || sk === 'default' || sk === 'titan') continue;
      const fwdX = -Math.sin(p.yaw), fwdZ = -Math.cos(p.yaw), hx = p.pos.x + Math.cos(p.yaw) * 0.42 + fwdX * 0.5, hz = p.pos.z - Math.sin(p.yaw) * 0.42 + fwdZ * 0.5, hy = p.pos.y + 1.05, c = WEAPON_SKINS[sk].pal.fx;
      if (sk === 'frost') P.puff(hx, hy, hz, c, 1, 0.35, -0.5, 0.06, 0.8);
      else if (sk === 'inferno') P.puff(hx, hy, hz, Math.random() < 0.5 ? c : [1, 0.85, 0.3], 1, 0.3, 1.4, 0.08, 0.5);
      else if (sk === 'blood') P.puff(hx, hy, hz, c, 1, 0.2, -1, 0.06, 0.6, false);
      else P.puff(hx, hy, hz, c, 1, 0.4, 0.4, 0.06, 0.45);
    }
  }

  stageInfo() {
    const s = this.server, M = CONFIG.MATCH;
    switch (s.phase) {
      case 'countdown': return ['GET READY', 'Match begins in ' + Math.ceil(M.COUNTDOWN - s.phaseTime), fmtTime(M.COUNTDOWN - s.phaseTime)];
      case 'build': { const left = s.timeLeft(); return left <= 30 * (M.BUILD / 180) ? ['PREPARE', 'Set traps, load TNT, sharpen weapons. War is coming.', fmtTime(left)] : ['BUILD', 'Fortify your land. Only your own land can be edited.', fmtTime(left)]; }
      case 'war': { const t = s.phaseTime / (M.WAR - M.CHAOS); const left = s.timeLeft(); return s.coreShielded && s.coreShielded() ? ['FIGHT', 'Cores are shielded for ' + Math.ceil(CONFIG.MATCH.CORE_SHIELD - s.phaseTime) + ' s. Find the enemy cores (purple).', fmtTime(left)] : t < 0.33 ? ['FIGHT', 'Break enemy cores. While yours stands, you respawn.', fmtTime(left)] : t < 0.75 ? ['DESTROY', 'Break enemy cores: without one, a team cannot respawn.', fmtTime(left)] : ['SURVIVE', 'Stay alive. Chaos is near.', fmtTime(left)]; }
      case 'chaos': return ['CHAOS', 'Sudden death: no respawns. Disasters rage. Last team standing wins.', fmtTime(s.timeLeft())];
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
    U.setPlayers(s.scoreboard().map((q) => ({ name: q.name, color: q.color, alive: q.alive, hp: q.health / q.maxHealth * 100, integ: s.integrity(q.index), core: !!(s.plots[q.index] && s.plots[q.index].core) && !s.baseDestroyed[q.index], score: Math.round(q.stats.score), me: q === p, ally: s.areAllies(q, p), bounty: q.bounty })));
    const v = s.vault, showV = s.phase === 'war' || s.phase === 'chaos' || s.phase === 'sandbox';
    const vst = VAULT_STAGES[v.stage || 0];
    U.setVault(showV, v.cooldown > 0 ? 1 - v.cooldown / 50 : v.progress, v.cooldown > 0 ? 'VAULT RECHARGING' : (v.capturing ? 'CAPTURING ' : 'VAULT ') + ((v.stage || 0) + 1) + '/3: ' + vst.name, v.cooldown > 0 ? 'cool' : v.capturing ? 'cap' : '');
    U.setCharge(this.charge); U.setBuffs(this.player);
    U.setDebug(this.debugVisible, this.debugText());
    // contextual hint
    let hint = '';
    const t = this.target;
    if (t && p.alive) { const d = this.world.def(t.x, t.y, t.z); if (INTERACTIVE.has(d.type)) hint = { lever: '[Right-click] flip lever', button: '[Right-click] press button', door: '[Right-click] open / close door', timer: '[Right-click] start timer', turret: '[Right-click] refill arrows (1 part)' }[d.type] + '  ·  crouch to place instead'; }
    if (!p.alive) hint = '';
    U.setHint(hint);
    if (!p.alive && s.mode !== 'sandbox' && this.state !== 'results' && !(this.replay && this.replay.fullscreen)) {
      const tg = s.players[this.spectateIndex];
      if (this.myCoreAlive()) U.setSpectate('RESPAWNING AT YOUR CORE...');
      else U.setSpectate(tg && tg.alive ? `SPECTATING <b style="color:${tg.color}">${esc(tg.name)}</b> &mdash; <kbd>Space</kbd> next &middot; <kbd>R</kbd> killcam` : 'SPECTATING &mdash; <kbd>Space</kbd> switch player');
    } else U.setSpectate('');
    U.setScreenTint(this.tintKind());
  }
  statusLine() {
    const p = this.player, s = this.server, bits = [];
    bits.push(`<b>${esc(CLASSES[p.classId].name)}</b> on <b>${esc(LANDS[p.landId].name)}</b>`);
    const mates = s.players.filter((q) => s.areAllies(p, q));
    if (mates.length) bits.push('<span class="ally">ALLIED with ' + mates.map((m) => esc(m.name)).join(', ') + '</span>');
    if (p.bounty) bits.push(`<span class="bad">BOUNTY $${p.bounty}</span>`);
    if (this.admin && this.admin.unlocked && this.admin.enabled && s === this.localServer) bits.push('<span class="bad">ADMIN</span>');
    if (s.base_destroyed_flag) bits.push('');
    if (s.plots[p.index] && s.plots[p.index].core) bits.push(s.baseDestroyed[p.index] ? '<span class="bad">NO CORE: no respawns</span>' : '<span class="ally">CORE SAFE</span>');
    if (p.burnTime > 0) bits.push('<span class="bad">BURNING</span>');
    { const maxAir = (p.deadlyWater ? CONFIG.WATER.AIR : CONFIG.WATER.NATURAL_AIR) * (armorPerk(p.look).air || 1); if (p.air != null && p.air < maxAir - 0.05) bits.push(p.air <= 0 ? '<span class="bad">DROWNING! Pour lava to escape</span>' : `<span class="bad">AIR ${Math.max(0, Math.ceil(p.air))}s</span>`); }
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
    for (const q of snap.players) q.flash = clamp(((this.flashT.get(q.index) || 0) - this.time) / 0.25, 0, 1);
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
      if (this.kick > 0) { dir.y += this.kick * 0.05; const l = Math.hypot(dir.x, dir.y, dir.z); dir.x /= l; dir.y /= l; dir.z /= l; }
      cam = { x: e.x + (Math.random() - 0.5) * sh, y: e.y + (Math.random() - 0.5) * sh, z: e.z + (Math.random() - 0.5) * sh, dir, fov: this.settings.fov + (this.fovAdd || 0) };
      const it = this.currentItem();
      if (p.alive && it) held = it.def.kind === 'tool' ? { kind: 'tool', id: it.id, skin: p.look && p.look.weapons ? p.look.weapons[it.id] : null, tile: weaponTile(it.id, p.look && p.look.weapons ? p.look.weapons[it.id] : 'default'), block: this.blockAmt, charge: it.id === 'bow' ? this.charge : 0, equip: this.equip } : { kind: 'block', id: BlockRegistry.byType(it.def.block).id, meta: it.id === 'piston' ? 12 : 0, equip: this.equip };
    }
    this.cam = cam;
    const m = srv.map ? srv.map.vault : null;
    const live = s.phase === 'war' || s.phase === 'chaos' || s.phase === 'sandbox';
    return {
      chunks: this.chunks, cam, snap, selfIndex, target: this.target, mining: this.mining ? clamp(this.mining.progress, 0, 1) : 0,
      particles: this.particles, darkness: this.dark, time: this.time, held, swing: p.swing > 0 ? 1 - p.swing : 0,
      hints: this.hints, vault: m && live ? Object.assign({}, m.pads ? m.pads[s.vault.stage || 0] : m, { cooldown: s.vault.cooldown, capturing: s.vault.capturing }) : null,
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
        if (d > 10 && armorPerk(q.look).stealth && !s.areAllies(q, this.player)) continue;      // Shadow Cloak
        const pr = Mat4.project(vp, q.pos.x, hy, q.pos.z);
        if (!pr || Math.abs(pr.x) > 1.1 || Math.abs(pr.y) > 1.1) continue;
        plates.push({ x: (pr.x * 0.5 + 0.5) * cw, y: (1 - (pr.y * 0.5 + 0.5)) * ch, scale: clamp(1.2 - d / 90, 0.6, 1.1), name: q.name, color: q.color, hp: Math.round(q.health / q.maxHealth * 100), ally: s.areAllies(q, this.player), bounty: q.bounty, hot: (this.hotT.get(q.index) || 0) > this.time, title: q.look && TITLES[q.look.title] ? TITLES[q.look.title].name : '', say: (this.bubbles.get(q.id) || {}).until > this.time ? this.bubbles.get(q.id).text : '' });
      }
    }
    this.ui.updateNameplates(plates);
    const fl = [];
    if ((this.state === 'playing' || this.state === 'panel') && r.lastVP) {
      const vp = r.lastVP, cw = this.canvas.clientWidth, ch = this.canvas.clientHeight;
      this.floats = this.floats.filter((f) => this.time - f.t0 < 0.95);
      for (const f of this.floats) {
        const age = this.time - f.t0, pr = Mat4.project(vp, f.x, f.y + age * 1.3, f.z);
        if (!pr || Math.abs(pr.x) > 1.1 || Math.abs(pr.y) > 1.1) continue;
        fl.push({ x: (pr.x * 0.5 + 0.5) * cw, y: (1 - (pr.y * 0.5 + 0.5)) * ch, alpha: clamp(1.6 - age * 1.6, 0, 1), scale: age < 0.12 ? 0.6 + age * 5 : 1, text: f.text, cls: f.cls });
      }
    }
    this.ui.updateFloaters(fl);
  }
}

/* ============================== EXPORTS / BOOT ============================== */
const api = {
  CONFIG, BlockRegistry, BLOCKS, ID, TILE, World, MapGenerator, buildChunkMesh, buildBlockListMesh, Player, Mob, GameServer, Bot, Mat4, AIR, B, VERTEX_FLOATS,
  CLASSES, LANDS, MAPS, MAP_ORDER, ITEMS, EVENT_DEFS, EVENT_LIST, startResources, mineTime, TOOLS, LAND_ORDER, CLASS_ORDER, RESOURCES, DIFFICULTIES, DIFF_ORDER,
  HostSession, ClientSession, NetServerView, Channel, netConnect, hashWorld, WEAPON_SKINS, WEAPON_TOOLS, weaponBoost, sanitizeProfile, sanitizeLook,
};
if (typeof module !== 'undefined' && module.exports) {
  module.exports = api;                     // lets tests/logic.test.js run the game logic in Node
} else {
  root.PhysicsWars = api;
  const boot = () => { root.game = new Game(); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
}

})(typeof window !== 'undefined' ? window : globalThis);
