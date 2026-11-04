import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { scanRows } from "../src/agent/sensitive-text-test-support.ts";

const CODE_COMMIT = "5b0ddfa7";
const RUNS = 5;
const TARGET_MS = 200;
const engine = fileURLToPath(new URL("..", import.meta.url));

function codeText(n) {
  const names = execFileSync(
    "git",
    ["-C", engine, "ls-tree", "-r", "--name-only", CODE_COMMIT, "src"],
    { encoding: "utf8" },
  )
    .split("\n")
    .filter((path) => path.endsWith(".ts"))
    .sort();
  let text = "";
  for (const path of names) {
    text += execFileSync(
      "git",
      ["-C", engine, "show", `${CODE_COMMIT}:${path}`],
      {
        encoding: "utf8",
        maxBuffer: 1 << 26,
      },
    );
    if (text.length >= n) break;
  }
  return text.slice(0, n);
}

function measure(name) {
  const row = scanRows(codeText).find((candidate) => candidate.name === name);
  if (!row) throw new Error(`no row ${name}`);
  const run = row.prepare();
  run();
  const times = [];
  for (let index = 0; index < RUNS; index++) {
    const start = process.hrtime.bigint();
    run();
    times.push(Number(process.hrtime.bigint() - start) / 1e6);
  }
  times.sort((left, right) => left - right);
  return times[Math.floor(times.length / 2)];
}

const [, script, name] = process.argv;
if (name) {
  process.stdout.write(`${JSON.stringify({ name, ms: measure(name) })}\n`);
} else {
  const names = scanRows(codeText).map((row) => row.name);
  let worst = { name: "", ms: 0 };
  for (const rowName of names) {
    const output = execFileSync(
      process.execPath,
      ["--max-old-space-size=4096", script, rowName],
      { encoding: "utf8", maxBuffer: 1 << 20 },
    );
    const result = JSON.parse(output);
    if (result.ms > worst.ms) worst = result;
    process.stdout.write(`${result.ms.toFixed(1)} ms | ${result.name}\n`);
  }
  process.stdout.write(
    `worst ${worst.ms.toFixed(1)} ms | ${worst.name} | target ${TARGET_MS} ms | ${worst.ms <= TARGET_MS ? "pass" : "fail"}\n`,
  );
}
