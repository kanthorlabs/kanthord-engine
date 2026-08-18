import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

import { verdict } from "./verdict.ts";
import { main, parseArguments } from "../main.ts";
import { RunnerError } from "../errors.ts";
import {
  acceptanceRecordPath,
  bundleDirectory,
  runDirectory,
  verifyRecordPath,
  type ScenarioId,
} from "../tag.ts";

const allScenarioIds: readonly ScenarioId[] = [
  "P1-E1",
  "P1-E2",
  "P1-E4",
  "P1-E5",
  "P1B-E1",
  "P1B-E2",
  "P1B-E3",
];

async function withTempCwd(run: () => Promise<void>): Promise<void> {
  const cwd = process.cwd();
  const dir = await mkdtemp(join(tmpdir(), "kanthord-e2e-verdict-"));
  process.chdir(dir);
  try {
    await run();
  } finally {
    process.chdir(cwd);
    await rm(dir, { recursive: true, force: true });
  }
}

async function writeBundleStub(
  tag: string,
  scenarioId: ScenarioId,
  fields: Readonly<{ commit: string; outcome: string }>,
): Promise<void> {
  await mkdir(bundleDirectory(tag, scenarioId), { recursive: true });
  await writeFile(
    join(bundleDirectory(tag, scenarioId), "bundle.json"),
    JSON.stringify({
      scenarioId,
      commit: fields.commit,
      outcome: fields.outcome,
    }),
    "utf8",
  );
}

async function writeVerifyStub(
  tag: string,
  fields: Readonly<{
    exitCode: number;
    commit: string;
    proposalRevision: string;
  }>,
): Promise<void> {
  await mkdir(runDirectory(tag), { recursive: true });
  await writeFile(
    verifyRecordPath(tag),
    JSON.stringify({
      exitCode: fields.exitCode,
      commit: fields.commit,
      proposalRevision: fields.proposalRevision,
    }),
    "utf8",
  );
}

async function writeAcceptanceStub(
  tag: string,
  fields: Readonly<{
    drive: string;
    judgment: string;
    commit: string;
    proposalRevision: string;
  }>,
): Promise<void> {
  await mkdir(runDirectory(tag), { recursive: true });
  await writeFile(
    acceptanceRecordPath(tag),
    JSON.stringify({
      drive: fields.drive,
      judgment: fields.judgment,
      commit: fields.commit,
      proposalRevision: fields.proposalRevision,
    }),
    "utf8",
  );
}

async function setupCompleteRun(tag: string): Promise<void> {
  for (const scenarioId of allScenarioIds) {
    await writeBundleStub(tag, scenarioId, { commit: "c1", outcome: "passed" });
  }
  await writeVerifyStub(tag, {
    exitCode: 0,
    commit: "c1",
    proposalRevision: "p1",
  });
  await writeAcceptanceStub(tag, {
    drive: "confirmed",
    judgment: "accepted",
    commit: "c1",
    proposalRevision: "p1",
  });
}

async function walkDigests(
  root: string,
): Promise<ReadonlyArray<{ relativePath: string; sha256: string }>> {
  const records: Array<{ relativePath: string; sha256: string }> = [];

  async function walk(directory: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = relative(root, fullPath).split(sep).join("/");
        const content = await readFile(fullPath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        records.push({ relativePath, sha256 });
      }
    }
  }

  await walk(root);
  return records.sort((a, b) => (a.relativePath < b.relativePath ? -1 : 1));
}

test("verdict returns [] and main exits 0 on a complete run", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");

    const failures = await verdict({ tag: "t1", scenariosOnly: false });
    assert.deepEqual(failures, []);

    const code = await main(["--verdict", "t1"]);
    assert.equal(code, 0);
  });
});

test("the verdict requires a P1-E5 bundle", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    await rm(bundleDirectory("t1", "P1-E5"), { recursive: true, force: true });

    const failures = await verdict({ tag: "t1", scenariosOnly: true });
    assert.deepEqual(failures, [
      {
        axis: "scenario",
        code: "unavailable",
        reason: "P1-E5 has no bundle under tag t1",
      },
    ]);

    const exit = await main(["--verdict", "t1", "--scenarios-only"]);
    assert.equal(exit, 3);
  });
});

const failureCases: ReadonlyArray<
  readonly [
    name: string,
    mutate: (tag: string) => Promise<void>,
    axis: "scenario" | "acceptance",
    code: string,
    reason: string,
    exitCode: number,
  ]
