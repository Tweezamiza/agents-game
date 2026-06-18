import {
  type ItemId,
  type MarketOrder,
  type QuestDef,
  type QuestState,
  RECIPES,
  type Role,
  type StructureKind,
  STRUCTURES,
} from "@agentworld/protocol";
import { iconEl, itemLabel } from "./icons";
import { QuestLog } from "./questlog";

export const ITEMS: ItemId[] = [
  "wood",
  "stone",
  "ember_crystal",
  "plank",
  "brick",
  "stone_axe",
  "ember_charm",
  "hide",
  "fang",
  "golem_core",
  "leather_armor",
  "fang_blade",
  "ward_totem",
];

export type TabId = "satchel" | "quests" | "market" | "build";
const TABS: TabId[] = ["satchel", "quests", "market", "build"];

const CHANNEL_GLYPH = { local: "⟡", world: "✦" } as const;
const MIN_INV_SLOTS = 10;
const INV_COLUMNS = 5;
const TOAST_MS = 3600;
const BANNER_MS = 3200;
const CHAT_LINE_CAP = 200;

export interface HudCallbacks {
  onSay: (channel: "local" | "world", text: string) => void;
  onCraft: (recipeId: string) => void;
  onFill: (orderId: string) => void;
  onPost: (side: "buy" | "sell", item: ItemId, qty: number, price: number) => void;
  onBuild: (structure: StructureKind) => void;
  onQuestAccept: (questId: string) => void;
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing HUD element #${id}`);
  return e as T;
}

export class Hud {
  private channel: "local" | "world" = "local";
  private myId = "";
  private activeTab: TabId = "satchel";

  private readonly hpFill = el<HTMLDivElement>("hp-fill");
  private readonly hpText = el<HTMLDivElement>("hp-text");
  private readonly apFill = el<HTMLDivElement>("ap-fill");
  private readonly apText = el<HTMLDivElement>("ap-text");
  private readonly xpFill = el<HTMLDivElement>("xp-fill");
  private readonly xpText = el<HTMLDivElement>("xp-text");
  private readonly levelBadge = el<HTMLDivElement>("level-badge");
  private readonly levelFlashEl = el<HTMLDivElement>("level-flash");
  private levelFlashTimer = 0;
  private readonly shardsNum = el<HTMLSpanElement>("shards-num");
  private readonly killsNum = el<HTMLSpanElement>("kills-num");
  private readonly deathsNum = el<HTMLSpanElement>("deaths-num");
  private readonly sanctuaryEl = el<HTMLDivElement>("sanctuary");
  private readonly vignetteEl = el<HTMLDivElement>("death-vignette");
  private vignetteTimer = 0;
  private readonly connStatus = el<HTMLDivElement>("conn-status");

  private readonly chatLog = el<HTMLDivElement>("chat-log");
  private readonly chatInput = el<HTMLInputElement>("chat-input");
  private readonly chatChannelBtn = el<HTMLButtonElement>("chat-channel");

  private readonly sideWrap = el<HTMLDivElement>("side-wrap");
  private readonly invList = el<HTMLDivElement>("inv-list");
  private readonly invEmpty = el<HTMLDivElement>("inv-empty");
  private readonly craftList = el<HTMLDivElement>("craft-list");
  private readonly buildList = el<HTMLDivElement>("build-list");
  private readonly marketList = el<HTMLDivElement>("market-list");
  private readonly postSide = el<HTMLSelectElement>("post-side");
  private readonly postItem = el<HTMLSelectElement>("post-item");
  private readonly postQty = el<HTMLInputElement>("post-qty");
  private readonly postPrice = el<HTMLInputElement>("post-price");

  private readonly toastStack = el<HTMLDivElement>("toast-stack");
  private readonly questBannerEl = el<HTMLDivElement>("quest-banner");
  private readonly questBannerTitle: HTMLElement;
  private questBannerTimer = 0;

  private readonly questLog: QuestLog;
  private readonly craftButtons = new Map<string, HTMLButtonElement>();
  private readonly buildButtons = new Map<StructureKind, HTMLButtonElement>();
  private lastInventory: Partial<Record<ItemId, number>> = {};

