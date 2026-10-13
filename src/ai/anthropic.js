import { AIUnavailableError } from "./provider.js";

/**
 * Claude through the Anthropic API. Answers that must follow a schema use
 * structured outputs; a request Claude declines on safety grounds is retried
 * server-side on a fallback model ("default" routing).
 * @param {import("../config.js").Config} cfg
 * @param {{ client?: any }} [opts] `client` replaces the SDK client (tests).
 * @returns {Promise<import("./provider.js").AIProvider>}
 */
export async function anthropicProvider(cfg, opts = {}) {
  const { default: Anthropic } = await import("@anthropic-ai/sdk");
  const client = opts.client ?? new Anthropic({ maxRetries: 4 });
  const model = cfg.ai.model || "claude-opus-5-5";
  const usage = { input: 0, output: 0 };
  let useFallbacks = true;

  /** @param {any} params */
  async function call(params) {
    try {
      const res = await client.beta.messages.create({
        ...params,
        model,
        ...(useFallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
      });
      usage.input += res.usage?.input_tokens ?? 0;
      usage.output += res.usage?.output_tokens ?? 0;
      return res;
    } catch (e) {
      // Accounts or proxies without server-side fallbacks: go on without them.
      if (useFallbacks && e instanceof Anthropic.BadRequestError && /fallback/i.test(e.message)) {
        useFallbacks = false;
        return call(params);
      }
      if (e instanceof Anthropic.AuthenticationError) throw new AIUnavailableError("Anthropic API key missing or invalid (set ANTHROPIC_API_KEY)");
      if (e instanceof Anthropic.PermissionDeniedError) throw new AIUnavailableError(`Anthropic API refused access: ${e.message}`);
      throw e;
    }
  }

  return {
    name: "anthropic",
    model,
    usage,
    async ask(req) {
      const content = req.parts.map((p) =>
        p.type === "text" ? { type: "text", text: p.text } : { type: "image", source: { type: "base64", media_type: p.mediaType, data: p.data } },
      );
      const res = await call({
        max_tokens: req.maxTokens ?? 16000,
        system: req.system,
        output_config: {
          effort: req.effort ?? cfg.ai.effort,
          ...(req.schema ? { format: { type: "json_schema", schema: req.schema } } : {}),
        },
        messages: [{ role: "user", content }],
      });
      if (res.stop_reason === "refusal") return { text: "", refused: true };
      const text = res.content
        .filter((/** @type {any} */ b) => b.type === "text")
        .map((/** @type {any} */ b) => b.text)
        .join("");
      return { text, json: req.schema ? JSON.parse(text) : undefined };
    },
    async close() {},
  };
}
