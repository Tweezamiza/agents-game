import { readFileSync } from "node:fs";

/**
 * Provider-agnostic LLM chat call for agent brains.
 *
 * Provider is picked from the environment (repo-root .env is also read):
 *   1. MINIMAX_API_KEY   -> MiniMax (OpenAI-compatible chat completions).
 *      MINIMAX_MODEL     (default "MiniMax-M3")
 *      MINIMAX_BASE_URL  (default "https://api.minimax.io/v1")
 *   2. ANTHROPIC_API_KEY -> Anthropic Messages API (claude-haiku-4-5).
 *   3. neither           -> null (callers fall back to heuristic behavior).
 *
 * Keys live in env/.env only — never hardcode them.
 */

function loadDotEnv(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const path of [".env", "../../.env"]) {
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

const env = { ...loadDotEnv(), ...process.env };

export interface LlmProvider {
  name: "minimax" | "anthropic";
  model: string;
}

export function activeProvider(): LlmProvider | null {
  if (env.MINIMAX_API_KEY) {
    return { name: "minimax", model: env.MINIMAX_MODEL ?? "MiniMax-M3" };
  }
  if (env.ANTHROPIC_API_KEY) {
    return { name: "anthropic", model: "claude-haiku-4-5-20251001" };
  }
  return null;
}

/** One system+user chat turn; returns the model's text output. */
export async function chat(system: string, user: string, maxTokens = 300): Promise<string> {
  const provider = activeProvider();
  if (!provider) throw new Error("no LLM provider configured");

  if (provider.name === "minimax") {
    const base = (env.MINIMAX_BASE_URL ?? "https://api.minimax.io/v1").replace(/\/$/, "");
    const res = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${env.MINIMAX_API_KEY}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: provider.model,
        max_tokens: maxTokens,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!res.ok) throw new Error(`MiniMax API ${res.status}: ${(await res.text()).slice(0, 200)}`);
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
      base_resp?: { status_code?: number; status_msg?: string };
    };
    // MiniMax reports some failures inside a 200 body.
    if (data.base_resp?.status_code && data.base_resp.status_code !== 0) {
      throw new Error(`MiniMax API error ${data.base_resp.status_code}: ${data.base_resp.status_msg}`);
    }
    const text = data.choices?.[0]?.message?.content;
    if (!text) throw new Error("MiniMax returned no message content");
    return text;
  }

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": env.ANTHROPIC_API_KEY!,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { content?: { type: string; text?: string }[] };
  const text = data.content?.find((b) => b.type === "text")?.text;
  if (!text) throw new Error("Anthropic returned no text content");
  return text;
}
