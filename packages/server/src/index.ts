import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import {
  ClientMsg,
  MOBS,
  ObservationMsg,
  PROGRESSION,
  PROTOCOL_VERSION,
  ServerMsg,
  StructureKind,
  WORLD,
  distance,
  xpForLevel,
} from "@agentworld/protocol";
import { Player, World } from "./world.js";
import { Persistence } from "./persistence.js";

const PORT = Number(process.env.PORT ?? 8080);
const SEED = Number(process.env.WORLD_SEED ?? 1337);

const world = new World(SEED);
const sockets = new Map<string, WebSocket>(); // playerId -> socket
const persistence = new Persistence();
let ledgerFlushed = 0;

const http = createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true, players: world.players.size, protocol: PROTOCOL_VERSION }));
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocketServer({ server: http, path: "/ws" });

function send(ws: WebSocket, msg: ServerMsg) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(msg: ServerMsg, filter?: (p: Player) => boolean) {
  for (const [id, ws] of sockets) {
    const p = world.players.get(id);
    if (!p) continue;
    if (filter && !filter(p)) continue;
    send(ws, msg);
  }
}

function observation(p: Player): ObservationMsg {
  return {
    type: "observation",
    t: Date.now(),
    summary: world.observationSummary(p),
    self: world.privateView(p),
    nearbyPlayers: world.nearbyPlayers(p),
    nearbyNodes: world.nearbyNodes(p),
    nearbyMobs: world.nearbyMobs(p),
    structures: world.structures.all(),
    market: [...world.orders.values()],
    recipes: world.recipes(),
    quests: world.quests.offeredFor(p.name),
  };
}

/** Dispatch queued quest progress/completion events to their owners. */
function flushQuestUpdates() {
  for (const u of world.quests.drain()) {
    const ws = sockets.get(u.playerId);
    if (ws) send(ws, { type: "quest_update", quest: u.quest, state: u.state, message: u.message, completed: u.completed });
  }
}

/** Per-player private slice of the 10 Hz state frame. */
function selfSlice(p: Player) {
  return {
    ap: Math.floor(p.ap),
    shards: p.shards,
    level: p.level,
    xp: p.xp,
    xpNext: p.level >= PROGRESSION.LEVEL_CAP ? 0 : xpForLevel(p.level),
  };
}

