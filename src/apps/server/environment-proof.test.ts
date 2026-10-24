import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { temporary } from "../../kernel/test-support.ts";
import {
  ProofPhase,
  type ProofInput,
} from "../../project/environment-state.ts";
import { ContainerRuntime } from "../../worker/contract.ts";
import {
  cacheVolumeArguments,
  cacheVolumeName,
  type RuntimeHost,
} from "./container-runtime.ts";
import { proveInImage, type ProofOptions } from "./environment-proof.ts";

const OWNER = "OWNER";
const TAG = "localhost/kanthord-env/repository/github/acme/app:digest";
const RUN_ID = "RUN1";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "repository:github:Acme/App";
const CACHE_VOLUME = cacheVolumeName(OWNER, PROJECT_ID, RESOURCE);
const NAME = `kanthord-proof-${RUN_ID}`;
const HOME = "/var/lib/kanthord";
const CHECKOUT = `${HOME}/checkout`;
const HOST_LINE = "host";
const SPAWN_LINE = "spawn";
const STDIN_LINE = "stdin";
const EXEC = "exec";
const VOLUME = "volume";
const SLOT_USER = "10001:10001";
const TINI = "/usr/bin/tini";
const MINIMUM_BUNDLE_BYTES = 0;
const START = "run";
const NOT_FOUND = -1;
const VOLUME_OPTION = "--volume";
const REMOVE = "rm";
const FAILED_EXIT = 3;
const EXISTS_EXIT = 125;
const COMMAND_COUNT = 5;
const MEMORY_MB = 4096;
const BOUNDED_MEMORY_MB = 8192;
const SHORT_LIMIT_MS = 500;
const POLL_STEP_MS = 50;
const POLL_ROUNDS = 100;
const BUNDLE_HEADER = "# v";
const FAKE_PODMAN = `const fs = require("node:fs");
const args = process.argv.slice(2);
const log = (entry) => fs.appendFileSync(require("node:path").join(__dirname, "log"), JSON.stringify(entry) + "\\n");
log(["spawn", ...args]);
const command = args.at(-1);
const finish = () => {
  const code = /^exit (\\d+)$/.exec(command);
  if (code) process.exit(Number(code[1]));
  if (command === "hang") return setInterval(() => {}, 1000);
  const echo = /^echo (.*)$/.exec(command);
  if (echo) process.stdout.write(echo[1]);
  process.exit(0);
};
if (!args.includes("-i")) finish();
else {
  const chunks = [];
  process.stdin.on("data", (chunk) => chunks.push(chunk));
  process.stdin.on("end", () => {
    const bytes = Buffer.concat(chunks);
    log(["stdin", bytes.subarray(0, 16).toString("latin1"), bytes.length]);
    process.exit(0);
  });
}
`;

function input(overrides: Partial<ProofInput> = {}): ProofInput & {
  tag: string;
} {
  return {
    run_id: RUN_ID,
    project_id: PROJECT_ID,
    binding_id: "binding",
    resource_identity: RESOURCE,
    commit: "c".repeat(40),
    setup: ["echo one", "echo two"],
    checks: ["echo check-one", "exit 3", "echo check-three"],
    tag: TAG,
    ...overrides,
  };
}

function proof(
  directory: string,
  overrides: {
    hostCode?: number;
    commandLimitMs?: number;
    environmentMemoryMb?: number;
    existingCache?: boolean;
  } = {},
) {
  const log = join(directory, "log");
  const script = join(directory, "fake-podman.cjs");
  const bin = join(directory, "bin");
  writeFileSync(script, FAKE_PODMAN);
  execFileSync("mkdir", [bin]);
  writeFileSync(
    join(bin, ContainerRuntime.Podman),
    `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`,
    { mode: 0o755 },
  );
  const host: RuntimeHost = {
    platform: "linux",
    uid: 1000,
    user: "user",
    environment: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
    },
    exists: () => false,
    resolves: () => true,
    run: (_runtime, args) => {
      appendFileSync(log, `${JSON.stringify([HOST_LINE, ...args])}\n`);
      if (
        overrides.existingCache &&
        args.join(" ") ===
          cacheVolumeArguments(OWNER, PROJECT_ID, RESOURCE).join(" ")
      )
        return Promise.resolve({
          code: EXISTS_EXIT,
          stdout: "",
          stderr: `Error: volume with name ${CACHE_VOLUME} already exists: volume already exists`,
        });
      return Promise.resolve({
        code: overrides.hostCode ?? 0,
        stdout: "",
        stderr: "",
      });
    },
  };
  const options: ProofOptions = {
    host,
    runtime: ContainerRuntime.Podman,
    owner: OWNER,
    stateDirectory: directory,
    exportRepository: (_binding, _commit, target) => {
      const git = (...args: string[]) =>
        execFileSync(
          "git",
          [
            "-C",
            target,
            "-c",
            "user.name=test",
            "-c",
            "user.email=test@example.com",
            ...args,
          ],
          { stdio: "ignore" },
        );
      git("init", "--quiet");
      writeFileSync(join(target, "file.txt"), "content");
      git("add", ".");
      git("commit", "--quiet", "-m", "head");
      return Promise.resolve();
    },
    ...(overrides.commandLimitMs === undefined
      ? {}
      : { commandLimitMs: overrides.commandLimitMs }),
    environmentMemoryMb: overrides.environmentMemoryMb ?? MEMORY_MB,
  };
  const lines = (): unknown[][] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as unknown[])
      : [];
  return {
    options,
    lines,
    runDirectory: join(directory, "environments", `run-${RUN_ID}`),
  };
}

