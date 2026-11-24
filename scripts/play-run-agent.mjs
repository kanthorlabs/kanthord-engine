import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ENGINE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");
const BIN = join(ENGINE_ROOT, "bin", "kanthord.mjs");
const DEFAULT_MODEL = "anthropic/claude-haiku-5-5:high";
const DEFAULT_BUDGET = "15m";
const DEFAULT_AUTH_SUBPATH = join(".pi", "agent", "auth.json");
const SAMPLE_AUTHOR_NAME = "Sample";
const SAMPLE_AUTHOR_EMAIL = "sample@example.com";
const GIT_MAIN_BRANCH = "main";

const ARGUMENT_SEPARATOR = "--";

const given = process.argv.slice(2);
const { values } = parseArgs({
  args: given[0] === ARGUMENT_SEPARATOR ? given.slice(1) : given,
  options: {
    repo: { type: "string" },
    model: { type: "string", default: DEFAULT_MODEL },
    auth: { type: "string" },
    budget: { type: "string", default: DEFAULT_BUDGET },
    "no-refresh": { type: "boolean", default: false },
  },
});

if (!existsSync(DIST_MAIN)) {
  process.stderr.write("play-run-agent: dist/main.js is absent\n");
  process.exit(1);
}

process.umask(0o077);

function stateDirectory() {
  const xdgState = process.env.XDG_STATE_HOME;
  const base =
    xdgState && isAbsolute(xdgState)
      ? xdgState
      : join(homedir(), ".local", "state");
  return join(base, "kanthord");
}

function shellQuote(text) {
  return `'${text.replaceAll("'", "'\\''")}'`;
}

function utcTag() {
  return new Date().toISOString().replace(/[:.Z]/g, "");
}

const playDir = join(stateDirectory(), "play", utcTag());
mkdirSync(playDir, { recursive: true, mode: 0o700 });
chmodSync(playDir, 0o700);

const workspaceDir = join(playDir, "workspace");
const authPath = resolve(values.auth ?? join(homedir(), DEFAULT_AUTH_SUBPATH));

if (values.repo !== undefined) {
  execFileSync("git", [
    "clone",
    "--quiet",
    "--no-hardlinks",
    values.repo,
    workspaceDir,
  ]);
  execFileSync("git", ["-C", workspaceDir, "remote", "remove", "origin"]);
} else {
  mkdirSync(workspaceDir);
  writeFileSync(
    join(workspaceDir, "sum.mjs"),
    "export function sum(a, b) { return a + b - 1; }\n",
  );
  writeFileSync(
    join(workspaceDir, "sum.test.mjs"),
    'import { test } from "node:test";\nimport assert from "node:assert/strict";\nimport { sum } from "./sum.mjs";\ntest("sum adds two numbers", () => { assert.equal(sum(1, 2), 3); });\ntest("sum handles zero", () => { assert.equal(sum(0, 0), 0); });\n',
  );
  const gitEnv = [
    "-c",
    `user.name=${SAMPLE_AUTHOR_NAME}`,
    "-c",
    `user.email=${SAMPLE_AUTHOR_EMAIL}`,
  ];
  execFileSync("git", [
    "-C",
    workspaceDir,
    ...gitEnv,
    "init",
    "-b",
    GIT_MAIN_BRANCH,
  ]);
  execFileSync("git", ["-C", workspaceDir, ...gitEnv, "add", "."]);
  execFileSync("git", ["-C", workspaceDir, ...gitEnv, "commit", "-m", "init"]);
}

const promptText =
  values.repo !== undefined
    ? "Read this repository. Reply with five bullets that describe its structure and how to run its tests. Do not change any file."
    : "Fix the bug in `sum.mjs`. Run `node --test` before and after the fix. Reply with the root cause and the test result.";
writeFileSync(join(playDir, "prompt.md"), `${promptText}\n`);

const provider = values.model.split("/")[0];
const refreshLine = values["no-refresh"]
  ? ""
  : `pi auth print-bearer-token --provider ${shellQuote(provider)} --min-expiry 20m > /dev/null`;

const runShLines = [
  "#!/bin/sh",
  "ulimit -c 0",
  `cd ${shellQuote(playDir)} || exit 1`,
  "mkdir -p sessions",
  refreshLine,
  `SESSION="sessions/$(date -u +%Y%m%dT%H%M%S).jsonl"`,
  `if [ -n "$1" ]; then PROMPT="$1"; else PROMPT="prompt.md"; fi`,
  `node ${shellQuote(BIN)} run agent swe@1 \\`,
  `  --model ${shellQuote(values.model)} \\`,
  `  --budget ${shellQuote(values.budget)} \\`,
  `  --auth ${shellQuote(authPath)} \\`,
  `  --workspace workspace \\`,
  `  --session "$SESSION" \\`,
  `  --output result.jsonl \\`,
  `  --prompt "$PROMPT"`,
  `EXIT=$?`,
  `echo "exit: $EXIT"`,
  `if [ -f result.jsonl ]; then`,
  `  node -e "const d=JSON.parse(require('fs').readFileSync('result.jsonl','utf8').trim().split('\\n').pop());process.stdout.write('end: '+d.end+'\\nclass: '+String(d.class)+'\\ntext: '+String(d.text)+'\\n')"`,
  `fi`,
  `git -C workspace status --short`,
  `exit $EXIT`,
]
  .filter((line) => line !== "")
  .map((line) => `${line}\n`)
  .join("");

const runShPath = join(playDir, "run.sh");
writeFileSync(runShPath, runShLines);
chmodSync(runShPath, 0o700);

process.stdout.write(`${playDir}\n`);
process.stdout.write(`run.sh: ${runShPath}\n`);
