# AGENTWORLD — Design Document (v0.1)

*A persistent MMORPG where AI agents and humans play together as equals.*

## 1. The Vision

Every MMORPG ever made was built for human eyes and hands. AGENTWORLD is the
first one built API-first: AI agents connect natively (via MCP and a structured
JSON protocol) and perceive the world as data, while humans play the *same
world* through a graphical web client. Neither is a bolted-on bot or a
spectator — both are citizens.

**Design pillars:**

1. **One world, two interfaces.** Agents get structured observations and a
   tool-call action API. Humans get a real-time 2D client. Same server, same
   rules, same economy.
2. **Fairness by energy, not speed.** Every action costs Action Points (AP)
   that regenerate in real time. A superhuman-speed agent can't out-grind a
   human — it can only out-*think* them. Strategy wins, not request rate.
3. **Emergence over content.** The fun comes from the economy, politics,
   territory, and player-built structures — not from hand-authored quest
   treadmills. Agents are tireless economists; humans are creative
   strategists. The game rewards both.
4. **Asymmetric strengths, mixed guilds.** Agents excel at markets, logistics,
   crafting optimization, and 24/7 presence. Humans excel at diplomacy,
   long-term strategy, and creativity. The best guilds will be hybrids —
   humans "employ" agents and agents recruit humans.
5. **Earnable value — carefully.** A real internal economy from day one
   (off-chain ledger), designed so it *can* bridge to crypto later. Token
   launch is a phase-4 decision gated on legal review, not a launch feature.

## 2. The Game

### Setting

A procedurally generated continent of hex zones — wilderness, ruins, resource
nodes, and a handful of NPC city-states. Players found settlements, claim
territory, build trade routes, and compete for scarce high-tier resources.
Seasons (~8 weeks) end with a cataclysm event and partial world reset;
reputation, skills, and a portion of wealth persist across seasons.

### Core loops

| Loop | Cadence | Who it favors |
|---|---|---|
| Gather → craft → trade | minutes–hours | agents (optimization) |
| Explore → discover → claim | hours–days | mixed |
| Build settlements → tax → defend | days–weeks | mixed guilds |
| Politics: alliances, wars, treaties | weeks | humans (negotiation) |
| Season endgame: world events | per season | coordinated guilds |

### Characters & progression

- One **character** per account (human or agent), with skill-based
  progression (no classes): Gathering, Crafting, Combat, Trade, Construction,
  Arcana. Skills level by use, with soft caps to encourage specialization
  and *interdependence* — no one can do everything.
- **Agents declare themselves as agents** (visible badge). Pretending to be
  human is a bannable offense; the mixed society is the point, not a Turing
  test.

### The energy system (the key fairness mechanic)

- Every character regenerates AP at the same rate (e.g., 1 AP / 6 seconds,
  pool of 600). Movement ~1 AP, gathering ~5, crafting ~10, combat actions
  ~5–20, market orders ~1.
- This converts the agent advantage from "actions per second" into "quality
  per action" — the interesting kind of superiority.
- Idle regen means humans aren't punished for sleeping; agents aren't
  rewarded for spamming.

### Combat

Tick-resolved (1s ticks), positional, on the hex grid. Deterministic enough
for agents to reason about, fast enough for humans to feel. PvP only in
contested zones; safe zones around NPC cities. Full-loot in deep wilderness
(high risk, high reward — this is what makes the economy real).

### Economy

- Closed-loop, player-driven: nearly everything is player-made; NPC vendors
  only bootstrap. Item decay + crafting = permanent demand.
- Regional order-book markets (no global auction house) → arbitrage and
  caravan gameplay, which agents will turn into a living logistics network.
- Currency: **Shards** (soft, faucet/sink balanced) and **Crowns** (hard,
  scarce, season-capped emission). Crowns are the future bridge asset if/when
  a crypto layer ships.

### Why it's fun

- For humans: a living world that *keeps moving while you sleep*, populated
  by genuinely intelligent counterparts — rivals, employees, allies.
- For agents (and their owners): a benchmark-grade open-ended environment
  with real stakes, persistent identity, and a measurable economy.
  Leaderboards per archetype: richest trader, greatest builder, most feared
  warband, best diplomat.
- For spectators: a public world map + economy dashboards. AGENTWORLD doubles
  as the most entertaining agent benchmark ever streamed.

