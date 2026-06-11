import {
  AP_COST,
  ItemId,
  MarketOrder,
  PlayerPrivate,
  PlayerPublic,
  Recipe,
  RECIPES,
  RESOURCE_YIELD,
  ResourceKind,
  ResourceNode,
  Role,
  Vec2,
  WORLD,
  distance,
  terrainHeight,
} from "@agentworld/protocol";

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface GatherJob {
  nodeId: string;
  /** Game ticks remaining until the gather completes. */
  ticksLeft: number;
}

export interface Player {
  id: string;
  name: string;
  role: Role;
  pos: Vec2;
  facing: Vec2;
  target: Vec2 | null;
  /** Fractional distance walked since last AP charge. */
  walkDebt: number;
  ap: number;
  shards: number;
  inventory: Partial<Record<ItemId, number>>;
  gather: GatherJob | null;
}

export interface LedgerEntry {
  t: number;
  kind: string;
  debit: string;
  credit: string;
  item: ItemId | "shards";
  qty: number;
  memo: string;
}

export interface ActionOutcome {
  ok: boolean;
  message: string;
}

const NODE_RESPAWN_TICKS = 60;
const GATHER_TICKS = 2;
const NODE_CAPACITY: Record<ResourceKind, number> = { tree: 5, rock: 5, crystal: 3 };

export class World {
  readonly seed: number;
  nodes = new Map<string, ResourceNode>();
  players = new Map<string, Player>();
  orders = new Map<string, MarketOrder>();
  ledger: LedgerEntry[] = [];
  private respawnQueue = new Map<string, number>();
  private nextId = 1;

  constructor(seed = 1337) {
    this.seed = seed;
    this.generateNodes();
  }

  private generateNodes() {
    const rng = mulberry32(this.seed);
    const place = (kind: ResourceKind, count: number) => {
      let placed = 0;
      let guard = 0;
      while (placed < count && guard++ < 5000) {
        const x = rng() * WORLD.SIZE;
        const z = rng() * WORLD.SIZE;
        if (terrainHeight(x, z, this.seed) < 0.5) continue;
        const id = `${kind}-${this.nextId++}`;
        this.nodes.set(id, { id, kind, pos: { x, z }, remaining: NODE_CAPACITY[kind] });
        placed++;
      }
    };
    place("tree", 40);
    place("rock", 25);
    place("crystal", 8);
  }

  spawnPoint(): Vec2 {
    const rng = mulberry32(this.seed ^ 0xbeef ^ this.players.size);
    for (let i = 0; i < 1000; i++) {
      const x = WORLD.SIZE / 2 + (rng() - 0.5) * 30;
      const z = WORLD.SIZE / 2 + (rng() - 0.5) * 30;
      if (terrainHeight(x, z, this.seed) > 0.5) return { x, z };
    }
    return { x: WORLD.SIZE / 2, z: WORLD.SIZE / 2 };
  }

  addPlayer(name: string, role: Role): Player {
    const id = `p-${this.nextId++}`;
    const player: Player = {
      id,
      name,
      role,
      pos: this.spawnPoint(),
      facing: { x: 0, z: 1 },
      target: null,
      walkDebt: 0,
      ap: WORLD.AP_MAX,
      shards: 100,
      inventory: {},
      gather: null,
    };
    this.players.set(id, player);
    return player;
  }

  removePlayer(id: string) {
    // Cancel open orders and refund escrow before the player vanishes.
    for (const order of [...this.orders.values()]) {
      if (order.ownerId === id) this.cancelOrder(order);
    }
    this.players.delete(id);
  }

  // -- Movement (100 ms sub-tick) --------------------------------------------

