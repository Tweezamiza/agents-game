import {
  AP_COST,
  COMBAT,
  Claim,
  EQUIPMENT_STATS,
  EquipSlot,
  Equipment,
  ItemId,
  MobKind,
  MobPublic,
  PVE,
  PROGRESSION,
  PlayerPrivate,
  PlayerPublic,
  QUESTS,
  Quest,
  QuestProgress,
  Recipe,
  RECIPES,
  RESOURCE_YIELD,
  ResourceKind,
  ResourceNode,
  Role,
  SAFE_ZONE_CENTER,
  ServerMsg,
  Structure,
  STRUCTURE_COSTS,
  StructureKind,
  TERRITORY,
  Vec2,
  WORLD,
  distance,
  maxHpForLevel,
  terrainHeight,
  xpForLevel,
  MarketOrder,
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
  hp: number;
  kills: number;
  deaths: number;
  /** Game ticks until this player may attack again. */
  attackCooldown: number;
  /** Game ticks since last combat involvement (for HP regen delay). */
  ticksSinceCombat: number;
  // -- Sprint 3: progression / equipment / quests -----------------------------
  xp: number;
  level: number;
  equipment: Equipment;
  quests: QuestProgress[];
}

export interface Mob {
  id: string;
  kind: MobKind;
  level: number;
  /** Spawn camp this mob roams around and leashes back to. */
  camp: Vec2;
  pos: Vec2;
  hp: number;
  hpMax: number;
  targetPlayerId: string | null;
  roamTarget: Vec2 | null;
  attackCooldownMs: number;
}

interface SpawnCamp {
  pos: Vec2;
  kind: MobKind;
}

export interface CombatOutcome extends ActionOutcome {
  damage?: number;
  targetHp?: number;
  killed?: boolean;
  loot?: number;
  lootItems?: Partial<Record<ItemId, number>>;
  xp?: number;
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

/** A server message queued by the simulation, addressed to one player or all. */
export interface Outbound {
  to: "all" | string;
  msg: ServerMsg;
}

const NODE_RESPAWN_TICKS = 60;
const GATHER_TICKS = 2;
const NODE_CAPACITY: Record<ResourceKind, number> = { tree: 5, rock: 5, crystal: 3 };

const MOB_LABEL: Record<MobKind, string> = {
  skeleton_minion: "Skeleton Minion",
  skeleton_warrior: "Skeleton Warrior",
};

export function mobName(m: Mob): string {
  return `${MOB_LABEL[m.kind]} Lv${m.level}`;
}

export class World {
  readonly seed: number;
  nodes = new Map<string, ResourceNode>();
  players = new Map<string, Player>();
  orders = new Map<string, MarketOrder>();
  mobs = new Map<string, Mob>();
  claims = new Map<string, Claim>();
  structures = new Map<string, Structure>();
  ledger: LedgerEntry[] = [];
  /** Structure ids destroyed since the last persistence sweep. */
  destroyedStructureIds: string[] = [];
  private respawnQueue = new Map<string, number>();
  private mobRespawnQueue: { camp: SpawnCamp; ticks: number }[] = [];
  private camps: SpawnCamp[] = [];
  /** Bad-luck protection for warrior equipment drops. */
  private warriorKillsSinceEquipDrop = 0;
  private outbox: Outbound[] = [];
  private nextId = 1;

  constructor(seed = 1337) {
    this.seed = seed;
    this.generateNodes();
    this.generateMobCamps();
  }

  /** Drain simulation-queued messages for the network layer to deliver. */
  drainOutbox(): Outbound[] {
    if (this.outbox.length === 0) return [];
    const out = this.outbox;
    this.outbox = [];
    return out;
  }

  private emit(to: "all" | string, msg: ServerMsg) {
    this.outbox.push({ to, msg });
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

  // -- PvE: skeleton camps ------------------------------------------------------

  private generateMobCamps() {
    const rng = mulberry32(this.seed ^ 0x5ce1e70);
    const h = (x: number, z: number) => terrainHeight(x, z, this.seed);
    const awayFromVillage = (x: number, z: number) =>
      distance({ x, z }, SAFE_ZONE_CENTER) >
      COMBAT.SAFE_ZONE_RADIUS + PVE.LEASH_RANGE + 10;

    // Highland ruins (northeast massif, y > 5.5): warrior camps.
    let guard = 0;
    while (this.camps.filter((c) => c.kind === "skeleton_warrior").length < 4 && guard++ < 30000) {
      const x = rng() * WORLD.SIZE;
      const z = rng() * WORLD.SIZE;
      if (h(x, z) < 5.5 || !awayFromVillage(x, z)) continue;
      if (this.camps.some((c) => distance(c.pos, { x, z }) < 22)) continue;
      this.camps.push({ pos: { x, z }, kind: "skeleton_warrior" });
    }
    // Forest edges (grassland band): minion camps.
    guard = 0;
    while (this.camps.length < 8 && guard++ < 30000) {
      const x = rng() * WORLD.SIZE;
      const z = rng() * WORLD.SIZE;
      const y = h(x, z);
      if (y < 1.2 || y > 5.0 || !awayFromVillage(x, z)) continue;
      if (this.camps.some((c) => distance(c.pos, { x, z }) < 22)) continue;
      this.camps.push({ pos: { x, z }, kind: "skeleton_minion" });
    }
    // 8 camps x 3 mobs = PVE.MAX_MOBS (24) alive at once.
    for (const camp of this.camps) {
      for (let i = 0; i < PVE.MAX_MOBS / this.camps.length; i++) this.spawnMob(camp, rng);
    }
  }

  private spawnMob(camp: SpawnCamp, rng: () => number = Math.random): Mob {
    const level =
      camp.kind === "skeleton_warrior" ? 3 + Math.floor(rng() * 3) : 1 + Math.floor(rng() * 2);
    const hpMax = PVE.HP_BASE + PVE.HP_PER_LEVEL * level;
    const a = rng() * 2 * Math.PI;
    const r = rng() * PVE.ROAM_RADIUS;
    let pos = { x: camp.pos.x + Math.cos(a) * r, z: camp.pos.z + Math.sin(a) * r };
    if (terrainHeight(pos.x, pos.z, this.seed) <= 0.2) pos = { ...camp.pos };
    const mob: Mob = {
      id: `m-${this.nextId++}`,
      kind: camp.kind,
      level,
      camp: { ...camp.pos },
      pos,
      hp: hpMax,
      hpMax,
      targetPlayerId: null,
      roamTarget: null,
      attackCooldownMs: 0,
    };
    this.mobs.set(mob.id, mob);
    return mob;
  }

  publicMobs(): MobPublic[] {
    return [...this.mobs.values()].map((m) => ({
      id: m.id,
      kind: m.kind,
      level: m.level,
      pos: m.pos,
      hp: m.hp,
      hpMax: m.hpMax,
      targetId: m.targetPlayerId ?? undefined,
    }));
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
      attackCooldown: 0,
      ticksSinceCombat: COMBAT.REGEN_DELAY_S,
      xp: restore?.xp ?? 0,
      level: Math.min(PROGRESSION.MAX_LEVEL, Math.max(1, restore?.level ?? 1)),
      equipment: restore?.equipment ?? {},
      quests: [],
    };
    if (player.hp <= 0) player.hp = this.maxHp(player);
    player.hp = Math.min(player.hp, this.maxHp(player));
    // Never restore into the sea (e.g. saved mid-walk near the shore).
    if (terrainHeight(player.pos.x, player.pos.z, this.seed) <= 0.2) player.pos = this.spawnPoint();
    this.players.set(id, player);
    // Re-attach persisted territory owned by this character (matched by name).
    for (const c of this.claims.values()) if (c.ownerName === name) c.ownerId = id;
    for (const s of this.structures.values()) if (s.ownerName === name) s.ownerId = id;
    return player;
  }

