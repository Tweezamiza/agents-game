/**
 * AGENTWORLD protocol v0.1 — the single wire contract shared by the world
 * server, the 3D web client, the MCP adapter, and starter agents.
 *
 * Transport: JSON messages over a single WebSocket endpoint (/ws).
 * Humans and agents speak the exact same protocol; the only difference is
 * cadence (the 3D client consumes 10 Hz `state` frames, agents call
 * `observe` on demand and receive LLM-shaped observations).
 */

export const PROTOCOL_VERSION = "0.4.0";

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
  BUILD: 5,
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
  /** Fraction of shards lost when a mob kills you (gentler than PvP). */
  MOB_DEATH_SHARD_FRACTION: 0.1,
  /** leather_armor in inventory reduces ALL incoming damage by this fraction. */
  ARMOR_REDUCTION: 0.25,
  /** fang_blade in inventory adds this to attack damage (stacks with charm). */
  BLADE_BONUS: 6,
} as const;

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
  | "hide"
  | "fang"
  | "golem_core"
  | "leather_armor"
  | "fang_blade"
  | "ward_totem";

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
  { id: "leather_armor", output: "leather_armor", outputQty: 1, inputs: { hide: 3 } },
  { id: "fang_blade", output: "fang_blade", outputQty: 1, inputs: { fang: 2, plank: 1 } },
  { id: "ward_totem", output: "ward_totem", outputQty: 1, inputs: { golem_core: 1, brick: 2 } },
];

// ---------------------------------------------------------------------------
// Mobs — server-authoritative PvE creatures, spawned from the world seed.
// ---------------------------------------------------------------------------

export type MobKind = "boar" | "wolf" | "golem";

export interface MobStats {
  /** Display name used in combat events and observations. */
  name: string;
  level: number;
  hpMax: number;
  damageMin: number;
  damageMax: number;
  /** World units per game tick — all mobs are slower than players. */
  moveSpeed: number;
  attackRange: number;
  /** Aggressive kinds attack players within this radius unprovoked. */
  aggroRange: number;
  aggressive: boolean;
  /** Rewards granted to the killer. */
  xp: number;
  shards: number;
  drop: ItemId;
  dropChance: number;
}

export const MOBS: Record<MobKind, MobStats> = {
  boar: { name: "Boar", level: 2, hpMax: 40, damageMin: 4, damageMax: 7, moveSpeed: 2.2, attackRange: 1.8, aggroRange: 8, aggressive: false, xp: 18, shards: 4, drop: "hide", dropChance: 0.8 },
  wolf: { name: "Wolf", level: 4, hpMax: 55, damageMin: 7, damageMax: 12, moveSpeed: 3.2, attackRange: 2, aggroRange: 10, aggressive: true, xp: 30, shards: 8, drop: "fang", dropChance: 0.7 },
  golem: { name: "Highland Golem", level: 8, hpMax: 140, damageMin: 14, damageMax: 22, moveSpeed: 1.3, attackRange: 2.2, aggroRange: 9, aggressive: true, xp: 75, shards: 20, drop: "golem_core", dropChance: 0.45 },
};

export interface MobPublic {
  id: string;
  kind: MobKind;
  pos: Vec2;
  hp: number;
  hpMax: number;
  level: number;
}

// ---------------------------------------------------------------------------
// Progression — XP, levels, and the curve between them.
// ---------------------------------------------------------------------------

export const PROGRESSION = {
  LEVEL_CAP: 20,
  /** hpMax = COMBAT.HP_MAX + HP_PER_LEVEL * (level - 1). */
  HP_PER_LEVEL: 4,
  /** Flat attack damage added per level above 1. */
  DAMAGE_PER_LEVEL: 1,
  XP_GATHER: 2,
  XP_CRAFT: 3,
  XP_PVP_KILL: 40,
} as const;

/** XP required to advance from level n to n + 1. */
export function xpForLevel(n: number): number {
  return Math.round(50 * Math.pow(n, 1.5));
}

// ---------------------------------------------------------------------------
// Structures + territory — player-built, in-memory this sprint.
// ---------------------------------------------------------------------------

export type StructureKind = "campfire" | "wall" | "banner";

export interface Structure {
  id: string;
  kind: StructureKind;
  ownerId: string;
  ownerName: string;
  pos: Vec2;
}

