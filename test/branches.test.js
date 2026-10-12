/**
 * Branch mode end to end: a throwaway git repo with two branches of the
 * fixture app; envdiff checks each out into a worktree, starts it, compares.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { compare } from "../src/index.js";
import { createLogger } from "../src/util/log.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const server = path.join(here, "fixtures", "site", "server.js");

test("compares two branches by building and serving each", { timeout: 300_000 }, async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "envdiff-repo-"));
  const git = (/** @type {string[]} */ ...args) =>
    execFileSync("git", ["-c", "user.name=test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { cwd: repo, stdio: "pipe" }).toString();
  git("init", "-q", "-b", "main");
  fs.writeFileSync(path.join(repo, "variant.txt"), "baseline\n");
  git("add", ".");
  git("commit", "-q", "-m", "baseline");
  git("checkout", "-q", "-b", "feature/regressions");
  fs.writeFileSync(path.join(repo, "variant.txt"), "candidate\n");
  git("commit", "-q", "-am", "candidate");
  git("checkout", "-q", "main");

  const out = path.join(repo, "report");
  const port = 4300 + Math.floor(Math.random() * 500) * 2;
  const { report } = await compare(
    {
      baseline: { ref: "main" },
      candidate: { ref: "feature/regressions" },
      branches: {
        serve: {
          repo,
          start: `node ${JSON.stringify(server)} --variant "$(cat variant.txt)" --port $PORT`,
          port,
          readyTimeout: 30,
        },
      },
      crawl: { maxPages: 4, startPaths: ["/legacy", "/contact"] },
      explore: { enabled: false },
      a11y: { enabled: false },
      report: { outDir: out },
    },
    { log: createLogger({ level: "silent" }) },
  );

  assert.equal(report.meta.baseline.ref, "main");
  assert.equal(report.meta.candidate.ref, "feature/regressions");
  assert.match(report.meta.candidate.sha, /^[0-9a-f]{40}$/);
  const types = report.findings.map((/** @type {any} */ f) => `${f.page} ${f.type}`);
  assert.ok(types.includes("/legacy page.unavailable"), types.join("\n"));
  assert.ok(types.includes("/contact page.unavailable"), types.join("\n"));
  assert.ok(fs.existsSync(path.join(out, "serve-candidate.log")));
  // Worktrees and servers are cleaned up.
  assert.equal(git("worktree", "list").trim().split("\n").length, 1);
  await assert.rejects(fetch(`http://localhost:${port}/`), "baseline server stopped");
  fs.rmSync(repo, { recursive: true, force: true });
});