  inSafeZone(pos: Vec2): boolean {
    return distance(pos, SAFE_ZONE_CENTER) <= COMBAT.SAFE_ZONE_RADIUS;
  }

  maxHp(p: Player): number {
    return maxHpForLevel(p.level);
  }

  // -- Progression --------------------------------------------------------------

  grantXp(p: Player, amount: number) {
    if (p.level >= PROGRESSION.MAX_LEVEL) return;
    p.xp += amount;
    while (p.level < PROGRESSION.MAX_LEVEL && p.xp >= xpForLevel(p.level)) {
      p.xp -= xpForLevel(p.level);
      p.level++;
      p.hp = Math.min(this.maxHp(p), p.hp + PROGRESSION.HP_PER_LEVEL);
      this.emit("all", {
        type: "event",
        event: "level_up",
        message: `${p.name} reached level ${p.level}!`,
        playerId: p.id,
        data: { level: p.level, hpMax: this.maxHp(p) },
      });
    }
    if (p.level >= PROGRESSION.MAX_LEVEL) p.xp = 0;
  }

  private weaponBonus(p: Player): number {
    const w = p.equipment.weapon;
    return (w && EQUIPMENT_STATS[w]?.damage) || 0;
  }

  private shieldDefense(p: Player): number {
    const s = p.equipment.offhand;
    return (s && EQUIPMENT_STATS[s]?.defense) || 0;
  }

  /** Outgoing damage roll for a player: base + charm + weapon + level. */
  private playerDamage(p: Player): number {
    const charm = (p.inventory.ember_charm ?? 0) > 0 ? COMBAT.CHARM_BONUS : 0;
    const roll =
      COMBAT.DAMAGE_MIN + Math.floor(Math.random() * (COMBAT.DAMAGE_MAX - COMBAT.DAMAGE_MIN + 1));
    return roll + charm + this.weaponBonus(p) + (p.level - 1) * PROGRESSION.DAMAGE_PER_LEVEL;
  }

  /** Incoming damage after shield mitigation; at least 1 always lands. */
  private mitigate(target: Player, dmg: number): number {
    return Math.max(1, dmg - this.shieldDefense(target));
  }

  // -- Equipment ------------------------------------------------------------------

  equip(p: Player, item: ItemId): ActionOutcome {
    const stats = EQUIPMENT_STATS[item];
    if (!stats)
      return {
        ok: false,
        message: `${item} is not equippable. Equippable: ${Object.keys(EQUIPMENT_STATS).join(", ")}.`,
      };
    if ((p.inventory[item] ?? 0) < 1) return { ok: false, message: `You do not have a ${item}.` };
    this.give(p, item, -1);
    const prev = p.equipment[stats.slot];
    if (prev) this.give(p, prev, 1);
    p.equipment[stats.slot] = item;
    const effect = stats.damage ? `+${stats.damage} damage` : `-${stats.defense} incoming damage`;
    return {
      ok: true,
      message: `Equipped ${item} (${stats.slot}, ${effect})${prev ? `, returned ${prev} to inventory` : ""}.`,
    };
  }

  unequip(p: Player, slot: EquipSlot): ActionOutcome {
    const prev = p.equipment[slot];
    if (!prev) return { ok: false, message: `Nothing equipped in ${slot}.` };
    delete p.equipment[slot];
    this.give(p, prev, 1);
    return { ok: true, message: `Unequipped ${prev} from ${slot}.` };
  }

  // -- Combat ---------------------------------------------------------------------