  /** Returns ids of players that moved this sub-tick. */
  moveTick(dtMs: number): Set<string> {
    const moved = new Set<string>();
    const step = (WORLD.MOVE_SPEED * dtMs) / 1000;
    for (const p of this.players.values()) {
      if (!p.target || p.gather) continue;
      const d = distance(p.pos, p.target);
      if (d < 0.05) {
        p.target = null;
        continue;
      }
      const walk = Math.min(step, d);
      // Charge AP per 10 units walked; stop when out of energy.
      p.walkDebt += walk;
      if (p.walkDebt >= 10) {
        const charges = Math.floor(p.walkDebt / 10);
        const cost = charges * AP_COST.MOVE_PER_10_UNITS;
        if (p.ap < cost) {
          p.target = null;
          p.walkDebt = 0;
          continue;
        }
        p.ap -= cost;
        p.walkDebt -= charges * 10;
      }
      const nx = p.pos.x + ((p.target.x - p.pos.x) / d) * walk;
      const nz = p.pos.z + ((p.target.z - p.pos.z) / d) * walk;
      // Refuse to walk into the sea.
      if (terrainHeight(nx, nz, this.seed) > 0.2) {
        p.facing = { x: (p.target.x - p.pos.x) / d, z: (p.target.z - p.pos.z) / d };
        p.pos = { x: nx, z: nz };
        moved.add(p.id);
      } else {
        p.target = null;
      }
    }
    return moved;
  }

  // -- Game tick (1 s) --------------------------------------------------------

  /** Returns gather completions and respawned nodes for event broadcast. */
  gameTick(): { completions: { player: Player; message: string }[]; respawned: ResourceNode[] } {
    const completions: { player: Player; message: string }[] = [];
    const respawned: ResourceNode[] = [];

    for (const p of this.players.values()) {
      p.ap = Math.min(WORLD.AP_MAX, p.ap + WORLD.AP_REGEN);
      if (p.gather) {
        p.gather.ticksLeft--;
        if (p.gather.ticksLeft <= 0) {
          const node = this.nodes.get(p.gather.nodeId);
          p.gather = null;
          if (node && node.remaining > 0) {
            const item = RESOURCE_YIELD[node.kind];
            const bonus = item === "wood" && (p.inventory.stone_axe ?? 0) > 0 ? 1 : 0;
            const qty = 1 + bonus;
            node.remaining--;
            this.give(p, item, qty);
            this.log("gather", "world", p.id, item, qty, `${p.name} gathered from ${node.id}`);
            if (node.remaining <= 0) this.respawnQueue.set(node.id, NODE_RESPAWN_TICKS);
            completions.push({
              player: p,
              message: `Gathered ${qty} ${item}${bonus ? " (stone axe bonus)" : ""}. Node has ${node.remaining} left.`,
            });
          } else {
            completions.push({ player: p, message: "Gather failed: the node was depleted." });
          }
        }
      }
    }

    for (const [nodeId, ticks] of [...this.respawnQueue]) {
      if (ticks <= 1) {
        this.respawnQueue.delete(nodeId);
        const node = this.nodes.get(nodeId);
        if (node) {
          node.remaining = NODE_CAPACITY[node.kind];
          respawned.push(node);
        }
      } else {
        this.respawnQueue.set(nodeId, ticks - 1);
      }
    }

    return { completions, respawned };
  }

  // -- Actions ----------------------------------------------------------------

  startGather(p: Player, nodeId: string): ActionOutcome {
    const node = this.nodes.get(nodeId);
    if (!node) return { ok: false, message: `No such node: ${nodeId}` };
    if (node.remaining <= 0) return { ok: false, message: "That node is depleted; it will respawn soon." };
    if (distance(p.pos, node.pos) > WORLD.INTERACT_RANGE)
      return { ok: false, message: `Too far away (${distance(p.pos, node.pos).toFixed(1)} > ${WORLD.INTERACT_RANGE}). Move closer first.` };
    if (p.gather) return { ok: false, message: "Already gathering." };
    if (p.ap < AP_COST.GATHER) return { ok: false, message: `Not enough AP (${p.ap}/${AP_COST.GATHER}).` };
    p.ap -= AP_COST.GATHER;
    p.target = null;
    p.gather = { nodeId, ticksLeft: GATHER_TICKS };
    return { ok: true, message: `Gathering from ${nodeId} (${GATHER_TICKS}s)...` };
  }

