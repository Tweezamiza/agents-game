#!/usr/bin/env node
/**
 * Sprint 3 smoke test — exercises every new server system over the flat WS
 * protocol: join -> find mob -> walk -> kill -> XP/loot -> equip -> quests ->
 * claim -> build. Run against a live server:
 *
 *   node scripts/smoke-sprint3.mjs            (ws://localhost:8080/ws)
 *   WS_URL=ws://host:port/ws node scripts/smoke-sprint3.mjs
 *
 * Uses two bots: SmokeHero does the checks; SmokeAlly adds damage so warrior
 * fights stay survivable. Exits 0 on green, 1 on the first failed check.
 */

const WS_URL = process.env.WS_URL ?? "ws://localhost:8080/ws";
const VILLAGE = { x: 120, z: 120 };
const suffix = Math.random().toString(36).slice(2, 7);

let passed = 0;
function ok(label, extra = "") {
  passed++;
  console.log(`  PASS  ${label}${extra ? ` — ${extra}` : ""}`);
}
function fail(label, extra = "") {
  console.error(`  FAIL  ${label}${extra ? ` — ${extra}` : ""}`);
  process.exit(1);
}
function assert(cond, label, extra = "") {
  if (cond) ok(label, extra);
  else fail(label, extra);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

class Bot {
  constructor(name) {
    this.name = name;
    this.ws = null;
    this.welcome = null;
    this.state = null; // latest 10 Hz frame
    this.inbox = []; // every non-state message, in order
    this.selfView = null; // latest PlayerPrivate from action_result.self
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(WS_URL);
      this.ws.onopen = () => resolve();
      this.ws.onerror = (e) => reject(new Error(`ws error for ${this.name}: ${e.message ?? e}`));
      this.ws.onmessage = (ev) => {
        const msg = JSON.parse(ev.data);
        if (msg.type === "state") this.state = msg;
        else {
          if (msg.type === "welcome") this.welcome = msg;
          if (msg.type === "action_result" && msg.self) this.selfView = msg.self;
          this.inbox.push(msg);
          if (this.inbox.length > 2000) this.inbox.splice(0, 1000);
        }
      };
    });
  }

  send(msg) {
    this.ws.send(JSON.stringify(msg));
  }

  async join() {
    await this.connect();
    this.send({ type: "join", name: this.name, role: "agent" });
    await this.waitFor((m) => m.type === "welcome", 10000, "welcome");
    return this.welcome;
  }

  /** Wait for the next inbox message matching `pred` (scans only new ones). */
  async waitFor(pred, timeoutMs, what) {
    let cursor = this.inbox.length;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      while (cursor < this.inbox.length) {
        const m = this.inbox[cursor++];
        if (pred(m)) return m;
      }
      await sleep(50);
    }
    fail(`timeout waiting for ${what} (${this.name})`);
  }

  async waitUntil(fn, timeoutMs, what) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (fn()) return true;
      await sleep(100);
    }
    fail(`timeout waiting until ${what} (${this.name})`);
  }

  pos() {
    const me = this.state?.players.find((p) => p.id === this.welcome.playerId);
    return me ? me.pos : this.welcome.self.pos;
  }
  hp() {
    return this.state?.self?.hp ?? this.welcome.self.hp;
  }
  mobs() {
    return this.state?.mobs ?? [];
  }
  mob(id) {
    return this.mobs().find((m) => m.id === id);
  }

  /** Walk to a point, re-issuing move (target may be refreshed by caller). */
  async moveTo(target, within = 1.5, timeoutMs = 90000, soft = false) {
    const deadline = Date.now() + timeoutMs;
    let lastSend = 0;
    while (Date.now() < deadline) {
      const d = dist(this.pos(), target);
      if (d <= within) return true;
      if (Date.now() - lastSend > 1000) {
        this.send({ type: "move", target: { x: target.x, z: target.z } });
        lastSend = Date.now();
      }
      await sleep(150);
    }
    if (soft) return false;
    fail(`moveTo (${target.x.toFixed(0)},${target.z.toFixed(0)}) timed out for ${this.name}`);
  }

  /** One attack request; resolves with my own action_result (not victim notes). */
  async attack(targetId) {
    const mine = (m) =>
      m.type === "action_result" &&
      m.action === "attack" &&
      !/hit you|You were slain/.test(m.message);
    const cursor = this.inbox.length;
    this.send({ type: "attack", targetId });
    const deadline = Date.now() + 5000;
    let i = cursor;
    while (Date.now() < deadline) {
      while (i < this.inbox.length) {
        const m = this.inbox[i++];
        if (mine(m)) return m;
      }
      await sleep(40);
    }
    fail(`attack result timeout (${this.name})`);
  }

  async gatherOne(nodeId) {
    const cursor = this.inbox.length;
    this.send({ type: "gather", nodeId });
    let i = cursor;
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      while (i < this.inbox.length) {
        const m = this.inbox[i++];
        if (m.type === "action_result" && m.action === "gather") {
          if (!m.ok) return m;
          if (/^Gathered|depleted/.test(m.message)) return m; // completion
        }
      }
      await sleep(80);
    }
    // A mob hit can interrupt the gather; let the caller retry.
    return { ok: false, message: "gather interrupted (timeout)" };
  }
}