function ofKind(lines: unknown[][], kind: string): string[][] {
  return lines
    .filter((line) => line[0] === kind)
    .map((line) => line.slice(1) as string[]);
}

function cleaned(lines: unknown[][]): boolean {
  const host = ofKind(lines, HOST_LINE).map((line) => line.join(" "));
  return (
    host.includes(`rm --force ${NAME}`) &&
    host.includes(`volume rm --force ${NAME}`)
  );
}

function after(args: string[], flag: string): string | undefined {
  return args[args.indexOf(flag) + 1];
}

test("the container starts hardened with the slot flags, a new volume and an idle tini, and keeps the network", async (t) => {
  const { options, lines } = proof(temporary(t));
  await proveInImage(options, input(), new AbortController().signal);
  const host = ofKind(lines(), HOST_LINE);
  const create = host.find((line) => line[0] === VOLUME);
  assert.deepEqual(create, [
    "volume",
    "create",
    "--label",
    `io.kanthord.owner=${OWNER}`,
    NAME,
  ]);
  const start = host.find((line) => line[0] === START);
  assert.ok(start);
  assert.equal(after(start, "--user"), SLOT_USER);
  for (const flag of [
    "--read-only",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
  ])
    assert.ok(start.includes(flag), flag);
  assert.match(after(start, "--tmpfs") ?? "", /^\/tmp(:|$)/);
  assert.equal(after(start, "--label"), `io.kanthord.owner=${OWNER}`);
  assert.equal(after(start, "--volume"), `${NAME}:${HOME}`);
  assert.equal(after(start, "--name"), NAME);
  assert.equal(after(start, "--entrypoint"), TINI);
  assert.deepEqual(start.slice(start.indexOf(TAG)), [
    TAG,
    "--",
    "sleep",
    "infinity",
  ]);
  assert.equal(
    start.some((argument) => argument.startsWith("--network")),
    false,
  );
});

test("the proof container holds the memory bound", async (t) => {
  const { options, lines } = proof(temporary(t), {
    environmentMemoryMb: BOUNDED_MEMORY_MB,
  });
  await proveInImage(options, input(), new AbortController().signal);
  const start = ofKind(lines(), HOST_LINE).find((line) => line[0] === START);
  assert.ok(start);
  assert.equal(after(start, "--memory"), `${BOUNDED_MEMORY_MB}m`);
});

test("the bundle goes to the container on standard input and the clone lands in the checkout of the home", async (t) => {
  const { options, lines } = proof(temporary(t));
  await proveInImage(options, input(), new AbortController().signal);
  const feed = ofKind(lines(), SPAWN_LINE).find((line) => line.includes("-i"));
  assert.ok(feed);
  assert.deepEqual(feed.slice(0, 6), [EXEC, "-i", "-w", HOME, NAME, "/bin/sh"]);
  assert.match(feed.at(-1) ?? "", /git clone --quiet head\.bundle checkout/);
  const [, header, size] = lines().find((line) => line[0] === STDIN_LINE) ?? [];
  assert.ok(String(header).startsWith(BUNDLE_HEADER));
  assert.ok(Number(size) > MINIMUM_BUNDLE_BYTES);
});

test("each setup command, then each check, runs through exec in the checkout and the results hold the phase, the command, the exit code and the output", async (t) => {
  const { options, lines } = proof(temporary(t));
  const results = await proveInImage(
    options,
    input(),
    new AbortController().signal,
  );
  const execs = ofKind(lines(), SPAWN_LINE).filter((line) =>
    line.includes("bash"),
  );
  assert.deepEqual(
    execs,
    [
      "echo one",
      "echo two",
      "echo check-one",
      "exit 3",
      "echo check-three",
    ].map((command) => [EXEC, "-w", CHECKOUT, NAME, "bash", "-c", command]),
  );
  assert.deepEqual(results, [
    {
      phase: ProofPhase.Setup,
      command: "echo one",
      exit_code: 0,
      timed_out: false,
      output: "one",
    },
    {
      phase: ProofPhase.Setup,
      command: "echo two",
      exit_code: 0,
      timed_out: false,
      output: "two",
    },
    {
      phase: ProofPhase.Check,
      command: "echo check-one",
      exit_code: 0,
      timed_out: false,
      output: "check-one",
    },
    {
      phase: ProofPhase.Check,
      command: "exit 3",
      exit_code: FAILED_EXIT,
      timed_out: false,
      output: "",
    },
    {
      phase: ProofPhase.Check,
      command: "echo check-three",
      exit_code: 0,
      timed_out: false,
      output: "check-three",
    },
  ]);
});

