import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { platform } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { after, test, type TestContext } from "node:test";
import { promisify } from "node:util";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { temporary, UNSET_GIT_ENVIRONMENT } from "../kernel/test-support.ts";
import { createBashSandbox } from "./bash-sandbox.ts";

const execFileAsync = promisify(execFile);

const SANDBOX_PLATFORMS: readonly NodeJS.Platform[] = ["darwin", "linux"];
const DARWIN: NodeJS.Platform = "darwin";
const BLOCKED_ON_DARWIN = platform() === DARWIN;
const COMMAND_TIMEOUT_MS = 30_000;
const CASE_TIMEOUT_MS = 60_000;
const SUCCESS = 0;
const SCRIPT_MODE = 0o755;
const SYSTEM_PATH = ["/usr/bin", "/bin", "/usr/sbin", "/sbin"];
const PNPM_FALLBACK_PATH = ["/opt/homebrew/bin", "/usr/local/bin"];
const PNPM = "pnpm";
const SCRIPT_NAME = "home-path-tool";
const SCRIPT_OUTPUT = "ran from the home PATH entry";
const LINKED_SCRIPT_NAME = "linked-path-tool";
const LINKED_ENTRY = "a/current/bin";
const LINKED_SPAWN = [
  `const run = require("node:child_process").spawnSync("${LINKED_SCRIPT_NAME}", { encoding: "utf8" });`,
  "if (run.error) { console.log(run.error.code); process.exit(1); }",
  "console.log(run.stdout.trim());",
].join(" ");
const GIT_USER_NAME = "Probe";
const INCLUDED_MARKER = "included";
const GIT_CONFIG = [
  "[user]",
  `\tname = ${GIT_USER_NAME}`,
  "\temail = probe@example.test",
  "[init]",
  "\tdefaultBranch = main",
  "[commit]",
  "\tgpgsign = false",
].join("\n");
const SECRET_FILES = [
  ".git-credentials",
  ".netrc",
  ".npmrc",
  ".config/gh/hosts.yml",
  ".docker/config.json",
  ".claude/settings.json",
  ".codex/auth.json",
  ".config/git/credentials",
];
const GIT_USER_FILES = [".gitconfig", ".config/git"];
const PNPM_GLOBAL_DIRECTORY =
  platform() === DARWIN ? "Library/Preferences/pnpm" : ".config/pnpm";
const PNPM_COMMANDS = ["pnpm --version", "pnpm config get store-dir"];

interface Outcome {
  status: number;
  output: string;
}