// ---------------------------------------------------------------------------

/** Gather `count` of a resource, hopping nodes as they deplete. */
async function gatherMany(bot, kind, count) {
  if (count <= 0) return;
  const item = { tree: "wood", rock: "stone", crystal: "ember_crystal" }[kind];
  const have = () => bot.selfView?.inventory?.[item] ?? 0;
  const goal = have() + count;
  const tried = new Set();
  let guard = 0;
  while (have() < goal) {
    if (guard++ > 60) fail(`gatherMany(${kind}) made no progress`);
    // Stay alive: back off toward the village if skeletons chewed us up.
    if (bot.hp() < 45) {
      const p = bot.pos();
      const v = { x: VILLAGE.x - p.x, z: VILLAGE.z - p.z };
      const l = Math.hypot(v.x, v.z) || 1;
      console.log(`  (${bot.name} at ${bot.hp()} HP — regenerating before gathering)`);
      await bot.moveTo({ x: p.x + (v.x / l) * 25, z: p.z + (v.z / l) * 25 }, 2, 60000, true);
      await bot.waitUntil(() => bot.hp() >= 80, 90000, "regen before gathering");
    }
    const node = bot.welcome.nodes
      .filter((n) => n.kind === kind && !tried.has(n.id))
      .filter((n) => bot.mobs().every((m) => dist(m.pos, n.pos) > 15))
      .sort((a, b) => dist(a.pos, bot.pos()) - dist(b.pos, bot.pos()))[0];
    if (!node) fail(`no reachable ${kind} nodes left for ${bot.name}`);
    await bot.moveTo(node.pos, 2.5);
    while (have() < goal) {
      const r = await bot.gatherOne(node.id);
      if (!r.ok || /depleted/.test(r.message)) {
        if (/Not enough AP/.test(r.message)) await sleep(5000);
        else tried.add(node.id);
        break;
      }
    }
  }
}

/** Hero (+ally) kill one mob; hero must land the killing blow for loot.
 *  Returns the kill action_result, or null if the mob vanished (stale pick). */
async function killMob(hero, ally, mobId, fleePoint) {
  const start = Date.now();
  const deadline = start + 240000;
  let killResult = null;
  while (Date.now() < deadline) {
    const m = hero.mob(mobId);
    if (!m) {
      if (killResult) return killResult;
      // State frames lag the simulation by ~100ms; give them a beat, then
      // treat a still-missing mob as a stale selection and re-pick.
      if (Date.now() - start < 2000) {
        await sleep(300);
        continue;
      }
      return null;
    }
    // Survival: disengage and regen when hurt.
    if (hero.hp() < 35) {
      console.log(`  (hero at ${hero.hp()} HP — disengaging to regen)`);
      await hero.moveTo(fleePoint, 2);
      await ally.moveTo({ x: fleePoint.x + 3, z: fleePoint.z }, 2);
      await hero.waitUntil(() => hero.hp() >= 80, 90000, "hero regen");
      continue;
    }
    const heroD = dist(hero.pos(), m.pos);
    if (heroD > 2.2) {
      hero.send({ type: "move", target: { x: m.pos.x, z: m.pos.z } });
    } else {
      const r = await hero.attack(mobId);
      if (r.ok && /You slew/.test(r.message)) {
        killResult = r;
        return r;
      }
      if (!r.ok && /Not enough AP/.test(r.message)) await sleep(3000);
    }
    // Ally adds damage but never takes the killing blow (stops at 45 HP).
    const am = hero.mob(mobId);
    if (am && am.hp > 45 && ally.hp() >= 40) {
      const allyD = dist(ally.pos(), am.pos);
      if (allyD > 2.2) ally.send({ type: "move", target: { x: am.pos.x, z: am.pos.z } });
      else {
        const r = await ally.attack(mobId);
        if (r.ok && /You slew/.test(r.message)) fail("ally stole the killing blow (tune thresholds)");
      }
    } else if (ally.hp() < 40) {
      ally.send({ type: "move", target: fleePoint });
    }
    await sleep(450);
  }
  fail(`killMob ${mobId} timed out`);
}

