import { ItemId, QuestDef, QuestObjectiveKind, QuestState, distance } from "@agentworld/protocol";
import { EXPLORE_RADIUS, PLACES, SIDE_TEMPLATES, STORY_QUESTS } from "./quest-content.js";
import { mulberry32 } from "./rng.js";
import type { Player, World } from "./world.js";

/** The side board rotates every 10 minutes; everyone sees the same board. */
export const BOARD_ROTATION_MS = 10 * 60 * 1000;
export const BOARD_SIZE = 3;
/** Max simultaneously active (accepted, unfinished) side quests per player. */
export const MAX_ACTIVE_SIDE = 3;

/** A quest journal event bound for one player's socket as a quest_update. */
export interface QuestUpdate {
  playerId: string;
  playerName: string;
  quest: QuestDef;
  state: QuestState;
  message: string;
  completed?: boolean;
}

const STORY_BY_ID = new Map(STORY_QUESTS.map((q) => [q.id, q]));

const plural = (t: string) => (t === "wolf" ? "wolves" : `${t}s`);

/** "gather 5 wood", "slay 3 wolves", "reach the highland summit", ... */
export function describeObjective(def: QuestDef): string {
  const { kind, target, qty } = def.objective;
  switch (kind) {
    case "gather": return `gather ${qty} ${target}`;
    case "craft": return `craft ${qty} ${target}`;
    case "kill": return `slay ${qty} ${qty > 1 ? plural(target) : target}`;
    case "build": return `build ${qty > 1 ? `${qty} ${plural(target)}` : `a ${target}`}`;
    case "explore": return `reach ${PLACES[target]?.name ?? target}`;
  }
}

/**
 * Story campaign + rotating side board. Per-player QuestState keyed by
 * player NAME (not id) so progress survives reconnects within a session;
 * across restarts it rides the aw_characters.quests column.
 */
export class QuestEngine {
  /** player name -> questId -> state. */
  private states = new Map<string, Map<string, QuestState>>();
  /** Progress/completion events awaiting dispatch, drained by the server. */
  private pending: QuestUpdate[] = [];

  constructor(private readonly world: World) {}

  /** The current side-quest board: deterministic from (world seed, epoch). */
  board(now = Date.now()): QuestDef[] {
    return this.boardForEpoch(Math.floor(now / BOARD_ROTATION_MS));
  }

  private boardForEpoch(epoch: number): QuestDef[] {
    const rng = mulberry32((this.world.seed ^ 0x9e3779b9) + epoch * 7919);
    const picks: number[] = [];
    while (picks.length < BOARD_SIZE) {
      const i = Math.floor(rng() * SIDE_TEMPLATES.length);
      if (!picks.includes(i)) picks.push(i);
    }
    return picks.map((tpl, slot) => ({ id: `side-${epoch}-${slot}`, ...SIDE_TEMPLATES[tpl](rng) }));
  }

  /** Resolve any quest id to its definition (story, or regenerated board). */
  defOf(questId: string): QuestDef | undefined {
    const story = STORY_BY_ID.get(questId);
    if (story) return story;
    const m = questId.match(/^side-(\d+)-(\d)$/);
    if (!m) return undefined;
    return this.boardForEpoch(Number(m[1]))[Number(m[2])];
  }

  /**
   * Quests visible to a player: unlocked-and-unfinished story quests, the
   * current board (minus completed), plus defs of any accepted quests that
   * have since rotated off the board (journals still need them).
   */
  offeredFor(name: string, now = Date.now()): QuestDef[] {
    const m = this.states.get(name);
    const completed = (id: string) => m?.get(id)?.done === true;
    const offered: QuestDef[] = [];
    for (const q of STORY_QUESTS) {
      if (completed(q.id)) continue;
      if (q.requires && !completed(q.requires)) continue;
      offered.push(q);
    }
    for (const q of this.board(now)) if (!completed(q.id)) offered.push(q);
    if (m) {
      for (const st of m.values()) {
        if (st.done || offered.some((q) => q.id === st.questId)) continue;
        const def = this.defOf(st.questId);
        if (def) offered.push(def);
      }
    }
    return offered;
  }

  /** Accepted quest states (active + completed), for PlayerPrivate.quests. */
  statesFor(name: string): QuestState[] {
    return [...(this.states.get(name)?.values() ?? [])].map((s) => ({ ...s }));
  }

