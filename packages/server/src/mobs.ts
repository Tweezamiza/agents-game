import {
  COMBAT,
  MOBS,
  MobKind,
  MobPublic,
  SAFE_ZONE_CENTER,
  Vec2,
  WORLD,
  distance,
  terrainHeight,
} from "@agentworld/protocol";
import type { Player } from "./world.js";
import { mulberry32 } from "./rng.js";

/** Game ticks from death to respawn at the home position. */
const RESPAWN_TICKS = 90;
/** The world boss stays down much longer — its return is an event. */
const BOSS_RESPAWN_TICKS = 600;
/** Dragged further than this from home, a mob de-aggros and walks back. */
const LEASH_RANGE = 25;
/** Game ticks between mob attacks. */
const ATTACK_COOLDOWN_TICKS = 2;
/** HP healed per game tick while idle or leashing, below full health. */
const IDLE_HEAL = 4;
/** Idle wander keeps a mob within this radius of home. */
const WANDER_RADIUS = 8;

const SPAWN_COUNTS: Record<MobKind, number> = { boar: 14, wolf: 10, golem: 6, bonelord: 1 };
/** Terrain bands: boars in meadows, wolves in the forest belt, golems on the highland. */
const SPAWN_BANDS: Record<MobKind, [number, number]> = {
  boar: [0.8, 3.2],
  wolf: [1.2, 6.5],
  golem: [5.5, Infinity],
  // The Bonelord holds the very top of the highland.
  bonelord: [6.5, Infinity],
};

export interface Mob {
  id: string;
  kind: MobKind;
  pos: Vec2;
  home: Vec2;
  hp: number;
  /** Aggro target player id, or null when idle/leashing. */
  targetId: string | null;
  /** Walking back home after being dragged past the leash range. */
  leashing: boolean;
  attackCooldown: number;
  /** Game ticks until respawn; 0 = alive. */
  respawnTicks: number;
}

/** A mob landing a hit this tick. Raw damage — the World applies armor. */
export interface MobStrike {
  mob: Mob;
  target: Player;
  damage: number;
}

export class MobManager {
  readonly mobs = new Map<string, Mob>();

  constructor(private readonly seed: number) {
    this.generate();
  }

  /** Deterministic spawns from the world seed, like resource nodes. */
  private generate(): void {
    const rng = mulberry32(this.seed ^ 0xfade);
    const clearOfVillage = (x: number, z: number) =>
      distance({ x, z }, SAFE_ZONE_CENTER) > COMBAT.SAFE_ZONE_RADIUS + 6;
    let n = 1;
    for (const kind of Object.keys(SPAWN_COUNTS) as MobKind[]) {
      const [lo, hi] = SPAWN_BANDS[kind];
      let placed = 0;
      let guard = 0;
      while (placed < SPAWN_COUNTS[kind] && guard++ < 30000) {
        const x = rng() * WORLD.SIZE;
        const z = rng() * WORLD.SIZE;
        const y = terrainHeight(x, z, this.seed);
        if (y < lo || y > hi || !clearOfVillage(x, z)) continue;
        const id = `m-${kind}-${n++}`;
        this.mobs.set(id, {
          id,
          kind,
          pos: { x, z },
          home: { x, z },
          hp: MOBS[kind].hpMax,
          targetId: null,
          leashing: false,
          attackCooldown: 0,
          respawnTicks: 0,
        });
        placed++;
      }
    }
  }

  /** Retaliate against an attacker (all kinds, even passive boars). */
  aggroOn(mob: Mob, attackerId: string): void {
    mob.targetId = attackerId;
    mob.leashing = false;
  }

  /** Mark dead; respawns at home after RESPAWN_TICKS game ticks. */
  kill(mob: Mob): void {
    mob.hp = 0;
    mob.targetId = null;
    mob.leashing = false;
    mob.respawnTicks = mob.kind === "bonelord" ? BOSS_RESPAWN_TICKS : RESPAWN_TICKS;
  }