export const STRUCTURES: Record<StructureKind, { name: string; cost: Partial<Record<ItemId, number>> }> = {
  campfire: { name: "Campfire", cost: { wood: 2, stone: 1 } },
  wall: { name: "Wall", cost: { brick: 3 } },
  banner: { name: "Banner", cost: { ward_totem: 1, plank: 2 } },
};

export const TERRITORY = {
  /** A banner claims a circular territory of this radius for its owner. */
  BANNER_RADIUS: 20,
  /** Extra AP regenerated per game tick while inside your own territory. */
  AP_REGEN_BONUS: 2,
  /** Campfires heal players within this radius by HEAL_HP per game tick. */
  CAMPFIRE_HEAL_RADIUS: 6,
  CAMPFIRE_HEAL_HP: 1,
  /** Max 1 campfire per player within this radius (anti-spam). */
  CAMPFIRE_MIN_SPACING: 30,
} as const;

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
}

export interface PlayerPrivate extends PlayerPublic {
  ap: number;
  apMax: number;
  shards: number;
  inventory: Partial<Record<ItemId, number>>;
  kills: number;
  deaths: number;
  /** XP progress within the current level. */
  xp: number;
  /** XP needed to reach the next level (0 at the cap). */
  xpNext: number;
  /** True while inside the central no-PvP shrine zone. */
  inSafeZone: boolean;
  /** Active and completed quests (accepted ones only). */
  quests: QuestState[];
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
// Quests — a hand-authored story campaign plus a rotating side-quest board.
// Definitions are static content; per-player progress lives in QuestState.
// ---------------------------------------------------------------------------

export type QuestObjectiveKind = "gather" | "craft" | "kill" | "build" | "explore";

export interface QuestObjective {
  kind: QuestObjectiveKind;
  /** ItemId for gather, recipe id for craft, MobKind for kill, StructureKind for build, named place for explore. */
  target: string;
  qty: number;
}

export interface QuestDef {
  id: string;
  title: string;
  /** Narrative hook shown in the journal — the giver's words, in character. */
  story: string;
  /** NPC quest giver, e.g. "Elder Maren". */
  giver: string;
  objective: QuestObjective;
  rewardShards: number;
  rewardXp: number;
  rewardItems?: Partial<Record<ItemId, number>>;
  /** Story chains: quest id that must be turned in first. */
  requires?: string;
  /** True for rotating board side-quests (non-story). */
  side?: boolean;
}

export interface QuestState {
  questId: string;
  progress: number;
  /** Objective met; rewards are granted automatically on completion. */
  done: boolean;
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
  /** Player id ("p-...") or mob id ("m-..."). */
  targetId: string;
}

export interface BuildMsg {
  type: "build";
  /** Built at the player's current position. */
  structure: StructureKind;
}

export interface QuestAcceptMsg {
  type: "quest_accept";
  questId: string;
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
  | BuildMsg
  | QuestAcceptMsg;

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
  mobs: MobPublic[];
  structures: Structure[];
  /** All quests currently offered to this player (story unlocks + board). */
  quests: QuestDef[];
}

/** 10 Hz frame for smooth rendering. Positions only; full data via observe. */
export interface StateMsg {
  type: "state";
  t: number;
  players: PlayerPublic[];
  /** Live mobs only — dead ones vanish until they respawn. */
  mobs: MobPublic[];
  self: { ap: number; shards: number; level: number; xp: number; xpNext: number };
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

/** Full structure list, broadcast whenever something is built (or a banner moves). */
export interface StructureUpdateMsg {
  type: "structure_update";
  structures: Structure[];
}

/** Sent to one player when a quest is accepted, progresses, or completes. */
export interface QuestUpdateMsg {
  type: "quest_update";
  quest: QuestDef;
  state: QuestState;
  /** Journal line, e.g. "Wolfsbane: 2/3 wolves slain." */
  message: string;
  /** Set when the quest just completed and rewards were granted. */
  completed?: boolean;
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
  nearbyMobs: MobPublic[];
  structures: Structure[];
  market: MarketOrder[];
  recipes: Recipe[];
  /** Quests currently offered to this player (story unlocks + board). */
  quests: QuestDef[];
}

export type ServerMsg =
  | WelcomeMsg
  | StateMsg
  | ChatEvent
  | ActionResultMsg
  | NodeUpdateMsg
  | MarketUpdateMsg
  | StructureUpdateMsg
  | QuestUpdateMsg
  | ErrorMsg
  | ObservationMsg
  | CombatEvent;

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