  attack(p: Player, targetId: string): CombatOutcome {
    if (this.mobs.has(targetId)) return this.attackMob(p, this.mobs.get(targetId)!);
    if (this.structures.has(targetId)) return this.attackStructure(p, this.structures.get(targetId)!);
    const target = this.players.get(targetId);
    if (!target)
      return { ok: false, message: `No such target: ${targetId} (player, mob, or structure id).` };
    if (target.id === p.id) return { ok: false, message: "You cannot attack yourself." };
    if (p.attackCooldown > 0) return { ok: false, message: "Attack on cooldown; wait a moment." };
    if (p.ap < AP_COST.ATTACK) return { ok: false, message: `Not enough AP (${p.ap}/${AP_COST.ATTACK}).` };
    if (distance(p.pos, target.pos) > COMBAT.ATTACK_RANGE)
      return { ok: false, message: `Too far away (${distance(p.pos, target.pos).toFixed(1)} > ${COMBAT.ATTACK_RANGE}). Close the distance first.` };
    if (this.inSafeZone(p.pos) || this.inSafeZone(target.pos))
      return { ok: false, message: "The shrine's peace holds here — no violence in the safe zone." };

    p.ap -= AP_COST.ATTACK;
    p.attackCooldown = COMBAT.COOLDOWN_TICKS;
    p.ticksSinceCombat = 0;
    target.ticksSinceCombat = 0;
    const damage = this.mitigate(target, this.playerDamage(p));
    target.hp -= damage;
    target.gather = null; // taking a hit interrupts gathering

    let outcome: CombatOutcome;
    if (target.hp <= 0) {
      const loot = Math.floor(target.shards * COMBAT.LOOT_SHARD_FRACTION);
      target.shards -= loot;
      p.shards += loot;
      p.kills++;
      target.deaths++;
      target.hp = this.maxHp(target);
      target.pos = this.spawnPoint();
      target.target = null;
      this.log("combat", target.id, p.id, "shards", loot, `${p.name} slew ${target.name}`);
      this.emit(target.id, {
        type: "action_result",
        action: "attack",
        ok: false,
        message: `You were slain by ${p.name} and lost ${loot} shards. You wake at the shrine.`,
        self: this.privateView(target),
      });
      outcome = { ok: true, message: `You slew ${target.name} and looted ${loot} shards!`, damage, targetHp: 0, killed: true, loot };
    } else {
      this.emit(target.id, {
        type: "action_result",
        action: "attack",
        ok: false,
        message: `${p.name} hit you for ${damage} (${target.hp}/${this.maxHp(target)} HP). Fight back or flee!`,
        self: this.privateView(target),
      });
      outcome = { ok: true, message: `Hit ${target.name} for ${damage} (${target.hp}/${this.maxHp(target)} HP left).`, damage, targetHp: target.hp, killed: false };
    }
    this.emit("all", {
      type: "combat",
      attacker: { id: p.id, name: p.name },
      target: { id: target.id, name: target.name },
      damage,
      targetHp: outcome.targetHp ?? target.hp,
      killed: outcome.killed ?? false,
      loot: outcome.loot,
      attackerKind: "player",
      targetKind: "player",
    });
    return outcome;
  }

  private attackMob(p: Player, mob: Mob): CombatOutcome {
    if (p.attackCooldown > 0) return { ok: false, message: "Attack on cooldown; wait a moment." };
    if (p.ap < AP_COST.ATTACK) return { ok: false, message: `Not enough AP (${p.ap}/${AP_COST.ATTACK}).` };
    if (distance(p.pos, mob.pos) > COMBAT.ATTACK_RANGE)
      return { ok: false, message: `Too far away (${distance(p.pos, mob.pos).toFixed(1)} > ${COMBAT.ATTACK_RANGE}). Close the distance first.` };

    p.ap -= AP_COST.ATTACK;
    p.attackCooldown = COMBAT.COOLDOWN_TICKS;
    p.ticksSinceCombat = 0;
    const damage = this.playerDamage(p);
    mob.hp -= damage;
    // Retaliate: the mob turns on its attacker (within leash rules).
    if (!mob.targetPlayerId && distance(mob.camp, p.pos) <= PVE.LEASH_RANGE && !this.inSafeZone(p.pos))
      mob.targetPlayerId = p.id;

    let outcome: CombatOutcome;
    if (mob.hp <= 0) {
      const xp = PVE.XP_PER_MOB_LEVEL * mob.level;
      const lootItems = this.rollMobLoot(mob);
      for (const [item, qty] of Object.entries(lootItems))
        this.give(p, item as ItemId, qty);
      this.grantXp(p, xp);
      this.questProgress(p, "slay", mob.kind, 1);
      this.log("pve", mob.id, p.id, "bone", lootItems.bone ?? 0, `${p.name} slew ${mobName(mob)}`);
      this.mobs.delete(mob.id);
      this.mobRespawnQueue.push({ camp: { pos: mob.camp, kind: mob.kind }, ticks: PVE.RESPAWN_S });
      const lootStr = Object.entries(lootItems).map(([k, v]) => `${v} ${k}`).join(", ");
      outcome = {
        ok: true,
        message: `You slew ${mobName(mob)}! +${xp} XP, loot: ${lootStr}.`,
        damage,
        targetHp: 0,
        killed: true,
        lootItems,
        xp,
      };
    } else {
      outcome = {
        ok: true,
        message: `Hit ${mobName(mob)} for ${damage} (${mob.hp}/${mob.hpMax} HP left).`,
        damage,
        targetHp: mob.hp,
        killed: false,
      };
    }
    this.emit("all", {
      type: "combat",
      attacker: { id: p.id, name: p.name },
      target: { id: mob.id, name: mobName(mob) },
      damage,
      targetHp: Math.max(0, mob.hp),
      killed: outcome.killed ?? false,
      attackerKind: "player",
      targetKind: "mob",
      lootItems: outcome.lootItems,
      xp: outcome.xp,
    });
    return outcome;
  }