> = [
  [
    "P1-E4 bundle absent",
    async (tag) => {
      await rm(bundleDirectory(tag, "P1-E4"), { recursive: true, force: true });
    },
    "scenario",
    "unavailable",
    "P1-E4 has no bundle under tag t1",
    3,
  ],
  [
    "P1-E2 bundle outcome failed",
    async (tag) => {
      await writeBundleStub(tag, "P1-E2", { commit: "c1", outcome: "failed" });
    },
    "scenario",
    "assertion-failed",
    "P1-E2 reports failed",
    1,
  ],
  [
    "P1-E2 bundle outcome unavailable",
    async (tag) => {
      await writeBundleStub(tag, "P1-E2", {
        commit: "c1",
        outcome: "unavailable",
      });
    },
    "scenario",
    "assertion-failed",
    "P1-E2 reports unavailable",
    1,
  ],
  [
    "verify.json absent",
    async (tag) => {
      await rm(verifyRecordPath(tag), { force: true });
    },
    "scenario",
    "unavailable",
    "tag t1 has no verify record",
    3,
  ],
  [
    "verify.json exitCode 1",
    async (tag) => {
      await writeVerifyStub(tag, {
        exitCode: 1,
        commit: "c1",
        proposalRevision: "p1",
      });
    },
    "scenario",
    "assertion-failed",
    "the verify record reports exit status 1",
    1,
  ],
  [
    "P1-E5 bundle on commit c2",
    async (tag) => {
      await writeBundleStub(tag, "P1-E5", { commit: "c2", outcome: "passed" });
    },
    "scenario",
    "assertion-failed",
    "P1-E5 is on commit c2; the verify record is on c1",
    1,
  ],
  [
    "acceptance record on proposal revision p2",
    async (tag) => {
      await writeAcceptanceStub(tag, {
        drive: "confirmed",
        judgment: "accepted",
        commit: "c1",
        proposalRevision: "p2",
      });
    },
    "scenario",
    "assertion-failed",
    "the acceptance record names proposal revision p2; the verify record names p1",
    1,
  ],
  [
    "acceptance.json absent",
    async (tag) => {
      await rm(acceptanceRecordPath(tag), { force: true });
    },
    "acceptance",
    "unavailable",
    "tag t1 has no acceptance record",
    3,
  ],
  [
    "drive not-confirmed",
    async (tag) => {
      await writeAcceptanceStub(tag, {
        drive: "not-confirmed",
        judgment: "accepted",
        commit: "c1",
        proposalRevision: "p1",
      });
    },
    "acceptance",
    "assertion-failed",
    "the acceptance record reports drive not-confirmed",
    1,
  ],
  [
    "judgment rejected",
    async (tag) => {
      await writeAcceptanceStub(tag, {
        drive: "confirmed",
        judgment: "rejected",
        commit: "c1",
        proposalRevision: "p1",
      });
    },
    "acceptance",
    "assertion-failed",
    "the acceptance record reports judgment rejected",
    1,
  ],
  [
    "acceptance record on commit c2",
    async (tag) => {
      await writeAcceptanceStub(tag, {
        drive: "confirmed",
        judgment: "accepted",
        commit: "c2",
        proposalRevision: "p1",
      });
    },
    "acceptance",
    "assertion-failed",
    "the acceptance record is on commit c2; the verify record is on c1",
    1,
  ],
];

for (const [name, mutate, axis, code, reason, exitCode] of failureCases) {
  test(`verdict reports exactly one failure: ${name}`, async () => {
    await withTempCwd(async () => {
      await setupCompleteRun("t1");
      await mutate("t1");

      const failures = await verdict({ tag: "t1", scenariosOnly: false });
      assert.deepEqual(failures, [{ axis, code, reason }]);

      const exit = await main(["--verdict", "t1"]);
      assert.equal(exit, exitCode);
    });
  });
}

test("a present but corrupt verify.json reports assertion-failed on the scenario axis, naming the file and the parse fault", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    const malformed = "{ not json ";
    let parseMessage = "";
    try {
      JSON.parse(malformed);
    } catch (error) {
      parseMessage = (error as Error).message;
    }
    await writeFile(verifyRecordPath("t1"), malformed, "utf8");

    const failures = await verdict({ tag: "t1", scenariosOnly: false });
    assert.deepEqual(failures, [
      {
        axis: "scenario",
        code: "assertion-failed",
        reason: `verify.json at ${verifyRecordPath("t1")} is not valid JSON: ${parseMessage}`,
      },
    ]);

    const exit = await main(["--verdict", "t1"]);
    assert.equal(exit, 1);
  });
});

test("a present but corrupt bundle.json reports assertion-failed on the scenario axis, naming the file and the parse fault", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    const malformed = "{ not json ";
    let parseMessage = "";
    try {
      JSON.parse(malformed);
    } catch (error) {
      parseMessage = (error as Error).message;
    }
    const corruptBundlePath = join(
      bundleDirectory("t1", "P1-E1"),
      "bundle.json",
    );
    await writeFile(corruptBundlePath, malformed, "utf8");

    const failures = await verdict({ tag: "t1", scenariosOnly: false });
    assert.deepEqual(failures, [
      {
        axis: "scenario",
        code: "assertion-failed",
        reason: `bundle.json at ${corruptBundlePath} is not valid JSON: ${parseMessage}`,
      },
    ]);

    const exit = await main(["--verdict", "t1"]);
    assert.equal(exit, 1);
  });
});

