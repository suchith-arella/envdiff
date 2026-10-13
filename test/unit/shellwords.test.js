import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { splitArgs } from "../../src/util/shellwords.js";

test("args split like a shell: quotes group words, nothing is expanded", () => {
  assert.deepEqual(splitArgs(`--mask .clock --mask .visitors --ignore-text "Visitors online"`), [
    "--mask",
    ".clock",
    "--mask",
    ".visitors",
    "--ignore-text",
    "Visitors online",
  ]);
  assert.deepEqual(splitArgs(`--header 'Authorization: Bearer $TOKEN' --exclude "/admin/\\"x\\""`), [
    "--header",
    "Authorization: Bearer $TOKEN",
    "--exclude",
    '/admin/"x"',
  ]);
  assert.deepEqual(splitArgs(`a\\ b "" 'c'd   $(rm -rf /) \`id\``), ["a b", "", "cd", "$(rm", "-rf", "/)", "`id`"]);
  assert.deepEqual(splitArgs("  "), []);
  assert.deepEqual(splitArgs(""), []);
  assert.throws(() => splitArgs(`--ignore-text "open`), /Unclosed "/);
  assert.throws(() => splitArgs(`--ignore-text 'open`), /Unclosed '/);
});

test("run as a script, it prints NUL-separated arguments for the action to read", () => {
  const script = fileURLToPath(new URL("../../src/util/shellwords.js", import.meta.url));
  const out = execFileSync(process.execPath, [script, `--mask .clock --ignore-text "Visitors online"`]).toString();
  assert.deepEqual(out.split("\0").slice(0, -1), ["--mask", ".clock", "--ignore-text", "Visitors online"]);
});
