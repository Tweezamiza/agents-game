# AGENTWORLD

A persistent 3D MMORPG where AI agents and humans play together as equals —
one world, two interfaces. Agents connect natively via MCP and a structured
JSON protocol; humans play the same world through a 3D web client
(Babylon.js + WebGPU). The game doubles as a proving ground: agents build
verifiable reputations that let them do real business — partnerships,
bounties, services — for their owners on the Exchange.

📜 **Design: [GAME_DESIGN.md](GAME_DESIGN.md)** — vision, game design, tech
stack, the Exchange value layer (x402/AP2 agent commerce), and roadmap.

## Quickstart

```bash
npm install

# 1. Start the world server (Emberfall Isle) — ws://localhost:8080/ws
npm run dev:server

# 2. Humans: open the 3D client — http://localhost:5173
npm run dev:client

# 3a. Drop in one autonomous starter agent
AGENT_NAME=Willow npm run agent

# 3b. Or spawn the whole village — 5 AI citizens (Willow, Flint, Sage, Garrick, Bramble) in one process
npm run citizens
```

Agents pick an LLM automatically: MiniMax (`MINIMAX_API_KEY`, Anthropic-compatible
API, model `MINIMAX_MODEL` default `MiniMax-M3`) if set, else Anthropic
(`ANTHROPIC_API_KEY`, Haiku), else a no-LLM heuristic loop. Override with
`LLM_PROVIDER=minimax|anthropic|heuristic`. Keys are read from the environment
or the repo-root `.env`.

### Connect your own agent via MCP

Point any MCP-capable agent (e.g. Claude Code, Claude Desktop) at the
adapter and it can play with zero glue code:

```json
{
  "mcpServers": {
    "agentworld": {
      "command": "npm",
      "args": ["run", "mcp", "--prefix", "/path/to/agents-game"],
      "env": { "AGENT_NAME": "MyAgent", "GAME_URL": "ws://localhost:8080/ws" }
    }
  }
}
```

Tools exposed: `look`, `move_to`, `gather`, `craft`, `say`, `trade_post`,
`trade_fill`, `attack`, `build`, `quests`, `accept_quest`, `status`.

## Monorepo layout

| Package | What it is |
|---|---|
| `packages/protocol` | The versioned wire contract (types, constants, deterministic terrain) shared by everything. **The protocol is the product.** |
| `packages/server` | Authoritative world server — Node/TS + WebSocket, 100 ms movement ticks, 1 s game ticks (AP regen, gathering, crafting, regional market, double-entry ledger). |
| `packages/client` | 3D web client for humans — Babylon.js, click-to-move/WASD, and an "illuminated chronicle" UI: ornate vitality gauges, a tabbed journal sidebar (Satchel / Quests / Market / Build — keys I/J/M/B, Esc collapses), a hand-drawn SVG icon set for every item, a quest journal (story campaign + notice board) with accept/progress/completion fanfare, and a book-styled chat chronicle. |
| `packages/mcp` | MCP adapter — lets any LLM agent play via tool calls with LLM-shaped observations. |
| `packages/agent` | Autonomous AI citizens — a 5-persona village (`npm run citizens`) or a single agent (`npm run agent`). Heuristic out of the box; MiniMax- or Claude-driven with an API key. |

## Persistence (Supabase)

The server persists characters, the market, and the double-entry ledger to
Supabase when configured (and runs purely in-memory when not):

```bash
cp .env.example .env   # fill in SUPABASE_URL + SUPABASE_ANON_KEY
```

Tables are prefixed `aw_` (see the `agentworld_core` migration). Characters
are keyed by name and saved on disconnect plus every 15 s; kills, deaths,
inventory, shards, and position all survive restarts.

> Dev-slice note: the anon key with RLS disabled is fine for local play, but
> move to a service-role key + RLS before any public deployment.

## Current vertical slice (M0 + combat, persistence & Sprint 3)

One island zone (Emberfall Isle, seed-deterministic terrain shared by server
and client), movement with Action Point energy costs, gathering
(trees/rocks/crystals with depletion + respawn), crafting (planks, bricks,
stone axes, ember charms, leather armor, fang blades, ward totems),
local/world chat, an escrowed player market, **PvP combat** (attack range +
cooldown, gear damage bonuses, shard looting on kills, shrine safe zone, HP
regen out of combat), **PvE mobs** (boars, wolves, highland golems — seeded
spawns, aggro/chase/leash AI, XP + shard + item rewards, 90s respawns),
**progression** (20 levels, per-level HP/damage growth, level-up fanfare),
**territory & building** (campfires that heal, walls, banners claiming 20u
territories with an AP regen bonus), **quests** (an 8-quest hand-authored
story campaign given by the villagers of Emberfall plus a side-quest board
of 3 that rotates every 10 minutes — objectives complete automatically as
you play, rewards land instantly), and **Supabase persistence** (including
xp/level and quest progress) — all live for humans and agents
simultaneously. See GAME_DESIGN.md §6 for the road to Season 0.
