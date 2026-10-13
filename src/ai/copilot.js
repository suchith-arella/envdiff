import { AIUnavailableError, parseJsonReply } from "./provider.js";

/** One answer may take a while (images, a busy model); a hung one shouldn't hold the run. */
const TIMEOUT_MS = 5 * 60 * 1000;

const SIGN_IN = [
  "GitHub Copilot needs a signed-in GitHub user with Copilot:",
  "  in GitHub Actions, give the job `permissions: copilot-requests: write` and pass GITHUB_TOKEN",
  "  (for organization repositories, an owner must allow Copilot CLI billed to the organization);",
  "  locally, run `copilot login` or set GH_TOKEN.",
].join("\n");

/**
 * GitHub Copilot, through the Copilot SDK, as the signed-in GitHub user.
 * Each request is its own session with a replaced system prompt, no tools at
 * all and every permission request refused: the model reads what envdiff
 * sends and answers, nothing more. It never runs commands on the machine.
 *
 * The SDK (and the Copilot runtime it carries, about 150 MB) is installed on
 * demand, not with envdiff: `npm install @github/copilot-sdk`. The envdiff
 * Action does this when its `ai` input is `copilot`.
 * @param {import("../config.js").Config} cfg
 * @param {{ env: NodeJS.ProcessEnv, outDir: string, sdk?: any, log: import("../util/log.js").Logger }} ctx
 * @returns {Promise<import("./provider.js").AIProvider>}
 */
export async function copilotProvider(cfg, ctx) {
  let sdk = ctx.sdk;
  if (!sdk) {
    // A variable, so the optional package isn't needed to type-check or bundle envdiff.
    const name = "@github/copilot-sdk";
    try {
      sdk = await import(name);
    } catch {
      throw new AIUnavailableError(`GitHub Copilot needs the Copilot SDK: npm install @github/copilot-sdk (Node ^20.19 or >=22.12). The envdiff Action installs it when ai is copilot.`);
    }
  }
  const env = ctx.env;
  const token = env.COPILOT_GITHUB_TOKEN || env.GH_TOKEN || env.GITHUB_TOKEN || undefined;
  const client = new sdk.CopilotClient({
    ...(token ? { gitHubToken: token } : {}),
    logLevel: "error",
    // Nothing of the repository is needed: the prompt carries everything.
    workingDirectory: ctx.outDir,
  });
  try {
    await client.start();
  } catch (e) {
    throw unavailable(e);
  }
  const model = cfg.ai.model || "auto";
  /** Structured output is a preview feature: off for good once a runtime turns it down. */
  let structured = true;

  return {
    name: "copilot",
    model,
    usage: { input: 0, output: 0 },
    async ask(req) {
      const effort = req.effort ?? cfg.ai.effort;
      let session;
      try {
        session = await client.createSession({
          model,
          ...(effort && model !== "auto" ? { reasoningEffort: effort } : {}),
          systemMessage: { mode: "replace", content: req.system },
          availableTools: [],
          onPermissionRequest: () => ({ kind: "reject", feedback: "No tools are available in this session." }),
          enableSessionStore: false,
        });
      } catch (e) {
        throw unavailable(e);
      }
      try {
        // Images go as attachments, referred to in the text where they belong.
        /** @type {{ type: "blob", data: string, mimeType: string }[]} */
        const attachments = [];
        const prompt = req.parts
          .map((p) => {
            if (p.type === "text") return p.text;
            attachments.push({ type: "blob", data: p.data, mimeType: p.mediaType });
            return `[image ${attachments.length}]`;
          })
          .join("\n\n");
        /**
         * Send and wait for the answer, or for the session to fail: a waiting
         * structured answer doesn't end when the session errors (signed out,
         * no access), only when its time runs out.
         * @param {any} opts
         * @returns {Promise<any>}
         */
        const answer = (opts) =>
          new Promise((resolve, reject) => {
            const off = session.on("session.error", (/** @type {any} */ ev) => {
              off?.();
              reject(new Error(ev?.data?.message ?? "the Copilot session failed"));
            });
            session.sendAndWait(opts, TIMEOUT_MS).then(
              (/** @type {any} */ r) => {
                off?.();
                resolve(r);
              },
              (/** @type {any} */ e) => {
                off?.();
                reject(e);
              },
            );
          });
        /** @type {any} */
        let event;
        if (req.schema && structured) {
          try {
            event = await answer({ prompt, attachments, responseSchema: req.schema });
          } catch (e) {
            if (!/response ?format|responseSchema|structured|not supported|unsupported/i.test(String(/** @type {Error} */ (e)?.message))) throw unavailable(e);
            structured = false;
          }
        }
        if (!event) {
          const ask = req.schema
            ? `${prompt}\n\nAnswer with only a JSON object that matches this JSON Schema, and nothing else:\n${JSON.stringify(req.schema)}`
            : prompt;
          try {
            event = await answer({ prompt: ask, attachments });
          } catch (e) {
            throw unavailable(e);
          }
        }
        const text = String(event?.data?.content ?? "");
        if (!text.trim()) return { text: "", refused: true };
        return { text, json: req.schema ? parseJsonReply(text) : undefined };
      } finally {
        await session.disconnect().catch(() => {});
      }
    },
    async close() {
      await client.stop().catch(() => {});
    },
  };
}

/**
 * Signing-in and access problems come back on every request: make them one
 * clear error. Anything else is passed on as it is.
 * @param {unknown} e
 */
function unavailable(e) {
  const msg = /** @type {Error} */ (e)?.message ?? String(e);
  if (/auth|unauthori[sz]ed|\b40[13]\b|forbidden|not (signed|logged) in|login|token|not enabled|no access|subscription|seat|policy|entitle/i.test(msg)) {
    // The runtime wraps the HTTP answer in JSON; its body says it best.
    const body = /"body":"([^"]{1,200})/.exec(msg)?.[1]?.replace(/\\n/g, " ").trim();
    const short = body || msg.replace(/^Execution failed: (model resolution leaf failed: )?/, "").split("\n")[0].slice(0, 200);
    return new AIUnavailableError(`GitHub Copilot refused: ${short}\n${SIGN_IN}`);
  }
  return e instanceof Error ? e : new Error(msg);
}