interface Home {
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function secretContent(file: string): string {
  return `secret=${file}`;
}

function writeHomeFile(home: string, file: string, content: string): void {
  const path = join(home, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${content}\n`);
}

function executableIn(directory: string, name: string): boolean {
  try {
    accessSync(join(directory, name), constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pnpmDirectory(): string | undefined {
  const candidates = [
    ...(process.env.PATH ?? "").split(delimiter),
    dirname(process.execPath),
    ...(process.env.npm_execpath ? [dirname(process.env.npm_execpath)] : []),
    ...PNPM_FALLBACK_PATH,
  ];
  return candidates.find((directory) => executableIn(directory, PNPM));
}

function childPath(extra: readonly string[]): string {
  const pnpm = pnpmDirectory();
  return [
    ...extra,
    ...(process.env.PATH ?? "").split(delimiter),
    dirname(process.execPath),
    ...(pnpm === undefined ? [] : [pnpm]),
    ...SYSTEM_PATH,
  ].join(delimiter);
}

function fakeHome(t: TestContext, pathEntries: readonly string[] = []): Home {
  const root = realpathSync(temporary(t));
  const home = join(root, "home");
  const cwd = join(home, "repo");
  const tmp = join(root, "tmp");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(tmp);
  writeHomeFile(home, ".gitconfig", GIT_CONFIG);
  writeHomeFile(home, ".config/git/ignore", "ignored-by-probe");
  for (const file of SECRET_FILES)
    writeHomeFile(home, file, secretContent(file));
  writeHomeFile(home, `${PNPM_GLOBAL_DIRECTORY}/rc`, "update-notifier=false");
  const bin = join(home, ".local/bin");
  mkdirSync(bin, { recursive: true });
  const script = join(bin, SCRIPT_NAME);
  writeFileSync(script, `#!/bin/sh\necho '${SCRIPT_OUTPUT}'\n`);
  chmodSync(script, SCRIPT_MODE);
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    ...UNSET_GIT_ENVIRONMENT,
    HOME: home,
    TMPDIR: tmp,
    PATH: childPath(pathEntries.map((entry) => join(home, entry))),
    XDG_CONFIG_HOME: undefined,
    PNPM_HOME: undefined,
    pnpm_config_store_dir: undefined,
    pnpm_config_cache_dir: undefined,
    npm_config_cache: undefined,
  };
  execFileSync("git", ["init", "-q"], { cwd, env });
  return { home, cwd, env };
}

function isExitCode(code: unknown): code is number {
  return Number.isInteger(code);
}

async function execute(
  command: string,
  cwd: string,
  env: NodeJS.ProcessEnv,
): Promise<Outcome> {
  try {
    const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
      cwd,
      env,
      timeout: COMMAND_TIMEOUT_MS,
      encoding: "utf8",
    });
    return { status: SUCCESS, output: `${stdout}${stderr}` };
  } catch (error) {
    const failure = error as {
      code?: unknown;
      stdout?: string;
      stderr?: string;
    };
    if (!isExitCode(failure.code)) throw error;
    return {
      status: failure.code,
      output: `${failure.stdout ?? ""}${failure.stderr ?? ""}`,
    };
  }
}

const sandbox = createBashSandbox(SandboxManager);

async function inSandbox(
  h: Home,
  command: string,
  denyRead: string[] = [],
): Promise<Outcome> {
  const wrapped = await sandbox.wrap(command, h.cwd, {
    env: h.env,
    denyRead,
  });
  try {
    return await execute(wrapped, h.cwd, h.env);
  } finally {
    sandbox.cleanup();
  }
}

