import { readFileSync } from "node:fs";
import { Claim, Equipment, ItemId, Role, Structure, StructureKind, TERRITORY, Vec2 } from "@agentworld/protocol";
import type { LedgerEntry, Player } from "./world.js";

/**
 * Supabase persistence over PostgREST. Optional: if SUPABASE_URL /
 * SUPABASE_ANON_KEY are not set (env or repo-root .env), the server runs
 * purely in-memory. Tables are prefixed aw_ (shared project); when the game
 * moves to a dedicated Supabase project, only these env vars change.
 *
 * NOTE: the slice uses the anon key with RLS disabled on aw_ tables — fine
 * for development, must move to a service-role key + RLS before any public
 * deployment.
 */

export interface CharacterRow {
  name: string;
  role: Role;
  x: number;
  z: number;
  ap: number;
  hp: number;
  shards: number;
  inventory: Partial<Record<ItemId, number>>;
  kills: number;
  deaths: number;
  xp?: number;
  level?: number;
  equipment?: Equipment;
}

export interface ClaimRow {
  id: string;
  owner_name: string;
  x: number;
  z: number;
  size: number;
}

export interface StructureRow {
  id: string;
  claim_id: string;
  owner_name: string;
  kind: StructureKind;
  x: number;
  z: number;
  hp: number;
}

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of [".env", "../../.env"]) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
        if (m) out[m[1]] = m[2];
      }
      break;
    } catch {
      // try next path
    }
  }
  return out;
}

export class Persistence {
  private url: string | null;
  private key: string | null;
  readonly enabled: boolean;
  private ledgerQueue: LedgerEntry[] = [];

  constructor() {
    const env = { ...loadDotEnv(), ...process.env };
    this.url = env.SUPABASE_URL ?? null;
    this.key = env.SUPABASE_ANON_KEY ?? null;
    this.enabled = !!(this.url && this.key);
  }

  private async rest(path: string, init: RequestInit & { prefer?: string } = {}): Promise<Response> {
    const headers: Record<string, string> = {
      apikey: this.key!,
      Authorization: `Bearer ${this.key}`,
      "Content-Type": "application/json",
    };
    if (init.prefer) headers.Prefer = init.prefer;
    return fetch(`${this.url}/rest/v1/${path}`, { ...init, headers });
  }

  async ping(): Promise<boolean> {
    if (!this.enabled) return false;
    try {
      const res = await this.rest("aw_characters?select=name&limit=1");
      return res.ok;
    } catch {
      return false;
    }
  }

  async loadCharacter(name: string): Promise<CharacterRow | null> {
    if (!this.enabled) return null;
    try {
      const res = await this.rest(`aw_characters?name=eq.${encodeURIComponent(name)}&select=*`);
      if (!res.ok) return null;
      const rows = (await res.json()) as CharacterRow[];
      return rows[0] ?? null;
    } catch (err) {
      console.error("persistence: loadCharacter failed:", err);
      return null;
    }
  }

  async saveCharacter(p: Player): Promise<void> {
    if (!this.enabled) return;
    const row: CharacterRow & { updated_at: string } = {
      name: p.name,
      role: p.role,
      x: p.pos.x,
      z: p.pos.z,
      ap: Math.floor(p.ap),
      hp: p.hp,
      shards: p.shards,
      inventory: p.inventory,
      kills: p.kills,
      deaths: p.deaths,
      xp: p.xp,
      level: p.level,
      equipment: p.equipment,
      updated_at: new Date().toISOString(),
    };
    try {
      const res = await this.rest("aw_characters?on_conflict=name", {
        method: "POST",
        body: JSON.stringify(row),
        prefer: "resolution=merge-duplicates",
      });
      if (!res.ok) console.error("persistence: saveCharacter failed:", res.status, await res.text());
    } catch (err) {
      console.error("persistence: saveCharacter failed:", err);
    }
  }

  queueLedger(entries: LedgerEntry[]): void {
    if (this.enabled) this.ledgerQueue.push(...entries);
  }

