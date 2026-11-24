import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { homedir, userInfo } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

const ENGINE_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DIST_MAIN = join(ENGINE_ROOT, "dist", "main.js");
const BIN = join(ENGINE_ROOT, "bin", "kanthord.mjs");
const DEFAULT_MODEL = "anthropic/claude-sonnet-5-5:medium";
const DEFAULT_BUDGET = "15m";
const DEFAULT_AUTH_SUBPATH = join(".config", "kanthord", "auth.json");
const SAMPLE_AUTHOR_NAME = "Sample";
const SAMPLE_AUTHOR_EMAIL = "sample@example.com";
const GIT_MAIN_BRANCH = "main";
const ARGUMENT_SEPARATOR = "--";
const REFRESH_FAILED_LINE = "play-run-agent: the token refresh failed\n";

export async function refreshAuthWith(
  authPath,
  provider,
  minOAuthValidityMs,
  createRuntimeFn,
) {
  const create = createRuntimeFn ?? ((opts) => ModelRuntime.create(opts));
  const runtime = await create({
    authPath,
    modelsPath: null,
    allowModelNetwork: false,
    refreshOnCreate: false,
  });
  const result = await runtime.getAuth(provider, { minOAuthValidityMs });
  if (result === undefined) {
    throw new Error("refresh returned no result");
  }
}

const IS_MAIN =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (IS_MAIN) {
  const given = process.argv.slice(2);
  const { values, positionals } = parseArgs({
    args: given[0] === ARGUMENT_SEPARATOR ? given.slice(1) : given,
    options: {
      repo: { type: "string" },
      model: { type: "string", default: DEFAULT_MODEL },
      auth: { type: "string" },
      budget: { type: "string", default: DEFAULT_BUDGET },
      "no-refresh": { type: "boolean", default: false },
      "no-build": { type: "boolean", default: false },
      "refresh-only": { type: "boolean", default: false },
    },
    allowPositionals: true,
  });

  const promptArg = positionals[0];

  if (!values["no-build"]) {
    let needsBuild = !existsSync(DIST_MAIN);
    if (!needsBuild) {
      const newer = spawnSync(
        "find",
        [join(ENGINE_ROOT, "src"), "-newer", DIST_MAIN, "-name", "*.ts"],
        { encoding: "utf8" },
      );
      needsBuild = newer.stdout.trim().length > 0;
    }
    if (needsBuild) {
      try {
        execFileSync("pnpm", ["run", "build"], {
          cwd: ENGINE_ROOT,
          stdio: "inherit",
        });
      } catch {
        process.exit(1);
      }
    }
  }

  process.umask(0o077);

  const authPath = resolve(
    values.auth ?? join(userInfo().homedir, DEFAULT_AUTH_SUBPATH),
  );

  const playDir = (() => {
    const xdgState = process.env.XDG_STATE_HOME;
    const base =
      xdgState && isAbsolute(xdgState)
        ? xdgState
        : join(homedir(), ".local", "state");
    const d = new Date();
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return join(base, "kanthord", "play", `${year}${month}${day}`);
  })();

  const dirExists = existsSync(playDir);

  if (dirExists) {
    const stats = lstatSync(playDir);
    if (stats.isSymbolicLink()) {
      process.stderr.write(`play-run-agent: ${playDir} is a symbolic link\n`);
      process.exit(1);
    }
    if ((stats.mode & 0o777) !== 0o700) {
      process.stderr.write(`play-run-agent: ${playDir} mode is not 0700\n`);
      process.exit(1);
    }
    if (stats.uid !== process.getuid?.()) {
      process.stderr.write(
        `play-run-agent: ${playDir} is not owned by the current user\n`,
      );
      process.exit(1);
    }
    if (values.repo !== undefined) {
      process.stderr.write(
        `play-run-agent: existing workspace used; --repo ignored\n`,
      );
    }
  } else {
    mkdirSync(playDir, { recursive: true, mode: 0o700 });
    chmodSync(playDir, 0o700);
  }

  const workspaceDir = join(playDir, "workspace");

  if (!dirExists) {
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
      execFileSync("git", [
        "-C",
        workspaceDir,
        ...gitEnv,
        "commit",
        "-m",
        "init",
      ]);
    }

    const promptText =
      values.repo !== undefined
        ? "Read this repository. Reply with five bullets that describe its structure and how to run its tests. Do not change any file."
        : "Fix the bug in `sum.mjs`. Run `node --test` before and after the fix. Reply with the root cause and the test result.";
    writeFileSync(join(playDir, "prompt.md"), `${promptText}\n`);
  }

  if (!values["no-refresh"]) {
    const provider = values.model.split("/")[0];
    const budgetMs = (() => {
      const m = /^(\d+)(s|m|h)$/.exec(values.budget);
      if (!m) return 0;
      const v = parseInt(m[1], 10);
      if (m[2] === "s") return v * 1000;
      if (m[2] === "m") return v * 60000;
      return v * 3600000;
    })();
    const minMs = Math.max(20 * 60000, budgetMs + 10 * 60000);
    try {
      await refreshAuthWith(authPath, provider, minMs);
    } catch {
      process.stderr.write(REFRESH_FAILED_LINE);
      process.exit(1);
    }
  }

  process.stdout.write(`${playDir}\n`);

  if (values["refresh-only"]) {
    process.exit(0);
  }

  const sessionsDir = join(playDir, "sessions");
  mkdirSync(sessionsDir, { recursive: true });

  const utcHhmmss = new Date().toISOString().slice(11, 19).replace(/:/g, "");
  let sessionFilename = `${utcHhmmss}.jsonl`;
  if (existsSync(join(sessionsDir, sessionFilename))) {
    sessionFilename = `${new Date().toISOString().replace(/[:.Z]/g, "")}.jsonl`;
  }
  const sessionPath = join(sessionsDir, sessionFilename);

  function shellQuote(text) {
    return `'${text.replaceAll("'", "'\\''")}'`;
  }

  const runShLines = [
    "#!/bin/sh",
    "ulimit -c 0",
    `cd ${shellQuote(playDir)} || exit 1`,
    "mkdir -p sessions",
    `if [ -n "$1" ]; then PROMPT="$1"; else PROMPT="prompt.md"; fi`,
    `node ${shellQuote(BIN)} run agent swe@1 \\`,
    `  --model ${shellQuote(values.model)} \\`,
    `  --budget ${shellQuote(values.budget)} \\`,
    `  --auth ${shellQuote(authPath)} \\`,
    `  --workspace workspace \\`,
    `  --session ${shellQuote(sessionPath)} \\`,
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
    .map((line) => `${line}\n`)
    .join("");

  const runShPath = join(playDir, "run.sh");
  writeFileSync(runShPath, runShLines);
  chmodSync(runShPath, 0o700);

  process.stdout.write(`run.sh: ${runShPath}\n`);

  const runResult = spawnSync(
    runShPath,
    promptArg !== undefined ? [promptArg] : [],
    { stdio: "inherit" },
  );

  process.exit(runResult.status ?? 1);
}
