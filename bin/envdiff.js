#!/usr/bin/env node
import { main } from "../src/cli.js";

const major = Number(process.versions.node.split(".")[0]);
if (major < 20) {
  console.error(`envdiff needs Node.js 20 or newer (found ${process.versions.node}).`);
  process.exit(2);
}

main(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err);
    process.exitCode = 2;
  },
);