  async flushLedger(): Promise<void> {
    if (!this.enabled || this.ledgerQueue.length === 0) return;
    const batch = this.ledgerQueue.splice(0, this.ledgerQueue.length);
    try {
      const res = await this.rest("aw_ledger", {
        method: "POST",
        body: JSON.stringify(
          batch.map((e) => ({
            t: new Date(e.t).toISOString(),
            kind: e.kind,
            debit: e.debit,
            credit: e.credit,
            item: e.item,
            qty: e.qty,
            memo: e.memo,
          })),
        ),
      });
      if (!res.ok) console.error("persistence: flushLedger failed:", res.status, await res.text());
    } catch (err) {
      this.ledgerQueue.unshift(...batch);
      console.error("persistence: flushLedger failed:", err);
    }
  }

  restoreToPlayer(row: CharacterRow): Pick<Player, "pos" | "ap" | "hp" | "shards" | "inventory" | "kills" | "deaths" | "xp" | "level" | "equipment"> {
    return {
      pos: { x: row.x, z: row.z },
      ap: row.ap,
      hp: row.hp,
      shards: row.shards,
      inventory: row.inventory ?? {},
      kills: row.kills,
      deaths: row.deaths,
      xp: row.xp ?? 0,
      level: row.level ?? 1,
      equipment: row.equipment ?? {},
    };
  }

  // -- Territory (Sprint 3): aw_claims / aw_structures -------------------------

  async loadTerritory(): Promise<{ claims: Claim[]; structures: Structure[] } | null> {
    if (!this.enabled) return null;
    try {
      const [claimsRes, structuresRes] = await Promise.all([
        this.rest("aw_claims?select=*"),
        this.rest("aw_structures?select=*"),
      ]);
      if (!claimsRes.ok || !structuresRes.ok) return null;
      const claimRows = (await claimsRes.json()) as ClaimRow[];
      const structureRows = (await structuresRes.json()) as StructureRow[];
      return {
        claims: claimRows.map((r) => ({
          id: r.id,
          ownerId: "",
          ownerName: r.owner_name,
          center: { x: r.x, z: r.z },
          size: r.size,
        })),
        structures: structureRows.map((r) => ({
          id: r.id,
          kind: r.kind,
          ownerId: "",
          ownerName: r.owner_name,
          claimId: r.claim_id,
          pos: { x: r.x, z: r.z },
          hp: r.hp,
          hpMax: TERRITORY.STRUCTURE_HP,
        })),
      };
    } catch (err) {
      console.error("persistence: loadTerritory failed:", err);
      return null;
    }
  }

  async saveTerritory(claims: Claim[], structures: Structure[], destroyedStructureIds: string[]): Promise<void> {
    if (!this.enabled) return;
    try {
      if (claims.length > 0) {
        const res = await this.rest("aw_claims?on_conflict=id", {
          method: "POST",
          prefer: "resolution=merge-duplicates",
          body: JSON.stringify(
            claims.map((c): ClaimRow => ({ id: c.id, owner_name: c.ownerName, x: c.center.x, z: c.center.z, size: c.size })),
          ),
        });
        if (!res.ok) console.error("persistence: save claims failed:", res.status, await res.text());
      }
      if (structures.length > 0) {
        const res = await this.rest("aw_structures?on_conflict=id", {
          method: "POST",
          prefer: "resolution=merge-duplicates",
          body: JSON.stringify(
            structures.map((s): StructureRow => ({ id: s.id, claim_id: s.claimId, owner_name: s.ownerName, kind: s.kind, x: s.pos.x, z: s.pos.z, hp: s.hp })),
          ),
        });
        if (!res.ok) console.error("persistence: save structures failed:", res.status, await res.text());
      }
      if (destroyedStructureIds.length > 0) {
        // Structure ids are server-generated (s-<n>), safe to inline.
        const ids = destroyedStructureIds.join(",");
        const res = await this.rest(`aw_structures?id=in.(${ids})`, { method: "DELETE" });
        if (!res.ok) console.error("persistence: delete structures failed:", res.status, await res.text());
      }
    } catch (err) {
      console.error("persistence: saveTerritory failed:", err);
    }
  }
}