  private rollMobLoot(mob: Mob): Partial<Record<ItemId, number>> {
    const loot: Partial<Record<ItemId, number>> = {};
    loot.bone = 1 + Math.floor(Math.random() * PVE.BONE_DROP_MAX);
    if (Math.random() < PVE.EMBER_DROP_CHANCE) loot.ember_crystal = 1;
    if (mob.kind === "skeleton_warrior") {
      this.warriorKillsSinceEquipDrop++;
      if (
        Math.random() < PVE.EQUIP_DROP_CHANCE ||
        this.warriorKillsSinceEquipDrop > PVE.EQUIP_PITY_KILLS
      ) {
        this.warriorKillsSinceEquipDrop = 0;
        const item: ItemId = Math.random() < 0.5 ? "rusty_sword" : "wooden_shield";
        loot[item] = (loot[item] ?? 0) + 1;
      }
    }
    return loot;
  }

  private attackStructure(p: Player, s: Structure): CombatOutcome {
    if (p.attackCooldown > 0) return { ok: false, message: "Attack on cooldown; wait a moment." };
    if (p.ap < AP_COST.ATTACK) return { ok: false, message: `Not enough AP (${p.ap}/${AP_COST.ATTACK}).` };
    if (distance(p.pos, s.pos) > COMBAT.ATTACK_RANGE)
      return { ok: false, message: `Too far away (${distance(p.pos, s.pos).toFixed(1)} > ${COMBAT.ATTACK_RANGE}).` };
    if (this.inSafeZone(p.pos) || this.inSafeZone(s.pos))
      return { ok: false, message: "No siege inside the shrine's safe zone." };

    p.ap -= AP_COST.ATTACK;
    p.attackCooldown = COMBAT.COOLDOWN_TICKS;
    p.ticksSinceCombat = 0;
    const damage = this.playerDamage(p);
    s.hp -= damage;

    let outcome: CombatOutcome;
    if (s.hp <= 0) {
      // Salvage: half the build materials drop to the destroyer.
      const lootItems: Partial<Record<ItemId, number>> = {};
      for (const [item, qty] of Object.entries(STRUCTURE_COSTS[s.kind])) {
        const n = Math.floor(qty * TERRITORY.SALVAGE_FRACTION);
        if (n > 0) {
          lootItems[item as ItemId] = n;
          this.give(p, item as ItemId, n);
        }
      }
      this.structures.delete(s.id);
      this.destroyedStructureIds.push(s.id);
      this.log("siege", s.ownerName, p.id, "shards", 0, `${p.name} destroyed ${s.ownerName}'s ${s.kind} (${s.id})`);
      this.emit("all", {
        type: "event",
        event: "structure_destroyed",
        message: `${p.name} destroyed ${s.ownerName}'s ${s.kind}!`,
        playerId: p.id,
        data: { structureId: s.id, kind: s.kind, ownerName: s.ownerName },
      });
      const lootStr = Object.entries(lootItems).map(([k, v]) => `${v} ${k}`).join(", ") || "nothing";
      outcome = {
        ok: true,
        message: `You destroyed ${s.ownerName}'s ${s.kind} and salvaged ${lootStr}!`,
        damage,
        targetHp: 0,
        killed: true,
        lootItems,
      };
    } else {
      outcome = {
        ok: true,
        message: `Hit ${s.ownerName}'s ${s.kind} for ${damage} (${s.hp}/${s.hpMax} HP left).`,
        damage,
        targetHp: s.hp,
        killed: false,
      };
    }
    this.emit("all", {
      type: "combat",
      attacker: { id: p.id, name: p.name },
      target: { id: s.id, name: `${s.ownerName}'s ${s.kind}` },
      damage,
      targetHp: Math.max(0, s.hp),
      killed: outcome.killed ?? false,
      attackerKind: "player",
      targetKind: "structure",
      lootItems: outcome.lootItems,
    });
    return outcome;
  }

  removePlayer(id: string) {
    // Cancel open orders and refund escrow before the player vanishes.
    for (const order of [...this.orders.values()]) {
      if (order.ownerId === id) this.cancelOrder(order);
    }
    // Territory persists; detach the session id (re-attached by name on join).
    for (const c of this.claims.values()) if (c.ownerId === id) c.ownerId = "";
    for (const s of this.structures.values()) if (s.ownerId === id) s.ownerId = "";
    for (const m of this.mobs.values()) if (m.targetPlayerId === id) m.targetPlayerId = null;
    this.players.delete(id);
  }

  // -- Movement (100 ms sub-tick) --------------------------------------------

  /** Returns ids of players that moved this sub-tick. Also steps mob AI. */
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
    this.mobMoveTick(dtMs);
    return moved;
  }

  private mobStepToward(m: Mob, target: Vec2, dtMs: number) {
    const d = distance(m.pos, target);
    if (d < 0.05) return;
    const walk = Math.min((PVE.MOB_SPEED * dtMs) / 1000, d);
    const nx = m.pos.x + ((target.x - m.pos.x) / d) * walk;
    const nz = m.pos.z + ((target.z - m.pos.z) / d) * walk;
    // Mobs never wade into the sea and never enter the shrine safe zone.
    if (terrainHeight(nx, nz, this.seed) <= 0.2) return;
    if (this.inSafeZone({ x: nx, z: nz })) return;
    m.pos = { x: nx, z: nz };
  }

  private mobMoveTick(dtMs: number) {
    for (const m of this.mobs.values()) {
      if (m.attackCooldownMs > 0) m.attackCooldownMs -= dtMs;
      const target = m.targetPlayerId ? this.players.get(m.targetPlayerId) : undefined;
      if (m.targetPlayerId && !target) m.targetPlayerId = null;

      if (target) {
        const leashed =
          distance(m.camp, m.pos) > PVE.LEASH_RANGE ||
          distance(m.camp, target.pos) > PVE.LEASH_RANGE ||
          this.inSafeZone(target.pos);
        if (leashed) {
          m.targetPlayerId = null;
          m.roamTarget = { ...m.camp };
          continue;
        }
        const d = distance(m.pos, target.pos);
        if (d <= PVE.ATTACK_RANGE) {
          if (m.attackCooldownMs <= 0) this.mobAttack(m, target);
        } else {
          this.mobStepToward(m, target.pos, dtMs);
        }
      } else if (m.roamTarget) {
        if (distance(m.pos, m.roamTarget) < 0.3) m.roamTarget = null;
        else this.mobStepToward(m, m.roamTarget, dtMs);
      }
    }
  }