// ---------------------------------------------------------------------------

console.log(`Sprint 3 smoke vs ${WS_URL}`);

const hero = new Bot(`SmokeHero-${suffix}`);
const ally = new Bot(`SmokeAlly-${suffix}`);

// 1. Join + welcome sanity ----------------------------------------------------
const w = await hero.join();
assert(w.protocolVersion === "0.3.0", "welcome.protocolVersion is 0.3.0", w.protocolVersion);
assert(Array.isArray(w.mobs) && w.mobs.length > 0, "welcome includes mobs", `${w.mobs.length} alive`);
assert(Array.isArray(w.claims) && Array.isArray(w.structures), "welcome includes claims/structures");
assert(w.self.level === 1 && w.self.xp === 0 && w.self.xpNext === 100, "fresh self has level 1, 0/100 XP");
assert(typeof w.self.equipment === "object", "self.equipment present");
await ally.join();

await hero.waitUntil(() => hero.state && hero.state.mobs, 10000, "first state frame");
assert(
  hero.state.mobs.length > 0 && hero.state.self.level === 1 && hero.state.self.xpNext === 100,
  "state frames carry mobs + self xp/level/xpNext",
  `${hero.state.mobs.length} mobs, self ${JSON.stringify(hero.state.self)}`,
);
const kinds = new Set(hero.state.mobs.map((m) => m.kind));
assert(kinds.has("skeleton_minion") && kinds.has("skeleton_warrior"), "both mob kinds spawned", [...kinds].join(","));

// 2. Observation carries the new fields ---------------------------------------
hero.send({ type: "observe" });
const obs = await hero.waitFor((m) => m.type === "observation", 5000, "observation");
assert(Array.isArray(obs.questBoard) && obs.questBoard.length === 3, "observation.questBoard has 3 quests");
assert(Array.isArray(obs.nearbyMobs), "observation.nearbyMobs present");
assert(/Level 1/.test(obs.summary) && /quest/.test(obs.summary), "observation summary mentions level + quests");

// 3. Walk to a warrior camp and farm until equipment drops ---------------------
const warriors = hero.state.mobs
  .filter((m) => m.kind === "skeleton_warrior")
  .sort((a, b) => dist(a.pos, hero.pos()) - dist(b.pos, hero.pos()));
const camp = { ...warriors[0].pos };
const toVillage = { x: VILLAGE.x - camp.x, z: VILLAGE.z - camp.z };
const tvLen = Math.hypot(toVillage.x, toVillage.z);
const fleePoint = { x: camp.x + (toVillage.x / tvLen) * 30, z: camp.z + (toVillage.z / tvLen) * 30 };
console.log(`  warrior camp around (${camp.x.toFixed(0)}, ${camp.z.toFixed(0)}); walking out...`);
await hero.moveTo(fleePoint, 2);
await ally.moveTo({ x: fleePoint.x + 3, z: fleePoint.z }, 2.5);

