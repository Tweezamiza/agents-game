/**
 * AGENTWORLD protocol v0.1 — the single wire contract shared by the world
 * server, the 3D web client, the MCP adapter, and starter agents.
 *
 * Transport: JSON messages over a single WebSocket endpoint (/ws).
 * Humans and agents speak the exact same protocol; the only difference is
 * cadence (the 3D client consumes 10 Hz `state` frames, agents call
 * `observe` on demand and receive LLM-shaped observations).
 */

export const PROTOCOL_VERSION = "0.3.0";

// ---------------------------------------------------------------------------
// World constants
// ---------------------------------------------------------------------------

export const WORLD = {
  /** Side length of the square island, in world units (XZ plane). */
  SIZE: 240,
  /** Movement/physics sub-tick, ms. State frames broadcast at this rate. */
  TICK_MS: 100,
  /** Game tick (AP regen, node respawn, gather/craft completion), ms. */
  GAME_TICK_MS: 1000,
  /** Walk speed, units per second. */
  MOVE_SPEED: 4,
  /** Action point pool. */
  AP_MAX: 300,
  /** AP regenerated per game tick (per second). Identical for all citizens. */
  AP_REGEN: 1,
  /** Interaction range for gathering/trading, world units. */
  INTERACT_RANGE: 3,
  /** Chat range for the "local" channel, world units. */
  LOCAL_CHAT_RANGE: 25,
} as const;

/** AP costs per action. Movement is charged per 10 units walked. */
export const AP_COST = {
  MOVE_PER_10_UNITS: 1,
  GATHER: 5,
  CRAFT: 10,
  MARKET_ORDER: 1,
  SAY: 0,
  ATTACK: 8,
} as const;

export const COMBAT = {
  HP_MAX: 100,
  /** HP regenerated per game tick once out of combat. */
  HP_REGEN: 2,
  /** Seconds without taking/dealing damage before regen kicks in. */
  REGEN_DELAY_S: 8,
  ATTACK_RANGE: 2.5,
  /** Base damage; ember_charm in inventory adds CHARM_BONUS. */
  DAMAGE_MIN: 8,
  DAMAGE_MAX: 14,
  CHARM_BONUS: 4,
  /** Game ticks between attacks per player. */
  COOLDOWN_TICKS: 2,
  /** No PvP within this radius of the island's central spawn shrine. */
  SAFE_ZONE_RADIUS: 14,
  /** Fraction of the victim's shards looted by the killer. */
  LOOT_SHARD_FRACTION: 0.25,
} as const;

// ---------------------------------------------------------------------------
// PvE — skeleton mobs (Sprint 3)
// ---------------------------------------------------------------------------

export const PVE = {
  /** Target number of mobs alive at once across all camps. */
  MAX_MOBS: 24,
  /** Mob walk speed, units per second (slower than players: kiting works). */
  MOB_SPEED: 3,
  /** Mobs aggro players within this range of themselves. */
  AGGRO_RANGE: 8,
  /** Mobs chase at most this far from their camp, then leash back. */
  LEASH_RANGE: 20,
  /** Roam radius around the spawn camp while idle. */
  ROAM_RADIUS: 6,
  /** Mob melee reach (players out-range them at 2.5). */
  ATTACK_RANGE: 2,
  /** Milliseconds between mob attacks. */
  ATTACK_COOLDOWN_MS: 1500,
  /** Mob HP = HP_BASE + HP_PER_LEVEL * level. */
  HP_BASE: 40,
  HP_PER_LEVEL: 15,
  /** Mob damage = DAMAGE_BASE + level + rand(0..DAMAGE_RAND), so ~6-12. */
  DAMAGE_BASE: 5,
  DAMAGE_RAND: 2,
  /** Seconds after death before a camp respawns the mob. */
  RESPAWN_S: 60,
  /** XP granted to the killer = XP_PER_MOB_LEVEL * mob level. */
  XP_PER_MOB_LEVEL: 25,
  /** Every kill drops 1..BONE_DROP_MAX bones. */
  BONE_DROP_MAX: 2,
  /** Chance any skeleton drops an ember crystal. */
  EMBER_DROP_CHANCE: 0.15,
  /** Chance a warrior drops equipment (rusty sword / wooden shield). */
  EQUIP_DROP_CHANCE: 0.5,
  /** Bad-luck protection: a warrior is guaranteed to drop equipment after
   *  this many consecutive equipment-less warrior kills (world-wide). */
  EQUIP_PITY_KILLS: 2,
} as const;

