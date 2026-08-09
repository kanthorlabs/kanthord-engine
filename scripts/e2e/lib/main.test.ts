import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  main,
  parseArguments,
  deriveOutcome,
  resolveCommit,
  type RunInvocation,
} from "./main.ts";
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

test("parseArguments resolves --mint-tag to a MintTagInvocation carrying the minted tag", () => {
  assert.deepEqual(parseArguments(["--mint-tag"], "minted-tag"), {
    mintTag: "minted-tag",
  });
});

const mintTagRefusals: ReadonlyArray<
  readonly [name: string, argv: readonly string[], message: string]
> = [
  [
    "--mint-tag followed by a scenario id",
    ["--mint-tag", "P1-E1"],
    "--mint-tag is mutually exclusive with a scenario id",
  ],
  [
    "a scenario id followed by --mint-tag",
    ["P1-E1", "--mint-tag"],
    "--mint-tag is mutually exclusive with a scenario id",
  ],
  [
    "--mint-tag beside --tag",
    ["--mint-tag", "--tag", "t"],
    "--mint-tag is mutually exclusive with --tag",
  ],
  [
    "--mint-tag beside --reclaim",
    ["--mint-tag", "--reclaim", "t"],
    "--mint-tag is mutually exclusive with --reclaim",
  ],
];

for (const [name, argv, message] of mintTagRefusals) {
  test(`parseArguments refuses: ${name}`, () => {
    try {
      parseArguments(argv, "minted");
      assert.fail("expected a throw");
    } catch (error) {
      assert.ok(error instanceof RunnerError);
      assert.equal(error.code, "invalid-argument");
      assert.equal(error.message, message);
    }
  });
}

test("main(['--mint-tag']) writes exactly one line matching the tag pattern to stdout and never touches stderr", async (t) => {
  let stdout = "";
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });
  let stderrCalled = false;
  t.mock.method(process.stderr, "write", () => {
    stderrCalled = true;
    return true;
  });

  const code = await main(["--mint-tag"]);

  assert.equal(code, 0);
  assert.match(stdout, /^\d{17}-[0-9a-z]{26}\n$/);
  assert.equal(stderrCalled, false);
});

test("two sequential main(['--mint-tag']) calls print two different tags", async (t) => {
  const printed: string[] = [];
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    printed.push(chunk.toString());
    return true;
  });

  await main(["--mint-tag"]);
  await main(["--mint-tag"]);

  assert.equal(printed.length, 2);
  assert.notEqual(printed[0], printed[1]);
});

test("the tag main(['--mint-tag']) prints is accepted by parseArguments as a --tag value", async (t) => {
  let stdout = "";
  t.mock.method(process.stdout, "write", (chunk: string | Uint8Array) => {
    stdout += chunk.toString();
    return true;
  });

  await main(["--mint-tag"]);
  const printed = stdout.replace(/\n$/, "");

  const invocation = parseArguments(
    ["P1-E1", "--tag", printed],
    "x",
  ) as RunInvocation;
  assert.equal(invocation.tag, printed);
});

test("main(['--mint-tag']) creates nothing under .data/", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-mint-tag-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });
  t.mock.method(process.stdout, "write", () => true);

  const code = await main(["--mint-tag"]);

  assert.equal(code, 0);
  assert.deepEqual(await readdir("."), []);
});

test("parseArguments(['--record-verify', '--tag', 't1'], 'x') deep-equals { recordVerifyTag: 't1' }", () => {
  assert.deepEqual(parseArguments(["--record-verify", "--tag", "t1"], "x"), {
    recordVerifyTag: "t1",
  });
});

const recordVerifyRefusals: ReadonlyArray<
  readonly [name: string, argv: readonly string[], message: string]
> = [
  [
    "--record-verify with no --tag",
    ["--record-verify"],
    "--record-verify needs --tag",
  ],
  [
    "--record-verify followed by a scenario id",
    ["--record-verify", "--tag", "t", "P1-E1"],
    "--record-verify is mutually exclusive with a scenario id",
  ],
  [
    "--record-verify beside --reclaim",
    ["--record-verify", "--reclaim", "t"],
    "--record-verify is mutually exclusive with --reclaim",
  ],
  [
    "--mint-tag beside --record-verify",
    ["--mint-tag", "--record-verify", "--tag", "t"],
    "--mint-tag is mutually exclusive with --record-verify",
  ],
];

for (const [name, argv, message] of recordVerifyRefusals) {
  test(`parseArguments refuses: ${name}`, () => {
    assert.throws(
      () => parseArguments(argv, "x"),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal((error as RunnerError).message, message);
        return true;
      },
    );
  });
}

