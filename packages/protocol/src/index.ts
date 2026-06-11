/**
 * AGENTWORLD protocol v0.1 — the single wire contract shared by the world
 * server, the 3D web client, the MCP adapter, and starter agents.
 *
 * Transport: JSON messages over a single WebSocket endpoint (/ws).
 * Humans and agents speak the exact same protocol; the only difference is
 * cadence (the 3D client consumes 10 Hz `state` frames, agents call
 * `observe` on demand and receive LLM-shaped observations).
 */

export const PROTOCOL_VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// World constants
// ---------------------------------------------------------------------------

export const WORLD = {
  /** Side length of the square island, in world units (XZ plane). */
  SIZE: 96,
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
  | "ember_charm";

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
}

export interface PlayerPrivate extends PlayerPublic {
  ap: number;
  apMax: number;
  shards: number;
  inventory: Partial<Record<ItemId, number>>;
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

export type ClientMsg =
  | JoinMsg
  | MoveMsg
  | StopMsg
  | GatherMsg
  | CraftMsg
  | SayMsg
  | TradePostMsg
  | TradeFillMsg
  | ObserveMsg;

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
}

/** 10 Hz frame for smooth rendering. Positions only; full data via observe. */
export interface StateMsg {
  type: "state";
  t: number;
  players: PlayerPublic[];
  self: { ap: number; shards: number };
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
}

export type ServerMsg =
  | WelcomeMsg
  | StateMsg
  | ChatEvent
  | ActionResultMsg
  | NodeUpdateMsg
  | MarketUpdateMsg
  | ErrorMsg
  | ObservationMsg;

// ---------------------------------------------------------------------------
// Terrain — deterministic heightmap shared by server (collision/spawn) and
// client (rendering). Pure function of (x, z, seed); no noise library.
// ---------------------------------------------------------------------------

export function terrainHeight(x: number, z: number, seed: number): number {
  const s = Math.sin(seed) * 43758.5453;
  const h =
    Math.sin(x * 0.06 + s) * Math.cos(z * 0.05 + s * 0.7) * 2.2 +
    Math.sin(x * 0.013 + z * 0.017 + s * 1.3) * 4.0 +
    Math.sin((x + z) * 0.11 + s * 2.1) * 0.6;
  // Island falloff: edges sink below sea level (y = 0).
  const half = WORLD.SIZE / 2;
  const dx = (x - half) / half;
  const dz = (z - half) / half;
  const d = Math.sqrt(dx * dx + dz * dz);
  const falloff = Math.max(0, 1 - Math.pow(d, 3) * 1.4);
  return (h + 5) * falloff - 1.5;
}

export function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dz = a.z - b.z;
  return Math.sqrt(dx * dx + dz * dz);
}
