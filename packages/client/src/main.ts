import {
  type ResourceNode,
  type ServerMsg,
  type Vec2,
  WORLD,
  distance,
} from "@agentworld/protocol";
import { Hud } from "./hud";
import { Net } from "./net";
import { World3D } from "./world3d";

const GATHER_RANGE = 2.5;
const WASD_INTERVAL_MS = 150;
const WASD_STEP = 4;
const OBSERVE_INTERVAL_MS = 5000;

const canvas = document.getElementById("render-canvas") as HTMLCanvasElement;

let myId = "";
let apMax: number = WORLD.AP_MAX;
let joined = false;
let selfPos: Vec2 = { x: WORLD.SIZE / 2, z: WORLD.SIZE / 2 };
/** Last known own level, for the golden level-up flash. */
let lastLevel = 1;
/** Set when a node is clicked; auto-gather fires once on arrival. */
let pendingGather: string | null = null;
const nodeMap = new Map<string, ResourceNode>();

const hud = new Hud({
  onSay: (channel, text) => net.send({ type: "say", channel, text }),
  onCraft: (recipeId) => net.send({ type: "craft", recipeId }),
  onFill: (orderId) => net.send({ type: "trade_fill", orderId }),
  onPost: (side, item, qty, price) =>
    net.send({ type: "trade_post", side, item, qty, price }),
  onBuild: (structure) => net.send({ type: "build", structure }),
  onQuestAccept: (questId) => net.send({ type: "quest_accept", questId }),
});

const world = new World3D(canvas, {
  onTerrain: (x, z) => {
    if (!joined) return;
    pendingGather = null;
    net.send({ type: "move", target: { x: round2(x), z: round2(z) } });
  },
  onNode: (node) => {
    if (!joined) return;
    pendingGather = node.id;
    net.send({ type: "move", target: { x: node.pos.x, z: node.pos.z } });
  },
  onPlayer: (playerId) => {
    if (!joined) return;
    net.send({ type: "attack", targetId: playerId });
  },
  onMob: (mobId) => {
    if (!joined) return;
    net.send({ type: "attack", targetId: mobId });
  },
});

const net = new Net(
  `ws://${location.hostname}:8080/ws`,
  handleMsg,
  () => {
    joined = false;
    hud.setStatus("disconnected");
    hud.addError("Disconnected from server.");
  },
);

function handleMsg(msg: ServerMsg): void {
  switch (msg.type) {
    case "welcome": {
      myId = msg.playerId;
      apMax = msg.self.apMax;
      joined = true;
      hud.setMyId(myId);
      hud.setStatus(`connected — ${msg.self.name} on Emberfall Isle`);
      hud.setAp(msg.self.ap, apMax);
      hud.setHp(msg.self.hp, msg.self.hpMax);
      hud.setShards(msg.self.shards);
      hud.setInventory(msg.self.inventory);
      hud.setKD(msg.self.kills, msg.self.deaths);
      hud.setSafeZone(msg.self.inSafeZone);
      hud.setXp(msg.self.level, msg.self.xp, msg.self.xpNext);
      lastLevel = msg.self.level;
      hud.setQuestDefs(msg.quests ?? []);
      hud.setQuestStates(msg.self.quests ?? []);
      for (const node of msg.nodes) nodeMap.set(node.id, node);
      world.buildWorld(msg.seed, msg.nodes, myId, msg.mobs, msg.structures);
      selfPos = msg.self.pos;
      // One immediate observe (market + quest defs on older servers), then poll.
      net.send({ type: "observe" });
      window.setInterval(() => net.send({ type: "observe" }), OBSERVE_INTERVAL_MS);
      return;
    }
    case "state": {
      world.updatePlayers(msg.players);
      world.updateMobs(msg.mobs);
      hud.setAp(msg.self.ap, apMax);
      hud.setShards(msg.self.shards);
      hud.setXp(msg.self.level, msg.self.xp, msg.self.xpNext);
      if (msg.self.level > lastLevel) hud.levelFlash(msg.self.level);
      lastLevel = msg.self.level;
      const me = msg.players.find((p) => p.id === myId);
      if (me) {
        selfPos = me.pos;
        hud.setHp(me.hp, me.hpMax);
      }
      if (pendingGather) {
        const node = nodeMap.get(pendingGather);
        if (!node || node.remaining <= 0) {
          pendingGather = null;
        } else if (distance(selfPos, node.pos) <= GATHER_RANGE) {
          net.send({ type: "gather", nodeId: node.id });
          pendingGather = null;
        }
      }
      return;
    }
    case "chat":
      hud.addChat(msg.channel, msg.from.name, msg.from.role, msg.text);
      return;
    case "action_result": {
      hud.addLog(`${msg.action}: ${msg.message}`, msg.ok);
      if (msg.self) {
        apMax = msg.self.apMax;
        hud.setAp(msg.self.ap, apMax);
        hud.setHp(msg.self.hp, msg.self.hpMax);
        hud.setShards(msg.self.shards);
        hud.setInventory(msg.self.inventory);
        hud.setKD(msg.self.kills, msg.self.deaths);
        hud.setSafeZone(msg.self.inSafeZone);
        hud.setXp(msg.self.level, msg.self.xp, msg.self.xpNext);
        hud.setQuestStates(msg.self.quests ?? []);
      }
      return;
    }
    case "node_update":
      nodeMap.set(msg.node.id, msg.node);
      world.updateNode(msg.node);
      return;
    case "market_update":
      hud.setMarket(msg.orders);
      return;
    case "structure_update":
      world.setStructures(msg.structures);
      return;
    case "observation":
      hud.setInventory(msg.self.inventory);
      hud.setMarket(msg.market);
      hud.setKD(msg.self.kills, msg.self.deaths);
      hud.setSafeZone(msg.self.inSafeZone);
      hud.setQuestDefs(msg.quests ?? []);
      hud.setQuestStates(msg.self.quests ?? []);
      return;
    case "quest_update":
      hud.applyQuestUpdate(msg.quest, msg.state, msg.message, msg.completed === true);
      return;
    case "combat": {
      world.showAttack(msg.attacker.id);
      world.showHit(msg.target.id, msg.damage, msg.killed);
      // Damage floaters cover the play-by-play; the chronicle only records
      // kills and your own fights, so distant brawls can't flood the chat.
      const mine = msg.attacker.id === myId || msg.target.id === myId;
      if (msg.killed || mine) {
        const text = msg.killed
          ? `${msg.attacker.name} slew ${msg.target.name}${msg.loot ? ` (+${msg.loot} shards)` : ""}`
          : `${msg.attacker.name} hit ${msg.target.name} for ${msg.damage}`;
        hud.addCombat(text);
      }
      if (msg.killed && msg.target.id === myId) hud.flashDeathVignette();
      return;
    }
    case "error":
      hud.addError(msg.message);
      return;
  }
}