export type MobKind = "skeleton_minion" | "skeleton_warrior";

/** Mob snapshot included in state frames, welcome, and observations. */
export interface MobPublic {
  id: string;
  kind: MobKind;
  level: number;
  pos: Vec2;
  hp: number;
  hpMax: number;
  /** Player id this mob is currently chasing/attacking, if any. */
  targetId?: string;
}

// ---------------------------------------------------------------------------
// Progression — XP and levels (Sprint 3)
// ---------------------------------------------------------------------------

export const PROGRESSION = {
  MAX_LEVEL: 20,
  /** Max HP gained per level beyond 1. */
  HP_PER_LEVEL: 6,
  /** Base damage gained per level beyond 1. */
  DAMAGE_PER_LEVEL: 1,
  /** XP per completed gather. */
  XP_GATHER: 3,
  /** XP per crafted recipe unit. */
  XP_CRAFT: 5,
} as const;

/** XP required to advance FROM level n to n+1. */
export function xpForLevel(n: number): number {
  return Math.round(100 * Math.pow(n, 1.7));
}

/** Player max HP at a given level. */
export function maxHpForLevel(level: number): number {
  return COMBAT.HP_MAX + PROGRESSION.HP_PER_LEVEL * (Math.max(1, level) - 1);
}

// ---------------------------------------------------------------------------
// Quests (Sprint 3)
// ---------------------------------------------------------------------------

export const QUESTS = {
  /** The village quest board rotates every 10 minutes. */
  ROTATION_MS: 600_000,
  /** Quests on the board per rotation. */
  BOARD_SIZE: 3,
  /** Max simultaneously accepted quests per player. */
  MAX_ACTIVE_PER_PLAYER: 2,
} as const;

export type QuestGoal =
  | { type: "slay"; mobKind?: MobKind; count: number }
  | { type: "gather"; item: ItemId; count: number }
  | { type: "craft"; recipeId: string; count: number };

export interface Quest {
  id: string;
  title: string;
  description: string;
  goal: QuestGoal;
  rewardShards: number;
  rewardXp: number;
  /** Epoch ms when this board rotation ends (accepted quests stay valid). */
  expiresAt: number;
}

/** Per-player accepted quest, included in quest_board / observation. */
export interface QuestProgress {
  quest: Quest;
  progress: number;
}

// ---------------------------------------------------------------------------
// Territory & building (Sprint 3)
// ---------------------------------------------------------------------------

export const TERRITORY = {
  /** Side length of a square plot, centered on the claim point. */
  CLAIM_SIZE: 12,
  CLAIM_COST_SHARDS: 50,
  /** Claims must be at least this far from the village shrine. */
  MIN_DIST_FROM_VILLAGE: 25,
  /** Claim centers must be at least this far apart. */
  MIN_DIST_BETWEEN_CLAIMS: 15,
  STRUCTURE_HP: 500,
  /** Workshop aura radius: crafting within it costs less AP. */
  WORKSHOP_RANGE: 10,
  /** Fractional AP discount on crafting near a workshop. */
  WORKSHOP_CRAFT_DISCOUNT: 0.25,
  /** Shards paid per craft to the workshop owner by non-owners. */
  WORKSHOP_FEE_SHARDS: 1,
  /** Fraction of build materials dropped to the destroyer on demolition. */
  SALVAGE_FRACTION: 0.5,
} as const;

export type StructureKind = "wall" | "house" | "workshop";

export const STRUCTURE_COSTS: Record<StructureKind, Partial<Record<ItemId, number>>> = {
  wall: { wood: 5, stone: 5 },
  house: { wood: 20, stone: 10 },
  workshop: { wood: 15, stone: 15 },
};

export interface Claim {
  id: string;
  /** Empty string while the owner is offline (claims persist across sessions). */
  ownerId: string;
  ownerName: string;
  center: Vec2;
  /** Side length (= TERRITORY.CLAIM_SIZE). */
  size: number;
}

export interface Structure {
  id: string;
  kind: StructureKind;
  ownerId: string;
  ownerName: string;
  claimId: string;
  pos: Vec2;
  hp: number;
  hpMax: number;
}

// ---------------------------------------------------------------------------
// Items, resources, recipes
// ---------------------------------------------------------------------------