  private mobAttack(m: Mob, target: Player) {
    m.attackCooldownMs = PVE.ATTACK_COOLDOWN_MS;
    const raw = PVE.DAMAGE_BASE + m.level + Math.floor(Math.random() * (PVE.DAMAGE_RAND + 1));
    const damage = this.mitigate(target, raw);
    target.hp -= damage;
    target.ticksSinceCombat = 0;
    target.gather = null;
    let killed = false;
    if (target.hp <= 0) {
      killed = true;
      target.deaths++;
      target.hp = this.maxHp(target);
      target.pos = this.spawnPoint();
      target.target = null;
      m.targetPlayerId = null;
      m.roamTarget = { ...m.camp };
      this.emit(target.id, {
        type: "action_result",
        action: "attack",
        ok: false,
        message: `You were slain by a ${mobName(m)}. You wake at the shrine.`,
        self: this.privateView(target),
      });
      this.log("pve", target.id, m.id, "shards", 0, `${mobName(m)} slew ${target.name}`);
    } else {
      this.emit(target.id, {
        type: "action_result",
        action: "attack",
        ok: false,
        message: `${mobName(m)} hit you for ${damage} (${target.hp}/${this.maxHp(target)} HP). Fight back or flee!`,
        self: this.privateView(target),
      });
    }
    this.emit("all", {
      type: "combat",
      attacker: { id: m.id, name: mobName(m) },
      target: { id: target.id, name: target.name },
      damage,
      targetHp: killed ? 0 : target.hp,
      killed,
      attackerKind: "mob",
      targetKind: "player",
    });
  }

  // -- Game tick (1 s) --------------------------------------------------------

