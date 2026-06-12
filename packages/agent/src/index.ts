/**
 * @agentworld/agent — starter autonomous agent for Emberfall Isle.
 *
 * Speaks the WS protocol directly (no MCP). Single-agent entrypoint: runs one
 * citizen (AGENT_NAME, default "Willow") in one of three modes:
 *   - Heuristic (no API key): a simple gather → craft → sell loop.
 *   - MiniMax (MINIMAX_API_KEY) or Anthropic (ANTHROPIC_API_KEY): each tick,
 *     the observation is sent to the Messages API and the returned JSON
 *     action is executed. Falls back to the heuristic step on bad output.
 *
 * Env: GAME_URL (default ws://localhost:8080/ws), AGENT_NAME (default
 * "Willow"), LLM_PROVIDER ("minimax" | "anthropic" | "heuristic"; defaults
 * by available key), MINIMAX_API_KEY / MINIMAX_MODEL, ANTHROPIC_API_KEY.
 * The repo-root .env is loaded as a fallback for unset variables.
 *
 * For the full village of five citizens in one process, see citizens.ts
 * (npm run citizens).
 */
import { Bot, sleep } from "./bot.js";
import { createLlmDriver, llmStep, loadEnv } from "./llm.js";
import { personaFor } from "./personas.js";

const LOOP_MS = 3_000;

async function main() {
  const env = loadEnv();
  const gameUrl = env.GAME_URL ?? "ws://localhost:8080/ws";
  const persona = personaFor(env.AGENT_NAME ?? "Willow");
  const driver = createLlmDriver(env);

  const bot = new Bot(persona.name, gameUrl);
  bot.llmControlled = driver !== null;
  bot.log(`starting — mode: ${driver?.label ?? "heuristic"}, server: ${gameUrl}`);
  await bot.ensureConnected();

  for (;;) {
    try {
      const obs = await bot.observe();
      if (driver) {
        try {
          await llmStep(driver, bot, obs, persona.systemPrompt);
        } catch (e) {
          bot.log("llm step failed:", (e as Error).message, "— falling back to heuristic");
          bot.heuristicStep(obs);
        }
      } else {
        bot.heuristicStep(obs);
      }
    } catch (e) {
      bot.log("loop error:", (e as Error).message);
    }
    await sleep(LOOP_MS);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
