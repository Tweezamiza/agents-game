import {
  type ItemId,
  type MarketOrder,
  RECIPES,
  type Role,
} from "@agentworld/protocol";

export const ITEMS: ItemId[] = [
  "wood",
  "stone",
  "ember_crystal",
  "plank",
  "brick",
  "stone_axe",
  "ember_charm",
];

export interface HudCallbacks {
  onSay: (channel: "local" | "world", text: string) => void;
  onCraft: (recipeId: string) => void;
  onFill: (orderId: string) => void;
  onPost: (side: "buy" | "sell", item: ItemId, qty: number, price: number) => void;
}

function el<T extends HTMLElement>(id: string): T {
  const e = document.getElementById(id);
  if (!e) throw new Error(`Missing HUD element #${id}`);
  return e as T;
}

export class Hud {
  private channel: "local" | "world" = "local";
  private myId = "";

  private readonly apFill = el<HTMLDivElement>("ap-fill");
  private readonly apText = el<HTMLDivElement>("ap-text");
  private readonly shardsEl = el<HTMLDivElement>("shards");
  private readonly connStatus = el<HTMLDivElement>("conn-status");
  private readonly chatLog = el<HTMLDivElement>("chat-log");
  private readonly chatInput = el<HTMLInputElement>("chat-input");
  private readonly chatChannelBtn = el<HTMLButtonElement>("chat-channel");
  private readonly sidePanel = el<HTMLDivElement>("side-panel");
  private readonly sideToggle = el<HTMLButtonElement>("side-toggle");
  private readonly invList = el<HTMLDivElement>("inv-list");
  private readonly craftList = el<HTMLDivElement>("craft-list");
  private readonly marketList = el<HTMLDivElement>("market-list");
  private readonly postSide = el<HTMLSelectElement>("post-side");
  private readonly postItem = el<HTMLSelectElement>("post-item");
  private readonly postQty = el<HTMLInputElement>("post-qty");
  private readonly postPrice = el<HTMLInputElement>("post-price");

  constructor(private readonly cb: HudCallbacks) {
    this.chatChannelBtn.addEventListener("click", () => {
      this.channel = this.channel === "local" ? "world" : "local";
      this.chatChannelBtn.textContent = this.channel;
    });

    this.chatInput.addEventListener("keydown", (ev) => {
      ev.stopPropagation(); // don't trigger WASD while typing
      if (ev.key !== "Enter") return;
      const text = this.chatInput.value.trim();
      if (!text) return;
      this.cb.onSay(this.channel, text);
      this.chatInput.value = "";
    });

    this.sideToggle.addEventListener("click", () => {
      this.sidePanel.classList.toggle("collapsed");
    });

    // Craft buttons: one per recipe, inputs shown.
    for (const recipe of RECIPES) {
      const row = document.createElement("div");
      row.className = "craft-row";
      const inputs = Object.entries(recipe.inputs)
        .map(([item, qty]) => `${qty} ${item.replace(/_/g, " ")}`)
        .join(" + ");
      const label = document.createElement("span");
      label.innerHTML = `<b>${recipe.output.replace(/_/g, " ")}</b>${
        recipe.outputQty > 1 ? ` ×${recipe.outputQty}` : ""
      } <span class="inputs">← ${inputs}</span>`;
      const btn = document.createElement("button");
      btn.className = "action";
      btn.textContent = "Craft";
      btn.addEventListener("click", () => this.cb.onCraft(recipe.id));
      row.append(label, btn);
      this.craftList.appendChild(row);
    }

    // Item options for the post-order form.
    for (const item of ITEMS) {
      const opt = document.createElement("option");
      opt.value = item;
      opt.textContent = item.replace(/_/g, " ");
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

  /** Show the name modal and resolve with the entered name. */
  promptName(): Promise<string> {
    return new Promise((resolve) => {
      const modal = el<HTMLDivElement>("name-modal");
      const input = el<HTMLInputElement>("name-input");
      const btn = el<HTMLButtonElement>("name-btn");
      const submit = () => {
        const name = input.value.trim().slice(0, 24);
        if (!name) return;
        modal.style.display = "none";
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

  setAp(ap: number, apMax: number): void {
    const pct = apMax > 0 ? Math.max(0, Math.min(100, (ap / apMax) * 100)) : 0;
    this.apFill.style.width = `${pct}%`;
    this.apText.textContent = `${Math.floor(ap)} / ${apMax}`;
  }

  setShards(shards: number): void {
    this.shardsEl.textContent = `◆ Shards: ${shards}`;
  }

  setInventory(inv: Partial<Record<ItemId, number>>): void {
    this.invList.replaceChildren();
    const entries = Object.entries(inv).filter(([, qty]) => (qty ?? 0) > 0);
    if (entries.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "empty satchel";
      this.invList.appendChild(empty);
      return;
    }
    for (const [item, qty] of entries) {
      const row = document.createElement("div");
      row.className = "item";
      const name = document.createElement("span");
      name.textContent = item.replace(/_/g, " ");
      const count = document.createElement("span");
      count.className = "qty";
      count.textContent = `×${qty}`;
      row.append(name, count);
      this.invList.appendChild(row);
    }
  }

  setMarket(orders: MarketOrder[]): void {
    this.marketList.replaceChildren();
    if (orders.length === 0) {
      const empty = document.createElement("div");
      empty.className = "empty";
      empty.textContent = "no open orders";
      this.marketList.appendChild(empty);
      return;
    }
    for (const order of orders) {
      const row = document.createElement("div");
      row.className = "order-row";
      const label = document.createElement("span");
      const side = document.createElement("span");
      side.className = order.side;
      side.textContent = order.side.toUpperCase();
      label.append(
        side,
        ` ${order.qty} ${order.item.replace(/_/g, " ")} @ ${order.price}◆ — ${order.ownerName}`,
      );
      row.appendChild(label);
      if (order.ownerId !== this.myId) {
        const btn = document.createElement("button");
        btn.className = "action";
        btn.textContent = "Fill";
        btn.addEventListener("click", () => this.cb.onFill(order.id));
        row.appendChild(btn);
      }
      this.marketList.appendChild(row);
    }
  }

  addChat(channel: "local" | "world", name: string, role: Role, text: string): void {
    const line = document.createElement("div");
    line.className = "line";
    const ch = document.createElement("span");
    ch.className = "ch";
    ch.textContent = `[${channel}] `;
    const who = document.createElement("span");
    who.className = role === "agent" ? "who agent" : "who";
    who.textContent = role === "agent" ? `${name} [agent]: ` : `${name}: `;
    const body = document.createElement("span");
    body.textContent = text;
    line.append(ch, who, body);
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
    while (this.chatLog.childElementCount > 200) {
      this.chatLog.firstElementChild?.remove();
    }
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }
}