// ---------------------------------------------------------------------------
// WASD movement: while held, send a camera-relative move target every ~150 ms.
// ---------------------------------------------------------------------------

const heldKeys = new Set<string>();

function isTyping(): boolean {
  const a = document.activeElement;
  return a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement;
}

window.addEventListener("keydown", (ev) => {
  if (isTyping()) return;
  if (ev.key === "Escape") {
    hud.closeSidebar();
    return;
  }
  const k = ev.key.toLowerCase();
  if (k === "w" || k === "a" || k === "s" || k === "d") heldKeys.add(k);
  // Journal thumb-tabs: I satchel · J quests · M market · B build.
  else if (k === "i") hud.openTab("satchel");
  else if (k === "j") hud.openTab("quests");
  else if (k === "m") hud.openTab("market");
  else if (k === "b") hud.openTab("build");
});
window.addEventListener("keyup", (ev) => heldKeys.delete(ev.key.toLowerCase()));
window.addEventListener("blur", () => heldKeys.clear());

window.setInterval(() => {
  if (!joined || heldKeys.size === 0 || isTyping()) return;
  const f = (heldKeys.has("w") ? 1 : 0) - (heldKeys.has("s") ? 1 : 0);
  const r = (heldKeys.has("d") ? 1 : 0) - (heldKeys.has("a") ? 1 : 0);
  if (f === 0 && r === 0) return;
  const basis = world.cameraBasis();
  let dx = basis.fx * f + basis.rx * r;
  let dz = basis.fz * f + basis.rz * r;
  const len = Math.hypot(dx, dz);
  if (len < 1e-4) return;
  dx /= len;
  dz /= len;
  const x = clamp(selfPos.x + dx * WASD_STEP, 0, WORLD.SIZE);
  const z = clamp(selfPos.z + dz * WASD_STEP, 0, WORLD.SIZE);
  pendingGather = null;
  net.send({ type: "move", target: { x: round2(x), z: round2(z) } });
}, WASD_INTERVAL_MS);

// ---------------------------------------------------------------------------

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

async function start(): Promise<void> {
  const name = await hud.promptName();
  hud.setStatus("connecting…");
  try {
    await net.connect();
  } catch (err) {
    hud.setStatus("connection failed");
    hud.addError(err instanceof Error ? err.message : "Connection failed.");
    return;
  }
  net.send({ type: "join", name, role: "human" });
}

void start();