test("an absent bundle.json keeps its current unavailable reason string verbatim", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    await rm(bundleDirectory("t1", "P1-E1"), { recursive: true, force: true });

    const failures = await verdict({ tag: "t1", scenariosOnly: false });
    assert.deepEqual(failures, [
      {
        axis: "scenario",
        code: "unavailable",
        reason: "P1-E1 has no bundle under tag t1",
      },
    ]);

    const exit = await main(["--verdict", "t1"]);
    assert.equal(exit, 3);
  });
});

test("a present but corrupt acceptance.json reports assertion-failed on the acceptance axis, naming the file and the parse fault", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    const malformed = "{ not json ";
    let parseMessage = "";
    try {
      JSON.parse(malformed);
    } catch (error) {
      parseMessage = (error as Error).message;
    }
    await writeFile(acceptanceRecordPath("t1"), malformed, "utf8");

    const failures = await verdict({ tag: "t1", scenariosOnly: false });
    assert.deepEqual(failures, [
      {
        axis: "acceptance",
        code: "assertion-failed",
        reason: `acceptance.json at ${acceptanceRecordPath("t1")} is not valid JSON: ${parseMessage}`,
      },
    ]);

    const exit = await main(["--verdict", "t1"]);
    assert.equal(exit, 1);
  });
});

test("main(['--verdict', 't1']) writes one stderr line per failure, in list order", async (t) => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    await rm(bundleDirectory("t1", "P1-E4"), { recursive: true, force: true });
    await writeAcceptanceStub("t1", {
      drive: "not-confirmed",
      judgment: "accepted",
      commit: "c1",
      proposalRevision: "p1",
    });

    const lines: string[] = [];
    t.mock.method(process.stderr, "write", (chunk: string) => {
      lines.push(String(chunk));
      return true;
    });

    const exit = await main(["--verdict", "t1"]);

    assert.deepEqual(lines, [
      "e2e: verdict: scenario axis: P1-E4 has no bundle under tag t1\n",
      "e2e: verdict: acceptance axis: the acceptance record reports drive not-confirmed\n",
    ]);
    assert.equal(exit, 3);
  });
});

test("--scenarios-only exits 0 on a complete scenario axis with no acceptance record", async () => {
  await withTempCwd(async () => {
    for (const scenarioId of allScenarioIds) {
      await writeBundleStub("t1", scenarioId, {
        commit: "c1",
        outcome: "passed",
      });
    }
    await writeVerifyStub("t1", {
      exitCode: 0,
      commit: "c1",
      proposalRevision: "p1",
    });

    const failures = await verdict({ tag: "t1", scenariosOnly: true });
    assert.deepEqual(failures, []);

    const exit = await main(["--verdict", "t1", "--scenarios-only"]);
    assert.equal(exit, 0);
  });
});

test("--scenarios-only still reports a missing bundle when a valid acceptance record exists", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    await rm(bundleDirectory("t1", "P1-E1"), { recursive: true, force: true });

    const failures = await verdict({ tag: "t1", scenariosOnly: true });
    assert.deepEqual(failures, [
      {
        axis: "scenario",
        code: "unavailable",
        reason: "P1-E1 has no bundle under tag t1",
      },
    ]);

    const exit = await main(["--verdict", "t1", "--scenarios-only"]);
    assert.equal(exit, 3);
  });
});

test("--verdict modifies no file under the run directory, on a passing run", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    const before = await walkDigests(process.cwd());

    await main(["--verdict", "t1"]);

    const after = await walkDigests(process.cwd());
    assert.deepEqual(after, before);
  });
});

test("--verdict modifies no file under the run directory, on a failing run", async () => {
  await withTempCwd(async () => {
    await setupCompleteRun("t1");
    await rm(bundleDirectory("t1", "P1-E1"), { recursive: true, force: true });
    const before = await walkDigests(process.cwd());

    await main(["--verdict", "t1"]);

    const after = await walkDigests(process.cwd());
    assert.deepEqual(after, before);
  });
});

const verdictRefusals: ReadonlyArray<
  readonly [name: string, argv: readonly string[], message: string]
> = [
  [
    "--verdict beside a scenario id",
    ["--verdict", "t1", "P1-E1"],
    "--verdict is mutually exclusive with a scenario id",
  ],
  [
    "--verdict beside --tag",
    ["--verdict", "t1", "--tag", "t2"],
    "--verdict is mutually exclusive with --tag",
  ],
  [
    "--verdict beside --reclaim",
    ["--verdict", "t1", "--reclaim", "t2"],
    "--verdict is mutually exclusive with --reclaim",
  ],
  [
    "--scenarios-only without --verdict",
    ["--scenarios-only", "P1-E1"],
    "--scenarios-only applies to --verdict only",
  ],
  [
    "--verdict with an invalid tag",
    ["--verdict", "not a tag"],
    "tag not a tag is not a valid tag",
  ],
];

for (const [name, argv, message] of verdictRefusals) {
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

test("parseArguments(['--verdict', 't1', '--scenarios-only'], 'x') deep-equals { verdictTag: 't1', scenariosOnly: true }", () => {
  const invocation = parseArguments(
    ["--verdict", "t1", "--scenarios-only"],
    "x",
  );
  assert.deepEqual(invocation, { verdictTag: "t1", scenariosOnly: true });
});
