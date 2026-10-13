import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveConfig } from "../../src/config.js";
import { pickProvider, parseJsonReply, AIUnavailableError } from "../../src/ai/provider.js";
import { copilotProvider } from "../../src/ai/copilot.js";
import { createLogger } from "../../src/util/log.js";

const log = createLogger({ level: "silent" });

/**
 * A stand-in for @github/copilot-sdk that records what it is asked.
 * @param {{ structured?: boolean, reply?: string | ((o: any) => string), failStart?: string }} o
 */
function fakeSdk({ structured = true, reply = "{}", failStart } = {}) {
  /** @type {{ client: any, sessions: any[], sends: any[], disconnected: number, stopped: boolean }} */
  const seen = { client: null, sessions: [], sends: [], disconnected: 0, stopped: false };
  class CopilotClient {
    constructor(/** @type {any} */ opts) {
      seen.client = opts;
    }
    async start() {
      if (failStart) throw new Error(failStart);
    }
    async stop() {
      seen.stopped = true;
      return [];
    }
    async createSession(/** @type {any} */ cfg) {
      seen.sessions.push(cfg);
      return {
        on: () => () => {},
        async sendAndWait(/** @type {any} */ opts, /** @type {number} */ timeout) {
          seen.sends.push({ opts, timeout });
          if (opts.responseSchema && !structured) throw new Error("responseFormat is not supported by this runtime");
          return { type: "assistant.message", data: { content: typeof reply === "function" ? reply(opts) : reply } };
        },
        async disconnect() {
          seen.disconnected++;
        },
      };
    }
  }
  return { sdk: { CopilotClient }, seen };
}

const SCHEMA = { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false };

test("auto picks Anthropic when its key is set, GitHub Copilot otherwise", () => {
  const cfg = resolveConfig({ ai: { enabled: true } });
  assert.equal(pickProvider(cfg, { ANTHROPIC_API_KEY: "x" }), "anthropic");
  assert.equal(pickProvider(cfg, { GITHUB_TOKEN: "x" }), "copilot");
  assert.equal(pickProvider(cfg, {}), "copilot");
  assert.equal(pickProvider(resolveConfig({ ai: { provider: "Copilot" } }), { ANTHROPIC_API_KEY: "x" }), "copilot");
  assert.throws(() => resolveConfig({ ai: { provider: "openai" } }), /ai.provider must be auto, anthropic or copilot/);
});

test("Copilot answers in a session with no tools, as the workflow's GitHub user", async () => {
  const { sdk, seen } = fakeSdk({ reply: '{"ok":true}' });
  const cfg = resolveConfig({ ai: { enabled: true, provider: "copilot" } });
  const p = await copilotProvider(cfg, { env: { GITHUB_TOKEN: "ghs_test" }, outDir: "/tmp/report", sdk, log });
  assert.equal(p.name, "copilot");
  assert.equal(p.model, "auto");
  const res = await p.ask({
    system: "You triage.",
    parts: [
      { type: "text", text: "Findings: …" },
      { type: "text", text: "BASELINE page:" },
      { type: "image", mediaType: "image/png", data: "AAAA" },
      { type: "text", text: "Classify them." },
    ],
    schema: SCHEMA,
  });
  assert.deepEqual(res.json, { ok: true });
  assert.equal(seen.client.gitHubToken, "ghs_test");
  assert.equal(seen.client.workingDirectory, "/tmp/report");
  const session = seen.sessions[0];
  assert.deepEqual(session.availableTools, [], "no tools: it can't run anything on the runner");
  assert.deepEqual(session.systemMessage, { mode: "replace", content: "You triage." });
  assert.equal(session.onPermissionRequest().kind, "reject");
  assert.equal(session.reasoningEffort, undefined, "automatic model choice takes no effort setting");
  const sent = seen.sends[0].opts;
  assert.deepEqual(sent.responseSchema, SCHEMA);
  assert.deepEqual(sent.attachments, [{ type: "blob", data: "AAAA", mimeType: "image/png" }]);
  assert.match(sent.prompt, /BASELINE page:\n\n\[image 1\]\n\nClassify them\./);
  assert.equal(seen.disconnected, 1);
  await p.close();
  assert.ok(seen.stopped);
});

test("Copilot without structured output is asked for JSON in words, and its JSON found", async () => {
  const { sdk, seen } = fakeSdk({ structured: false, reply: 'Here you go:\n```json\n{"ok": false}\n```' });
  const cfg = resolveConfig({ ai: { enabled: true, provider: "copilot", model: "claude-opus-5.5" } });
  const p = await copilotProvider(cfg, { env: {}, outDir: "/tmp", sdk, log });
  const res = await p.ask({ system: "s", parts: [{ type: "text", text: "q" }], schema: SCHEMA, effort: "high" });
  assert.deepEqual(res.json, { ok: false });
  assert.equal(seen.sessions[0].reasoningEffort, "high");
  assert.equal(seen.client.gitHubToken, undefined, "no token: the logged-in user");
  assert.equal(seen.sends[1].opts.responseSchema, undefined);
  assert.match(seen.sends[1].opts.prompt, /JSON Schema/);
  // Not asked for structured output again.
  await p.ask({ system: "s", parts: [{ type: "text", text: "q" }], schema: SCHEMA });
  assert.equal(seen.sends[2].opts.responseSchema, undefined);
});

test("Copilot sign-in problems become one clear error", async () => {
  const { sdk } = fakeSdk({ failStart: "Not authorized: Copilot is not enabled for this account" });
  const cfg = resolveConfig({ ai: { enabled: true, provider: "copilot" } });
  await assert.rejects(copilotProvider(cfg, { env: {}, outDir: "/tmp", sdk, log }), (e) => e instanceof AIUnavailableError && /copilot-requests: write/.test(e.message));
});

test("JSON replies are found in prose and code fences", () => {
  assert.deepEqual(parseJsonReply('{"a":1}'), { a: 1 });
  assert.deepEqual(parseJsonReply('Sure!\n```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(parseJsonReply('The answer is {"a":3}. Done.'), { a: 3 });
  assert.throws(() => parseJsonReply("no json here"), /not JSON/);
});
