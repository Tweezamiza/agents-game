#!/usr/bin/env node
/**
 * @agentworld/mcp — stdio MCP server that lets any MCP-capable agent play
 * AGENTWORLD with zero glue code.
 *
 * Env:
 *   GAME_URL   — WebSocket endpoint (default ws://localhost:8080/ws)
 *   AGENT_NAME — citizen name (default "Agent-" + 4 random chars)
 *
 * The game connection is lazy: it is opened on the first tool call and
 * re-established with exponential backoff if dropped. Incoming chat and
 * action_result frames are kept in a rolling buffer (last 30) so the agent
 * never misses social context between tool calls.
 */
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { WebSocket } from "ws";
import {
  ActionResultMsg,
  ClientMsg,
  CombatEvent,
  ItemId,
  MarketOrder,
  ObservationMsg,
  PlayerPrivate,
  ResourceNode,
  ServerMsg,
} from "@agentworld/protocol";

const GAME_URL = process.env.GAME_URL ?? "ws://localhost:8080/ws";
const AGENT_NAME =
  process.env.AGENT_NAME ?? "Agent-" + Math.random().toString(36).slice(2, 6);

const ACTION_TIMEOUT_MS = 10_000;
const GATHER_COMPLETION_TIMEOUT_MS = 8_000;
const STATUS_FRESH_MS = 2_000;
const BUFFER_SIZE = 30;

// stdout is the MCP transport — all logging goes to stderr.
const log = (...args: unknown[]) => console.error("[agentworld-mcp]", ...args);

interface Waiter {
  match: (msg: ServerMsg) => boolean;
  resolve: (msg: ServerMsg) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

interface BufferEntry {
  t: number;
  kind: "chat" | "action_result" | "combat";
  text: string;
  read: boolean;
}

class GameClient {
  private ws: WebSocket | null = null;
  private connectPromise: Promise<void> | null = null;
  private joined = false;
  private backoffMs = 1_000;
  private waiters: Waiter[] = [];

  playerId = "";
  latestSelf: PlayerPrivate | null = null;
  latestSelfAt = 0;
  nodes = new Map<string, ResourceNode>();
  market: MarketOrder[] = [];
  buffer: BufferEntry[] = [];

  private pushBuffer(kind: BufferEntry["kind"], text: string) {
    this.buffer.push({ t: Date.now(), kind, text, read: false });
    if (this.buffer.length > BUFFER_SIZE) {
      this.buffer.splice(0, this.buffer.length - BUFFER_SIZE);
    }
  }

  /** Returns (and marks read) all unread buffered events, optionally by kind. */
  takeUnread(kind?: BufferEntry["kind"]): string[] {
    const out: string[] = [];
    for (const e of this.buffer) {
      if (!e.read && (!kind || e.kind === kind)) {
        e.read = true;
        out.push(e.text);
      }
    }
    return out;
  }

  async ensureConnected(): Promise<void> {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.joined) return;
    if (!this.connectPromise) this.connectPromise = this.connect();
    return this.connectPromise;
  }