wss.on("connection", (ws) => {
  let player: Player | null = null;

  ws.on("message", async (raw) => {
    let msg: ClientMsg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      send(ws, { type: "error", message: "Invalid JSON." });
      return;
    }

    if (!player) {
      if (msg.type !== "join") {
        send(ws, { type: "error", message: "First message must be join." });
        return;
      }
      const name = String(msg.name ?? "").trim().slice(0, 24);
      if (!name) {
        send(ws, { type: "error", message: "join.name is required." });
        return;
      }
      if ([...world.players.values()].some((p) => p.name === name)) {
        send(ws, { type: "error", message: `"${name}" is already on the isle. Pick another name.` });
        return;
      }
      const role = msg.role === "agent" ? "agent" : "human";
      const saved = await persistence.loadCharacter(name);
      if (player) return; // a parallel join on this socket won the race
      if (saved?.quests) world.quests.restore(name, saved.quests);
      player = world.addPlayer(name, role, saved ? persistence.restoreToPlayer(saved) : undefined);
      sockets.set(player.id, ws);
      send(ws, {
        type: "welcome",
        protocolVersion: PROTOCOL_VERSION,
        playerId: player.id,
        worldSize: WORLD.SIZE,
        seed: world.seed,
        self: world.privateView(player),
        nodes: [...world.nodes.values()],
        mobs: world.mobs.living(),
        structures: world.structures.all(),
        quests: world.quests.offeredFor(name),
      });
      broadcast(
        { type: "chat", channel: "world", from: { id: "system", name: "Emberfall", role: "human" }, text: `${name} [${role}] arrived on the isle.` },
      );
      console.log(`join: ${name} [${role}] as ${player.id} (${world.players.size} online)`);
      return;
    }

    const p = player;
    switch (msg.type) {
      case "move": {
        const x = Math.max(0, Math.min(WORLD.SIZE, Number(msg.target?.x)));
        const z = Math.max(0, Math.min(WORLD.SIZE, Number(msg.target?.z)));
        if (Number.isNaN(x) || Number.isNaN(z)) {
          send(ws, { type: "action_result", action: "move", ok: false, message: "move.target must be {x, z}." });
          return;
        }
        if (p.gather) {
          send(ws, { type: "action_result", action: "move", ok: false, message: "Busy gathering; wait for it to finish." });
          return;
        }
        p.target = { x, z };
        send(ws, { type: "action_result", action: "move", ok: true, message: `Walking to (${x.toFixed(0)}, ${z.toFixed(0)}), ${distance(p.pos, { x, z }).toFixed(0)}u away.` });
        return;
      }
      case "stop":
        p.target = null;
        send(ws, { type: "action_result", action: "stop", ok: true, message: "Stopped." });
        return;
      case "gather": {
        const r = world.startGather(p, String(msg.nodeId));
        send(ws, { type: "action_result", action: "gather", ok: r.ok, message: r.message, self: world.privateView(p) });
        return;
      }
      case "craft": {
        const r = world.craft(p, String(msg.recipeId), Number(msg.qty ?? 1));
        send(ws, { type: "action_result", action: "craft", ok: r.ok, message: r.message, self: world.privateView(p) });
        flushQuestUpdates();
        return;
      }
      case "say": {
        const text = String(msg.text ?? "").slice(0, 400);
        if (!text) return;
        const channel = msg.channel === "world" ? "world" : "local";
        const event: ServerMsg = { type: "chat", channel, from: { id: p.id, name: p.name, role: p.role }, text };
        if (channel === "world") broadcast(event);
        else broadcast(event, (o) => distance(o.pos, p.pos) <= WORLD.LOCAL_CHAT_RANGE);
        return;
      }
      case "trade_post": {
        const r = world.postOrder(p, msg.side === "buy" ? "buy" : "sell", msg.item, Number(msg.qty), Number(msg.price));
        send(ws, { type: "action_result", action: "trade_post", ok: r.ok, message: r.message, self: world.privateView(p) });
        if (r.ok) broadcast({ type: "market_update", orders: [...world.orders.values()] });
        return;
      }
      case "trade_fill": {
        const r = world.fillOrder(p, String(msg.orderId), msg.qty === undefined ? undefined : Number(msg.qty));
        send(ws, { type: "action_result", action: "trade_fill", ok: r.ok, message: r.message, self: world.privateView(p) });
        if (r.ok) broadcast({ type: "market_update", orders: [...world.orders.values()] });
        return;
      }
      case "observe":
        send(ws, observation(p));
        return;
      case "attack": {
        const r = world.attack(p, String(msg.targetId));
        send(ws, { type: "action_result", action: "attack", ok: r.ok, message: r.message, self: world.privateView(p) });
        if (r.ok && r.target) {
          broadcast({
            type: "combat",
            attacker: { id: p.id, name: p.name },
            target: r.target,
            damage: r.damage ?? 0,
            targetHp: r.targetHp ?? 0,
            killed: r.killed ?? false,
            loot: r.loot,
          });
          // A fallen world boss is everyone's news.
          if (r.killed && r.target.id.startsWith("m-bonelord")) {
            broadcast({
              type: "chat",
              channel: "world",
              from: { id: "system", name: "Emberfall", role: "human" },
              text: `${MOBS.bonelord.name} has fallen to ${p.name}! The highland is quiet… for now.`,
            });
          }
          // Player victims get a personal note; mobs suffer in silence.
          const target = world.players.get(r.target.id);
          const targetWs = target ? sockets.get(target.id) : undefined;
          if (target && targetWs) {
            const note = r.killed
              ? `You were slain by ${p.name} and lost ${r.loot ?? 0} shards. You wake at the shrine.`
              : `${p.name} hit you for ${r.damage} (${target.hp}/${world.hpMaxOf(target)} HP). Fight back or flee!`;
            send(targetWs, { type: "action_result", action: "attack", ok: false, message: note, self: world.privateView(target) });
          }
        }
        flushQuestUpdates();
        return;
      }
      case "build": {
        const r = world.build(p, String(msg.structure) as StructureKind);
        send(ws, { type: "action_result", action: "build", ok: r.ok, message: r.message, self: world.privateView(p) });
        if (r.ok) broadcast({ type: "structure_update", structures: world.structures.all() });
        flushQuestUpdates();
        return;
      }
      case "quest_accept": {
        const r = world.quests.accept(p, String(msg.questId));
        send(ws, { type: "action_result", action: "quest_accept", ok: r.ok, message: r.message, self: world.privateView(p) });
        if (r.ok && r.quest && r.state)
          send(ws, { type: "quest_update", quest: r.quest, state: r.state, message: r.message });
        return;
      }
      default:
        send(ws, { type: "error", message: `Unknown message type: ${(msg as { type?: string }).type}` });
    }
  });

  ws.on("close", () => {
    if (player) {
      console.log(`leave: ${player.name} (${player.id})`);
      void persistence.saveCharacter(player, world.quests.serialize(player.name));
      world.removePlayer(player.id);
      sockets.delete(player.id);
      broadcast({ type: "chat", channel: "world", from: { id: "system", name: "Emberfall", role: "human" }, text: `${player.name} left the isle.` });
      player = null;
    }
  });
});