const hasEquip = () => {
  const inv = hero.selfView?.inventory ?? {};
  if ((inv.rusty_sword ?? 0) > 0) return "rusty_sword";
  if ((inv.wooden_shield ?? 0) > 0) return "wooden_shield";
  return null;
};
let kills = 0;
let firstKill = null;
const killedIds = new Set();
while (!hasEquip()) {
  if (kills >= 4) fail("no equipment after 4 warrior kills (pity should guarantee by 3)");
  await sleep(500); // let state frames catch up with the simulation
  const target = hero
    .mobs()
    .filter((m) => m.kind === "skeleton_warrior" && !killedIds.has(m.id))
    .sort((a, b) => a.hp - b.hp || dist(a.pos, hero.pos()) - dist(b.pos, hero.pos()))[0];
  if (!target) fail("no warriors visible in state");
  console.log(`  engaging ${target.id} Lv${target.level} (${target.hp}/${target.hpMax} HP)`);
  const r = await killMob(hero, ally, target.id, fleePoint);
  if (!r) continue; // stale pick; re-select
  killedIds.add(target.id);
  kills++;
  if (!firstKill) firstKill = r;
  console.log(`  kill #${kills}: ${r.message}`);
}
ok("killed warrior(s) via existing attack message", `${kills} kill(s)`);
assert(/\+\d+ XP/.test(firstKill.message), "kill message reports XP");
assert((hero.selfView.inventory.bone ?? 0) >= 1, "bones dropped to killer inventory", `${hero.selfView.inventory.bone} bone`);
assert(hero.selfView.xp > 0 || hero.selfView.level > 1, "hero gained XP/levels", `level ${hero.selfView.level}, ${hero.selfView.xp}/${hero.selfView.xpNext} XP`);
const combatEv = hero.inbox.find((m) => m.type === "combat" && m.targetKind === "mob" && m.killed && m.xp);
assert(combatEv, "mob death broadcast a combat event with xp/lootItems", JSON.stringify(combatEv?.lootItems));

// 4. Equip the drop ------------------------------------------------------------
const item = hasEquip();
hero.send({ type: "equip", item });
const eq = await hero.waitFor((m) => m.type === "action_result" && m.action === "equip", 5000, "equip result");
assert(eq.ok, "equip succeeded", eq.message);
const slot = item === "rusty_sword" ? "weapon" : "offhand";
assert(eq.self.equipment[slot] === item, `self.equipment.${slot} is ${item}`);
await hero.waitUntil(
  () => hero.state.players.find((p) => p.id === hero.welcome.playerId)?.equipment?.[slot] === item,
  5000,
  "equipment visible in public state",
);
ok("equipment visible in PlayerPublic state frames");

// 5. Quests ---------------------------------------------------------------------
hero.send({ type: "quest_list" });
const board = await hero.waitFor((m) => m.type === "quest_board", 5000, "quest_board");
assert(board.quests.length === 3 && board.rotatesAt > Date.now(), "quest_board lists 3 rotating quests",
  board.quests.map((q) => `${q.id}:${q.title}`).join(" | "));

// Prefer cheap-to-progress goals.
const pref = (q) => {
  const g = q.goal;
  if (g.type === "gather" && (g.item === "wood" || g.item === "stone")) return 0;
  if (g.type === "craft" && (g.recipeId === "plank" || g.recipeId === "brick")) return 1;
  if (g.type === "craft") return 2;
  if (g.type === "slay") return 3;
  return 4; // gather ember_crystal: long trek
};
const quest = [...board.quests].sort((a, b) => pref(a) - pref(b))[0];
hero.send({ type: "quest_accept", questId: quest.id });
const qa = await hero.waitFor((m) => m.type === "action_result" && m.action === "quest_accept", 5000, "quest_accept");
assert(qa.ok, `accepted quest "${quest.title}"`, qa.message);
assert(qa.self.quests.length === 1, "self.quests tracks the accepted quest");

// Cap check: a player may hold at most 2 quests.
const others = board.quests.filter((q) => q.id !== quest.id);
hero.send({ type: "quest_accept", questId: others[0].id });
await hero.waitFor((m) => m.type === "action_result" && m.action === "quest_accept" && m.ok, 5000, "2nd accept");
hero.send({ type: "quest_accept", questId: others[1].id });
const qa3 = await hero.waitFor((m) => m.type === "action_result" && m.action === "quest_accept" && !m.ok, 5000, "3rd accept rejected");
assert(/2 active quests/.test(qa3.message), "third quest_accept rejected (max 2)", qa3.message);