  /** AI on the 1s game tick: respawn, leash, aggro, chase, attack, wander. */
  tick(players: Map<string, Player>, inSafeZone: (pos: Vec2) => boolean): MobStrike[] {
    const strikes: MobStrike[] = [];
    for (const m of this.mobs.values()) {
      if (m.respawnTicks > 0) {
        if (--m.respawnTicks === 0) {
          m.hp = MOBS[m.kind].hpMax;
          m.pos = { ...m.home };
        }
        continue;
      }
      const stats = MOBS[m.kind];
      if (m.attackCooldown > 0) m.attackCooldown--;

      // Drop targets that vanished, sheltered in the safe zone, or out-ran us.
      if (m.targetId) {
        const t = players.get(m.targetId);
        if (!t || inSafeZone(t.pos) || distance(m.pos, t.pos) > LEASH_RANGE * 1.5) m.targetId = null;
      }
      if (distance(m.pos, m.home) > LEASH_RANGE) {
        m.targetId = null;
        m.leashing = true;
      }

      if (m.targetId) {
        const t = players.get(m.targetId)!;
        if (distance(m.pos, t.pos) <= stats.attackRange) {
          if (m.attackCooldown === 0) {
            m.attackCooldown = ATTACK_COOLDOWN_TICKS;
            const damage =
              stats.damageMin + Math.floor(Math.random() * (stats.damageMax - stats.damageMin + 1));
            strikes.push({ mob: m, target: t, damage });
          }
        } else {
          this.step(m, t.pos, stats.moveSpeed, inSafeZone);
        }
        continue;
      }

      if (m.hp < stats.hpMax) m.hp = Math.min(stats.hpMax, m.hp + IDLE_HEAL);

      if (m.leashing) {
        this.step(m, m.home, stats.moveSpeed * 1.5, inSafeZone);
        if (distance(m.pos, m.home) < 1.5) m.leashing = false;
        continue;
      }

      // Idle: aggressive kinds hunt the nearest exposed player.
      if (stats.aggressive) {
        let best: Player | null = null;
        let bestD = stats.aggroRange;
        for (const p of players.values()) {
          if (inSafeZone(p.pos)) continue;
          const d = distance(m.pos, p.pos);
          if (d <= bestD) {
            best = p;
            bestD = d;
          }
        }
        if (best) {
          m.targetId = best.id;
          continue;
        }
      }

      // Idle wander: small random steps, pulled back toward home.
      const far = distance(m.pos, m.home) > WANDER_RADIUS;
      const a = Math.random() * 2 * Math.PI;
      const to = far
        ? m.home
        : { x: m.pos.x + Math.cos(a) * 1.5, z: m.pos.z + Math.sin(a) * 1.5 };
      if (Math.random() < 0.55) this.step(m, to, Math.min(1.2, stats.moveSpeed), inSafeZone);
    }
    return strikes;
  }

  /** Walk up to `speed` units toward target; sea and safe zone are walls. */
  private step(m: Mob, target: Vec2, speed: number, inSafeZone: (pos: Vec2) => boolean): void {
    const d = distance(m.pos, target);
    if (d < 0.05) return;
    const walk = Math.min(speed, d);
    const nx = m.pos.x + ((target.x - m.pos.x) / d) * walk;
    const nz = m.pos.z + ((target.z - m.pos.z) / d) * walk;
    if (terrainHeight(nx, nz, this.seed) <= 0.2) return;
    if (inSafeZone({ x: nx, z: nz })) return;
    m.pos = { x: nx, z: nz };
  }

  view(m: Mob): MobPublic {
    return { id: m.id, kind: m.kind, pos: m.pos, hp: m.hp, hpMax: MOBS[m.kind].hpMax, level: MOBS[m.kind].level };
  }

  /** Live mobs only — the dead vanish until they respawn. */
  living(): MobPublic[] {
    return [...this.mobs.values()].filter((m) => m.respawnTicks === 0).map((m) => this.view(m));
  }
}
