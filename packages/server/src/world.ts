import {
  AP_COST,
  COMBAT,
  ItemId,
  MOBS,
  MobPublic,
  SAFE_ZONE_CENTER,
  MarketOrder,
  PlayerPrivate,
  PlayerPublic,
  PROGRESSION,
  Recipe,
  RECIPES,
  RESOURCE_YIELD,
  ResourceKind,
  ResourceNode,
  Role,
  Structure,
  StructureKind,
  STRUCTURES,
  TERRITORY,
  Vec2,
  WORLD,
  distance,
  terrainHeight,
  xpForLevel,
} from "@agentworld/protocol";
import { MobManager } from "./mobs.js";
import { StructureManager } from "./structures.js";
import { mulberry32 } from "./rng.js";

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
  hp: number;
  kills: number;
  deaths: number;
  /** XP progress within the current level. */
  xp: number;
  level: number;
  /** Game ticks until this player may attack again. */
  attackCooldown: number;
  /** Game ticks since last combat involvement (for HP regen delay). */
  ticksSinceCombat: number;
}

export interface CombatOutcome extends ActionOutcome {
  damage?: number;
  targetHp?: number;
  killed?: boolean;
  loot?: number;
  /** Who was struck — players and mobs alike — for the combat broadcast. */
  target?: { id: string; name: string };
}

export interface BuildOutcome extends ActionOutcome {
  structure?: Structure;
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
  readonly mobs: MobManager;
  readonly structures = new StructureManager();
  /** World-chat announcements (level-ups), drained by the server each tick. */
  private announcements: string[] = [];
  private respawnQueue = new Map<string, number>();
  private nextId = 1;

  constructor(seed = 1337) {
    this.seed = seed;
    this.generateNodes();
    this.mobs = new MobManager(seed);
  }

