#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const result = spawnSync("npm", ["run", "--silent", "typecheck"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "pipe"],
});

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim();
if (output.length > 0) {
  process.stdout.write(`${output}\n`);
}

if (result.error) {
  process.stdout.write(
    `VERIFY: FAIL — npm run typecheck could not start: ${result.error.message}\n`,
  );
  process.exit(1);
}

if (result.status !== 0) {
  process.stdout.write(
    `VERIFY: FAIL — npm run typecheck exited ${result.status}\n`,
  );
  process.exit(1);
}

process.stdout.write("VERIFY: PASS — npm run typecheck is clean\n");
