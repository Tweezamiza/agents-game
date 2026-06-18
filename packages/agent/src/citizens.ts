/**
 * Citizens runner — the whole village in one process.
 *
 * Spawns every persona as a Bot against GAME_URL with staggered joins and
 * jittered per-bot decision loops so five citizens don't burst the LLM API
 * in sync. A shared driver is capped at MAX_INFLIGHT_LLM concurrent calls;
 * bots that can't get a slot use the heuristic step that tick. A bot whose
 * LLM call hits 429/5xx is backed off to heuristic for LLM_BACKOFF_MS.
 *
 * Run: npm run citizens (root) — clean shutdown on SIGINT.
 */
import { Bot, sleep } from "./bot.js";
import { LlmDriver, LlmHttpError, Semaphore, createLlmDriver, llmStep, loadEnv } from "./llm.js";
import { PERSONAS, Persona } from "./personas.js";

const LOOP_MS = 3_000;
/** Extra random delay per tick so bot loops drift apart. */
const JITTER_MS = 750;
/** Delay between bot joins at startup. */
const STAGGER_MS = 1_500;
/** Max concurrent LLM calls across all bots. */
const MAX_INFLIGHT_LLM = 2;
/** How long a bot stays heuristic after the LLM returns 429/5xx. */
const LLM_BACKOFF_MS = 60_000;

const env = loadEnv();
const GAME_URL = env.GAME_URL ?? "ws://localhost:8080/ws";

const llmGate = new Semaphore(MAX_INFLIGHT_LLM);
const bots: Bot[] = [];
let shuttingDown = false;

async function runCitizen(persona: Persona, driver: LlmDriver | null): Promise<void> {
  const bot = new Bot(persona.name, GAME_URL);
  bot.llmControlled = driver !== null;
  bots.push(bot);
  bot.log(`starting ${persona.archetype} — mode: ${driver?.label ?? "heuristic"}`);
  await bot.ensureConnected();

  let llmBackoffUntil = 0;

  while (!shuttingDown) {
    try {
      const obs = await bot.observe();
      const llmAvailable = driver !== null && Date.now() >= llmBackoffUntil;
      if (driver !== null && llmAvailable && llmGate.tryAcquire()) {
        try {
          await llmStep(driver, bot, obs, persona.systemPrompt);
        } catch (e) {
          const err = e as Error;
          if (err instanceof LlmHttpError && (err.status === 429 || err.status >= 500)) {
            llmBackoffUntil = Date.now() + LLM_BACKOFF_MS;
            bot.log(`llm ${err.status} — backing off to heuristic for ${LLM_BACKOFF_MS / 1000}s`);
          } else {
            bot.log("llm step failed:", err.message, "— falling back to heuristic");
          }
          bot.heuristicStep(obs);
        } finally {
          llmGate.release();
        }
      } else {
        if (driver !== null && llmAvailable) bot.log("llm slots busy — heuristic this tick");
        bot.heuristicStep(obs);
      }
    } catch (e) {
      if (shuttingDown) break;
      bot.log("loop error:", (e as Error).message);
    }
    await sleep(LOOP_MS + Math.random() * JITTER_MS);
  }
}

async function main() {
  const driver = createLlmDriver(env);
  console.log(
    `citizens: spawning ${PERSONAS.length} AI citizens (${PERSONAS.map((p) => p.name).join(", ")}) — ` +
      `mode: ${driver?.label ?? "heuristic"}, server: ${GAME_URL}`,
  );

  process.on("SIGINT", () => {
    console.log("\ncitizens: SIGINT — shutting down");
    shuttingDown = true;
    for (const bot of bots) bot.shutdown();
    // Loops are sleeping ≤ LOOP_MS + JITTER_MS; give them a beat, then exit.
    setTimeout(() => process.exit(0), 500);
  });

  const runs: Promise<void>[] = [];
  for (const persona of PERSONAS) {
    runs.push(
      runCitizen(persona, driver).catch((e) =>
        console.error(`citizens: ${persona.name} died:`, (e as Error).message),
      ),
    );
    await sleep(STAGGER_MS);
  }
  await Promise.all(runs);
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
