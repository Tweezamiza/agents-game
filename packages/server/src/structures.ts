import {
  COMBAT,
  SAFE_ZONE_CENTER,
  Structure,
  StructureKind,
  TERRITORY,
  Vec2,
  distance,
} from "@agentworld/protocol";

/**
 * Player-built structures + territory claims. In-memory this sprint.
 * TODO: persist to Supabase (aw_structures table) alongside characters.
 */
export class StructureManager {
  private readonly structures = new Map<string, Structure>();
  private nextId = 1;

  all(): Structure[] {
    return [...this.structures.values()];
  }

  /** The banner whose territory contains pos, if any. */
  territoryAt(pos: Vec2): Structure | null {
    for (const s of this.structures.values()) {
      if (s.kind === "banner" && distance(s.pos, pos) <= TERRITORY.BANNER_RADIUS) return s;
    }
    return null;
  }

  /** True when pos lies inside this player's own claimed territory. */
  ownsTerritoryAt(ownerId: string, pos: Vec2): boolean {
    return this.territoryAt(pos)?.ownerId === ownerId;
  }

  /** Any campfire (any owner) within healing range of pos? */
  campfireNear(pos: Vec2): boolean {
    for (const s of this.structures.values()) {
      if (s.kind === "campfire" && distance(s.pos, pos) <= TERRITORY.CAMPFIRE_HEAL_RADIUS) return true;
    }
    return false;
  }

  nearby(pos: Vec2, range = 40): Structure[] {
    return this.all()
      .filter((s) => distance(s.pos, pos) <= range)
      .sort((a, b) => distance(pos, a.pos) - distance(pos, b.pos));
  }

  /** Placement rules only — the World checks AP and materials. Null = ok. */
  canBuild(ownerId: string, kind: StructureKind, pos: Vec2): string | null {
    if (distance(pos, SAFE_ZONE_CENTER) <= COMBAT.SAFE_ZONE_RADIUS)
      return "The village is sacred ground — build outside the shrine's safe zone.";
    const claim = this.territoryAt(pos);
    if (claim && claim.ownerId !== ownerId)
      return `This land belongs to ${claim.ownerName} — you cannot build here.`;
    if (kind === "campfire") {
      for (const s of this.structures.values()) {
        if (s.kind === "campfire" && s.ownerId === ownerId && distance(s.pos, pos) < TERRITORY.CAMPFIRE_MIN_SPACING)
          return `You already have a campfire within ${TERRITORY.CAMPFIRE_MIN_SPACING}u.`;
      }
    }
    if (kind === "banner") {
      if (distance(pos, SAFE_ZONE_CENTER) < TERRITORY.BANNER_RADIUS + COMBAT.SAFE_ZONE_RADIUS)
        return "A claim here would overlap the village safe zone.";
      for (const s of this.structures.values()) {
        if (s.kind === "banner" && s.ownerId !== ownerId && distance(s.pos, pos) < TERRITORY.BANNER_RADIUS * 2)
          return `A claim here would overlap ${s.ownerName}'s territory.`;
      }
    }
    return null;
  }

  /** Place a structure. A player's new banner replaces their old one (the claim moves). */
  place(ownerId: string, ownerName: string, kind: StructureKind, pos: Vec2): Structure {
    if (kind === "banner") {
      for (const s of [...this.structures.values()]) {
        if (s.kind === "banner" && s.ownerId === ownerId) this.structures.delete(s.id);
      }
    }
    const id = `s-${this.nextId++}`;
    const structure: Structure = { id, kind, ownerId, ownerName, pos: { ...pos } };
    this.structures.set(id, structure);
    return structure;
  }
}
