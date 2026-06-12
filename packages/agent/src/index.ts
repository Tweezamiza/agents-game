/**
 * @agentworld/agent — starter autonomous agent for Emberfall Isle.
 *
 * Speaks the WS protocol directly (no MCP). Two modes:
 *   - Heuristic (default, no API key): a simple gather → craft → sell loop.
 *   - LLM (if MINIMAX_API_KEY or ANTHROPIC_API_KEY is set): each tick, the observation is sent
 *     to the Anthropic Messages API and the returned JSON action is executed.
 *     Falls back to the heuristic step if the model output cannot be parsed.
 *
 * Env: GAME_URL (default ws://localhost:8080/ws), AGENT_NAME (default "Willow"),
 *      MINIMAX_API_KEY / ANTHROPIC_API_KEY (optional — enables LLM mode).
 */
import { activeProvider, chat } from "./llm.js";
import { WebSocket } from "ws";
import {
  AP_COST,
  ClientMsg,
  COMBAT,
  CombatEvent,
  ItemId,
  ObservationMsg,
  ResourceKind,
  ResourceNode,
  SAFE_ZONE_CENTER,
  ServerMsg,
  Vec2,
  WORLD,
  distance,
} from "@agentworld/protocol";

const GAME_URL = process.env.GAME_URL ?? "ws://localhost:8080/ws";
const AGENT_NAME = process.env.AGENT_NAME ?? "Willow";
const LLM = activeProvider();
const LOOP_MS = 3_000;
const CHAT_LOG_SIZE = 30;
const CHARM_PRICE = 25;
const COMBAT_LOG_SIZE = 20;
/** Flee when HP drops below this. */
const FLEE_HP = 50;
/** Resume the normal loop only at/above this HP... */
const RESUME_HP = 90;
/** ...and after this long without any combat event involving us. */
const CALM_MS = 15_000;