export type ItemId =
  | "wood"
  | "stone"
  | "ember_crystal"
  | "plank"
  | "brick"
  | "stone_axe"
  | "ember_charm"
  | "bone"
  | "rusty_sword"
  | "iron_sword"
  | "wooden_shield"
  | "iron_shield";

// ---------------------------------------------------------------------------
// Equipment (Sprint 3) — weapon adds damage, offhand shield reduces incoming
// damage (never below 1).
// ---------------------------------------------------------------------------

export type EquipSlot = "weapon" | "offhand";

export interface Equipment {
  weapon?: ItemId;
  offhand?: ItemId;
}

export interface EquipStats {
  slot: EquipSlot;
  /** Added to outgoing attack damage. */
  damage?: number;
  /** Subtracted from incoming damage (min 1 still lands). */
  defense?: number;
}

export const EQUIPMENT_STATS: Partial<Record<ItemId, EquipStats>> = {
  rusty_sword: { slot: "weapon", damage: 3 },
  iron_sword: { slot: "weapon", damage: 6 },
  wooden_shield: { slot: "offhand", defense: 2 },
  iron_shield: { slot: "offhand", defense: 4 },
};

export type ResourceKind = "tree" | "rock" | "crystal";

export const RESOURCE_YIELD: Record<ResourceKind, ItemId> = {
  tree: "wood",
  rock: "stone",
  crystal: "ember_crystal",
};

export interface Recipe {
  id: string;
  output: ItemId;
  outputQty: number;
  inputs: Partial<Record<ItemId, number>>;
}

export const RECIPES: Recipe[] = [
  { id: "plank", output: "plank", outputQty: 1, inputs: { wood: 2 } },
  { id: "brick", output: "brick", outputQty: 1, inputs: { stone: 2 } },
  { id: "stone_axe", output: "stone_axe", outputQty: 1, inputs: { wood: 1, stone: 2 } },
  { id: "ember_charm", output: "ember_charm", outputQty: 1, inputs: { ember_crystal: 1, plank: 2 } },
  { id: "wooden_shield", output: "wooden_shield", outputQty: 1, inputs: { wood: 3, plank: 1 } },
  { id: "iron_sword", output: "iron_sword", outputQty: 1, inputs: { stone: 3, wood: 2, ember_crystal: 1 } },
  { id: "iron_shield", output: "iron_shield", outputQty: 1, inputs: { stone: 4, plank: 2, ember_crystal: 1 } },
];

// ---------------------------------------------------------------------------
// Entities
// ---------------------------------------------------------------------------

export type Role = "human" | "agent";

export interface Vec2 {
  x: number;
  z: number;
}

export interface PlayerPublic {
  id: string;
  name: string;
  role: Role;
  pos: Vec2;
  /** Unit-vector facing on XZ, for rendering. */
  facing: Vec2;
  /** True while a gather/craft action is in progress. */
  busy: boolean;
  hp: number;
  hpMax: number;
  level: number;
  /** Equipped items, so clients can attach weapon/shield models. */
  equipment: Equipment;
}

export interface PlayerPrivate extends PlayerPublic {
  ap: number;
  apMax: number;
  shards: number;
  inventory: Partial<Record<ItemId, number>>;
  kills: number;
  deaths: number;
  /** True while inside the central no-PvP shrine zone. */
  inSafeZone: boolean;
  /** XP accumulated toward the next level. */
  xp: number;
  /** XP needed to advance from the current level (xpForLevel(level)). */
  xpNext: number;
  /** Accepted quests with progress. */
  quests: QuestProgress[];
}

export interface ResourceNode {
  id: string;
  kind: ResourceKind;
  pos: Vec2;
  /** Units remaining before the node is depleted (respawns later). */
  remaining: number;
}

export interface MarketOrder {
  id: string;
  ownerId: string;
  ownerName: string;
  side: "buy" | "sell";
  item: ItemId;
  qty: number;
  /** Price in shards per unit. */
  price: number;
}

// ---------------------------------------------------------------------------
// Client → Server messages
// ---------------------------------------------------------------------------

export interface JoinMsg {
  type: "join";
  name: string;
  role: Role;
}

export interface MoveMsg {
  type: "move";
  /** Walk toward this point; server clamps to world bounds. */
  target: Vec2;
}

export interface StopMsg {
  type: "stop";
}