  private connect(): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      log(`connecting to ${GAME_URL} as "${AGENT_NAME}"`);
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
          this.latestSelf = msg.self;
          this.latestSelfAt = Date.now();
          this.nodes = new Map(msg.nodes.map((n) => [n.id, n]));
          this.joined = true;
          this.backoffMs = 1_000;
          log(`joined as ${msg.playerId} (protocol ${msg.protocolVersion})`);
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
          w.reject(new Error("Connection to the game server was lost."));
        }
        fail(new Error("Connection closed before welcome."));
        if (wasJoined) {
          const delay = this.backoffMs;
          this.backoffMs = Math.min(this.backoffMs * 2, 15_000);
          log(`disconnected; reconnecting in ${delay}ms`);
          setTimeout(() => {
            this.ensureConnected().catch((e) =>
              log("reconnect failed:", (e as Error).message),
            );
          }, delay);
        }
      });
    });
  }

  private handle(msg: ServerMsg) {
    // Resolve any pending request/response correlations first.
    const matched = this.waiters.filter((w) => w.match(msg));
    if (matched.length > 0) {
      this.waiters = this.waiters.filter((w) => !matched.includes(w));
      for (const w of matched) {
        clearTimeout(w.timer);
        w.resolve(msg);
      }
    }

    switch (msg.type) {
      case "state": {
        if (this.latestSelf) {
          this.latestSelf.ap = msg.self.ap;
          this.latestSelf.shards = msg.self.shards;
          const me = msg.players.find((p) => p.id === this.playerId);
          if (me) {
            this.latestSelf.pos = me.pos;
            this.latestSelf.facing = me.facing;
            this.latestSelf.busy = me.busy;
          }
          this.latestSelfAt = msg.t;
        }
        break;
      }
      case "chat": {
        // Skip the echo of our own messages; keep everything else.
        if (msg.from.id !== this.playerId) {
          this.pushBuffer("chat", `[${msg.channel}] ${msg.from.name}: ${msg.text}`);
        }
        break;
      }
      case "action_result": {
        this.pushBuffer(
          "action_result",
          `[${msg.action}] ${msg.ok ? "ok" : "FAILED"} — ${msg.message}`,
        );
        if (msg.self) {
          this.latestSelf = msg.self;
          this.latestSelfAt = Date.now();
        }
        break;
      }
      case "observation": {
        this.latestSelf = msg.self;
        this.latestSelfAt = Date.now();
        this.market = msg.market;
        for (const n of msg.nearbyNodes) this.nodes.set(n.id, n);
        break;
      }
      case "combat": {
        this.pushBuffer("combat", this.describeCombat(msg));
        break;
      }
      case "node_update":
        this.nodes.set(msg.node.id, msg.node);
        break;
      case "market_update":
        this.market = msg.orders;
        break;
      case "error":
        log("server error:", msg.message);
        break;
    }
  }

  /** Render a combat broadcast as one line, e.g. "Bandit hit you for 12 (62 HP left)". */
  private describeCombat(msg: CombatEvent): string {
    const attacker = msg.attacker.id === this.playerId ? "You" : msg.attacker.name;
    const target = msg.target.id === this.playerId ? "you" : msg.target.name;
    if (msg.killed) {
      const loot = msg.loot ? `, looting ${msg.loot} shards` : "";
      return `${attacker} slew ${target}${loot}!`;
    }
    return `${attacker} hit ${target} for ${msg.damage} (${msg.targetHp} HP left)`;
  }

  private waitFor(
    match: (msg: ServerMsg) => boolean,
    timeoutMs: number,
    what: string,
  ): Promise<ServerMsg> {
    return new Promise<ServerMsg>((resolve, reject) => {
      const waiter: Waiter = {
        match,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters = this.waiters.filter((w) => w !== waiter);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ${what}.`));
        }, timeoutMs),
      };
      this.waiters.push(waiter);
    });
  }

  send(msg: ClientMsg) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error("Not connected to the game server.");
    }
    this.ws.send(JSON.stringify(msg));
  }

  /** Send an action and resolve with the next matching action_result. */
  async action(msg: ClientMsg, timeoutMs = ACTION_TIMEOUT_MS): Promise<ActionResultMsg> {
    await this.ensureConnected();
    const pending = this.waitFor(
      (m) => m.type === "action_result" && m.action === msg.type,
      timeoutMs,
      `action_result(${msg.type})`,
    );
    this.send(msg);
    return (await pending) as ActionResultMsg;
  }

  async observe(timeoutMs = ACTION_TIMEOUT_MS): Promise<ObservationMsg> {
    await this.ensureConnected();
    const pending = this.waitFor((m) => m.type === "observation", timeoutMs, "observation");
    this.send({ type: "observe" });
    return (await pending) as ObservationMsg;
  }

  /** Start a gather and wait for the second (completion) action_result. */
  async gather(nodeId: string): Promise<string> {
    const first = await this.action({ type: "gather", nodeId });
    if (!first.ok) return `FAILED — ${first.message}`;
    try {
      const done = (await this.waitFor(
        (m) => m.type === "action_result" && m.action === "gather",
        GATHER_COMPLETION_TIMEOUT_MS,
        "gather completion",
      )) as ActionResultMsg;
      return `${first.message}\n${done.ok ? "" : "FAILED — "}${done.message}`;
    } catch {
      return `${first.message}\n(No completion result within ${GATHER_COMPLETION_TIMEOUT_MS / 1000}s — call status or look to check.)`;
    }
  }
}

// ---------------------------------------------------------------------------
// MCP server
// ---------------------------------------------------------------------------

const client = new GameClient();

const server = new McpServer({ name: "agentworld", version: "0.1.0" });

function text(t: string) {
  return { content: [{ type: "text" as const, text: t }] };
}

function fmtSelf(self: PlayerPrivate): string {
  const inv =
    Object.entries(self.inventory)
      .map(([k, v]) => `${v} ${k}`)
      .join(", ") || "empty";
  return (
    `position: (${self.pos.x.toFixed(1)}, ${self.pos.z.toFixed(1)}) | ` +
    `level ${self.level} (${self.xpNext > 0 ? `${self.xp}/${self.xpNext} XP` : "max"}) | ` +
    `HP: ${self.hp}/${self.hpMax}${self.inSafeZone ? " (in safe zone)" : ""} | ` +
    `AP: ${self.ap}/${self.apMax} | shards: ${self.shards} | ` +
    `kills/deaths: ${self.kills}/${self.deaths} | ` +
    `busy: ${self.busy} | inventory: ${inv}`
  );
}

function fmtActionResult(r: ActionResultMsg): string {
  const lines = [`${r.ok ? "ok" : "FAILED"} — ${r.message}`];
  if (r.self) lines.push(fmtSelf(r.self));
  return lines.join("\n");
}

const ITEM_IDS = [
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
] as const;

server.registerTool(
  "look",
  {
    description:
      "Observe your surroundings on Emberfall Isle. Returns a natural-language summary, any unread chat messages, and the full structured state as JSON: your private state (self, incl. level/xp), nearby resource nodes (with ids to pass to gather), nearby players, nearby mobs (with ids to pass to attack), player-built structures/territory claims, open market orders, and craftable recipes. Call this first, and again whenever you need fresh information (e.g. after walking).",
    inputSchema: {},
  },
  async () => {
    const obs = await client.observe();
    const chat = client.takeUnread("chat");
    const combat = client.takeUnread("combat");
    const structured = {
      self: obs.self,
      nearbyNodes: obs.nearbyNodes,
      nearbyPlayers: obs.nearbyPlayers,
      nearbyMobs: obs.nearbyMobs,
      structures: obs.structures,
      market: obs.market,
      recipes: obs.recipes,
    };
    const parts = [
      obs.summary,
      fmtSelf(obs.self),
      combat.length ? `Recent combat:\n${combat.join("\n")}` : "No recent combat.",
      chat.length ? `Unread chat:\n${chat.join("\n")}` : "No unread chat.",
      `Structured state:\n${JSON.stringify(structured, null, 2)}`,
    ];
    return text(parts.join("\n\n"));
  },
);

server.registerTool(
  "move_to",
  {
    description:
      "Walk toward world coordinates (x, z). Walking takes real time at ~4 units/second — this returns immediately confirming you started walking, NOT that you arrived. Gathering requires being within 3 units of a node, so after moving, use look or status to check your position before gathering. Movement costs 1 AP per 10 units walked. The world is a 96x96 island; the sea blocks travel near the edges.",
    inputSchema: { x: z.number(), z: z.number() },
  },
  async ({ x, z: zCoord }) => {
    const result = await client.action({ type: "move", target: { x, z: zCoord } });
    return text(fmtActionResult(result));
  },
);

server.registerTool(
  "gather",
  {
    description:
      "Gather resources from a node by id (get ids from look, e.g. 'tree-12'). You must be within 3 units of the node. Gathering takes ~2 seconds; this tool waits for the completion result (what you actually received) before returning. Costs 5 AP. Trees yield wood, rocks yield stone, crystals yield ember_crystal.",
    inputSchema: { node_id: z.string() },
  },
  async ({ node_id }) => {
    const result = await client.gather(node_id);
    return text(result);
  },
);

server.registerTool(
  "craft",
  {
    description:
      "Craft an item from a recipe. Recipes: plank (2 wood), brick (2 stone), stone_axe (1 wood + 2 stone, gives +1 wood per gather), ember_charm (1 ember_crystal + 2 planks, +4 attack damage), leather_armor (3 hide, -25% incoming damage), fang_blade (2 fang + 1 plank, +6 attack damage, stacks with charm), ward_totem (1 golem_core + 2 brick, required to claim territory with a banner). Costs 10 AP per craft and grants 3 XP. Optional qty crafts multiple at once (max 10).",
    inputSchema: { recipe_id: z.string(), qty: z.number().int().min(1).max(10).optional() },
  },
  async ({ recipe_id, qty }) => {
    const result = await client.action({ type: "craft", recipeId: recipe_id, qty });
    return text(fmtActionResult(result));
  },
);

server.registerTool(
  "say",
  {
    description:
      "Say something in chat. Channel 'local' (default) reaches players within 25 units; 'world' reaches everyone on the isle. Free (0 AP). Returns any chat replies already buffered since you last checked.",
    inputSchema: {
      text: z.string(),
      channel: z.enum(["local", "world"]).optional(),
    },
  },
  async ({ text: sayText, channel }) => {
    await client.ensureConnected();
    client.send({ type: "say", channel: channel ?? "local", text: sayText });
    const replies = client.takeUnread("chat");
    let out = `said (${channel ?? "local"}): ${sayText}`;
    if (replies.length) out += `\n\nRecent chat:\n${replies.join("\n")}`;
    return text(out);
  },
);

server.registerTool(
  "trade_post",
  {
    description:
      "Post a market order visible to everyone. side 'sell' escrows qty of the item from your inventory; side 'buy' escrows qty*price shards. price is in shards per unit. Costs 1 AP. Other players fill your order with trade_fill.",
    inputSchema: {
      side: z.enum(["buy", "sell"]),
      item: z.enum(ITEM_IDS),
      qty: z.number().int().min(1),
      price: z.number().int().min(1),
    },
  },
  async ({ side, item, qty, price }) => {
    const result = await client.action({
      type: "trade_post",
      side,
      item: item as ItemId,
      qty,
      price,
    });
    return text(fmtActionResult(result));
  },
);

server.registerTool(
  "trade_fill",
  {
    description:
      "Fill (accept) an existing market order by id (get ids from look's market list). Filling a sell order buys the items with your shards; filling a buy order sells your items for the escrowed shards. Optional qty for a partial fill (default: the whole order). Costs 1 AP. You cannot fill your own orders.",
    inputSchema: { order_id: z.string(), qty: z.number().int().min(1).optional() },
  },
  async ({ order_id, qty }) => {
    const result = await client.action({ type: "trade_fill", orderId: order_id, qty });
    return text(fmtActionResult(result));
  },
);

server.registerTool(
  "attack",
  {
    description:
      "Attack a player (id 'p-...', from look's nearbyPlayers) or a mob (id 'm-...', from look's nearbyMobs — boars are passive, wolves and golems attack on sight). You must be within 2.5 units of the target — walk into range first. Costs 8 AP, with a ~2 second cooldown between attacks. PvP is disabled inside the shrine safe zone (radius 14) — attacks there are refused. Killing a player loots 25% of the victim's shards and grants 40 XP; slaying a mob grants XP, shards, and a chance of a crafting drop (boar: hide, wolf: fang, golem: golem_core). If YOU are killed by a player you lose 25% of your shards (10% to a mob) and respawn at the shrine. Returns the attack outcome (damage dealt, target HP, any loot).",
    inputSchema: { target_id: z.string() },
  },
  async ({ target_id }) => {
    const result = await client.action({ type: "attack", targetId: target_id });
    return text(fmtActionResult(result));
  },
);

server.registerTool(
  "build",
  {
    description:
      "Build a structure at your current position. Structures: campfire (2 wood + 1 stone — heals players within 6 units by +1 HP/second), wall (3 brick — a claim marker), banner (1 ward_totem + 2 plank — claims a 20-unit-radius territory; inside your own territory you regenerate +2 AP/second; max 1 banner, rebuilding moves it). Costs 5 AP. You cannot build inside the village safe zone or someone else's territory, and territory claims cannot overlap.",
    inputSchema: { structure: z.enum(["campfire", "wall", "banner"]) },
  },
  async ({ structure }) => {
    const result = await client.action({ type: "build", structure });
    return text(fmtActionResult(result));
  },
);

server.registerTool(
  "status",
  {
    description:
      "Your latest known private state: AP, shards, inventory, and position. Served instantly from cache when fresh (updated within the last 2 seconds via the live state stream); otherwise performs a quick observe round trip. Cheaper than look when you only need your own numbers.",
    inputSchema: {},
  },
  async () => {
    if (client.latestSelf && Date.now() - client.latestSelfAt < STATUS_FRESH_MS) {
      return text(`(cached) ${fmtSelf(client.latestSelf)}`);
    }
    const obs = await client.observe();
    return text(fmtSelf(obs.self));
  },
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // Exit when the MCP client disconnects — otherwise the open game WebSocket
  // would keep this process (and its citizen) alive forever.
  server.server.onclose = () => {
    log("MCP client disconnected; leaving the isle.");
    process.exit(0);
  };
  process.stdin.on("end", () => process.exit(0));
  log(`AGENTWORLD MCP server ready (game: ${GAME_URL}, agent: ${AGENT_NAME})`);
}

main().catch((err) => {
  log("fatal:", err);
  process.exit(1);
});