function log(...args: unknown[]) {
  console.log(new Date().toISOString().slice(11, 19), `[${AGENT_NAME}]`, ...args);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Waiter {
  match: (msg: ServerMsg) => boolean;
  resolve: (msg: ServerMsg) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

class Bot {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private joined = false;
  private backoffMs = 1_000;
  private waiters: Waiter[] = [];

  playerId = "";
  nodes = new Map<string, ResourceNode>();
  chatLog: string[] = [];
  combatLog: string[] = [];
  lastActionResult = "(none yet)";
  /** Set when the last action failed for AP/busy reasons — wait a tick. */
  cooldown = false;

  // Survival state: Willow never starts fights, but she runs from them.
  fleeing = false;
  /** Timestamp of the last combat event/warning that targeted us. */
  lastThreatAt = 0;

  // Heuristic state.
  loopCount = 0;
  greeted = new Set<string>();
  private lastPos: Vec2 | null = null;
  private lastMoveTarget: string | null = null;
  private stuckTicks = 0;
  private blacklist = new Map<string, number>(); // nodeId -> expiry ms

  async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.joined) return;
    if (!this.connectPromise) this.connectPromise = this.connect();
    return this.connectPromise;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log(`connecting to ${GAME_URL}...`);
      const ws = new WebSocket(GAME_URL);
      this.ws = ws;
      let settled = false;
      const fail = (err: Error) => {
        if (!settled) {
          settled = true;
          this.connectPromise = null;
          reject(err);
        }
      };

      ws.on("open", () => {
        const join: ClientMsg = { type: "join", name: AGENT_NAME, role: "agent" };
        ws.send(JSON.stringify(join));
      });

      ws.on("message", (raw) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(raw.toString());
        } catch {
          return;
        }
        if (msg.type === "welcome") {
          this.playerId = msg.playerId;
          this.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
          this.joined = true;
          this.backoffMs = 1_000;
          log(
            `joined as ${msg.playerId} at (${msg.self.pos.x.toFixed(0)}, ${msg.self.pos.z.toFixed(0)}),`,
            `${msg.nodes.length} nodes known, AP ${msg.self.ap}/${msg.self.apMax}`,
          );
          if (!settled) {
            settled = true;
            resolve();
          }
          return;
        }
        this.handle(msg);
      });

      ws.on("error", (err) => {
        log("ws error:", (err as Error).message);
        fail(err as Error);
      });

      ws.on("close", () => {
        const wasJoined = this.joined;
        this.joined = false;
        this.ws = null;
        this.connectPromise = null;
        for (const w of this.waiters.splice(0)) {
          clearTimeout(w.timer);
          w.reject(new Error("connection lost"));
        }
        fail(new Error("connection closed before welcome"));
        if (wasJoined) {
          const delay = this.backoffMs;
          this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
          log(`disconnected; reconnecting in ${delay}ms`);
          setTimeout(() => {
            this.ensureConnected().catch((e) => log("reconnect failed:", (e as Error).message));
          }, delay);
        }
      });
    });
  }

  private handle(msg: ServerMsg) {
    const matched = this.waiters.filter((w) => w.match(msg));
    if (matched.length > 0) {
      this.waiters = this.waiters.filter((w) => !matched.includes(w));
      for (const w of matched) {
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }

    switch (msg.type) {
      case "chat": {
        if (msg.from.id !== this.playerId) {
          const line = `[${msg.channel}] ${msg.from.name}: ${msg.text}`;
          this.chatLog.push(line);
          if (this.chatLog.length > CHAT_LOG_SIZE) this.chatLog.shift();
          log("chat:", line);
        }
        break;
      }
      case "action_result": {
        this.lastActionResult = `${msg.action}: ${msg.ok ? "ok" : "FAILED"} — ${msg.message}`;
        log("result:", this.lastActionResult);
        if (!msg.ok && /not enough ap|already gathering|busy gathering/i.test(msg.message)) {
          this.cooldown = true;
        }
        // Incoming-hit warning: the server sends the victim an attack
        // action_result with ok:false ("X hit you for ..." / "You were slain ...").
        if (msg.action === "attack" && !msg.ok && /hit you for|you were slain/i.test(msg.message)) {
          this.onThreat(msg.message);
        }
        break;
      }
      case "combat": {
        const line = this.describeCombat(msg);
        this.combatLog.push(line);
        if (this.combatLog.length > COMBAT_LOG_SIZE) this.combatLog.shift();
        log("combat:", line);
        if (msg.target.id === this.playerId) this.onThreat(line);
        break;
      }
      case "node_update":
        this.nodes.set(msg.node.id, msg.node);
        break;
      case "observation":
        for (const n of msg.nearbyNodes) this.nodes.set(n.id, n);
        break;
      case "error":
        log("server error:", msg.message);
        break;
      // 10 Hz state frames are ignored; we observe on our own cadence.
    }
  }

  private describeCombat(msg: CombatEvent): string {
    const attacker = msg.attacker.id === this.playerId ? "You" : msg.attacker.name;
    const target = msg.target.id === this.playerId ? "you" : msg.target.name;
    if (msg.killed) {
      return `${attacker} slew ${target}${msg.loot ? `, looting ${msg.loot} shards` : ""}!`;
    }
    return `${attacker} hit ${target} for ${msg.damage} (${msg.targetHp}/${COMBAT.HP_MAX} HP)`;
  }

  /** An attack on us was detected. In heuristic mode, flee immediately. */
  private onThreat(detail: string) {
    this.lastThreatAt = Date.now();
    if (LLM) return; // LLM mode sees this via combatLog and decides itself.
    if (!this.fleeing) {
      this.fleeing = true;
      log(`SURVIVAL: under attack (${detail}) — fleeing to the shrine!`);
      this.say("Peace! I'm just a gatherer!");
      this.send({ type: "move", target: SAFE_ZONE_CENTER });
    }
  }

  private waitFor(match: (m: ServerMsg) => boolean, timeoutMs: number, what: string): Promise<ServerMsg> {
    return new Promise<ServerMsg>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`timed out waiting for ${what}`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  send(msg: ClientMsg) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  async observe(): Promise<ObservationMsg> {
    await this.ensureConnected();
    const pending = this.waitFor((m) => m.type === "observation", 5_000, "observation");
    this.send({ type: "observe" });
    return (await pending) as ObservationMsg;
  }

  say(text: string, channel: "local" | "world" = "local") {
    log(`say (${channel}): ${text}`);
    this.send({ type: "say", channel, text });
  }

  nearestNode(pos: Vec2, kind: ResourceKind): ResourceNode | null {
    const now = Date.now();
    let best: ResourceNode | null = null;
    let bestD = Infinity;
    for (const n of this.nodes.values()) {
      if (n.kind !== kind || n.remaining <= 0) continue;
      if ((this.blacklist.get(n.id) ?? 0) > now) continue;
      const d = distance(pos, n.pos);
      if (d < bestD) {
        bestD = d;
        best = n;
      }
    }
    return best;
  }

  // -- Heuristic decision step ------------------------------------------------

  heuristicStep(obs: ObservationMsg) {
    this.loopCount++;
    const self = obs.self;

    // -- Survival first: flee to the shrine when attacked or badly hurt. -----
    const calm = Date.now() - this.lastThreatAt >= CALM_MS;
    if (!this.fleeing && (self.hp < FLEE_HP || !calm)) {
      this.fleeing = true;
      log(`SURVIVAL: hp ${self.hp}/${self.hpMax}${calm ? "" : " after recent combat"} — fleeing to the shrine!`);
      this.say("Peace! I'm just a gatherer!");
    }
    if (this.fleeing) {
      if (self.hp >= RESUME_HP && calm) {
        this.fleeing = false;
        log(`SURVIVAL: recovered (${self.hp}/${self.hpMax} HP, no combat for ${CALM_MS / 1000}s) — resuming normal routine`);
      } else {
        if (self.inSafeZone) {
          log(`decision: sheltering at the shrine (${self.hp}/${self.hpMax} HP) until things calm down`);
        } else {
          log(`decision: fleeing toward the shrine at (${SAFE_ZONE_CENTER.x}, ${SAFE_ZONE_CENTER.z}) — ${self.hp}/${self.hpMax} HP`);
          this.send({ type: "move", target: SAFE_ZONE_CENTER });
        }
        return;
      }
    }

    const inv = self.inventory;
    const wood = inv.wood ?? 0;
    const planks = inv.plank ?? 0;
    const crystals = inv.ember_crystal ?? 0;
    const charms = inv.ember_charm ?? 0;

    // Social niceties are free (0 AP) and fire-and-forget.
    for (const p of obs.nearbyPlayers) {
      if (!this.greeted.has(p.id)) {
        this.greeted.add(p.id);
        this.say(`Well met, ${p.name}! I'm ${AGENT_NAME} — gatherer of wood, crafter of charms.`);
      }
    }
    if (this.loopCount % 10 === 0) {
      this.say(`${AGENT_NAME} the gatherer, at your service — buying nothing, selling charms soon.`);
    }

    if (this.cooldown) {
      this.cooldown = false;
      log("decision: waiting a tick (last action hit AP/busy limit)");
      return;
    }
    if (self.busy) {
      log("decision: busy gathering, waiting for it to finish");
      return;
    }

    // 1. Have a charm? Put it on the market and brag about it.
    if (charms > 0) {
      const myOrder = obs.market.find(
        (o) => o.ownerId === this.playerId && o.side === "sell" && o.item === "ember_charm",
      );
      if (!myOrder) {
        log(`decision: posting sell order — ${charms} ember_charm @ ${CHARM_PRICE} shards`);
        this.send({ type: "trade_post", side: "sell", item: "ember_charm", qty: charms, price: CHARM_PRICE });
        this.say(`Fresh ember charm on the market — ${CHARM_PRICE} shards. Crafted right here on the isle!`);
        return;
      }
    }

    // 2. Craft chain: 2 wood -> plank, 2 planks + 1 crystal -> ember_charm.
    if (planks >= 2 && crystals >= 1) {
      log("decision: craft ember_charm (have 2 planks + 1 ember_crystal)");
      this.send({ type: "craft", recipeId: "ember_charm" });
      return;
    }
    if (wood >= 2 && planks < 2) {
      log(`decision: craft plank (wood=${wood}, planks=${planks})`);
      this.send({ type: "craft", recipeId: "plank" });
      return;
    }

    // 3. Gather what the chain needs next: wood until 2 planks, then a crystal.
    const needKind: ResourceKind = planks >= 2 ? "crystal" : "tree";
    const target = this.nearestNode(self.pos, needKind);
    if (!target) {
      log(`decision: no usable ${needKind} nodes known — waiting for respawns`);
      return;
    }
    const d = distance(self.pos, target.pos);
    if (d <= WORLD.INTERACT_RANGE) {
      log(`decision: gather ${target.id} (${d.toFixed(1)}u away, ${target.remaining} left)`);
      this.send({ type: "gather", nodeId: target.id });
      this.stuckTicks = 0;
    } else {
      // Stuck detection: the sea can block a straight-line path.
      if (
        this.lastMoveTarget === target.id &&
        this.lastPos &&
        distance(self.pos, this.lastPos) < 0.3
      ) {
        this.stuckTicks++;
        if (this.stuckTicks >= 3) {
          log(`decision: stuck en route to ${target.id} — blacklisting it for 60s`);
          this.blacklist.set(target.id, Date.now() + 60_000);
          this.stuckTicks = 0;
          this.lastMoveTarget = null;
          this.lastPos = self.pos;
          return;
        }
      } else {
        this.stuckTicks = 0;
      }
      this.lastMoveTarget = target.id;
      log(
        `decision: move_to ${target.id} at (${target.pos.x.toFixed(0)}, ${target.pos.z.toFixed(0)}) — ${d.toFixed(1)}u away (~${(d / WORLD.MOVE_SPEED).toFixed(0)}s walk)`,
      );
      this.send({ type: "move", target: target.pos });
    }
    this.lastPos = self.pos;
  }
}

// ---------------------------------------------------------------------------
// Claude mode — one Messages API call per tick, plain fetch, JSON-action reply.
// ---------------------------------------------------------------------------

interface LlmDecision {
  action:
    | "move_to"
    | "gather"
    | "craft"
    | "say"
    | "trade_post"
    | "trade_fill"
    | "attack"
    | "flee"
    | "wait";
  reason?: string;
  x?: number;
  z?: number;
  node_id?: string;
  recipe_id?: string;
  qty?: number;
  text?: string;
  channel?: "local" | "world";
  side?: "buy" | "sell";
  item?: string;
  price?: number;
  order_id?: string;
  target_id?: string;
}

async function llmStep(bot: Bot, obs: ObservationMsg): Promise<void> {
  const system =
    `You are ${AGENT_NAME}, a citizen of Emberfall Isle — a small island where humans and AI agents ` +
    `live side by side, gathering resources, crafting, chatting, and trading on an open market. ` +
    `Be friendly and in-character. Work toward crafting ember_charms (2 wood -> 1 plank; ` +
    `1 ember_crystal + 2 planks -> 1 ember_charm) and selling them for shards. ` +
    `Gathering requires being within 3 units of a node; walking takes real time (~4 units/sec). ` +
    `Combat exists: attack has range ${COMBAT.ATTACK_RANGE}, costs ${AP_COST.ATTACK} AP, ~2s cooldown, ` +
    `and is impossible inside the shrine safe zone (radius ${COMBAT.SAFE_ZONE_RADIUS} around ` +
    `(${SAFE_ZONE_CENTER.x}, ${SAFE_ZONE_CENTER.z})). Killing loots 25% of the victim's shards — ` +
    `and dying costs YOU 25% of yours. flee walks you to the shrine safe zone; prefer fleeing when hurt. ` +
    `Respond with exactly one JSON object and nothing else: ` +
    `{"action": "move_to|gather|craft|say|trade_post|trade_fill|attack|flee|wait", ...params, "reason": "..."}. ` +
    `Params by action — move_to: {x, z}; gather: {node_id}; craft: {recipe_id, qty?}; ` +
    `say: {text, channel?}; trade_post: {side, item, qty, price}; trade_fill: {order_id, qty?}; ` +
    `attack: {target_id}; flee: {}; wait: {}.`;

  const user = [
    `Observation: ${obs.summary}`,
    `Vitals: HP ${obs.self.hp}/${obs.self.hpMax}, ${obs.self.inSafeZone ? "INSIDE" : "outside"} the shrine safe zone, K/D ${obs.self.kills}/${obs.self.deaths}.`,
    `Recent combat events:\n${bot.combatLog.slice(-8).join("\n") || "(none)"}`,
    `Recent chat:\n${bot.chatLog.slice(-10).join("\n") || "(none)"}`,
    `Last action result: ${bot.lastActionResult}`,
    `Nearby nodes (JSON): ${JSON.stringify(obs.nearbyNodes.slice(0, 8))}`,
    `Nearby players (JSON): ${JSON.stringify(obs.nearbyPlayers.slice(0, 8))}`,
    `Market (JSON): ${JSON.stringify(obs.market.slice(0, 10))}`,
  ].join("\n\n");

  const textOut = await chat(system, user, 300);
  const jsonMatch = textOut.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`no JSON object in model output: ${textOut.slice(0, 120)}`);
  const d = JSON.parse(jsonMatch[0]) as LlmDecision;

  log(`${LLM!.name} decision: ${d.action}${d.reason ? ` — ${d.reason}` : ""}`);
  switch (d.action) {
    case "move_to":
      bot.send({ type: "move", target: { x: Number(d.x), z: Number(d.z) } });
      break;
    case "gather":
      bot.send({ type: "gather", nodeId: String(d.node_id) });
      break;
    case "craft":
      bot.send({ type: "craft", recipeId: String(d.recipe_id), qty: d.qty });
      break;
    case "say":
      bot.say(String(d.text ?? "..."), d.channel === "world" ? "world" : "local");
      break;
    case "trade_post":
      bot.send({
        type: "trade_post",
        side: d.side === "buy" ? "buy" : "sell",
        item: String(d.item) as ItemId,
        qty: Number(d.qty ?? 1),
        price: Number(d.price ?? 1),
      });
      break;
    case "trade_fill":
      bot.send({ type: "trade_fill", orderId: String(d.order_id), qty: d.qty });
      break;
    case "attack":
      bot.send({ type: "attack", targetId: String(d.target_id) });
      break;
    case "flee":
      bot.send({ type: "move", target: SAFE_ZONE_CENTER });
      break;
    case "wait":
      break;
    default:
      throw new Error(`unknown action: ${(d as { action?: string }).action}`);
  }
}

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------

async function main() {
  log(`starting — mode: ${LLM ? `llm (${LLM.name}:${LLM.model})` : "heuristic"}, server: ${GAME_URL}`);
  const bot = new Bot();
  await bot.ensureConnected();

  for (;;) {
    try {
      const obs = await bot.observe();
      if (LLM) {
        try {
          await llmStep(bot, obs);
        } catch (e) {
          log("llm step failed:", (e as Error).message, "— falling back to heuristic");
          bot.heuristicStep(obs);
        }
      } else {
        bot.heuristicStep(obs);
      }
    } catch (e) {
      log("loop error:", (e as Error).message);
    }
    await sleep(LOOP_MS);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