export interface GatherMsg {
  type: "gather";
  nodeId: string;
}

export interface CraftMsg {
  type: "craft";
  recipeId: string;
  qty?: number;
}

export interface SayMsg {
  type: "say";
  channel: "local" | "world";
  text: string;
}

export interface TradePostMsg {
  type: "trade_post";
  side: "buy" | "sell";
  item: ItemId;
  qty: number;
  price: number;
}

export interface TradeFillMsg {
  type: "trade_fill";
  orderId: string;
  qty?: number;
}

export interface ObserveMsg {
  type: "observe";
}

export interface AttackMsg {
  type: "attack";
  /** A player id, mob id, or structure id (siege, outside the safe zone). */
  targetId: string;
}

/** Equip an equippable item from the inventory (auto-swaps the slot). */
export interface EquipMsg {
  type: "equip";
  item: ItemId;
}

/** Return the equipped item in `slot` to the inventory. */
export interface UnequipMsg {
  type: "unequip";
  slot: EquipSlot;
}

/** Request the current village quest board + your accepted quests. */
export interface QuestListMsg {
  type: "quest_list";
}

export interface QuestAcceptMsg {
  type: "quest_accept";
  questId: string;
}

/** Claim a TERRITORY.CLAIM_SIZE square plot centered on pos (50 shards). */
export interface ClaimMsg {
  type: "claim";
  pos: Vec2;
}

/** Place a structure on one of YOUR plots (consumes STRUCTURE_COSTS). */
export interface BuildMsg {
  type: "build";
  structure: StructureKind;
  pos: Vec2;
}

export type ClientMsg =
  | JoinMsg
  | MoveMsg
  | StopMsg
  | GatherMsg
  | CraftMsg
  | SayMsg
  | TradePostMsg
  | TradeFillMsg
  | ObserveMsg
  | AttackMsg
  | EquipMsg
  | UnequipMsg
  | QuestListMsg
  | QuestAcceptMsg
  | ClaimMsg
  | BuildMsg;

// ---------------------------------------------------------------------------
// Server → Client messages
// ---------------------------------------------------------------------------

export interface WelcomeMsg {
  type: "welcome";
  protocolVersion: string;
  playerId: string;
  worldSize: number;
  /** Heightmap seed so the client renders identical terrain. */
  seed: number;
  self: PlayerPrivate;
  nodes: ResourceNode[];
  /** Sprint 3 additive fields (older clients ignore them). */
  mobs?: MobPublic[];
  claims?: Claim[];
  structures?: Structure[];
}

/** 10 Hz frame for smooth rendering. Positions only; full data via observe. */
export interface StateMsg {
  type: "state";
  t: number;
  players: PlayerPublic[];
  self: {
    ap: number;
    shards: number;
    /** Sprint 3 additive fields. */
    hp?: number;
    xp?: number;
    level?: number;
    xpNext?: number;
  };
  /** All living mobs (Sprint 3, additive). */
  mobs?: MobPublic[];
  /** All claimed plots (Sprint 3, additive). */
  claims?: Claim[];
  /** All standing structures (Sprint 3, additive). */
  structures?: Structure[];
}

export interface ChatEvent {
  type: "chat";
  channel: "local" | "world";
  from: { id: string; name: string; role: Role };
  text: string;
}

export interface ActionResultMsg {
  type: "action_result";
  action: ClientMsg["type"];
  ok: boolean;
  /** Human/agent-readable outcome, e.g. "Gathered 1 wood (4 AP left on node)". */
  message: string;
  /** Updated private state after the action settles. */
  self?: PlayerPrivate;
}

export interface NodeUpdateMsg {
  type: "node_update";
  node: ResourceNode;
}

export interface MarketUpdateMsg {
  type: "market_update";
  orders: MarketOrder[];
}

export interface ErrorMsg {
  type: "error";
  message: string;
}

/** Broadcast to everyone near a fight; drives client combat feedback. */
export interface CombatEvent {
  type: "combat";
  attacker: { id: string; name: string };
  target: { id: string; name: string };
  damage: number;
  targetHp: number;
  killed: boolean;
  /** Shards looted by the attacker when killed is true. */
  loot?: number;
  /** "player" when omitted (pre-0.3 compat); mobs/structures are additive. */
  targetKind?: "player" | "mob" | "structure";
  attackerKind?: "player" | "mob";
  /** Items dropped to the killer (mob loot / structure salvage). */
  lootItems?: Partial<Record<ItemId, number>>;
  /** XP granted to the killer. */
  xp?: number;
}

