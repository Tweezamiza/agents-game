/**
 * LLM drivers + shared decision plumbing.
 *
 * One interface — decide(systemPrompt, userPrompt) => raw model text — with
 * two Anthropic-Messages-API-compatible backends (Anthropic, MiniMax) plus
 * the JSON-action parser/dispatcher both feed. Provider selection via
 * LLM_PROVIDER env ("minimax" | "anthropic" | "heuristic"); defaults to
 * minimax if MINIMAX_API_KEY is set, else anthropic, else heuristic.
 *
 * Env is read from process.env, backfilled from the repo-root .env if
 * present (same tiny loader pattern as packages/server/src/persistence.ts).
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ItemId, ObservationMsg, SAFE_ZONE_CENTER } from "@agentworld/protocol";
import { Bot } from "./bot.js";

export type LlmProvider = "minimax" | "anthropic" | "heuristic";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODEL = "claude-haiku-4-5-20251001";
const MINIMAX_URL = "https://api.minimax.io/anthropic/v1/messages";
const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";
const MAX_TOKENS = 300;

// -- Env ----------------------------------------------------------------------

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  const candidates = [".env", "../../.env", fileURLToPath(new URL("../../../.env", import.meta.url))];
  for (const path of candidates) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*"?([^"\n]*)"?\s*$/);
        if (m) out[m[1]] = m[2];
      }
      break;
    } catch {
      // try next path
    }
  }
  return out;
}

/** process.env wins over the root .env; .env fills the gaps. */
export function loadEnv(): Record<string, string | undefined> {
  return { ...loadDotEnv(), ...process.env };
}

// -- Drivers --------------------------------------------------------------------

export interface LlmDriver {
  provider: Exclude<LlmProvider, "heuristic">;
  /** Human-readable label for startup logs, e.g. "minimax (MiniMax-M3)". */
  label: string;
  decide(systemPrompt: string, userPrompt: string): Promise<string>;
}

/** Thrown on non-2xx LLM responses so callers can back off on 429/5xx. */
export class LlmHttpError extends Error {
  readonly status: number;
  constructor(provider: string, status: number, body: string) {
    super(`${provider} API ${status}: ${body.slice(0, 200)}`);
    this.status = status;
  }
}

async function messagesApi(
  provider: Exclude<LlmProvider, "heuristic">,
  url: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new LlmHttpError(provider, res.status, await res.text());
  }
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  return data.content?.find((b) => b.type === "text")?.text ?? "";
}

export function resolveProvider(env: Record<string, string | undefined>): LlmProvider {
  const explicit = env.LLM_PROVIDER;
  if (explicit === "minimax" || explicit === "anthropic" || explicit === "heuristic") return explicit;
  if (env.MINIMAX_API_KEY) return "minimax";
  if (env.ANTHROPIC_API_KEY) return "anthropic";
  return "heuristic";
}

/** Returns null for heuristic mode (no driver — callers use bot.heuristicStep). */
export function createLlmDriver(env: Record<string, string | undefined>): LlmDriver | null {
  const provider = resolveProvider(env);
  if (provider === "heuristic") return null;
  if (provider === "minimax") {
    const key = env.MINIMAX_API_KEY;
    if (!key) throw new Error("LLM_PROVIDER=minimax but MINIMAX_API_KEY is not set");
    const model = env.MINIMAX_MODEL ?? MINIMAX_DEFAULT_MODEL;
    return {
      provider,
      label: `minimax (${model})`,
      decide: (system, user) => messagesApi(provider, MINIMAX_URL, key, model, system, user),
    };
  }
  const key = env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("LLM_PROVIDER=anthropic but ANTHROPIC_API_KEY is not set");
  return {
    provider,
    label: `anthropic (${ANTHROPIC_MODEL})`,
    decide: (system, user) => messagesApi(provider, ANTHROPIC_URL, key, ANTHROPIC_MODEL, system, user),
  };
}

// -- Decision parsing + dispatch --------------------------------------------------

export interface AgentDecision {
  action:
    | "move_to"
    | "gather"
    | "craft"
    | "say"
    | "trade_post"
    | "trade_fill"
    | "attack"
    | "quest_accept"
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
  quest_id?: string;
}

/**
 * Parse the model's raw text into a JSON action and dispatch it on the bot.
 * Throws if no parseable JSON action is found — callers fall back to
 * bot.heuristicStep(obs) exactly as the single-agent loop always has.
 */
export function executeDecision(bot: Bot, rawText: string): void {
  const jsonMatch = rawText.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`no JSON object in model output: ${rawText.slice(0, 120)}`);
  const d = JSON.parse(jsonMatch[0]) as AgentDecision;

  bot.log(`llm decision: ${d.action}${d.reason ? ` — ${d.reason}` : ""}`);
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
    case "quest_accept":
      bot.send({ type: "quest_accept", questId: String(d.quest_id) });
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

/** The per-tick user prompt: observation summary + logs + structured context. */
export function buildUserPrompt(bot: Bot, obs: ObservationMsg): string {
  return [
    `Observation: ${obs.summary}`,
    `Vitals: HP ${obs.self.hp}/${obs.self.hpMax}, ${obs.self.inSafeZone ? "INSIDE" : "outside"} the shrine safe zone, K/D ${obs.self.kills}/${obs.self.deaths}.`,
    `Recent combat events:\n${bot.combatLog.slice(-8).join("\n") || "(none)"}`,
    `Recent chat:\n${bot.chatLog.slice(-10).join("\n") || "(none)"}`,
    `Last action result: ${bot.lastActionResult}`,
    `Nearby nodes (JSON): ${JSON.stringify(obs.nearbyNodes.slice(0, 8))}`,
    `Nearby players (JSON): ${JSON.stringify(obs.nearbyPlayers.slice(0, 8))}`,
    `Market (JSON): ${JSON.stringify(obs.market.slice(0, 10))}`,
  ].join("\n\n");
}

/** One LLM-driven tick: prompt → decide → dispatch. Throws on API/parse failure. */
export async function llmStep(
  driver: LlmDriver,
  bot: Bot,
  obs: ObservationMsg,
  systemPrompt: string,
): Promise<void> {
  const text = await driver.decide(systemPrompt, buildUserPrompt(bot, obs));
  executeDecision(bot, text);
}

// -- Concurrency ----------------------------------------------------------------

/** Tiny non-queueing semaphore: caps in-flight LLM calls across all bots. */
export class Semaphore {
  private inFlight = 0;
  constructor(private readonly limit: number) {}

  tryAcquire(): boolean {
    if (this.inFlight >= this.limit) return false;
    this.inFlight++;
    return true;
  }

  release(): void {
    this.inFlight = Math.max(0, this.inFlight - 1);
  }
}