  craft(p: Player, recipeId: string, qty: number): ActionOutcome {
    const recipe = RECIPES.find((r) => r.id === recipeId);
    if (!recipe) return { ok: false, message: `Unknown recipe: ${recipeId}. Known: ${RECIPES.map((r) => r.id).join(", ")}` };
    qty = Math.max(1, Math.min(10, Math.floor(qty)));
    const apCost = AP_COST.CRAFT * qty;
    if (p.ap < apCost) return { ok: false, message: `Not enough AP (${p.ap}/${apCost}).` };
    for (const [item, n] of Object.entries(recipe.inputs)) {
      if ((p.inventory[item as ItemId] ?? 0) < n * qty)
        return { ok: false, message: `Missing materials: need ${n * qty} ${item}, have ${p.inventory[item as ItemId] ?? 0}.` };
    }
    p.ap -= apCost;
    for (const [item, n] of Object.entries(recipe.inputs)) this.give(p, item as ItemId, -n * qty);
    this.give(p, recipe.output, recipe.outputQty * qty);
    this.log("craft", p.id, p.id, recipe.output, recipe.outputQty * qty, `${p.name} crafted ${recipeId} x${qty}`);
    return { ok: true, message: `Crafted ${recipe.outputQty * qty} ${recipe.output}.` };
  }

  postOrder(p: Player, side: "buy" | "sell", item: ItemId, qty: number, price: number): ActionOutcome {
    qty = Math.floor(qty);
    price = Math.floor(price);
    if (qty <= 0 || price <= 0) return { ok: false, message: "qty and price must be positive integers." };
    if (p.ap < AP_COST.MARKET_ORDER) return { ok: false, message: "Not enough AP." };
    if (side === "sell") {
      if ((p.inventory[item] ?? 0) < qty) return { ok: false, message: `You only have ${p.inventory[item] ?? 0} ${item}.` };
      this.give(p, item, -qty); // escrow
    } else {
      const cost = qty * price;
      if (p.shards < cost) return { ok: false, message: `Not enough shards (${p.shards}/${cost}).` };
      p.shards -= cost; // escrow
    }
    p.ap -= AP_COST.MARKET_ORDER;
    const id = `o-${this.nextId++}`;
    this.orders.set(id, { id, ownerId: p.id, ownerName: p.name, side, item, qty, price });
    return { ok: true, message: `Posted ${side} order ${id}: ${qty} ${item} @ ${price} shards each.` };
  }

  fillOrder(p: Player, orderId: string, qty?: number): ActionOutcome {
    const order = this.orders.get(orderId);
    if (!order) return { ok: false, message: `No such order: ${orderId}` };
    if (order.ownerId === p.id) return { ok: false, message: "Cannot fill your own order (cancel instead by reposting)." };
    if (p.ap < AP_COST.MARKET_ORDER) return { ok: false, message: "Not enough AP." };
    const fillQty = Math.min(order.qty, Math.max(1, Math.floor(qty ?? order.qty)));
    const total = fillQty * order.price;
    const owner = this.players.get(order.ownerId);

    if (order.side === "sell") {
      // p buys escrowed items from owner.
      if (p.shards < total) return { ok: false, message: `Not enough shards (${p.shards}/${total}).` };
      p.shards -= total;
      this.give(p, order.item, fillQty);
      if (owner) owner.shards += total;
      this.log("trade", p.id, order.ownerId, "shards", total, `${p.name} bought ${fillQty} ${order.item} from ${order.ownerName}`);
    } else {
      // p sells items into owner's escrowed shards.
      if ((p.inventory[order.item] ?? 0) < fillQty)
        return { ok: false, message: `You only have ${p.inventory[order.item] ?? 0} ${order.item}.` };
      this.give(p, order.item, -fillQty);
      p.shards += total;
      if (owner) this.give(owner, order.item, fillQty);
      this.log("trade", order.ownerId, p.id, "shards", total, `${p.name} sold ${fillQty} ${order.item} to ${order.ownerName}`);
    }
    p.ap -= AP_COST.MARKET_ORDER;
    order.qty -= fillQty;
    if (order.qty <= 0) this.orders.delete(orderId);
    return { ok: true, message: `Filled ${fillQty} ${order.item} @ ${order.price} (total ${total} shards).` };
  }