  constructor(private readonly cb: HudCallbacks) {
    const bannerTitle = this.questBannerEl.querySelector<HTMLElement>(".qb-title");
    if (!bannerTitle) throw new Error("Missing quest banner title element");
    this.questBannerTitle = bannerTitle;

    this.questLog = new QuestLog(
      el<HTMLDivElement>("quest-story"),
      el<HTMLDivElement>("quest-side"),
      (questId) => this.cb.onQuestAccept(questId),
    );

    this.wireChat();
    this.wireTabs();
    this.buildCraftRows();
    this.buildBuildRows();
    this.buildPostForm();
    this.setInventory({}); // empty slot grid until the first server frame
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  private wireChat(): void {
    this.chatChannelBtn.addEventListener("click", () => {
      this.channel = this.channel === "local" ? "world" : "local";
      this.chatChannelBtn.textContent = CHANNEL_GLYPH[this.channel];
      this.chatChannelBtn.title = `Chat channel: ${this.channel} (click to toggle)`;
    });

    const send = (): void => {
      const text = this.chatInput.value.trim();
      if (!text) return;
      this.cb.onSay(this.channel, text);
      this.chatInput.value = "";
    };
    this.chatInput.addEventListener("keydown", (ev) => {
      ev.stopPropagation(); // don't trigger WASD/tab keys while typing
      if (ev.key === "Enter") send();
    });
    el<HTMLButtonElement>("chat-send").addEventListener("click", send);
  }

  private wireTabs(): void {
    for (const tab of TABS) {
      el<HTMLButtonElement>(`tab-${tab}`).addEventListener("click", () => this.openTab(tab));
    }
  }

  /** Craft rows: output icon + name, ingredient icons, Craft button. */
  private buildCraftRows(): void {
    for (const recipe of RECIPES) {
      const row = document.createElement("div");
      row.className = "craft-row";

      const out = document.createElement("span");
      out.className = "r-out";
      out.appendChild(iconEl(recipe.output));
      const name = document.createElement("span");
      name.textContent =
        itemLabel(recipe.output) + (recipe.outputQty > 1 ? ` ×${recipe.outputQty}` : "");
      out.appendChild(name);

      const arrow = document.createElement("span");
      arrow.className = "r-arrow";
      arrow.textContent = "◂";

      const inputs = document.createElement("span");
      inputs.className = "r-in";
      for (const [item, qty] of Object.entries(recipe.inputs)) {
        inputs.appendChild(ingredient(item as ItemId, qty));
      }

      const btn = document.createElement("button");
      btn.className = "action";
      btn.textContent = "Craft";
      btn.setAttribute("aria-label", `Craft ${itemLabel(recipe.output)}`);
      btn.addEventListener("click", () => this.cb.onCraft(recipe.id));
      this.craftButtons.set(recipe.id, btn);

      row.append(out, arrow, inputs, btn);
      this.craftList.appendChild(row);
    }
  }

  /** Build rows: structure icon + name, cost icons, Build button. */
  private buildBuildRows(): void {
    const entries = Object.entries(STRUCTURES) as [
      StructureKind,
      (typeof STRUCTURES)[StructureKind],
    ][];
    for (const [kind, spec] of entries) {
      const row = document.createElement("div");
      row.className = "craft-row";

      const out = document.createElement("span");
      out.className = "r-out";
      out.appendChild(iconEl(kind));
      const name = document.createElement("span");
      name.textContent = spec.name;
      out.appendChild(name);

      const arrow = document.createElement("span");
      arrow.className = "r-arrow";
      arrow.textContent = "◂";

      const inputs = document.createElement("span");
      inputs.className = "r-in";
      for (const [item, qty] of Object.entries(spec.cost)) {
        inputs.appendChild(ingredient(item as ItemId, qty));
      }

      const btn = document.createElement("button");
      btn.className = "action";
      btn.textContent = "Build";
      btn.setAttribute("aria-label", `Build ${spec.name}`);
      btn.addEventListener("click", () => this.cb.onBuild(kind));
      this.buildButtons.set(kind, btn);

      row.append(out, arrow, inputs, btn);
      this.buildList.appendChild(row);
    }
  }

  private buildPostForm(): void {
    for (const item of ITEMS) {
      const opt = document.createElement("option");
      opt.value = item;
      opt.textContent = itemLabel(item);
      this.postItem.appendChild(opt);
    }
    el<HTMLButtonElement>("post-btn").addEventListener("click", () => {
      const side = this.postSide.value === "buy" ? "buy" : "sell";
      const item = this.postItem.value as ItemId;
      const qty = Math.max(1, Math.floor(Number(this.postQty.value) || 1));
      const price = Math.max(1, Math.floor(Number(this.postPrice.value) || 1));
      this.cb.onPost(side, item, qty, price);
    });
  }

  // -------------------------------------------------------------------------
  // Join modal
  // -------------------------------------------------------------------------

  /** Show the name modal; on submit, fade it and play the panel entrance. */
  promptName(): Promise<string> {
    return new Promise((resolve) => {
      const modal = el<HTMLDivElement>("name-modal");
      const input = el<HTMLInputElement>("name-input");
      const btn = el<HTMLButtonElement>("name-btn");
      const submit = (): void => {
        const name = input.value.trim().slice(0, 24);
        if (!name) return;
        modal.style.display = "none";
        document.body.classList.remove("pre-join");
        document.body.classList.add("entered");
        resolve(name);
      };
      btn.addEventListener("click", submit);
      input.addEventListener("keydown", (ev) => {
        ev.stopPropagation();
        if (ev.key === "Enter") submit();
      });
      input.focus();
    });
  }

  setMyId(id: string): void {
    this.myId = id;
  }

  setStatus(text: string): void {
    this.connStatus.textContent = text;
  }

  // -------------------------------------------------------------------------
  // Vitality gauges — compositor-friendly scaleX fills
  // -------------------------------------------------------------------------

  setAp(ap: number, apMax: number): void {
    const frac = apMax > 0 ? Math.max(0, Math.min(1, ap / apMax)) : 0;
    this.apFill.style.transform = `scaleX(${frac})`;
    this.apText.textContent = `${Math.floor(ap)} / ${apMax}`;
  }

  /** HP gauge: sage at health, gold when worn, ember-red when dire. */
  setHp(hp: number, hpMax: number): void {
    const frac = hpMax > 0 ? Math.max(0, Math.min(1, hp / hpMax)) : 0;
    this.hpFill.style.transform = `scaleX(${frac})`;
    this.hpFill.classList.toggle("low", frac < 0.35);
    this.hpFill.classList.toggle("mid", frac >= 0.35 && frac < 0.7);
    this.hpText.textContent = `${Math.max(0, Math.floor(hp))} / ${hpMax}`;
  }

  setKD(kills: number, deaths: number): void {
    this.killsNum.textContent = `${kills}`;
    this.deathsNum.textContent = `${deaths}`;
  }

  /** XP bar + level seal. xpNext of 0 means the level cap is reached. */
  setXp(level: number, xp: number, xpNext: number): void {
    const frac = xpNext > 0 ? Math.max(0, Math.min(1, xp / xpNext)) : 1;
    this.xpFill.style.transform = `scaleX(${frac})`;
    this.xpText.textContent = xpNext > 0 ? `${xp} / ${xpNext} XP` : "MAX";
    this.levelBadge.textContent = `${level}`;
  }

  /** Golden flash banner on level-up. */
  levelFlash(level: number): void {
    this.levelFlashEl.textContent = `✦ Level ${level} ✦`;
    this.levelFlashEl.classList.add("active");
    window.clearTimeout(this.levelFlashTimer);
    this.levelFlashTimer = window.setTimeout(
      () => this.levelFlashEl.classList.remove("active"),
      2400,
    );
  }

  setSafeZone(inSafeZone: boolean): void {
    this.sanctuaryEl.style.display = inSafeZone ? "block" : "none";
  }

  /** Brief red vignette when we are slain. */
  flashDeathVignette(): void {
    this.vignetteEl.classList.add("active");
    window.clearTimeout(this.vignetteTimer);
    this.vignetteTimer = window.setTimeout(
      () => this.vignetteEl.classList.remove("active"),
      900,
    );
  }

  setShards(shards: number): void {
    this.shardsNum.textContent = `${shards}`;
  }

  // -------------------------------------------------------------------------
  // Journal sidebar — tabs
  // -------------------------------------------------------------------------

  /** Open a tab; pressing the active tab's key (or clicking it) collapses. */
  openTab(tab: TabId): void {
    const collapsed = this.sideWrap.classList.contains("collapsed");
    if (!collapsed && tab === this.activeTab) {
      this.closeSidebar();
      return;
    }
    this.sideWrap.classList.remove("collapsed");
    this.setTab(tab);
  }

  closeSidebar(): void {
    this.sideWrap.classList.add("collapsed");
  }

  /** Legacy toggle (kept for API compatibility): collapse/expand journal. */
  toggleSidePanel(): void {
    this.sideWrap.classList.toggle("collapsed");
  }

  private setTab(tab: TabId): void {
    this.activeTab = tab;
    for (const t of TABS) {
      el<HTMLButtonElement>(`tab-${t}`).setAttribute("aria-selected", t === tab ? "true" : "false");
      el<HTMLDivElement>(`pane-${t}`).hidden = t !== tab;
    }
  }

  // -------------------------------------------------------------------------
  // Satchel — icon grid + affordability
  // -------------------------------------------------------------------------

  setInventory(inv: Partial<Record<ItemId, number>>): void {
    this.lastInventory = inv;
    this.refreshAffordability();
    this.invList.replaceChildren();
    const owned = ITEMS.filter((item) => (inv[item] ?? 0) > 0);
    this.invEmpty.style.display = owned.length === 0 ? "block" : "none";

    const filled = Math.max(MIN_INV_SLOTS, Math.ceil(owned.length / INV_COLUMNS) * INV_COLUMNS);
    for (let i = 0; i < filled; i++) {
      const slot = document.createElement("div");
      slot.className = "slot";
      const item = owned[i];
      if (item) {
        const qty = inv[item] ?? 0;
        slot.title = `${itemLabel(item)} ×${qty}`;
        slot.setAttribute("aria-label", `${itemLabel(item)}, quantity ${qty}`);
        slot.appendChild(iconEl(item));
        const badge = document.createElement("span");
        badge.className = "qty";
        badge.textContent = `${qty}`;
        slot.appendChild(badge);
      } else {
        slot.classList.add("vacant");
      }
      this.invList.appendChild(slot);
    }
  }

  /** Grey out craft/build buttons the satchel can't afford. */
  private refreshAffordability(): void {
    for (const recipe of RECIPES) {
      const btn = this.craftButtons.get(recipe.id);
      if (!btn) continue;
      btn.disabled = !this.canAfford(recipe.inputs);
    }
    for (const [kind, btn] of this.buildButtons) {
      btn.disabled = !this.canAfford(STRUCTURES[kind].cost);
    }
  }

  private canAfford(cost: Partial<Record<ItemId, number>>): boolean {
    return Object.entries(cost).every(
      ([item, qty]) => (this.lastInventory[item as ItemId] ?? 0) >= qty,
    );
  }

  // -------------------------------------------------------------------------
  // Market
  // -------------------------------------------------------------------------

  setMarket(orders: MarketOrder[]): void {
    this.marketList.replaceChildren();
    if (orders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "No open orders.";
      this.marketList.appendChild(empty);
      return;
    }
    for (const order of orders) {
      const row = document.createElement("div");
      row.className = "order-row";

      const side = document.createElement("span");
      side.className = `o-side ${order.side}`;
      side.textContent = order.side.toUpperCase();

      const body = document.createElement("span");
      body.className = "o-body";
      body.appendChild(iconEl(order.item));
      const what = document.createElement("span");
      what.textContent = `${order.qty} ${itemLabel(order.item)}`;
      body.appendChild(what);
      const price = document.createElement("span");
      price.className = "o-price";
      price.appendChild(iconEl("shard"));
      const priceNum = document.createElement("span");
      priceNum.textContent = `${order.price}`;
      price.appendChild(priceNum);
      body.appendChild(price);
      const owner = document.createElement("span");
      owner.className = "o-owner";
      owner.textContent = order.ownerName;
      body.appendChild(owner);

      row.append(side, body);
      if (order.ownerId !== this.myId) {
        const btn = document.createElement("button");
        btn.className = "action";
        btn.textContent = "Fill";
        btn.setAttribute(
          "aria-label",
          `Fill ${order.side} order: ${order.qty} ${itemLabel(order.item)} at ${order.price} shards`,
        );
        btn.addEventListener("click", () => this.cb.onFill(order.id));
        row.appendChild(btn);
      }
      this.marketList.appendChild(row);
    }
  }

  // -------------------------------------------------------------------------
  // Quest journal + quest fanfare
  // -------------------------------------------------------------------------

  /** Offered quest definitions, from welcome/observation frames. */
  setQuestDefs(defs: QuestDef[]): void {
    this.questLog.setDefs(defs);
  }

  /** Accepted-quest progress, from PlayerPrivate.quests. */
  setQuestStates(states: QuestState[]): void {
    this.questLog.setStates(states);
  }

  /** A quest_update: refresh journal, toast the line, fanfare on completion. */
  applyQuestUpdate(def: QuestDef, state: QuestState, message: string, completed: boolean): void {
    this.questLog.upsert(def, state);
    this.toast(message);
    if (completed) this.questBanner(def.title);
  }

  /** Centre-top "Quest Complete" sweep with rising embers. */
  private questBanner(title: string): void {
    this.questBannerTitle.textContent = title;
    this.questBannerEl.classList.remove("active");
    // Force a reflow so re-adding the class restarts the CSS animations.
    void this.questBannerEl.offsetWidth;
    this.questBannerEl.classList.add("active");
    window.clearTimeout(this.questBannerTimer);
    this.questBannerTimer = window.setTimeout(
      () => this.questBannerEl.classList.remove("active"),
      BANNER_MS,
    );
  }

  /** Transient centre-top toast (quest progress lines etc.). */
  toast(text: string): void {
    const node = document.createElement("div");
    node.className = "toast";
    node.textContent = text;
    this.toastStack.appendChild(node);
    requestAnimationFrame(() => node.classList.add("show"));
    window.setTimeout(() => {
      node.classList.remove("show");
      window.setTimeout(() => node.remove(), 350);
    }, TOAST_MS);
  }

  // -------------------------------------------------------------------------
  // Chronicle
  // -------------------------------------------------------------------------

  addChat(channel: "local" | "world", name: string, role: Role, text: string): void {
    const line = document.createElement("div");
    line.className = "line";
    const ch = document.createElement("span");
    ch.className = "ch";
    ch.textContent = CHANNEL_GLYPH[channel];
    ch.title = `${channel} channel`;
    const who = document.createElement("span");
    who.className = role === "agent" ? "who agent" : "who";
    who.textContent = role === "agent" ? `${name} ⚙ ` : `${name} `;
    const body = document.createElement("span");
    body.textContent = text;
    line.append(ch, who, body);
    this.appendLine(line);
  }

  /** Combat line for the chronicle, e.g. "Bandit hit Willow for 12". */
  addCombat(text: string): void {
    const line = document.createElement("div");
    line.className = "line combat";
    line.textContent = `⚔ ${text}`;
    this.appendLine(line);
  }

  /** Muted log line for action_result messages. */
  addLog(text: string, ok: boolean): void {
    const line = document.createElement("div");
    line.className = ok ? "line sys" : "line err";
    line.textContent = text;
    this.appendLine(line);
  }

  addError(text: string): void {
    const line = document.createElement("div");
    line.className = "line err";
    line.textContent = `⚠ ${text}`;
    this.appendLine(line);
  }

  private appendLine(line: HTMLElement): void {
    this.chatLog.appendChild(line);
    while (this.chatLog.childElementCount > CHAT_LINE_CAP) {
      this.chatLog.firstElementChild?.remove();
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }
}

/** Small "icon ×qty" chunk used by craft and build ingredient lists. */
function ingredient(item: ItemId, qty: number): HTMLElement {
  const span = document.createElement("span");
  span.className = "ing";
  span.title = `${qty} ${itemLabel(item)}`;
  span.appendChild(iconEl(item));
  const n = document.createElement("span");
  n.textContent = `${qty}`;
  span.appendChild(n);
  return span;
}