test("the first failed setup command ends the command list and no check runs", async (t) => {
  const { options, lines } = proof(temporary(t));
  const results = await proveInImage(
    options,
    input({ setup: ["echo one", "exit 3", "echo never"] }),
    new AbortController().signal,
  );
  assert.deepEqual(
    results.map((result) => result.command),
    ["echo one", "exit 3"],
  );
  assert.equal(
    ofKind(lines(), SPAWN_LINE).some((line) => line.includes("echo check-one")),
    false,
  );
});

test("a command over the limit answers timed_out", async (t) => {
  const { options } = proof(temporary(t), { commandLimitMs: SHORT_LIMIT_MS });
  const [result] = await proveInImage(
    options,
    input({ setup: [], checks: ["hang"] }),
    new AbortController().signal,
  );
  assert.equal(result?.timed_out, true);
  assert.equal(result?.exit_code, null);
  assert.match(result?.output ?? "", /time limit/);
});

test("the container, the volume and the run directory are gone after a pass and after a failure", async (t) => {
  const passed = proof(temporary(t));
  await proveInImage(passed.options, input(), new AbortController().signal);
  assert.equal(cleaned(passed.lines()), true);
  assert.equal(existsSync(passed.runDirectory), false);
  const failed = proof(temporary(t));
  await proveInImage(
    failed.options,
    input({ setup: ["exit 3"] }),
    new AbortController().signal,
  );
  assert.equal(cleaned(failed.lines()), true);
  assert.equal(existsSync(failed.runDirectory), false);
});

test("an abort of the signal ends the proof and removes the container, the volume and the run directory", async (t) => {
  const { options, lines, runDirectory } = proof(temporary(t));
  const controller = new AbortController();
  const pending = proveInImage(
    options,
    input({ setup: [], checks: ["hang"] }),
    controller.signal,
  );
  for (let round = 0; round < POLL_ROUNDS; round++) {
    if (ofKind(lines(), SPAWN_LINE).some((line) => line.includes("hang")))
      break;
    await delay(POLL_STEP_MS);
  }
  controller.abort();
  await assert.rejects(pending);
  assert.equal(cleaned(lines()), true);
  assert.equal(existsSync(runDirectory), false);
});

test("a refused container start fails the proof and still removes what exists", async (t) => {
  const { options, lines, runDirectory } = proof(temporary(t), { hostCode: 1 });
  await assert.rejects(
    proveInImage(options, input(), new AbortController().signal),
  );
  assert.equal(cleaned(lines()), true);
  assert.equal(existsSync(runDirectory), false);
});

test("the proof container mounts the cache volume of the group after the cache volume is created", async (t) => {
  const { options, lines } = proof(temporary(t));
  await proveInImage(options, input(), new AbortController().signal);
  const host = ofKind(lines(), HOST_LINE);
  const create = host.findIndex(
    (line) =>
      line.join(" ") ===
      cacheVolumeArguments(OWNER, PROJECT_ID, RESOURCE).join(" "),
  );
  const start = host.findIndex((line) => line[0] === START);
  assert.notEqual(create, NOT_FOUND);
  assert.ok(create < start);
  const volumes = host[start]!.flatMap((arg, index) =>
    host[start]![index - 1] === VOLUME_OPTION ? [arg] : [],
  );
  assert.deepEqual(volumes, [
    `${NAME}:${HOME}`,
    `${CACHE_VOLUME}:${HOME}/.cache`,
  ]);
});

test("the proof container starts with the cache volume of the group when the volume exists", async (t) => {
  const { options, lines } = proof(temporary(t), { existingCache: true });
  const results = await proveInImage(
    options,
    input(),
    new AbortController().signal,
  );
  const start = ofKind(lines(), HOST_LINE).find((line) => line[0] === START);
  assert.ok(start);
  assert.ok(start.includes(`${CACHE_VOLUME}:${HOME}/.cache`));
  assert.equal(results.length, COMMAND_COUNT);
});

test("the run removes the home volume and never the cache volume", async (t) => {
  const { options, lines } = proof(temporary(t));
  await proveInImage(options, input(), new AbortController().signal);
  const removed = ofKind(lines(), HOST_LINE).filter(
    (line) => line[0] === VOLUME && line[1] === REMOVE,
  );
  assert.deepEqual(removed, [["volume", "rm", "--force", NAME]]);
});