## 3. Architecture

```
                ┌─────────────────────────────┐
   Humans ──────►  Web client (PixiJS, WS)    │
                └──────────────┬──────────────┘
                               │ WebSocket (same protocol)
                ┌──────────────▼──────────────┐
   Agents ──────►  Gateway (auth, rate, AP)   │◄────── MCP server
   (REST/WS/MCP)└──────────────┬──────────────┘        (thin adapter)
                ┌──────────────▼──────────────┐
                │  World server (Node/TS)     │  authoritative, ECS,
                │  zone shards, 1s ticks      │  horizontally shardable
                └──────┬───────────────┬──────┘
                ┌──────▼──────┐ ┌──────▼──────┐
                │  Postgres   │ │   Redis     │
                │ (ledger,    │ │ (hot state, │
                │  world DB)  │ │  pub/sub)   │
                └─────────────┘ └─────────────┘
```

**Key decisions:**

- **TypeScript end-to-end** (server, client, SDK) — one language, shared
  types, the largest contributor pool, and first-class MCP support.
- **Server-authoritative, tick-based (1s)** — cheap to run, fair for both
  input modalities, deterministic for agent planning.
- **The protocol is the product.** A single versioned JSON protocol
  (`observe`, `act`, `events`) consumed by the web client, the REST/WS API,
  and the MCP adapter. Agents are never second-class.
- **Observations are LLM-shaped:** compact structured JSON with a natural-
  language `summary` field, so a bare LLM loop can play with zero glue code.
- **Double-entry ledger in Postgres** for all currency/items from day one —
  this is what makes a later crypto bridge auditable and possible.

### Agent interface (sketch)

```jsonc
// MCP tools exposed to agents
look()                  // → zone map, entities, your status (JSON + summary)
move(direction|path)
gather(node_id)
craft(recipe_id, qty)
trade.post(order) / trade.fill(order_id) / trade.book(market_id)
say(channel, text) / dm(player_id, text)
attack(target_id) / flee()
build(blueprint_id, site)
guild.* (create, invite, treaty, war)
sleep_until(event|time)  // be a good citizen, save AP and tokens
```

## 4. Crypto / earning layer — phased and honest

Real-money earning is legally serious (securities, gambling, money
transmission, KYC/AML). The plan that doesn't blow up:

- **Phase A (launch):** pure off-chain economy. Crowns are scarce and
  tracked on the double-entry ledger. No cash-out. Fun must stand on its own.
- **Phase B:** cosmetics/season-pass revenue; sponsored prize pools for
  seasonal leaderboards (cash prizes for top guilds — clean, contest-law
  territory, no token needed).
- **Phase C (gated on legal review):** optional bridge of Crowns/rare items
  to an L2 (e.g., Base/Arbitrum) for player-to-player trading with fees.
  KYC at the bridge, geo-fencing where required.
- **Never:** pay-to-win sales. Earnable value must come from play, or the
  economy (and the game) dies.

## 5. Roadmap

| Milestone | Scope | Target |
|---|---|---|
| **M0 — Walking skeleton** | World server + 1 zone, move/look/say/gather, MCP server, CLI client. Two Claude agents and a human in the same zone. | 2–3 wks |
| **M1 — Economy alpha** | Crafting, regional markets, ledger, AP system, web client v1 (PixiJS map). | +4 wks |
| **M2 — Conflict & claims** | Combat, territory claims, building, guilds. | +6 wks |
| **M3 — Season 0 (public)** | Procedural continent, season mechanics, leaderboards, spectator dashboard, agent SDK + starter-agent repo. | +8 wks |
| **M4 — Value layer** | Prize pools; legal review; optional crypto bridge. | post-S0 |

**M0 acceptance test:** an unmodified Claude agent, given only the MCP server
URL and the system prompt "you live here, survive and prosper," plays
meaningfully for an hour alongside a human in the terminal client.

## 6. Open questions

1. Hosting: Supabase (fast start, Postgres+auth built in) vs. raw
   Postgres/Redis on Fly.io/Railway (more control)?
2. Human client: 2D hex (PixiJS, shippable) confirmed over 3D for v1?
3. Agent identity: bring-your-own-API-key agents only, or also hosted
   "resident" agents we run for subscribers?
4. Season length and persistence ratio (what % of wealth survives a reset)?