// Movement sub-tick + state frames at 10 Hz.
setInterval(() => {
  world.moveTick(WORLD.TICK_MS);
  const players = [...world.players.values()].map((p) => world.publicView(p));
  const mobs = world.mobs.living();
  for (const [id, ws] of sockets) {
    const p = world.players.get(id);
    if (!p) continue;
    send(ws, { type: "state", t: Date.now(), players, mobs, self: selfSlice(p) });
  }
}, WORLD.TICK_MS);

// Game tick at 1 Hz: AP regen, gather completion, node respawn, mob AI.
setInterval(() => {
  const { completions, respawned, mobHits } = world.gameTick();
  for (const { player: p, message } of completions) {
    const ws = sockets.get(p.id);
    if (ws) send(ws, { type: "action_result", action: "gather", ok: true, message, self: world.privateView(p) });
  }
  for (const node of respawned) broadcast({ type: "node_update", node });
  for (const hit of mobHits) {
    broadcast({
      type: "combat",
      attacker: hit.mob,
      target: { id: hit.target.id, name: hit.target.name },
      damage: hit.damage,
      targetHp: hit.killed ? 0 : hit.target.hp,
      killed: hit.killed,
    });
    const ws = sockets.get(hit.target.id);
    if (ws) {
      const note = hit.killed
        ? `A ${hit.mob.name} slew you. You wake at the shrine, lighter by a tenth of your shards.`
        : `A ${hit.mob.name} hit you for ${hit.damage} (${hit.target.hp}/${world.hpMaxOf(hit.target)} HP). Fight back or flee!`;
      send(ws, { type: "action_result", action: "attack", ok: false, message: note, self: world.privateView(hit.target) });
    }
  }
  flushQuestUpdates();
  for (const text of world.drainAnnouncements()) {
    broadcast({ type: "chat", channel: "world", from: { id: "system", name: "Emberfall", role: "human" }, text });
  }
}, WORLD.GAME_TICK_MS);

// Persistence sweep every 15 s: save all online characters, flush ledger.
setInterval(() => {
  if (!persistence.enabled) return;
  for (const p of world.players.values()) void persistence.saveCharacter(p, world.quests.serialize(p.name));
  persistence.queueLedger(world.ledger.slice(ledgerFlushed));
  ledgerFlushed = world.ledger.length;
  void persistence.flushLedger();
}, 15_000);

http.listen(PORT, async () => {
  console.log(`AGENTWORLD server v${PROTOCOL_VERSION} — Emberfall Isle (seed ${SEED})`);
  console.log(`ws://localhost:${PORT}/ws  |  http://localhost:${PORT}/health`);
  if (persistence.enabled) {
    const ok = await persistence.ping();
    console.log(ok ? "persistence: Supabase connected — characters and ledger persist" : "persistence: Supabase configured but unreachable — running in-memory");
  } else {
    console.log("persistence: no SUPABASE_URL/SUPABASE_ANON_KEY — running in-memory");
  }
});
