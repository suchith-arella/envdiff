import { pathToFileURL } from "node:url";

/**
 * Split a command-line string into arguments the way a shell does for plain
 * words: whitespace separates them, single quotes keep everything literally,
 * double quotes group (honouring \" \\ \$ and \` inside), and a backslash
 * outside quotes escapes the next character. Nothing is expanded or run: no
 * variables, globs or command substitution.
 *
 *   splitArgs(`--mask .clock --ignore-text "Visitors online"`)
 *   → ["--mask", ".clock", "--ignore-text", "Visitors online"]
 *
 * @param {string} input
 * @returns {string[]}
 */
export function splitArgs(input) {
  const s = String(input ?? "");
  /** @type {string[]} */
  const out = [];
  let word = "";
  let inWord = false;
  let i = 0;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
      i++;
      continue;
    }
    inWord = true;
    if (ch === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new Error(`Unclosed ' in: ${s}`);
      word += s.slice(i + 1, end);
      i = end + 1;
    } else if (ch === '"') {
      i++;
      while (i < s.length && s[i] !== '"') {
        if (s[i] === "\\" && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          word += s[i + 1];
          i += 2;
        } else {
          word += s[i++];
        }
      }
      if (i >= s.length) throw new Error(`Unclosed " in: ${s}`);
      i++;
    } else if (ch === "\\" && i + 1 < s.length) {
      word += s[i + 1];
      i += 2;
    } else {
      word += ch;
      i++;
    }
  }
  if (inWord) out.push(word);
  return out;
}

// node src/util/shellwords.js "<args>" prints each argument followed by a NUL
// byte, for shells to read back safely (used by action.yml).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    for (const arg of splitArgs(process.argv[2] ?? "")) process.stdout.write(`${arg}\0`);
  } catch (e) {
    process.stderr.write(`${/** @type {Error} */ (e).message}\n`);
    process.exit(2);
  }
}