  accept(p: Player, questId: string): { ok: boolean; message: string; quest?: QuestDef; state?: QuestState } {
    const m = this.states.get(p.name) ?? new Map<string, QuestState>();
    const existing = m.get(questId);
    if (existing)
      return { ok: false, message: existing.done ? "You already completed that quest." : "You already accepted that quest." };
    const def = this.offeredFor(p.name).find((q) => q.id === questId);
    if (!def) return { ok: false, message: `No such quest is offered: ${questId}.` };
    if (def.side) {
      const activeSide = [...m.values()].filter((s) => !s.done && this.defOf(s.questId)?.side).length;
      if (activeSide >= MAX_ACTIVE_SIDE)
        return { ok: false, message: `You already have ${MAX_ACTIVE_SIDE} active side quests. Finish one first.` };
    }
    const state: QuestState = { questId, progress: 0, done: false };
    m.set(questId, state);
    this.states.set(p.name, m);
    return {
      ok: true,
      message: `Accepted "${def.title}" from ${def.giver} — ${describeObjective(def)}. Reward: ${def.rewardShards} shards, ${def.rewardXp} XP.`,
      quest: def,
      state: { ...state },
    };
  }

  /**
   * Advance matching accepted quests after a world event. Completion grants
   * rewards immediately and queues a quest_update (story quests also get a
   * world-chat fanfare line).
   */
  progressEvent(p: Player, kind: QuestObjectiveKind, target: string, qty = 1): void {
    const m = this.states.get(p.name);
    if (!m) return;
    for (const st of m.values()) {
      if (st.done) continue;
      const def = this.defOf(st.questId);
      if (!def || def.objective.kind !== kind || def.objective.target !== target) continue;
      st.progress = Math.min(def.objective.qty, st.progress + qty);
      if (st.progress >= def.objective.qty) {
        st.done = true;
        p.shards += def.rewardShards;
        this.world.addXp(p, def.rewardXp);
        const items = Object.entries(def.rewardItems ?? {});
        for (const [item, n] of items) this.world.give(p, item as ItemId, n);
        const itemStr = items.length ? `, ${items.map(([k, v]) => `${v} ${k}`).join(", ")}` : "";
        if (!def.side) this.world.announce(`${p.name} completed "${def.title}"!`);
        this.pending.push({
          playerId: p.id,
          playerName: p.name,
          quest: def,
          state: { ...st },
          message: `Quest complete: "${def.title}" — +${def.rewardShards} shards, +${def.rewardXp} XP${itemStr}.`,
          completed: true,
        });
      } else {
        this.pending.push({
          playerId: p.id,
          playerName: p.name,
          quest: def,
          state: { ...st },
          message: `${def.title}: ${st.progress}/${def.objective.qty} — ${describeObjective(def)}.`,
        });
      }
    }
  }

  /** Game-tick position check for explore objectives. */
  checkExplore(p: Player): void {
    const m = this.states.get(p.name);
    if (!m) return;
    for (const st of m.values()) {
      if (st.done) continue;
      const def = this.defOf(st.questId);
      if (!def || def.objective.kind !== "explore") continue;
      const place = PLACES[def.objective.target];
      if (place && distance(p.pos, place.pos) <= EXPLORE_RADIUS)
        this.progressEvent(p, "explore", def.objective.target, 1);
    }
  }

  /** Queued quest_update events; the server drains and dispatches these. */
  drain(): QuestUpdate[] {
    return this.pending.splice(0, this.pending.length);
  }

  /** Snapshot for persistence (states only — defs are code). */
  serialize(name: string): QuestState[] {
    return this.statesFor(name);
  }

  /** Restore saved states unless the session already has fresher ones. */
  restore(name: string, states: QuestState[]): void {
    if (this.states.has(name) || states.length === 0) return;
    this.states.set(name, new Map(states.map((s) => [s.questId, { ...s }])));
  }

  /** One-line journal for observation summaries: active progress + offered hooks. */
  summaryFor(p: Player): string {
    const m = this.states.get(p.name);
    const active = [...(m?.values() ?? [])]
      .filter((s) => !s.done)
      .map((s) => ({ s, def: this.defOf(s.questId) }))
      .filter((x): x is { s: QuestState; def: QuestDef } => !!x.def);
    const activeStr = active
      .slice(0, 4)
      .map(({ s, def }) => `"${def.title}" (${s.progress}/${def.objective.qty} — ${describeObjective(def)})`)
      .join("; ");
    const hooks = this.offeredFor(p.name)
      .filter((q) => !m?.has(q.id))
      .slice(0, 2)
      .map((q) => `"${q.title}" from ${q.giver} (id ${q.id}: ${describeObjective(q)}, ${q.rewardShards} shards)`)
      .join("; ");
    return (
      `Active quests: ${activeStr || "none"}.` +
      (hooks ? ` Offered: ${hooks} — accept with quest_accept.` : "")
    );
  }
}
