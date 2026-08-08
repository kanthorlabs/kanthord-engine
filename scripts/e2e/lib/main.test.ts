import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";

import { main, parseArguments, deriveOutcome, resolveCommit } from "./main.ts";
import { RunnerError } from "./errors.ts";
import type { ResourceFailure } from "./resources.ts";
import { runDirectory } from "./tag.ts";
import type { CommandRecord } from "./command.ts";
import type { PodmanExecutor } from "./driver/podman.ts";

test("parseArguments resolves the scenario id and defaults every optional flag to null", () => {
  const invocation = parseArguments(["P1-E1"], "minted");

  assert.deepEqual(invocation, {
    scenarioId: "P1-E1",
    tag: "minted",
    daemonHost: null,
    clientHost: null,
  });
});

test("parseArguments resolves every optional flag when all three are given", () => {
  const invocation = parseArguments(
    ["P1-E3", "--tag", "t1", "--daemon-host", "a", "--client-host", "b"],
    "m",
  );

  assert.deepEqual(invocation, {
    scenarioId: "P1-E3",
    tag: "t1",
    daemonHost: "a",
    clientHost: "b",
  });
});

const refusals: ReadonlyArray<
  readonly [
    name: string,
    argv: readonly string[],
    code: string,
    message: string,
  ]
> = [
  ["no positional", [], "invalid-argument", "no scenario id"],
  [
    "two positionals",
    ["P1-E1", "P1-E2"],
    "invalid-argument",
    "more than one scenario id",
  ],
  [
    "a positional not in scenarios",
    ["P1-E9"],
    "invalid-argument",
    "unknown scenario P1-E9",
  ],
  [
    "an option token that is not one of the three",
    ["P1-E1", "--foo"],
    "invalid-argument",
    "unknown option --foo",
  ],
  [
    "an option with no value",
    ["P1-E1", "--tag"],
    "invalid-argument",
    "--tag needs a value",
  ],
  [
    "a --tag value failing the tag pattern",
    ["P1-E1", "--tag", "!!"],
    "invalid-argument",
    "tag !! is not a valid tag",
  ],
];

for (const [name, argv, code, message] of refusals) {
  test(`parseArguments refuses: ${name}`, () => {
    try {
      parseArguments(argv, "minted");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, code);
      assert.equal(error.message, message);
    }
  });
}

test("main writes the invalid-argument refusal to stderr and resolves exit code 2", async (t) => {
  let captured = "";
  t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
    captured += chunk.toString();
    return true;
  });

  const code = await main(["--tag"]);

  assert.equal(code, 2);
  assert.equal(captured, "e2e: invalid-argument: --tag needs a value\n");
});

test("main resolves exit code 2 for an unknown scenario id", async () => {
  const code = await main(["P1-E9"]);
  assert.equal(code, 2);
});

const oneCleanupFailure: readonly ResourceFailure[] = [
  { kind: "process", id: "daemon", reason: "SIGTERM ignored" },
];

test("deriveOutcome is passed only when there is no runError and cleanupFailures is empty", () => {
  assert.equal(
    deriveOutcome({ runError: undefined, cleanupFailures: [] }),
    "passed",
  );
});

test("SECURITY: deriveOutcome is failed, not passed, when the run itself succeeded but a cleanup left a failure behind", () => {
  assert.equal(
    deriveOutcome({ runError: undefined, cleanupFailures: oneCleanupFailure }),
    "failed",
  );
});

test("deriveOutcome is unavailable when runError is a RunnerError coded unavailable, even with cleanup failures", () => {
  assert.equal(
    deriveOutcome({
      runError: new RunnerError("unavailable", "no bare machine"),
      cleanupFailures: oneCleanupFailure,
    }),
    "unavailable",
  );
});

test("deriveOutcome is failed for any other runError", () => {
  assert.equal(
    deriveOutcome({ runError: new Error("boom"), cleanupFailures: [] }),
    "failed",
  );
});

test("resolveCommit resolves the value its read callback resolves", async () => {
  const commit = await resolveCommit(async () => "abc123");
  assert.equal(commit, "abc123");
});

test("SECURITY: resolveCommit rejects instead of silently resolving an empty commit when its read callback fails", async () => {
  await assert.rejects(
    resolveCommit(async () => {
      throw new Error("git not found");
    }),
    (error: unknown) => {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "unavailable");
      return true;
    },
  );
});

test("parseArguments refuses --reclaim combined with a scenario id", () => {
  try {
    parseArguments(["--reclaim", "R1", "P1-E4"], "minted");
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "invalid-argument");
  }
});

test("parseArguments refuses --reclaim combined with --tag", () => {
  try {
    parseArguments(["--reclaim", "R1", "--tag", "t1"], "minted");
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "invalid-argument");
  }
});

function record(argv: readonly string[], stdout: string): CommandRecord {
  return { argv, cwd: process.cwd(), exitCode: 0, stdout, stderr: "" };
}

function buildReclaimExecute(
  options: Readonly<{ staleContainerId?: string }> = {},
): Readonly<{ execute: PodmanExecutor; calls: (readonly string[])[] }> {
  const calls: (readonly string[])[] = [];
  const execute: PodmanExecutor = async (argv) => {
    calls.push(argv);
    if (argv[1] === "version") {
      return record(argv, "6.0.0\n");
    }
    if (argv[1] === "info") {
      return record(argv, "true arm64\n");
    }
    if (argv[1] === "ps") {
      return record(
        argv,
        options.staleContainerId !== undefined
          ? `${options.staleContainerId}\n`
          : "",
      );
    }
    if (
      argv.includes("--filter") &&
      argv.some((token) => token.startsWith("label="))
    ) {
      return record(argv, "");
    }
    throw new Error(`unexpected argv during --reclaim: ${argv.join(" ")}`);
  };
  return { execute, calls };
}

test("--reclaim R1 runs assertPodman and reclaimByLabel for R1, and issues no podman run and no scenario step", async () => {
  const { execute, calls } = buildReclaimExecute();

  const code = await main(["--reclaim", "R1"], { execute });

  assert.equal(code, 0);
  assert.ok(calls.some((argv) => argv[1] === "version"));
  assert.ok(
    calls.some(
      (argv) =>
        argv.includes("--filter") &&
        argv.some((token) => token === "label=kanthord-e2e-run=R1"),
    ),
  );
  assert.equal(
    calls.some((argv) => argv[1] === "run"),
    false,
  );
});

test("--reclaim R1 creates no directory under .data/", async () => {
  const tag = "reclaim-dir-check";
  const directory = runDirectory(tag);
  assert.equal(existsSync(directory), false);

  const { execute } = buildReclaimExecute();
  const code = await main(["--reclaim", tag], { execute });

  assert.equal(code, 0);
  assert.equal(existsSync(directory), false);
});

test("--reclaim R1 with a non-empty failed returns 1, and with an empty one returns 0", async () => {
  const clean = buildReclaimExecute();
  assert.equal(
    await main(["--reclaim", "reclaim-clean"], { execute: clean.execute }),
    0,
  );

  const dirty = buildReclaimExecute({ staleContainerId: "c1" });
  assert.equal(
    await main(["--reclaim", "reclaim-dirty"], { execute: dirty.execute }),
    1,
  );
});