test("main(['--record-verify', '--tag', 't1'], { verify }) resolves the verify exit status", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-record-verify-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const verify = {
    run: async () => 3,
    readCommit: async () => "c0ffee",
    readProposalRevision: async () => "dec0de",
    now: () => new Date("2026-08-09T10:00:00.000Z"),
  };

  const code = await main(["--record-verify", "--tag", "t1"], { verify });

  assert.equal(code, 3);
});

const recordAcceptanceRefusals: ReadonlyArray<
  readonly [name: string, argv: readonly string[], message: string]
> = [
  [
    "--record-acceptance with no --by",
    ["--record-acceptance", "--tag", "t"],
    "--record-acceptance needs --by",
  ],
  [
    "--record-acceptance with no --tag",
    [
      "--record-acceptance",
      "--by",
      "U",
      "--drive",
      "confirmed",
      "--judgment",
      "accepted",
    ],
    "--record-acceptance needs --tag",
  ],
  [
    "--drive outside driveValues",
    [
      "--record-acceptance",
      "--tag",
      "t",
      "--by",
      "U",
      "--drive",
      "maybe",
      "--judgment",
      "accepted",
    ],
    "--drive must be confirmed or not-confirmed",
  ],
  [
    "--judgment outside judgmentValues",
    [
      "--record-acceptance",
      "--tag",
      "t",
      "--by",
      "U",
      "--drive",
      "confirmed",
      "--judgment",
      "meh",
    ],
    "--judgment must be accepted or rejected",
  ],
  [
    "--drive not-confirmed with no --note-file",
    [
      "--record-acceptance",
      "--tag",
      "t",
      "--by",
      "U",
      "--drive",
      "not-confirmed",
      "--judgment",
      "accepted",
    ],
    "--note-file is required for --drive not-confirmed",
  ],
  [
    "--judgment rejected with no --note-file",
    [
      "--record-acceptance",
      "--tag",
      "t",
      "--by",
      "U",
      "--drive",
      "confirmed",
      "--judgment",
      "rejected",
    ],
    "--note-file is required for --judgment rejected",
  ],
  [
    "--by used without --record-acceptance",
    ["P1-E1", "--by", "U"],
    "--by applies to --record-acceptance only",
  ],
];

for (const [name, argv, message] of recordAcceptanceRefusals) {
  test(`parseArguments refuses: ${name}`, () => {
    assert.throws(
      () => parseArguments(argv, "x"),
      (error: unknown) => {
        assert.ok(error instanceof RunnerError);
        assert.equal((error as RunnerError).message, message);
        return true;
      },
    );
  });
}

test("a complete --record-acceptance argv deep-equals RecordAcceptanceInvocation with noteFile: null", () => {
  const invocation = parseArguments(
    [
      "--record-acceptance",
      "--tag",
      "t1",
      "--by",
      "Ulrich",
      "--drive",
      "confirmed",
      "--judgment",
      "accepted",
    ],
    "x",
  );

  assert.deepEqual(invocation, {
    recordAcceptance: {
      tag: "t1",
      by: "Ulrich",
      drive: "confirmed",
      judgment: "accepted",
      noteFile: null,
    },
  });
});

test("main with a stub acceptance dependency resolves 0 on the happy path, 3 on the no-bundle rejection, and 2 on the second write", async (t) => {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-record-acceptance-"));
  process.chdir(dir);
  t.after(async () => {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  });

  const acceptance = {
    readCommit: async () => "c0ffee",
    readProposalRevision: async () => "dec0de",
    now: () => new Date("2026-08-09T10:00:00.000Z"),
  };

  const noBundleCode = await main(
    [
      "--record-acceptance",
      "--tag",
      "t1",
      "--by",
      "Ulrich",
      "--drive",
      "confirmed",
      "--judgment",
      "accepted",
    ],
    { acceptance },
  );
  assert.equal(noBundleCode, 3);

  await mkdir(join(runDirectory("t1"), "P1-E1"), { recursive: true });
  await writeFile(
    join(runDirectory("t1"), "P1-E1", "bundle.json"),
    "{}",
    "utf8",
  );

  const happyCode = await main(
    [
      "--record-acceptance",
      "--tag",
      "t1",
      "--by",
      "Ulrich",
      "--drive",
      "confirmed",
      "--judgment",
      "accepted",
    ],
    { acceptance },
  );
  assert.equal(happyCode, 0);

  const secondWriteCode = await main(
    [
      "--record-acceptance",
      "--tag",
      "t1",
      "--by",
      "Ulrich",
      "--drive",
      "confirmed",
      "--judgment",
      "accepted",
    ],
    { acceptance },
  );
  assert.equal(secondWriteCode, 2);
});