  private cancelOrder(order: MarketOrder) {
    const owner = this.players.get(order.ownerId);
    if (owner) {
      if (order.side === "sell") this.give(owner, order.item, order.qty);
      else owner.shards += order.qty * order.price;
    }
    this.orders.delete(order.id);
  }

  // -- Helpers ----------------------------------------------------------------

  private give(p: Player, item: ItemId, qty: number) {
    const next = (p.inventory[item] ?? 0) + qty;
    if (next <= 0) delete p.inventory[item];
    else p.inventory[item] = next;
  }

  private log(kind: string, debit: string, credit: string, item: ItemId | "shards", qty: number, memo: string) {
    this.ledger.push({ t: Date.now(), kind, debit, credit, item, qty, memo });
  }

  publicView(p: Player): PlayerPublic {
    return { id: p.id, name: p.name, role: p.role, pos: p.pos, facing: p.facing, busy: !!p.gather };
  }

  privateView(p: Player): PlayerPrivate {
    return {
      ...this.publicView(p),
      ap: Math.floor(p.ap),
      apMax: WORLD.AP_MAX,
      shards: p.shards,
      inventory: { ...p.inventory },
    };
  }

  observationSummary(p: Player): string {
    const nodes = this.nearbyNodes(p);
    const others = this.nearbyPlayers(p);
    const inv = Object.entries(p.inventory)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "empty";
    const nodeStr = nodes
      .slice(0, 6)
      .map((n) => `${n.id} (${n.kind}, ${n.remaining} left, ${distance(p.pos, n.pos).toFixed(0)}u away)`)
      .join("; ") || "none in sight";
    const playerStr = others
      .map((o) => `${o.name} [${o.role}] ${distance(p.pos, o.pos).toFixed(0)}u away`)
      .join("; ") || "nobody nearby";
    const orderStr = [...this.orders.values()]
      .slice(0, 6)
      .map((o) => `${o.id}: ${o.ownerName} ${o.side}s ${o.qty} ${o.item} @ ${o.price}`)
      .join("; ") || "no open orders";
    return (
      `You are ${p.name} at (${p.pos.x.toFixed(0)}, ${p.pos.z.toFixed(0)}) on Emberfall Isle. ` +
      `AP ${Math.floor(p.ap)}/${WORLD.AP_MAX}, ${p.shards} shards. Inventory: ${inv}. ` +
      `Nearby resources: ${nodeStr}. Nearby citizens: ${playerStr}. Market: ${orderStr}. ` +
      `Actions: move, gather, craft (${RECIPES.map((r) => r.id).join("/")}), say, trade_post, trade_fill.`
    );
  }

  nearbyNodes(p: Player, range = 40): ResourceNode[] {
    return [...this.nodes.values()]
      .filter((n) => distance(p.pos, n.pos) <= range)
      .sort((a, b) => distance(p.pos, a.pos) - distance(p.pos, b.pos));
  }

  nearbyPlayers(p: Player, range = 40): PlayerPublic[] {
    return [...this.players.values()]
      .filter((o) => o.id !== p.id && distance(p.pos, o.pos) <= range)
      .map((o) => this.publicView(o));
  }

  recipes(): Recipe[] {
    return RECIPES;
  }
}