// Make progress on the preferred quest.
const g = quest.goal;
if (g.type === "gather") {
  const kind = { wood: "tree", stone: "rock", ember_crystal: "crystal" }[g.item];
  await gatherMany(hero, kind, 1);
} else if (g.type === "craft") {
  const needs = { plank: [["tree", 2]], brick: [["rock", 2]], stone_axe: [["tree", 1], ["rock", 2]] }[g.recipeId];
  for (const [kind, n] of needs) await gatherMany(hero, kind, n);
  hero.send({ type: "craft", recipeId: g.recipeId, qty: 1 });
  const cr = await hero.waitFor((m) => m.type === "action_result" && m.action === "craft", 8000, "craft result");
  assert(cr.ok, `crafted ${g.recipeId} for quest`, cr.message);
} else if (g.type === "slay") {
  let slain = null;
  while (!slain) {
    await sleep(500);
    const target = hero
      .mobs()
      .filter((m) => !killedIds.has(m.id))
      .sort((a, b) => dist(a.pos, hero.pos()) - dist(b.pos, hero.pos()))[0];
    slain = await killMob(hero, ally, target.id, fleePoint);
    if (slain) killedIds.add(target.id);
  }
}
hero.send({ type: "quest_list" });
const board2 = await hero.waitFor((m) => m.type === "quest_board", 5000, "quest_board #2");
const active = board2.active.find((a) => a.quest.id === quest.id);
const completedEv = hero.inbox.find((m) => m.type === "event" && m.event === "quest_complete" && m.data?.questId === quest.id);
assert((active && active.progress >= 1) || completedEv, "quest progress tracked server-side",
  active ? `${active.progress}/${active.quest.goal.count}` : "auto-completed");

// 6. Territory: claim a plot ----------------------------------------------------
// Gather wall materials first: 5 wood + 5 stone.
await gatherMany(hero, "tree", Math.max(0, 5 - (hero.selfView.inventory.wood ?? 0)));
await gatherMany(hero, "rock", Math.max(0, 5 - (hero.selfView.inventory.stone ?? 0)));
ok("gathered wall materials", `wood=${hero.selfView.inventory.wood}, stone=${hero.selfView.inventory.stone}`);

const shardsBefore = hero.selfView.shards;
let claimRes = null;
for (let i = 0; i < 8 && (!claimRes || !claimRes.ok); i++) {
  if (i > 0) {
    const a = (i / 8) * 2 * Math.PI;
    await hero.moveTo({ x: hero.pos().x + Math.cos(a) * 18, z: hero.pos().z + Math.sin(a) * 18 }, 2, 25000, true);
  }
  hero.send({ type: "claim", pos: hero.pos() });
  claimRes = await hero.waitFor((m) => m.type === "action_result" && m.action === "claim", 5000, "claim result");
  if (!claimRes.ok) console.log(`  (claim retry: ${claimRes.message})`);
}
assert(claimRes.ok, "claimed a 12x12 plot", claimRes.message);
assert(claimRes.self.shards === shardsBefore - 50, "claim cost 50 shards", `${shardsBefore} -> ${claimRes.self.shards}`);
await hero.waitUntil(() => (hero.state.claims ?? []).some((c) => c.ownerName === hero.name), 5000, "claim in state");
const myClaim = hero.state.claims.find((c) => c.ownerName === hero.name);
ok("claim visible in state frames", myClaim.id);

// Second claim too close must fail.
hero.send({ type: "claim", pos: hero.pos() });
const claim2 = await hero.waitFor((m) => m.type === "action_result" && m.action === "claim", 5000, "claim #2");
assert(!claim2.ok && /Too close/.test(claim2.message), "overlapping claim rejected", claim2.message);

// 7. Build a wall on the plot ---------------------------------------------------
hero.send({ type: "build", structure: "wall", pos: myClaim.center });
const built = await hero.waitFor((m) => m.type === "action_result" && m.action === "build", 5000, "build result");
assert(built.ok, "built a wall on own plot", built.message);
await hero.waitUntil(() => (hero.state.structures ?? []).some((s) => s.ownerName === hero.name && s.kind === "wall"), 5000, "structure in state");
const wall = hero.state.structures.find((s) => s.ownerName === hero.name);
assert(wall.hp === 500 && wall.hpMax === 500, "wall has 500 HP", wall.id);

// Building on someone else's plot must fail (ally tries).
ally.send({ type: "build", structure: "wall", pos: myClaim.center });
const denied = await ally.waitFor((m) => m.type === "action_result" && m.action === "build", 5000, "ally build denied");
assert(!denied.ok, "ally cannot build on hero's plot", denied.message);

// Siege: the wall is attackable (by the ally, outside safe zone).
await ally.moveTo(wall.pos, 2);
const siege = await ally.attack(wall.id);
assert(siege.ok && /for \d+/.test(siege.message), "structures are attackable (siege)", siege.message);

console.log(`\nAll ${passed} checks green.`);
hero.ws.close();
ally.ws.close();
process.exit(0);