  private generateNodes() {
    const rng = mulberry32(this.seed);
    const h = (x: number, z: number) => terrainHeight(x, z, this.seed);
    const clearOfVillage = (x: number, z: number) =>
      distance({ x, z }, SAFE_ZONE_CENTER) > COMBAT.SAFE_ZONE_RADIUS + 6;

    const add = (kind: ResourceKind, x: number, z: number) => {
      const id = `${kind}-${this.nextId++}`;
      this.nodes.set(id, { id, kind, pos: { x, z }, remaining: NODE_CAPACITY[kind] });
    };

    // Forest groves: deterministic cluster centres on grassland, trees
    // scattered around each so the island reads as woods, not confetti.
    const groves: Vec2[] = [];
    let guard = 0;
    while (groves.length < 9 && guard++ < 8000) {
      const x = rng() * WORLD.SIZE;
      const z = rng() * WORLD.SIZE;
      const y = h(x, z);
      if (y < 1.2 || y > 6.5 || !clearOfVillage(x, z)) continue;
      if (groves.some((g) => distance(g, { x, z }) < 34)) continue;
      groves.push({ x, z });
    }
    let trees = 0;
    guard = 0;
    while (trees < 120 && guard++ < 20000) {
      const g = groves[Math.floor(rng() * groves.length)];
      const a = rng() * 2 * Math.PI;
      const r = rng() * 16;
      const x = g.x + Math.cos(a) * r;
      const z = g.z + Math.sin(a) * r;
      const y = h(x, z);
      if (y < 0.8 || y > 7.5 || !clearOfVillage(x, z)) continue;
      add("tree", x, z);
      trees++;
    }

    // Rocks: up on the highland and exposed ridges.
    let rocks = 0;
    guard = 0;
    while (rocks < 70 && guard++ < 30000) {
      const x = rng() * WORLD.SIZE;
      const z = rng() * WORLD.SIZE;
      const y = h(x, z);
      if (y < 5.5 || !clearOfVillage(x, z)) continue;
      add("rock", x, z);
      rocks++;
    }

    // Ember crystals: rare, in the low meadows near the coast and basin.
    let crystals = 0;
    guard = 0;
    while (crystals < 24 && guard++ < 30000) {
      const x = rng() * WORLD.SIZE;
      const z = rng() * WORLD.SIZE;
      const y = h(x, z);
      if (y < 0.8 || y > 3.2 || !clearOfVillage(x, z)) continue;
      add("crystal", x, z);
      crystals++;
    }
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

  addPlayer(name: string, role: Role, restore?: Partial<Player>): Player {
    const id = `p-${this.nextId++}`;
    const player: Player = {
      id,
      name,
      role,
      pos: restore?.pos ?? this.spawnPoint(),
      facing: { x: 0, z: 1 },
      target: null,
      walkDebt: 0,
      ap: restore?.ap ?? WORLD.AP_MAX,
      shards: restore?.shards ?? 100,
      inventory: restore?.inventory ?? {},
      gather: null,
      hp: restore?.hp ?? COMBAT.HP_MAX,
      kills: restore?.kills ?? 0,
      deaths: restore?.deaths ?? 0,
      xp: restore?.xp ?? 0,
      level: restore?.level ?? 1,
      attackCooldown: 0,
      ticksSinceCombat: COMBAT.REGEN_DELAY_S,
    };
    if (player.hp <= 0) player.hp = this.hpMaxOf(player);
    // Never restore into the sea (e.g. saved mid-walk near the shore).
    if (terrainHeight(player.pos.x, player.pos.z, this.seed) <= 0.2) player.pos = this.spawnPoint();
    this.players.set(id, player);
    return player;
  }

  inSafeZone(pos: Vec2): boolean {
    return distance(pos, SAFE_ZONE_CENTER) <= COMBAT.SAFE_ZONE_RADIUS;
  }

  // -- Progression --------------------------------------------------------------

  hpMaxOf(p: Player): number {
    return COMBAT.HP_MAX + PROGRESSION.HP_PER_LEVEL * (p.level - 1);
  }

  /** Grant XP; level-ups fully heal and queue a world-chat announcement. */
  addXp(p: Player, xp: number): void {
    if (p.level >= PROGRESSION.LEVEL_CAP) return;
    p.xp += xp;
    while (p.level < PROGRESSION.LEVEL_CAP && p.xp >= xpForLevel(p.level)) {
      p.xp -= xpForLevel(p.level);
      p.level++;
      p.hp = this.hpMaxOf(p);
      this.announcements.push(`${p.name} reached level ${p.level}!`);
    }
    if (p.level >= PROGRESSION.LEVEL_CAP) p.xp = 0;
  }

  drainAnnouncements(): string[] {
    return this.announcements.splice(0, this.announcements.length);
  }

  /** Attack damage roll: base + level bonus + charm + fang blade (they stack). */
  private rollDamage(p: Player): number {
    const charm = (p.inventory.ember_charm ?? 0) > 0 ? COMBAT.CHARM_BONUS : 0;
    const blade = (p.inventory.fang_blade ?? 0) > 0 ? COMBAT.BLADE_BONUS : 0;
    const level = PROGRESSION.DAMAGE_PER_LEVEL * (p.level - 1);
    return (
      COMBAT.DAMAGE_MIN +
      Math.floor(Math.random() * (COMBAT.DAMAGE_MAX - COMBAT.DAMAGE_MIN + 1)) +
      charm + blade + level
    );
  }

  /** Incoming damage after armor mitigation (leather_armor reduces all damage). */
  private mitigate(target: Player, damage: number): number {
    const armored = (target.inventory.leather_armor ?? 0) > 0;
    return Math.max(1, Math.round(damage * (armored ? 1 - COMBAT.ARMOR_REDUCTION : 1)));
  }

  // -- Combat -------------------------------------------------------------------

  attack(p: Player, targetId: string): CombatOutcome {
    if (p.attackCooldown > 0) return { ok: false, message: "Attack on cooldown; wait a moment." };
    if (p.ap < AP_COST.ATTACK) return { ok: false, message: `Not enough AP (${p.ap}/${AP_COST.ATTACK}).` };
    if (targetId.startsWith("m-")) return this.attackMob(p, targetId);

    const target = this.players.get(targetId);
    if (!target) return { ok: false, message: `No such target: ${targetId}` };
    if (target.id === p.id) return { ok: false, message: "You cannot attack yourself." };
    if (distance(p.pos, target.pos) > COMBAT.ATTACK_RANGE)
      return { ok: false, message: `Too far away (${distance(p.pos, target.pos).toFixed(1)} > ${COMBAT.ATTACK_RANGE}). Close the distance first.` };
    if (this.inSafeZone(p.pos) || this.inSafeZone(target.pos))
      return { ok: false, message: "The shrine's peace holds here — no violence in the safe zone." };

    p.ap -= AP_COST.ATTACK;
    p.attackCooldown = COMBAT.COOLDOWN_TICKS;
    p.ticksSinceCombat = 0;
    target.ticksSinceCombat = 0;
    const damage = this.mitigate(target, this.rollDamage(p));
    target.hp -= damage;
    target.gather = null; // taking a hit interrupts gathering
    const who = { id: target.id, name: target.name };

    if (target.hp <= 0) {
      const loot = Math.floor(target.shards * COMBAT.LOOT_SHARD_FRACTION);
      target.shards -= loot;
      p.shards += loot;
      p.kills++;
      target.deaths++;
      target.hp = this.hpMaxOf(target);
      target.pos = this.spawnPoint();
      target.target = null;
      this.addXp(p, PROGRESSION.XP_PVP_KILL);
      this.log("combat", target.id, p.id, "shards", loot, `${p.name} slew ${target.name}`);
      return { ok: true, message: `You slew ${target.name} and looted ${loot} shards (+${PROGRESSION.XP_PVP_KILL} XP)!`, damage, targetHp: 0, killed: true, loot, target: who };
    }
    return { ok: true, message: `Hit ${target.name} for ${damage} (${target.hp}/${this.hpMaxOf(target)} HP left).`, damage, targetHp: target.hp, killed: false, target: who };
  }

  /** PvE branch: target ids prefixed "m-". Reuses the attack AP cost/cooldown. */
  private attackMob(p: Player, mobId: string): CombatOutcome {
    const mob = this.mobs.mobs.get(mobId);
    if (!mob || mob.respawnTicks > 0) return { ok: false, message: `No such creature: ${mobId}` };
    const stats = MOBS[mob.kind];
    if (distance(p.pos, mob.pos) > COMBAT.ATTACK_RANGE)
      return { ok: false, message: `Too far away (${distance(p.pos, mob.pos).toFixed(1)} > ${COMBAT.ATTACK_RANGE}). Close the distance first.` };

    p.ap -= AP_COST.ATTACK;
    p.attackCooldown = COMBAT.COOLDOWN_TICKS;
    p.ticksSinceCombat = 0;
    const damage = this.rollDamage(p);
    mob.hp -= damage;
    const who = { id: mob.id, name: stats.name };

    if (mob.hp <= 0) {
      this.mobs.kill(mob);
      p.shards += stats.shards;
      this.addXp(p, stats.xp);
      const dropped = Math.random() < stats.dropChance;
      if (dropped) this.give(p, stats.drop, 1);
      this.log("combat", mob.id, p.id, "shards", stats.shards, `${p.name} slew a ${stats.name}`);
      const lootStr = dropped ? `, 1 ${stats.drop}` : "";
      return { ok: true, message: `You slew the ${stats.name}! +${stats.xp} XP, +${stats.shards} shards${lootStr}.`, damage, targetHp: 0, killed: true, loot: stats.shards, target: who };
    }
    this.mobs.aggroOn(mob, p.id);
    return { ok: true, message: `Hit the ${stats.name} for ${damage} (${mob.hp}/${stats.hpMax} HP left).`, damage, targetHp: mob.hp, killed: false, target: who };
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

  /** Returns gather completions, respawned nodes, and mob combat for broadcast. */
  gameTick(): {
    completions: { player: Player; message: string }[];
    respawned: ResourceNode[];
    mobHits: { mob: { id: string; name: string }; target: Player; damage: number; killed: boolean; }[];
  } {
    const completions: { player: Player; message: string }[] = [];
    const respawned: ResourceNode[] = [];

    for (const p of this.players.values()) {
      const territoryBonus = this.structures.ownsTerritoryAt(p.id, p.pos) ? TERRITORY.AP_REGEN_BONUS : 0;
      p.ap = Math.min(WORLD.AP_MAX, p.ap + WORLD.AP_REGEN + territoryBonus);
      if (p.attackCooldown > 0) p.attackCooldown--;
      p.ticksSinceCombat++;
      const hpMax = this.hpMaxOf(p);
      if (p.ticksSinceCombat >= COMBAT.REGEN_DELAY_S && p.hp < hpMax)
        p.hp = Math.min(hpMax, p.hp + COMBAT.HP_REGEN);
      // Campfire warmth stacks with natural regen and works even in combat.
      if (p.hp < hpMax && this.structures.campfireNear(p.pos))
        p.hp = Math.min(hpMax, p.hp + TERRITORY.CAMPFIRE_HEAL_HP);
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
            this.addXp(p, PROGRESSION.XP_GATHER);
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

    // Mob AI: wander/aggro/chase, then apply any landed strikes.
    const mobHits: { mob: { id: string; name: string }; target: Player; damage: number; killed: boolean }[] = [];
    for (const strike of this.mobs.tick(this.players, (pos) => this.inSafeZone(pos))) {
      const t = strike.target;
      const damage = this.mitigate(t, strike.damage);
      t.hp -= damage;
      t.gather = null; // taking a hit interrupts gathering
      t.ticksSinceCombat = 0;
      const name = MOBS[strike.mob.kind].name;
      if (t.hp <= 0) {
        // Slain by a beast: gentler than PvP — lose 10% of shards, no looter.
        const lost = Math.floor(t.shards * COMBAT.MOB_DEATH_SHARD_FRACTION);
        t.shards -= lost;
        t.deaths++;
        t.hp = this.hpMaxOf(t);
        t.pos = this.spawnPoint();
        t.target = null;
        strike.mob.targetId = null;
        this.log("combat", t.id, strike.mob.id, "shards", lost, `a ${name} slew ${t.name}`);
        mobHits.push({ mob: { id: strike.mob.id, name }, target: t, damage, killed: true });
      } else {
        mobHits.push({ mob: { id: strike.mob.id, name }, target: t, damage, killed: false });
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

    return { completions, respawned, mobHits };
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
    this.addXp(p, PROGRESSION.XP_CRAFT * qty);
    this.log("craft", p.id, p.id, recipe.output, recipe.outputQty * qty, `${p.name} crafted ${recipeId} x${qty}`);
    return { ok: true, message: `Crafted ${recipe.outputQty * qty} ${recipe.output}.` };
  }

  /** Build a structure at the player's current position. */
  build(p: Player, kind: StructureKind): BuildOutcome {
    const spec = STRUCTURES[kind];
    if (!spec) return { ok: false, message: `Unknown structure: ${String(kind)}. Known: ${Object.keys(STRUCTURES).join(", ")}` };
    if (p.ap < AP_COST.BUILD) return { ok: false, message: `Not enough AP (${p.ap}/${AP_COST.BUILD}).` };
    const refusal = this.structures.canBuild(p.id, kind, p.pos);
    if (refusal) return { ok: false, message: refusal };
    for (const [item, n] of Object.entries(spec.cost)) {
      if ((p.inventory[item as ItemId] ?? 0) < n)
        return { ok: false, message: `Missing materials: need ${n} ${item}, have ${p.inventory[item as ItemId] ?? 0}.` };
    }
    p.ap -= AP_COST.BUILD;
    for (const [item, n] of Object.entries(spec.cost)) this.give(p, item as ItemId, -n);
    const structure = this.structures.place(p.id, p.name, kind, p.pos);
    this.log("build", p.id, "world", "shards", 0, `${p.name} built a ${kind} at (${p.pos.x.toFixed(0)}, ${p.pos.z.toFixed(0)})`);
    const claim = kind === "banner" ? ` Your territory now spans ${TERRITORY.BANNER_RADIUS}u around it.` : "";
    return { ok: true, message: `Built a ${spec.name}.${claim}`, structure };
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
    return {
      id: p.id,
      name: p.name,
      role: p.role,
      pos: p.pos,
      facing: p.facing,
      busy: !!p.gather,
      hp: p.hp,
      hpMax: this.hpMaxOf(p),
      level: p.level,
    };
  }

  privateView(p: Player): PlayerPrivate {
    return {
      ...this.publicView(p),
      ap: Math.floor(p.ap),
      apMax: WORLD.AP_MAX,
      shards: p.shards,
      inventory: { ...p.inventory },
      kills: p.kills,
      deaths: p.deaths,
      xp: p.xp,
      xpNext: p.level >= PROGRESSION.LEVEL_CAP ? 0 : xpForLevel(p.level),
      inSafeZone: this.inSafeZone(p.pos),
    };
  }

  observationSummary(p: Player): string {
    const nodes = this.nearbyNodes(p);
    const others = this.nearbyPlayers(p);
    const mobs = this.nearbyMobs(p);
    const nearStructures = this.structures.nearby(p.pos);
    const inv = Object.entries(p.inventory)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "empty";
    const nodeStr = nodes
      .slice(0, 6)
      .map((n) => `${n.id} (${n.kind}, ${n.remaining} left, ${distance(p.pos, n.pos).toFixed(0)}u away)`)
      .join("; ") || "none in sight";
    const playerStr = others
      .map((o) => `${o.name} (${o.id}) [${o.role}, lv${o.level}] ${distance(p.pos, o.pos).toFixed(0)}u away, ${o.hp}/${o.hpMax} HP`)
      .join("; ") || "nobody nearby";
    const mobStr = mobs
      .slice(0, 6)
      .map((m) => `${MOBS[m.kind].name} (${m.id}, lv${m.level}${MOBS[m.kind].aggressive ? ", aggressive" : ""}) ${distance(p.pos, m.pos).toFixed(0)}u away, ${m.hp}/${m.hpMax} HP`)
      .join("; ") || "none in sight";
    const structureStr = nearStructures
      .slice(0, 6)
      .map((s) => `${s.ownerName}'s ${s.kind} (${distance(p.pos, s.pos).toFixed(0)}u away)`)
      .join("; ") || "none nearby";
    const orderStr = [...this.orders.values()]
      .slice(0, 6)
      .map((o) => `${o.id}: ${o.ownerName} ${o.side}s ${o.qty} ${o.item} @ ${o.price}`)
      .join("; ") || "no open orders";
    const claim = this.structures.territoryAt(p.pos);
    const territory = claim
      ? claim.ownerId === p.id
        ? " You are standing in your own territory (+2 AP regen)."
        : ` You are standing in ${claim.ownerName}'s territory.`
      : "";
    const safety = this.inSafeZone(p.pos)
      ? "You are inside the shrine's safe zone (no PvP)."
      : "You are in the open wilds — PvP is possible here.";
    return (
      `You are ${p.name} (level ${p.level}, ${p.xp}/${p.level >= PROGRESSION.LEVEL_CAP ? "max" : xpForLevel(p.level)} XP) at (${p.pos.x.toFixed(0)}, ${p.pos.z.toFixed(0)}) on Emberfall Isle. ` +
      `HP ${p.hp}/${this.hpMaxOf(p)}, AP ${Math.floor(p.ap)}/${WORLD.AP_MAX}, ${p.shards} shards (K/D ${p.kills}/${p.deaths}). ` +
      `Inventory: ${inv}. ${safety}${territory} ` +
      `Nearby resources: ${nodeStr}. Nearby creatures: ${mobStr}. Nearby citizens: ${playerStr}. ` +
      `Nearby structures: ${structureStr}. Market: ${orderStr}. ` +
      `Actions: move, gather, craft (${RECIPES.map((r) => r.id).join("/")}), say, trade_post, trade_fill, ` +
      `attack (players or creatures by id, range ${COMBAT.ATTACK_RANGE}, no PvP in safe zone; slaying creatures grants XP/shards/loot), ` +
      `build (${Object.keys(STRUCTURES).join("/")} — campfires heal, banners claim territory).`
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

  nearbyMobs(p: Player, range = 40): MobPublic[] {
    return this.mobs
      .living()
      .filter((m) => distance(p.pos, m.pos) <= range)
      .sort((a, b) => distance(p.pos, a.pos) - distance(p.pos, b.pos));
  }

  recipes(): Recipe[] {
    return RECIPES;
  }
}