  /** Returns gather completions and respawned nodes for event broadcast. */
  gameTick(): { completions: { player: Player; message: string }[]; respawned: ResourceNode[] } {
    const completions: { player: Player; message: string }[] = [];
    const respawned: ResourceNode[] = [];

    for (const p of this.players.values()) {
      p.ap = Math.min(WORLD.AP_MAX, p.ap + WORLD.AP_REGEN);
      if (p.attackCooldown > 0) p.attackCooldown--;
      p.ticksSinceCombat++;
      if (p.ticksSinceCombat >= COMBAT.REGEN_DELAY_S && p.hp < this.maxHp(p))
        p.hp = Math.min(this.maxHp(p), p.hp + COMBAT.HP_REGEN);
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
            this.grantXp(p, PROGRESSION.XP_GATHER);
            this.questProgress(p, "gather", item, qty);
            this.log("gather", "world", p.id, item, qty, `${p.name} gathered from ${node.id}`);
            if (node.remaining <= 0) this.respawnQueue.set(node.id, NODE_RESPAWN_TICKS);
            completions.push({
              player: p,
              message: `Gathered ${qty} ${item}${bonus ? " (stone axe bonus)" : ""} (+${PROGRESSION.XP_GATHER} XP). Node has ${node.remaining} left.`,
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

    this.mobGameTick();
    return { completions, respawned };
  }

  private mobGameTick() {
    // Aggro scan + idle roaming.
    for (const m of this.mobs.values()) {
      if (m.targetPlayerId) continue;
      let best: Player | null = null;
      let bestD: number = PVE.AGGRO_RANGE;
      for (const p of this.players.values()) {
        if (this.inSafeZone(p.pos)) continue;
        if (distance(m.camp, p.pos) > PVE.LEASH_RANGE) continue;
        const d = distance(m.pos, p.pos);
        if (d <= bestD) {
          best = p;
          bestD = d;
        }
      }
      if (best) {
        m.targetPlayerId = best.id;
        m.roamTarget = null;
      } else if (!m.roamTarget && Math.random() < 0.2) {
        const a = Math.random() * 2 * Math.PI;
        const r = Math.random() * PVE.ROAM_RADIUS;
        const t = { x: m.camp.x + Math.cos(a) * r, z: m.camp.z + Math.sin(a) * r };
        if (terrainHeight(t.x, t.z, this.seed) > 0.2 && !this.inSafeZone(t)) m.roamTarget = t;
      }
    }
    // Respawns: 60 s after death, back at the camp.
    const due: SpawnCamp[] = [];
    this.mobRespawnQueue = this.mobRespawnQueue.filter((e) => {
      e.ticks--;
      if (e.ticks <= 0) {
        due.push(e.camp);
        return false;
      }
      return true;
    });
    for (const camp of due) {
      if (this.mobs.size >= PVE.MAX_MOBS) continue;
      const mob = this.spawnMob(camp);
      this.emit("all", {
        type: "event",
        event: "mob_spawn",
        message: `A ${mobName(mob)} rises near its camp.`,
        data: { mobId: mob.id, kind: mob.kind, level: mob.level, pos: mob.pos },
      });
    }
  }

  // -- Quests -------------------------------------------------------------------

  /** The rotating village quest board: deterministic from seed + epoch. */
  questBoard(now = Date.now()): { quests: Quest[]; rotatesAt: number } {
    const epoch = Math.floor(now / QUESTS.ROTATION_MS);
    const rotatesAt = (epoch + 1) * QUESTS.ROTATION_MS;
    const rng = mulberry32((this.seed ^ Math.imul(epoch, 2654435761)) >>> 0);
    type Template = () => Omit<Quest, "id" | "expiresAt">;
    const templates: Template[] = [
      () => {
        const count = 3 + Math.floor(rng() * 4); // 3-6
        return {
          title: `Slay ${count} skeletons`,
          description: `The village elder wants ${count} skeletons cleared from the wilds (any kind).`,
          goal: { type: "slay", count },
          rewardShards: 12 * count,
          rewardXp: 20 * count,
        };
      },
      () => {
        const count = 6 + Math.floor(rng() * 7); // 6-12
        return {
          title: `Gather ${count} wood`,
          description: `The carpenter needs ${count} wood from the groves.`,
          goal: { type: "gather", item: "wood", count },
          rewardShards: 3 * count,
          rewardXp: 5 * count,
        };
      },
      () => {
        const count = 6 + Math.floor(rng() * 7); // 6-12
        return {
          title: `Gather ${count} stone`,
          description: `The mason needs ${count} stone from the highland.`,
          goal: { type: "gather", item: "stone", count },
          rewardShards: 3 * count,
          rewardXp: 5 * count,
        };
      },
      () => {
        const count = 2 + Math.floor(rng() * 3); // 2-4
        return {
          title: `Gather ${count} ember crystals`,
          description: `The shrine keeper wants ${count} ember crystals from the meadows.`,
          goal: { type: "gather", item: "ember_crystal", count },
          rewardShards: 12 * count,
          rewardXp: 18 * count,
        };
      },
      () => {
        const count = 2 + Math.floor(rng() * 2); // 2-3
        return {
          title: `Craft ${count} planks`,
          description: `The carpenter wants ${count} planks sawn.`,
          goal: { type: "craft", recipeId: "plank", count },
          rewardShards: 8 * count,
          rewardXp: 10 * count,
        };
      },
      () => {
        const count = 2 + Math.floor(rng() * 2); // 2-3
        return {
          title: `Craft ${count} bricks`,
          description: `The mason wants ${count} bricks fired.`,
          goal: { type: "craft", recipeId: "brick", count },
          rewardShards: 8 * count,
          rewardXp: 10 * count,
        };
      },
      () => {
        const count = 1 + Math.floor(rng() * 2); // 1-2
        return {
          title: `Craft ${count} stone axe${count > 1 ? "s" : ""}`,
          description: `The lumber crew wants ${count} stone axe${count > 1 ? "s" : ""}.`,
          goal: { type: "craft", recipeId: "stone_axe", count },
          rewardShards: 15 * count,
          rewardXp: 20 * count,
        };
      },
    ];
    // Pick BOARD_SIZE distinct templates.
    const indices: number[] = [];
    while (indices.length < QUESTS.BOARD_SIZE) {
      const i = Math.floor(rng() * templates.length);
      if (!indices.includes(i)) indices.push(i);
    }
    const quests = indices.map((tplIdx, slot) => ({
      id: `q${epoch}-${slot}`,
      expiresAt: rotatesAt,
      ...templates[tplIdx](),
    }));
    return { quests, rotatesAt };
  }

  acceptQuest(p: Player, questId: string): ActionOutcome {
    const { quests } = this.questBoard();
    const quest = quests.find((q) => q.id === questId);
    if (!quest)
      return { ok: false, message: `No such quest on the board: ${questId}. Current: ${quests.map((q) => q.id).join(", ")}.` };
    if (p.quests.some((aq) => aq.quest.id === questId))
      return { ok: false, message: "You already accepted that quest." };
    if (p.quests.length >= QUESTS.MAX_ACTIVE_PER_PLAYER)
      return { ok: false, message: `You already have ${QUESTS.MAX_ACTIVE_PER_PLAYER} active quests. Finish one first.` };
    p.quests.push({ quest, progress: 0 });
    this.emit(p.id, {
      type: "event",
      event: "quest_accepted",
      message: `Quest accepted: ${quest.title} (reward ${quest.rewardShards} shards, ${quest.rewardXp} XP).`,
      playerId: p.id,
      data: { questId: quest.id },
    });
    return { ok: true, message: `Accepted "${quest.title}" — reward ${quest.rewardShards} shards + ${quest.rewardXp} XP.` };
  }

  /** Advance matching accepted quests; auto-complete when the goal is met. */
  private questProgress(p: Player, type: "slay" | "gather" | "craft", key: string, amount: number) {
    for (const aq of [...p.quests]) {
      const g = aq.quest.goal;
      if (g.type !== type) continue;
      if (g.type === "slay" && g.mobKind && g.mobKind !== key) continue;
      if (g.type === "gather" && g.item !== key) continue;
      if (g.type === "craft" && g.recipeId !== key) continue;
      aq.progress = Math.min(g.count, aq.progress + amount);
      if (aq.progress >= g.count) {
        p.quests = p.quests.filter((x) => x !== aq);
        p.shards += aq.quest.rewardShards;
        this.grantXp(p, aq.quest.rewardXp);
        this.log("quest", "world", p.id, "shards", aq.quest.rewardShards, `${p.name} completed ${aq.quest.title}`);
        this.emit(p.id, {
          type: "event",
          event: "quest_complete",
          message: `Quest complete: ${aq.quest.title}! +${aq.quest.rewardShards} shards, +${aq.quest.rewardXp} XP.`,
          playerId: p.id,
          data: { questId: aq.quest.id, rewardShards: aq.quest.rewardShards, rewardXp: aq.quest.rewardXp },
        });
      }
    }
  }

  // -- Territory & building ---------------------------------------------------

  claimPlot(p: Player, pos: Vec2): ActionOutcome {
    if (terrainHeight(pos.x, pos.z, this.seed) <= 0.5)
      return { ok: false, message: "Claims must be on solid land." };
    if (distance(pos, SAFE_ZONE_CENTER) <= TERRITORY.MIN_DIST_FROM_VILLAGE)
      return { ok: false, message: `Too close to the village — claim at least ${TERRITORY.MIN_DIST_FROM_VILLAGE}u from the shrine.` };
    for (const c of this.claims.values()) {
      if (distance(pos, c.center) <= TERRITORY.MIN_DIST_BETWEEN_CLAIMS)
        return { ok: false, message: `Too close to ${c.ownerName}'s claim ${c.id} (${distance(pos, c.center).toFixed(1)}u < ${TERRITORY.MIN_DIST_BETWEEN_CLAIMS}u).` };
    }
    if (p.shards < TERRITORY.CLAIM_COST_SHARDS)
      return { ok: false, message: `Claiming costs ${TERRITORY.CLAIM_COST_SHARDS} shards; you have ${p.shards}.` };
    p.shards -= TERRITORY.CLAIM_COST_SHARDS;
    const claim: Claim = {
      id: `c-${this.nextId++}`,
      ownerId: p.id,
      ownerName: p.name,
      center: { x: pos.x, z: pos.z },
      size: TERRITORY.CLAIM_SIZE,
    };
    this.claims.set(claim.id, claim);
    this.log("territory", p.id, "world", "shards", TERRITORY.CLAIM_COST_SHARDS, `${p.name} claimed plot ${claim.id}`);
    this.emit("all", {
      type: "event",
      event: "claim_created",
      message: `${p.name} claimed a ${TERRITORY.CLAIM_SIZE}x${TERRITORY.CLAIM_SIZE} plot at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}).`,
      playerId: p.id,
      data: { claimId: claim.id, center: claim.center },
    });
    return { ok: true, message: `Claimed plot ${claim.id} centered at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}) for ${TERRITORY.CLAIM_COST_SHARDS} shards.` };
  }

  private claimContaining(pos: Vec2): Claim | undefined {
    const half = TERRITORY.CLAIM_SIZE / 2;
    for (const c of this.claims.values()) {
      if (Math.abs(pos.x - c.center.x) <= half && Math.abs(pos.z - c.center.z) <= half) return c;
    }
    return undefined;
  }

  build(p: Player, kind: StructureKind, pos: Vec2): ActionOutcome {
    const costs = STRUCTURE_COSTS[kind];
    if (!costs)
      return { ok: false, message: `Unknown structure. Known: ${Object.keys(STRUCTURE_COSTS).join(", ")}.` };
    const claim = this.claimContaining(pos);
    if (!claim) return { ok: false, message: "You can only build on a claimed plot. Claim one first." };
    if (claim.ownerName !== p.name)
      return { ok: false, message: `That plot belongs to ${claim.ownerName}.` };
    if (terrainHeight(pos.x, pos.z, this.seed) <= 0.2)
      return { ok: false, message: "Cannot build in the sea." };
    for (const s of this.structures.values()) {
      if (distance(s.pos, pos) < 2)
        return { ok: false, message: `Too close to existing structure ${s.id}.` };
    }
    for (const [item, qty] of Object.entries(costs)) {
      if ((p.inventory[item as ItemId] ?? 0) < qty)
        return { ok: false, message: `Missing materials: need ${qty} ${item}, have ${p.inventory[item as ItemId] ?? 0}.` };
    }
    for (const [item, qty] of Object.entries(costs)) this.give(p, item as ItemId, -qty);
    const s: Structure = {
      id: `s-${this.nextId++}`,
      kind,
      ownerId: p.id,
      ownerName: p.name,
      claimId: claim.id,
      pos: { x: pos.x, z: pos.z },
      hp: TERRITORY.STRUCTURE_HP,
      hpMax: TERRITORY.STRUCTURE_HP,
    };
    this.structures.set(s.id, s);
    this.log("territory", p.id, "world", "wood", 0, `${p.name} built a ${kind} (${s.id}) on ${claim.id}`);
    this.emit("all", {
      type: "event",
      event: "structure_built",
      message: `${p.name} built a ${kind} at (${pos.x.toFixed(0)}, ${pos.z.toFixed(0)}).`,
      playerId: p.id,
      data: { structureId: s.id, kind, pos: s.pos, claimId: claim.id },
    });
    return { ok: true, message: `Built a ${kind} (${s.id}, ${s.hp} HP) on plot ${claim.id}.` };
  }

  /** Restore persisted territory at startup (owners re-attach by name on join). */
  restoreTerritory(claims: Claim[], structures: Structure[]) {
    for (const c of claims) {
      this.claims.set(c.id, { ...c, ownerId: "" });
      const n = Number(c.id.split("-")[1]);
      if (Number.isFinite(n)) this.nextId = Math.max(this.nextId, n + 1);
    }
    for (const s of structures) {
      this.structures.set(s.id, { ...s, ownerId: "" });
      const n = Number(s.id.split("-")[1]);
      if (Number.isFinite(n)) this.nextId = Math.max(this.nextId, n + 1);
    }
  }

  /** Nearest standing workshop within range of pos, if any. */
  private workshopNear(pos: Vec2): Structure | undefined {
    let best: Structure | undefined;
    let bestD: number = TERRITORY.WORKSHOP_RANGE;
    for (const s of this.structures.values()) {
      if (s.kind !== "workshop") continue;
      const d = distance(s.pos, pos);
      if (d <= bestD) {
        best = s;
        bestD = d;
      }
    }
    return best;
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
    // Workshop aura: crafting within range costs 25% less AP. Non-owners pay
    // the workshop owner a 1-shard fee per craft; owners craft with it free.
    const workshop = this.workshopNear(p.pos);
    const owner = workshop ? this.players.get(workshop.ownerId) : undefined;
    const ownWorkshop = workshop?.ownerName === p.name;
    const fee = workshop && !ownWorkshop ? TERRITORY.WORKSHOP_FEE_SHARDS : 0;
    const useWorkshop = !!workshop && (ownWorkshop || p.shards >= fee);
    let apCost = AP_COST.CRAFT * qty;
    if (useWorkshop) apCost = Math.ceil(apCost * (1 - TERRITORY.WORKSHOP_CRAFT_DISCOUNT));
    if (p.ap < apCost) return { ok: false, message: `Not enough AP (${p.ap}/${apCost}).` };
    for (const [item, n] of Object.entries(recipe.inputs)) {
      if ((p.inventory[item as ItemId] ?? 0) < n * qty)
        return { ok: false, message: `Missing materials: need ${n * qty} ${item}, have ${p.inventory[item as ItemId] ?? 0}.` };
    }
    p.ap -= apCost;
    let note = "";
    if (useWorkshop && workshop) {
      if (fee > 0) {
        p.shards -= fee;
        if (owner) owner.shards += fee;
        this.log("craft", p.id, workshop.ownerName, "shards", fee, `workshop fee at ${workshop.id}`);
        note = ` (workshop bonus, ${fee} shard fee to ${workshop.ownerName})`;
      } else {
        note = " (your workshop bonus)";
      }
    }
    for (const [item, n] of Object.entries(recipe.inputs)) this.give(p, item as ItemId, -n * qty);
    this.give(p, recipe.output, recipe.outputQty * qty);
    this.grantXp(p, PROGRESSION.XP_CRAFT * qty);
    this.questProgress(p, "craft", recipe.id, qty);
    this.log("craft", p.id, p.id, recipe.output, recipe.outputQty * qty, `${p.name} crafted ${recipeId} x${qty}`);
    return { ok: true, message: `Crafted ${recipe.outputQty * qty} ${recipe.output} (+${PROGRESSION.XP_CRAFT * qty} XP)${note}.` };
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
      hpMax: this.maxHp(p),
      level: p.level,
      equipment: { ...p.equipment },
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
      inSafeZone: this.inSafeZone(p.pos),
      xp: p.xp,
      xpNext: xpForLevel(p.level),
      quests: p.quests.map((aq) => ({ quest: aq.quest, progress: aq.progress })),
    };
  }

  observationSummary(p: Player): string {
    const nodes = this.nearbyNodes(p);
    const others = this.nearbyPlayers(p);
    const mobs = this.nearbyMobs(p);
    const inv = Object.entries(p.inventory)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "empty";
    const equipped =
      [p.equipment.weapon && `weapon: ${p.equipment.weapon}`, p.equipment.offhand && `offhand: ${p.equipment.offhand}`]
        .filter(Boolean)
        .join(", ") || "nothing";
    const nodeStr = nodes
      .slice(0, 6)
      .map((n) => `${n.id} (${n.kind}, ${n.remaining} left, ${distance(p.pos, n.pos).toFixed(0)}u away)`)
      .join("; ") || "none in sight";
    const playerStr = others
      .map((o) => `${o.name} (${o.id}) [${o.role}] lvl ${o.level}, ${distance(p.pos, o.pos).toFixed(0)}u away, ${o.hp}/${o.hpMax} HP`)
      .join("; ") || "nobody nearby";
    const mobStr = mobs
      .slice(0, 6)
      .map((m) => `${m.id} (${MOB_LABEL[m.kind]} Lv${m.level}, ${m.hp}/${m.hpMax} HP, ${distance(p.pos, m.pos).toFixed(0)}u away${m.targetId === p.id ? ", attacking YOU" : ""})`)
      .join("; ") || "none nearby";
    const orderStr = [...this.orders.values()]
      .slice(0, 6)
      .map((o) => `${o.id}: ${o.ownerName} ${o.side}s ${o.qty} ${o.item} @ ${o.price}`)
      .join("; ") || "no open orders";
    const questStr = p.quests
      .map((aq) => `${aq.quest.title} (${aq.progress}/${aq.quest.goal.count})`)
      .join("; ") || "none (send quest_list to see the village board)";
    const safety = this.inSafeZone(p.pos)
      ? "You are inside the shrine's safe zone (no PvP)."
      : "You are in the open wilds — PvP and skeletons are a danger here.";
    return (
      `You are ${p.name} at (${p.pos.x.toFixed(0)}, ${p.pos.z.toFixed(0)}) on Emberfall Isle. ` +
      `Level ${p.level} (${p.xp}/${xpForLevel(p.level)} XP), HP ${p.hp}/${this.maxHp(p)}, AP ${Math.floor(p.ap)}/${WORLD.AP_MAX}, ${p.shards} shards (K/D ${p.kills}/${p.deaths}). ` +
      `Inventory: ${inv}. Equipped: ${equipped}. ${safety} ` +
      `Active quests: ${questStr}. ` +
      `Nearby resources: ${nodeStr}. Nearby skeletons: ${mobStr}. Nearby citizens: ${playerStr}. Market: ${orderStr}. ` +
      `Actions: move, gather, craft (${RECIPES.map((r) => r.id).join("/")}), equip, unequip, say, trade_post, trade_fill, ` +
      `attack (players/mobs/structures, range ${COMBAT.ATTACK_RANGE}), quest_list, quest_accept, ` +
      `claim (${TERRITORY.CLAIM_COST_SHARDS} shards, ≥${TERRITORY.MIN_DIST_FROM_VILLAGE}u from village), build (wall/house/workshop on your plot).`
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
    return this.publicMobs()
      .filter((m) => distance(p.pos, m.pos) <= range)
      .sort((a, b) => distance(p.pos, a.pos) - distance(p.pos, b.pos));
  }

  nearbyClaims(p: Player, range = 60): Claim[] {
    return [...this.claims.values()].filter((c) => distance(p.pos, c.center) <= range);
  }

  nearbyStructures(p: Player, range = 60): Structure[] {
    return [...this.structures.values()].filter((s) => distance(p.pos, s.pos) <= range);
  }

  recipes(): Recipe[] {
    return RECIPES;
  }
}
