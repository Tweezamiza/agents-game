import type { ItemId, QuestDef, QuestState } from "@agentworld/protocol";
import { iconEl, itemLabel } from "./icons";

/** Verb shown before the objective target, per objective kind. */
const OBJECTIVE_VERB: Record<QuestDef["objective"]["kind"], string> = {
  gather: "Gather",
  craft: "Craft",
  kill: "Slay",
  build: "Build",
  explore: "Explore",
};

const EMPTY_STORY = "The elders have no word for you yet.";
const EMPTY_SIDE = "The notice board is bare.";

/**
 * The quest journal pane: story campaign ("The Chronicle of Emberfall")
 * plus the rotating side-quest notice board. Joins static QuestDefs
 * (offered to this player) with per-player QuestStates (accepted only).
 */
export class QuestLog {
  private defs = new Map<string, QuestDef>();
  private states = new Map<string, QuestState>();

  constructor(
    private readonly storyEl: HTMLElement,
    private readonly sideEl: HTMLElement,
    private readonly onAccept: (questId: string) => void,
  ) {}

  /** Replace the offered quest definitions (welcome/observation). */
  setDefs(defs: QuestDef[]): void {
    this.defs = new Map(defs.map((d) => [d.id, d]));
    this.render();
  }

  /** Replace the player's accepted-quest states (PlayerPrivate.quests). */
  setStates(states: QuestState[]): void {
    this.states = new Map(states.map((s) => [s.questId, s]));
    this.render();
  }

  /** Apply a single quest_update (accept / progress / completion). */
  upsert(def: QuestDef, state: QuestState): void {
    this.defs.set(def.id, def);
    this.states.set(state.questId, state);
    this.render();
  }

  /** Count of accepted-but-unfinished quests (journal tab nudge). */
  activeCount(): number {
    let n = 0;
    for (const s of this.states.values()) if (!s.done) n++;
    return n;
  }

  private render(): void {
    const story: QuestDef[] = [];
    const side: QuestDef[] = [];
    for (const def of this.defs.values()) (def.side ? side : story).push(def);
    this.renderSection(this.storyEl, story, EMPTY_STORY);
    this.renderSection(this.sideEl, side, EMPTY_SIDE);
  }

  private renderSection(el: HTMLElement, defs: QuestDef[], emptyText: string): void {
    el.replaceChildren();
    if (defs.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = emptyText;
      el.appendChild(empty);
      return;
    }
    for (const def of defs) el.appendChild(this.questCard(def));
  }

  private questCard(def: QuestDef): HTMLElement {
    const state = this.states.get(def.id);
    const card = document.createElement("article");
    card.className = "quest";
    if (!state) card.classList.add("offered");
    if (state?.done) card.classList.add("done");

    // Title row + status chip
    const head = document.createElement("div");
    head.className = "q-head";
    const title = document.createElement("span");
    title.className = "q-title";
    title.textContent = def.title;
    const chip = document.createElement("span");
    chip.className = "q-chip";
    if (state?.done) {
      chip.classList.add("done");
      chip.textContent = "✓ Complete";
    } else if (state) {
      chip.textContent = `${Math.min(state.progress, def.objective.qty)}/${def.objective.qty}`;
    } else {
      chip.classList.add("new");
      chip.textContent = "New";
    }
    head.append(title, chip);
    card.appendChild(head);

    // Giver + story
    const giver = document.createElement("p");
    giver.className = "q-giver";
    giver.textContent = `— ${def.giver}`;
    card.appendChild(giver);
    const story = document.createElement("p");
    story.className = "q-story";
    story.textContent = def.story;
    card.appendChild(story);

    // Objective: "Slay wolf — 2/3" + mini progress bar
    const obj = document.createElement("div");
    obj.className = "q-obj";
    const progress = Math.min(state?.progress ?? 0, def.objective.qty);
    const objLabel = document.createElement("span");
    objLabel.textContent =
      `${OBJECTIVE_VERB[def.objective.kind]} ${itemLabel(def.objective.target)} — ${progress}/${def.objective.qty}`;
    const bar = document.createElement("span");
    bar.className = "q-bar";
    const fill = document.createElement("i");
    const frac = def.objective.qty > 0 ? progress / def.objective.qty : 0;
    fill.style.transform = `scaleX(${Math.max(0, Math.min(1, frac))})`;
    bar.appendChild(fill);
    obj.append(objLabel, bar);
    card.appendChild(obj);

    // Rewards: shards ◆, XP, item icons
    const rewards = document.createElement("div");
    rewards.className = "q-rewards";
    if (def.rewardShards > 0) {
      rewards.appendChild(rewardChunk("shard", `${def.rewardShards}`, "shards"));
    }
    if (def.rewardXp > 0) {
      const xp = document.createElement("span");
      xp.className = "rw rw-xp";
      xp.textContent = `${def.rewardXp} XP`;
      rewards.appendChild(xp);
    }
    for (const [item, qty] of Object.entries(def.rewardItems ?? {})) {
      rewards.appendChild(rewardChunk(item as ItemId, `×${qty}`, itemLabel(item)));
    }
    if (rewards.childElementCount > 0) card.appendChild(rewards);

    // Accept button for offered-but-unaccepted quests
    if (!state) {
      const accept = document.createElement("button");
      accept.className = "action q-accept";
      accept.textContent = "Accept";
      accept.setAttribute("aria-label", `Accept quest: ${def.title}`);
      accept.addEventListener("click", () => this.onAccept(def.id));
      card.appendChild(accept);
    }
    return card;
  }
}

function rewardChunk(symbolId: string, text: string, label: string): HTMLElement {
  const span = document.createElement("span");
  span.className = "rw";
  span.title = label;
  span.appendChild(iconEl(symbolId));
  const t = document.createElement("span");
  t.textContent = text;
  span.appendChild(t);
  return span;
}