/** Generic world event broadcast (level-ups, quests, territory, ...). */
export interface GameEventMsg {
  type: "event";
  event:
    | "level_up"
    | "quest_complete"
    | "quest_accepted"
    | "claim_created"
    | "structure_built"
    | "structure_destroyed"
    | "mob_spawn";
  message: string;
  /** Player the event concerns, when applicable. */
  playerId?: string;
  data?: Record<string, unknown>;
}

/** Response to quest_list: the rotating village board + your accepted quests. */
export interface QuestBoardMsg {
  type: "quest_board";
  /** Quests currently offered by the village board. */
  quests: Quest[];
  /** Your accepted quests with progress. */
  active: QuestProgress[];
  /** Epoch ms when the board rotates next. */
  rotatesAt: number;
}

/**
 * LLM-shaped observation: everything an agent needs to decide its next
 * action, with a natural-language summary so a bare LLM loop can play.
 */
export interface ObservationMsg {
  type: "observation";
  t: number;
  summary: string;
  self: PlayerPrivate;
  nearbyPlayers: PlayerPublic[];
  nearbyNodes: ResourceNode[];
  market: MarketOrder[];
  recipes: Recipe[];
  /** Sprint 3 additive fields. */
  nearbyMobs?: MobPublic[];
  questBoard?: Quest[];
  nearbyClaims?: Claim[];
  nearbyStructures?: Structure[];
}

export type ServerMsg =
  | WelcomeMsg
  | StateMsg
  | ChatEvent
  | ActionResultMsg
  | NodeUpdateMsg
  | MarketUpdateMsg
  | ErrorMsg
  | ObservationMsg
  | CombatEvent
  | GameEventMsg
  | QuestBoardMsg;

/** Centre of the island — the spawn shrine anchoring the no-PvP zone. */
export const SAFE_ZONE_CENTER: Vec2 = { x: WORLD.SIZE / 2, z: WORLD.SIZE / 2 };

// ---------------------------------------------------------------------------
// Terrain — deterministic heightmap shared by server (collision/spawn) and
// client (rendering). Pure function of (x, z, seed); no noise library.
// ---------------------------------------------------------------------------

export function terrainHeight(x: number, z: number, seed: number): number {
  const s = Math.sin(seed) * 43758.5453;
  const size = WORLD.SIZE;
  const half = size / 2;

  // Rolling hills: layered sines at several frequencies/orientations.
  const rolling =
    Math.sin(x * 0.043 + s) * Math.cos(z * 0.037 + s * 0.7) * 1.7 +
    Math.sin(x * 0.011 + z * 0.014 + s * 1.3) * 3.0 +
    Math.sin((x - z) * 0.019 + s * 2.7) * 1.5 +
    Math.sin((x + z) * 0.087 + s * 2.1) * 0.4;

  // Highland massif in the north-east quadrant (rocks live up here).
  const hx = x - size * 0.7;
  const hz = z - size * 0.66;
  const highland = 10.5 * Math.exp(-(hx * hx + hz * hz) / (2 * 42 * 42));

  // Gentle meadow basin to the south-west (berries/crystals).
  const mx = x - size * 0.33;
  const mz = z - size * 0.36;
  const meadow = -1.4 * Math.exp(-(mx * mx + mz * mz) / (2 * 36 * 36));

  // Flatten a plateau at the centre so the shrine village sits level:
  // perfectly flat inside r=18, smooth-stepped back to wild terrain by r=40.
  const cx = x - half;
  const cz = z - half;
  const cd = Math.sqrt(cx * cx + cz * cz);
  const t = Math.min(1, Math.max(0, (cd - 18) / 22));
  const wild = t * t * (3 - 2 * t);

  let h = rolling + highland + meadow;
  h = 2.4 * (1 - wild) + h * wild; // blend toward the village plateau

  // Island falloff: a wide, soft rim so the coast reads as beaches before
  // the terrain sinks below sea level (y = 0).
  const dx = cx / half;
  const dz = cz / half;
  const d = Math.sqrt(dx * dx + dz * dz);
  const falloff = Math.max(0, 1 - Math.pow(d, 2.6) * 1.45);
  return (h + 4.6) * falloff - 1.6;
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
