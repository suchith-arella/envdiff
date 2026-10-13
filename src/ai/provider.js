/**
 * The model behind envdiff's AI features (triage of findings, and steps of
 * plain-English journeys it can't read on its own):
 *
 *   anthropic  Claude through the Anthropic API (ANTHROPIC_API_KEY)
 *   copilot    GitHub Copilot as the signed-in GitHub user: in GitHub Actions
 *              the workflow's GITHUB_TOKEN (with `copilot-requests: write`),
 *              locally `copilot login` or GH_TOKEN
 *
 * Both answer the same request: a system prompt, text and images, and an
 * optional JSON schema the answer must follow.
 *
 * @typedef {{ type: "text", text: string } | { type: "image", mediaType: string, data: string }} AIPart
 *   `data` is base64.
 * @typedef {object} AIRequest
 * @property {string} system
 * @property {AIPart[]} parts
 * @property {object} [schema] JSON Schema for the answer; without one the answer is free text.
 * @property {string} [effort] low | medium | high | xhigh | max
 * @property {number} [maxTokens]
 * @typedef {object} AIAnswer
 * @property {string} text
 * @property {any} [json] The parsed answer, when a schema was given.
 * @property {boolean} [refused] The model declined.
 * @typedef {object} AIProvider
 * @property {"anthropic"|"copilot"} name
 * @property {string} model
 * @property {(req: AIRequest) => Promise<AIAnswer>} ask
 * @property {{ input: number, output: number }} usage
 * @property {() => Promise<void>} close
 */

/** An error that will happen for every request (no credentials, no access): stop asking. */
export class AIUnavailableError extends Error {
  name = "AIUnavailableError";
}

/**
 * Which provider to use. "auto": Anthropic when an Anthropic credential is in
 * the environment, otherwise GitHub Copilot.
 * @param {import("../config.js").Config} cfg
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {"anthropic"|"copilot"}
 */
export function pickProvider(cfg, env = process.env) {
  const p = String(cfg.ai.provider ?? "auto").toLowerCase();
  if (p === "anthropic" || p === "claude") return "anthropic";
  if (p === "copilot" || p === "github") return "copilot";
  return env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN ? "anthropic" : "copilot";
}

/**
 * @param {import("../config.js").Config} cfg
 * @param {{ log: import("../util/log.js").Logger, outDir: string, env?: NodeJS.ProcessEnv, anthropicClient?: any, copilotSdk?: any }} ctx
 *   `anthropicClient` / `copilotSdk` replace the real ones (tests).
 * @returns {Promise<AIProvider>}
 */
export async function createProvider(cfg, ctx) {
  const env = ctx.env ?? process.env;
  if (pickProvider(cfg, env) === "anthropic") {
    const { anthropicProvider } = await import("./anthropic.js");
    return anthropicProvider(cfg, { client: ctx.anthropicClient });
  }
  const { copilotProvider } = await import("./copilot.js");
  return copilotProvider(cfg, { env, outDir: ctx.outDir, sdk: ctx.copilotSdk, log: ctx.log });
}

/**
 * JSON out of a model's reply: the whole reply, or the object inside a code
 * fence or prose around it.
 * @param {string} text
 */
export function parseJsonReply(text) {
  const t = String(text ?? "").trim();
  try {
    return JSON.parse(t);
  } catch {
    // look inside
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) {
    try {
      return JSON.parse(fence[1]);
    } catch {
      // fall through
    }
  }
  const start = t.indexOf("{");
  const end = t.lastIndexOf("}");
  if (start >= 0 && end > start) return JSON.parse(t.slice(start, end + 1));
  throw new Error(`the answer is not JSON: ${t.slice(0, 120)}`);
}