async function sandboxUnavailable(): Promise<string | false> {
  if (!SANDBOX_PLATFORMS.includes(platform()))
    return `the bash sandbox runs on darwin and linux, not on ${platform()}`;
  try {
    const wrapped = await sandbox.wrap("true", process.cwd(), {
      env: process.env,
      denyRead: [],
    });
    const probe = await execute(wrapped, process.cwd(), process.env).finally(
      () => sandbox.cleanup(),
    );
    return probe.status === SUCCESS
      ? false
      : `the sandbox cannot run a command: ${probe.output.trim()}`;
  } catch (error) {
    return `the sandbox cannot start: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const unavailable = await sandboxUnavailable();

after(() => sandbox.dispose());

function lastLine(outcome: Outcome): string {
  return outcome.output.trim().split("\n").at(-1) ?? "";
}

function assertOutcome(
  command: string,
  outcome: Outcome,
  blocked: boolean,
): void {
  const reason = `${command}: exit ${outcome.status}, ${lastLine(outcome)}`;
  if (blocked) assert.notEqual(outcome.status, SUCCESS, reason);
  else assert.equal(outcome.status, SUCCESS, reason);
}

test(
  "(invariant) cat of each secret file of the fake home fails under the deny list",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    for (const file of SECRET_FILES) {
      const command = `cat ${join(h.home, file)}`;
      const outcome = await inSandbox(h, command);
      assert.ok(
        !outcome.output.includes(secretContent(file)),
        `${command}: exit ${outcome.status}, ${lastLine(outcome)}`,
      );
      assert.notEqual(outcome.status, SUCCESS, command);
    }
  },
);

test(
  "(invariant) a cleanup after the command leaves no protected file in a cwd that had none",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    const outcome = await inSandbox(h, "true");
    assertOutcome("true", outcome, false);
    assert.equal(existsSync(join(h.cwd, ".env")), false);
  },
);

test(
  "(happy) git status and git commit pass in the cwd with .gitconfig and .config/git kept",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    for (const command of [
      "git status",
      "git commit --allow-empty -q -m probe",
    ])
      assertOutcome(command, await inSandbox(h, command), false);
  },
);

test(
  "(edge) git status with .gitconfig and .config/git denied",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    const command = "git status";
    const outcome = await inSandbox(
      h,
      command,
      GIT_USER_FILES.map((file) => join(h.home, file)),
    );
    assertOutcome(command, outcome, BLOCKED_ON_DARWIN);
  },
);

test(
  "(invariant) the sandboxed command sees the TMPDIR of the host",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    const command = 'echo "$TMPDIR"';
    const outcome = await inSandbox(h, command);
    assertOutcome(command, outcome, false);
    assert.equal(lastLine(outcome), h.env.TMPDIR);
  },
);

test(
  "(edge) git reads a key of a file that the kept .gitconfig includes",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    writeHomeFile(
      h.home,
      ".gitconfig",
      `${GIT_CONFIG}\n[include]\n\tpath = ~/.gitconfig-included\n`,
    );
    writeHomeFile(
      h.home,
      ".gitconfig-included",
      `[probe]\n\tmarker = ${INCLUDED_MARKER}\n`,
    );
    const command = "git config probe.marker";
    const outcome = await inSandbox(h, command);
    assertOutcome(command, outcome, false);
    assert.equal(lastLine(outcome), INCLUDED_MARKER);
  },
);

test(
  "(edge) git reads the user name of the kept .gitconfig",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t);
    const command = "git config user.name";
    const outcome = await inSandbox(h, command);
    assertOutcome(command, outcome, false);
    assert.equal(lastLine(outcome), GIT_USER_NAME);
  },
);

test(
  "(edge) pnpm --version and pnpm config get store-dir with .npmrc and the pnpm global configuration denied leak no secret",
  {
    skip:
      unavailable ||
      (pnpmDirectory() === undefined && "pnpm is not on any PATH entry"),
    timeout: CASE_TIMEOUT_MS,
  },
  async (t) => {
    const h = fakeHome(t);
    for (const command of PNPM_COMMANDS) {
      const outcome = await inSandbox(h, command);
      assert.ok(
        !outcome.output.includes(secretContent(".npmrc")),
        `${command}: exit ${outcome.status}, ${lastLine(outcome)}`,
      );
    }
  },
);

test(
  "(happy) a script in a kept home PATH entry runs",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t, [".local/bin"]);
    const outcome = await inSandbox(h, SCRIPT_NAME);
    assertOutcome(SCRIPT_NAME, outcome, false);
    assert.equal(lastLine(outcome), SCRIPT_OUTPUT);
  },
);

function linkedPathTool(h: Home): void {
  const release = join(h.home, "a", "releases", "1");
  mkdirSync(join(release, "bin"), { recursive: true });
  symlinkSync(release, join(h.home, "a", "current"));
  const script = join(release, "bin", LINKED_SCRIPT_NAME);
  writeFileSync(script, `#!/bin/sh\necho '${SCRIPT_OUTPUT}'\n`);
  chmodSync(script, SCRIPT_MODE);
}

test(
  "(edge) a command in a PATH entry through a symlink under the home runs by name and from node",
  { skip: unavailable, timeout: CASE_TIMEOUT_MS },
  async (t) => {
    const h = fakeHome(t, [LINKED_ENTRY]);
    linkedPathTool(h);
    const byName = await inSandbox(h, LINKED_SCRIPT_NAME);
    assertOutcome(LINKED_SCRIPT_NAME, byName, false);
    assert.equal(lastLine(byName), SCRIPT_OUTPUT);
    const command = `node -e '${LINKED_SPAWN}'`;
    const spawned = await inSandbox(h, command);
    assertOutcome(command, spawned, false);
    assert.equal(lastLine(spawned), SCRIPT_OUTPUT);
  },
);
