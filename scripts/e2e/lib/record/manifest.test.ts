import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";
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

import {
  checkManifest,
  declaredScenarioOrder,
  digestOf,
  manifestRecordPath,
  recordManifest,
  serializeManifest,
  type Manifest,
} from "./manifest.ts";
import { createBundleWriter, serializeBundle } from "../bundle.ts";
import { RunnerError } from "../errors.ts";
import { main, parseArguments, exitCodeFor } from "../main.ts";
import { bundleDirectory, runDirectory, type ScenarioId } from "../tag.ts";
import { secrets } from "../redact.ts";

const sampleManifest = {
  schemaVersion: 1,
  tag: "20260814120000000-01abcdefghijklmnopqrstuvwx",
  commit: "1111111111111111111111111111111111111111",
  proposalRevision: "2222222222222222222222222222222222222222",
  scenarios: [
    {
      id: "P1-E1",
      bundlePath: ".data/acceptance-t/P1-E1/bundle.json",
      sha256: "a".repeat(64),
      outcome: "passed",
    },
    {
      id: "P1-E2",
      bundlePath: ".data/acceptance-t/P1-E2/bundle.json",
      sha256: "b".repeat(64),
      outcome: "passed",
    },
  ],
  checklist: [
    {
      row: 1,
      subject: "the graph reads as the plan",
      answer: "confirmed",
      note: "",
    },
    {
      row: 2,
      subject: "the work is attributed",
      answer: "confirmed",
      note: "",
    },
    {
      row: 3,
      subject: "the result is readable from the node",
      answer: "confirmed",
      note: "",
    },
    {
      row: 4,
      subject: "the refusal is legible",
      answer: "confirmed",
      note: "",
    },
    {
      row: 5,
      subject: "the close is a human act",
      answer: "confirmed",
      note: "",
    },
    {
      row: 6,
      subject: "the block broke nothing he uses",
      answer: "confirmed",
      note: "",
    },
  ],
  report: {
    path: ".agent/acceptance/t/report.md",
    sha256: "c".repeat(64),
    bytes: 1234,
  },
  findings: [],
  outcome: "passed",
} as const;

test("serializeManifest writes the complete manifest in canonical byte order", () => {
  const text = serializeManifest(sampleManifest);

  assert.equal(
    text,
    `{
  "schemaVersion": 1,
  "tag": "20260814120000000-01abcdefghijklmnopqrstuvwx",
  "commit": "1111111111111111111111111111111111111111",
  "proposalRevision": "2222222222222222222222222222222222222222",
  "scenarios": [
    {
      "id": "P1-E1",
      "bundlePath": ".data/acceptance-t/P1-E1/bundle.json",
      "sha256": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "outcome": "passed"
    },
    {
      "id": "P1-E2",
      "bundlePath": ".data/acceptance-t/P1-E2/bundle.json",
      "sha256": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      "outcome": "passed"
    }
  ],
  "checklist": [
    {
      "row": 1,
      "subject": "the graph reads as the plan",
      "answer": "confirmed",
      "note": ""
    },
    {
      "row": 2,
      "subject": "the work is attributed",
      "answer": "confirmed",
      "note": ""
    },
    {
      "row": 3,
      "subject": "the result is readable from the node",
      "answer": "confirmed",
      "note": ""
    },
    {
      "row": 4,
      "subject": "the refusal is legible",
      "answer": "confirmed",
      "note": ""
    },
    {
      "row": 5,
      "subject": "the close is a human act",
      "answer": "confirmed",
      "note": ""
    },
    {
      "row": 6,
      "subject": "the block broke nothing he uses",
      "answer": "confirmed",
      "note": ""
    }
  ],
  "report": {
    "path": ".agent/acceptance/t/report.md",
    "sha256": "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
    "bytes": 1234
  },
  "findings": [],
  "outcome": "passed"
}
`,
  );
});

test("serializeManifest uses canonical nested key order instead of input key order", () => {
  const reorderedManifest = {
    ...sampleManifest,
    scenarios: sampleManifest.scenarios.map((scenario) => ({
      outcome: scenario.outcome,
      sha256: scenario.sha256,
      bundlePath: scenario.bundlePath,
      id: scenario.id,
    })),
    report: {
      bytes: sampleManifest.report.bytes,
      sha256: sampleManifest.report.sha256,
      path: sampleManifest.report.path,
    },
  } as const;

  assert.equal(
    serializeManifest(reorderedManifest),
    serializeManifest(sampleManifest),
  );
});

test("serialized manifest text ends with exactly one newline", () => {
  const text = serializeManifest(sampleManifest);

  assert.equal(text.at(-1), "\n");
  assert.equal(text.at(-2), "}");
});

test("serializeManifest redacts secrets in findings and checklist notes", () => {
  const findingSecret = "token-aaaaaaaa";
  const checklistSecret = "token-bbbbbbbb";
  secrets.hold(findingSecret);
  secrets.hold(checklistSecret);

  const text = serializeManifest({
    ...sampleManifest,
    checklist: [
      ...sampleManifest.checklist.slice(0, 5),
      { ...sampleManifest.checklist[5], note: checklistSecret },
    ],
    findings: [
      {
        id: "B1",
        action: "YES",
        name: "secret finding",
        description: findingSecret,
        fixEpic: null,
      },
    ],
  });

  assert.equal(text.includes(findingSecret), false);
  assert.equal(text.includes(checklistSecret), false);
  assert.equal(text.split("[redacted]").length - 1, 2);
});

test("declaredScenarioOrder names the seven scenarios in the declared run order", () => {
  assert.deepEqual(declaredScenarioOrder, [
    "P1-E1",
    "P1-E2",
    "P1B-E1",
    "P1-E4",
    "P1B-E2",
    "P1B-E3",
    "P1-E5",
  ]);
});

test("manifestRecordPath resolves a tag to its manifest file", () => {
  assert.equal(manifestRecordPath("t1"), ".data/acceptance-t1/manifest.json");
});

test("digestOf returns lowercase SHA-256 hex for content", () => {
  const content = Buffer.from("manifest");
  const digest = digestOf(content);

  assert.equal(digest.length, 64);
  assert.match(digest, /^[0-9a-f]{64}$/);
  assert.equal(digest, createHash("sha256").update(content).digest("hex"));
});

const fixtureCommit = "commit-1";
const fixtureProposalRevision = "proposal-1";
const fixtureReportText = "acceptance report\n";

type BundleOutcome = "passed" | "failed" | "unavailable";

type CompleteRun = Readonly<{
  manifest: Manifest;
  reportPath: string;
}>;

async function withTempCwd<T>(run: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-manifest-"));
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  }
}

async function withGitParentCwd<T>(run: () => Promise<T>): Promise<T> {
  const cwd = process.cwd();
  const directory = await mkdtemp(join(cwd, ".kanthord-e2e-manifest-"));
  process.chdir(directory);
  try {
    return await run();
  } finally {
    process.chdir(cwd);
    await rm(directory, { recursive: true, force: true });
  }
}

function bundleText(
  tag: string,
  scenarioId: ScenarioId,
  commit: string,
  outcome: BundleOutcome,
): string {
  const writer = createBundleWriter({
    scenarioId,
    mode: "deterministic",
    driver: "local",
    profile: "fixture",
    tag,
    commit,
    startedAt: "2026-08-14T12:00:00.000Z",
    identity: {
      hostname: "fixture-host",
      platform: "darwin",
      architecture: "arm64",
    },
    fixtureHashes: [],
  });

  return serializeBundle(
    writer.finish({
      outcome,
      cleanupFailures: [],
      finishedAt: "2026-08-14T12:00:01.000Z",
    }),
  );
}

async function writeBundleFile(
  tag: string,
  scenarioId: ScenarioId,
  commit = fixtureCommit,
  outcome: BundleOutcome = "passed",
): Promise<Buffer> {
  const bytes = Buffer.from(bundleText(tag, scenarioId, commit, outcome));
  const directory = bundleDirectory(tag, scenarioId);
  await mkdir(directory, { recursive: true });
  await writeFile(join(directory, "bundle.json"), bytes);
  return bytes;
}

function scenarioEntry(manifest: Manifest, id: ScenarioId) {
  const entry = manifest.scenarios.find((scenario) => scenario.id === id);
  if (entry === undefined) {
    throw new Error(`missing scenario ${id}`);
  }
  return entry;
}

async function writeManifestValue(tag: string, value: unknown): Promise<void> {
  await mkdir(runDirectory(tag), { recursive: true });
  await writeFile(
    manifestRecordPath(tag),
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
}

async function readManifestValue(tag: string): Promise<Manifest> {
  return JSON.parse(
    await readFile(manifestRecordPath(tag), "utf8"),
  ) as Manifest;
}

async function writeCompleteRun(tag: string): Promise<CompleteRun> {
  const scenarios: Array<Manifest["scenarios"][number]> = [];

  for (const id of declaredScenarioOrder) {
    const bytes = await writeBundleFile(tag, id);
    scenarios.push({
      id,
      bundlePath: join(bundleDirectory(tag, id), "bundle.json"),
      sha256: digestOf(bytes),
      outcome: "passed",
    });
  }

  const reportPath = `.agent/acceptance/${tag}/report.md`;
  const reportBytes = Buffer.from(fixtureReportText);
  await mkdir(join(".agent", "acceptance", tag), { recursive: true });
  await writeFile(reportPath, reportBytes);

  const manifest: Manifest = {
    schemaVersion: 1,
    tag,
    commit: fixtureCommit,
    proposalRevision: fixtureProposalRevision,
    scenarios,
    checklist: [
      {
        row: 1,
        subject: "the graph reads as the plan",
        answer: "confirmed",
        note: "",
      },
      {
        row: 2,
        subject: "the work is attributed",
        answer: "confirmed",
        note: "",
      },
      {
        row: 3,
        subject: "the result is readable from the node",
        answer: "confirmed",
        note: "",
      },
      {
        row: 4,
        subject: "the refusal is legible",
        answer: "confirmed",
        note: "",
      },
      {
        row: 5,
        subject: "the close is a human act",
        answer: "confirmed",
        note: "",
      },
      {
        row: 6,
        subject: "the block broke nothing he uses",
        answer: "confirmed",
        note: "",
      },
    ],
    report: {
      path: reportPath,
      sha256: digestOf(reportBytes),
      bytes: reportBytes.length,
    },
    findings: [],
    outcome: "passed",
  };

  await writeManifestValue(tag, JSON.parse(serializeManifest(manifest)));
  return { manifest, reportPath };
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
        const content = await readFile(fullPath);
        records.push({
          relativePath: relative(root, fullPath).split(sep).join("/"),
          sha256: digestOf(content),
        });
      }
    }
  }

  await walk(root);
  return records.sort((left, right) =>
    left.relativePath < right.relativePath ? -1 : 1,
  );
}

function assertRunnerError(
  run: () => unknown,
  code: string,
  message: string,
): void {
  try {
    run();
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
  }
}

async function assertRunnerErrorAsync(
  run: () => Promise<unknown>,
  code: string,
  message: string,
): Promise<void> {
  try {
    await run();
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, code);
    assert.equal(error.message, message);
  }
}

function manifestDependencies(
  overrides: Partial<{
    readCommit: () => Promise<string>;
    readProposalRevision: () => Promise<string>;
  }> = {},
) {
  return {
    readCommit: overrides.readCommit ?? (async () => "dependency-commit"),
    readProposalRevision:
      overrides.readProposalRevision ?? (async () => "dependency-revision"),
  };
}

test("checkManifest returns no failures for a complete run", async () => {
  await withTempCwd(async () => {
    await writeCompleteRun("t1");

    assert.deepEqual(await checkManifest("t1"), []);
  });
});

test("checkManifest rejects a manifest whose tag differs from the run tag", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", { ...run.manifest, tag: "t2" });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the manifest names tag t2; the run tag is t1",
      },
    ]);
  });
});

test("checkManifest rejects an unsupported manifest schema version", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", { ...run.manifest, schemaVersion: 2 });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the manifest names schema version 2; this runner writes 1",
      },
    ]);
  });
});

test("checkManifest rejects an unsupported manifest outcome", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", { ...run.manifest, outcome: "unknown" });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the manifest outcome unknown is not passed or failed",
      },
    ]);
  });
});

test("checkManifest reports the first scenario order difference after swapping rows wholesale", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const scenarios = [...run.manifest.scenarios];
    const p1bE1 = scenarios[2];
    const p1E4 = scenarios[3];
    assert.ok(p1bE1 !== undefined);
    assert.ok(p1E4 !== undefined);
    scenarios[2] = p1E4;
    scenarios[3] = p1bE1;
    await writeManifestValue("t1", { ...run.manifest, scenarios });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "scenario position 2 is P1-E4; the declared order names P1B-E1",
      },
    ]);
  });
});

test("checkManifest reports an absent final scenario position", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.slice(0, 6),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "scenario position 6 is absent; the declared order names P1-E5",
      },
    ]);
  });
});

test("checkManifest reports a scenario after the declared order ends", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const last = run.manifest.scenarios[6];
    assert.ok(last !== undefined);
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: [...run.manifest.scenarios, last],
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason:
          "scenario position 7 is P1-E5; the declared order ends at position 7",
      },
    ]);
  });
});

test("checkManifest reports an absent bundle and continues checking later entries", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const first = scenarioEntry(run.manifest, "P1-E1");
    const second = scenarioEntry(run.manifest, "P1-E2");
    await rm(first.bundlePath);
    const secondBytes = await readFile(second.bundlePath);
    const scenarios = run.manifest.scenarios.map((scenario) =>
      scenario.id === "P1-E2"
        ? { ...scenario, sha256: "0".repeat(64) }
        : scenario,
    );
    await writeManifestValue("t1", { ...run.manifest, scenarios });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "unavailable",
        reason: `the bundle at ${first.bundlePath} is absent`,
      },
      {
        code: "assertion-failed",
        reason: `the bundle at ${second.bundlePath} digests to ${digestOf(secondBytes)}; the manifest records ${"0".repeat(64)}`,
      },
    ]);
  });
});

test("checkManifest rejects a bundle whose recorded digest is wrong", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1-E1");
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: "0".repeat(64) }
          : scenario,
      ),
    });
    const actual = digestOf(await readFile(entry.bundlePath));

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the bundle at ${entry.bundlePath} digests to ${actual}; the manifest records ${"0".repeat(64)}`,
      },
    ]);
  });
});

test("checkManifest rejects a bundle with an invalid shape after its digest is recomputed", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1-E1");
    const bytes = Buffer.from("{}\n");
    await writeFile(entry.bundlePath, bytes);
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: digestOf(bytes) }
          : scenario,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the bundle at ${entry.bundlePath} is not a bundle`,
      },
    ]);
  });
});

test("checkManifest rejects a bundle that names another tag", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1-E1");
    const bytes = await writeBundleFile("t2", "P1-E1");
    await writeFile(entry.bundlePath, bytes);
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: digestOf(bytes) }
          : scenario,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the bundle at ${entry.bundlePath} names tag t2; the run tag is t1`,
      },
    ]);
  });
});

test("checkManifest rejects a bundle whose scenario id differs from its manifest row", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1B-E1");
    const source = await readFile(
      scenarioEntry(run.manifest, "P1-E2").bundlePath,
    );
    await writeFile(entry.bundlePath, source);
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: digestOf(source) }
          : scenario,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the bundle at ${entry.bundlePath} names scenario P1-E2; the manifest names P1B-E1`,
      },
    ]);
  });
});

test("checkManifest reports a bundle outcome mismatch against its manifest row", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1-E1");
    const bytes = await writeBundleFile("t1", "P1-E1", fixtureCommit, "failed");
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: digestOf(bytes), outcome: "passed" }
          : scenario,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the bundle at ${entry.bundlePath} reports failed; the manifest records passed`,
      },
    ]);
  });
});

test("checkManifest reports a non-passed manifest scenario during outcome consistency", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1-E1");
    const bytes = await writeBundleFile("t1", "P1-E1", fixtureCommit, "failed");
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: digestOf(bytes), outcome: "failed" }
          : scenario,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the manifest outcome is passed; scenario P1-E1 reports failed",
      },
    ]);
  });
});

test("checkManifest rejects a bundle on another commit", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const entry = scenarioEntry(run.manifest, "P1-E1");
    const bytes = await writeBundleFile("t1", "P1-E1", "commit-2");
    await writeFile(entry.bundlePath, bytes);
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === entry.id
          ? { ...scenario, sha256: digestOf(bytes) }
          : scenario,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the bundle at ${entry.bundlePath} is on commit commit-2; the manifest names ${fixtureCommit}`,
      },
    ]);
  });
});

test("checkManifest rejects a checklist with five rows", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      checklist: run.manifest.checklist.slice(0, 5),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the checklist holds 5 rows; six are required",
      },
    ]);
  });
});

test("checkManifest rejects a checklist with seven rows", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const last = run.manifest.checklist[5];
    assert.ok(last !== undefined);
    await writeManifestValue("t1", {
      ...run.manifest,
      checklist: [...run.manifest.checklist, last],
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the checklist holds 7 rows; six are required",
      },
    ]);
  });
});

test("checkManifest rejects an unanswered checklist row", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      checklist: run.manifest.checklist.map((row) =>
        row.row === 3 ? { ...row, answer: "maybe" } : row,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason:
          "checklist row 3 answers maybe; confirmed or rejected is required",
      },
    ]);
  });
});

test("checkManifest rejects a rejected checklist row with an empty note", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      checklist: run.manifest.checklist.map((row) =>
        row.row === 4 ? { ...row, answer: "rejected" } : row,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "checklist row 4 is rejected and carries no note",
      },
    ]);
  });
});

test("checkManifest rejects a rejected checklist row with a whitespace-only note", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      checklist: run.manifest.checklist.map((row) =>
        row.row === 4 ? { ...row, answer: "rejected", note: "   " } : row,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "checklist row 4 is rejected and carries no note",
      },
    ]);
  });
});

test("checkManifest reports an absent report", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await rm(run.reportPath);

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "unavailable",
        reason: `the report at ${run.reportPath} is absent`,
      },
    ]);
  });
});

test("checkManifest reports every mismatch for an empty report in class order", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeFile(run.reportPath, Buffer.alloc(0));

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the report at ${run.reportPath} is empty`,
      },
      {
        code: "assertion-failed",
        reason: `the report at ${run.reportPath} is 0 bytes; the manifest records ${Buffer.byteLength(fixtureReportText)}`,
      },
      {
        code: "assertion-failed",
        reason: `the report at ${run.reportPath} digests to ${digestOf(Buffer.alloc(0))}; the manifest records ${digestOf(Buffer.from(fixtureReportText))}`,
      },
    ]);
  });
});

test("checkManifest rejects a report whose recorded digest is wrong", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      report: { ...run.manifest.report, sha256: "0".repeat(64) },
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: `the report at ${run.reportPath} digests to ${digestOf(Buffer.from(fixtureReportText))}; the manifest records ${"0".repeat(64)}`,
      },
    ]);
  });
});

test("checkManifest requires a fix epic for a blocker finding", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      findings: [
        {
          id: "B1",
          action: "YES",
          name: "broken journey",
          description: "the journey failed",
          fixEpic: null,
        },
      ],
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "finding B1 is a blocker and names no fix epic",
      },
    ]);
  });
});

test("checkManifest accepts a blocker with a fix epic and a suggestion without one", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      findings: [
        {
          id: "B1",
          action: "YES",
          name: "broken journey",
          description: "the journey failed",
          fixEpic: "025.1-fix-journey",
        },
        {
          id: "S1",
          action: "NO",
          name: "slow setup",
          description: "the setup is slow",
          fixEpic: null,
        },
      ],
    });

    assert.deepEqual(await checkManifest("t1"), []);
  });
});

test("checkManifest reports every failed scenario row and rejected checklist row for a passed outcome", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const first = scenarioEntry(run.manifest, "P1-E1");
    const second = scenarioEntry(run.manifest, "P1-E2");
    const firstBytes = await writeBundleFile(
      "t1",
      "P1-E1",
      fixtureCommit,
      "failed",
    );
    const secondBytes = await writeBundleFile(
      "t1",
      "P1-E2",
      fixtureCommit,
      "failed",
    );
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) => {
        if (scenario.id === first.id) {
          return {
            ...scenario,
            sha256: digestOf(firstBytes),
            outcome: "failed",
          };
        }
        if (scenario.id === second.id) {
          return {
            ...scenario,
            sha256: digestOf(secondBytes),
            outcome: "failed",
          };
        }
        return scenario;
      }),
      checklist: run.manifest.checklist.map((row) =>
        row.row === 5 ? { ...row, answer: "rejected", note: "refusal" } : row,
      ),
    });

    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "assertion-failed",
        reason: "the manifest outcome is passed; scenario P1-E1 reports failed",
      },
      {
        code: "assertion-failed",
        reason: "the manifest outcome is passed; scenario P1-E2 reports failed",
      },
      {
        code: "assertion-failed",
        reason: "the manifest outcome is passed; checklist row 5 is rejected",
      },
    ]);
  });
});

test("checkManifest returns unavailable for an absent manifest", async () => {
  await withTempCwd(async () => {
    assert.deepEqual(await checkManifest("t1"), [
      {
        code: "unavailable",
        reason: "tag t1 has no manifest",
      },
    ]);
  });
});

test("checkManifest returns one assertion failure for invalid manifest JSON", async () => {
  await withTempCwd(async () => {
    await mkdir(runDirectory("t1"), { recursive: true });
    await writeFile(manifestRecordPath("t1"), "{", "utf8");

    const failures = await checkManifest("t1");
    assert.equal(failures.length, 1);
    assert.equal(failures[0]?.code, "assertion-failed");
    assert.match(
      failures[0]?.reason ?? "",
      /^manifest\.json at \.data\/acceptance-t1\/manifest\.json is not valid JSON:/,
    );
  });
});

for (const [name, value] of [
  ["null", null],
  ["an array", []],
  ["an object missing scenarios", { schemaVersion: 1 }],
] as const) {
  test(`checkManifest does not throw for ${name}`, async () => {
    await withTempCwd(async () => {
      await writeManifestValue("t1", value);

      assert.deepEqual(await checkManifest("t1"), [
        {
          code: "assertion-failed",
          reason:
            "manifest.json at .data/acceptance-t1/manifest.json is not a manifest",
        },
      ]);
    });
  });
}

test("checkManifest modifies no file while it checks a complete run", async () => {
  await withTempCwd(async () => {
    await writeCompleteRun("t1");
    const before = await walkDigests(runDirectory("t1"));

    assert.deepEqual(await checkManifest("t1"), []);

    const after = await walkDigests(runDirectory("t1"));
    assert.deepEqual(after, before);
  });
});

test("recordManifest stamps a valid source and writes the serialized record", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("source");
    const sourcePath = join(process.cwd(), "source-manifest.json");
    const source = {
      ...run.manifest,
      schemaVersion: 99,
      tag: "source-tag",
      commit: "source-commit",
      proposalRevision: "source-revision",
    };
    await writeFile(sourcePath, serializeManifest(source), "utf8");

    const record = await recordManifest(manifestDependencies(), {
      tag: "recorded",
      manifestFile: sourcePath,
    });

    assert.deepEqual(record, {
      ...run.manifest,
      schemaVersion: 1,
      tag: "recorded",
      commit: "dependency-commit",
      proposalRevision: "dependency-revision",
    });
    assert.equal(
      await readFile(manifestRecordPath("recorded"), "utf8"),
      serializeManifest(record),
    );
  });
});

test("recordManifest uses the input and dependencies instead of source identity fields", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("source");
    const sourcePath = join(process.cwd(), "source-manifest.json");
    await writeFile(
      sourcePath,
      serializeManifest({
        ...run.manifest,
        schemaVersion: 8,
        tag: "wrong-source-tag",
        commit: "wrong-source-commit",
        proposalRevision: "wrong-source-revision",
      }),
      "utf8",
    );

    const record = await recordManifest(
      manifestDependencies({
        readCommit: async () => "stamped-commit",
        readProposalRevision: async () => "stamped-revision",
      }),
      { tag: "stamped-tag", manifestFile: sourcePath },
    );

    assert.equal(record.schemaVersion, 1);
    assert.equal(record.tag, "stamped-tag");
    assert.equal(record.commit, "stamped-commit");
    assert.equal(record.proposalRevision, "stamped-revision");
  });
});

test("recordManifest rejects an absent source file with invalid-argument", async () => {
  await withTempCwd(async () => {
    const sourcePath = join(process.cwd(), "missing-manifest.json");

    await assertRunnerErrorAsync(
      () =>
        recordManifest(manifestDependencies(), {
          tag: "t1",
          manifestFile: sourcePath,
        }),
      "invalid-argument",
      `--manifest ${sourcePath} does not exist`,
    );
  });
});

test("recordManifest rejects invalid JSON and a source that is not a manifest", async () => {
  await withTempCwd(async () => {
    const invalidPath = join(process.cwd(), "invalid-manifest.json");
    await writeFile(invalidPath, "{", "utf8");
    await assertRunnerErrorAsync(
      () =>
        recordManifest(manifestDependencies(), {
          tag: "invalid-json",
          manifestFile: invalidPath,
        }),
      "invalid-argument",
      `--manifest ${invalidPath} is not valid JSON`,
    );

    const shapePath = join(process.cwd(), "invalid-shape.json");
    await writeFile(shapePath, "[]", "utf8");
    await assertRunnerErrorAsync(
      () =>
        recordManifest(manifestDependencies(), {
          tag: "invalid-shape",
          manifestFile: shapePath,
        }),
      "invalid-argument",
      `--manifest ${shapePath} is not a manifest`,
    );
  });
});

test("recordManifest does not call dependencies when the source is absent or malformed", async () => {
  await withTempCwd(async () => {
    let commitCalls = 0;
    let proposalCalls = 0;
    const dependencies = manifestDependencies({
      readCommit: async () => {
        commitCalls += 1;
        return "commit";
      },
      readProposalRevision: async () => {
        proposalCalls += 1;
        return "revision";
      },
    });
    const missingPath = join(process.cwd(), "missing.json");

    await assertRunnerErrorAsync(
      () =>
        recordManifest(dependencies, {
          tag: "missing",
          manifestFile: missingPath,
        }),
      "invalid-argument",
      `--manifest ${missingPath} does not exist`,
    );

    const malformedPath = join(process.cwd(), "malformed.json");
    await writeFile(malformedPath, "{", "utf8");
    await assertRunnerErrorAsync(
      () =>
        recordManifest(dependencies, {
          tag: "malformed",
          manifestFile: malformedPath,
        }),
      "invalid-argument",
      `--manifest ${malformedPath} is not valid JSON`,
    );

    assert.equal(commitCalls, 0);
    assert.equal(proposalCalls, 0);
  });
});

test("recordManifest refuses a second write and preserves the original bytes", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("source");
    const sourcePath = join(process.cwd(), "source-manifest.json");
    await writeFile(sourcePath, serializeManifest(run.manifest), "utf8");
    const input = { tag: "t1", manifestFile: sourcePath };
    await recordManifest(manifestDependencies(), input);
    const before = await readFile(manifestRecordPath("t1"));

    await assertRunnerErrorAsync(
      () => recordManifest(manifestDependencies(), input),
      "tag-reused",
      "tag t1 already holds a manifest",
    );

    const after = await readFile(manifestRecordPath("t1"));
    assert.deepEqual(after, before);
  });
});

test("recordManifest refuses a reused tag before reading a missing source file", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("source");
    const sourcePath = join(process.cwd(), "source-manifest.json");
    await writeFile(sourcePath, serializeManifest(run.manifest), "utf8");
    await recordManifest(manifestDependencies(), {
      tag: "t1",
      manifestFile: sourcePath,
    });

    const missingPath = join(process.cwd(), "does-not-exist.json");
    await assertRunnerErrorAsync(
      () =>
        recordManifest(manifestDependencies(), {
          tag: "t1",
          manifestFile: missingPath,
        }),
      "tag-reused",
      "tag t1 already holds a manifest",
    );
  });
});

test("parseArguments resolves the record-manifest invocation", () => {
  assert.deepEqual(
    parseArguments(
      ["--record-manifest", "--tag", "t1", "--manifest", "m.json"],
      "minted",
    ),
    { recordManifest: { tag: "t1", manifestFile: "m.json" } },
  );
});

test("parseArguments resolves the check-manifest invocation", () => {
  assert.deepEqual(parseArguments(["--check-manifest", "t1"], "minted"), {
    checkManifestTag: "t1",
  });
});

test("parseArguments requires a tag and a source file for record-manifest", () => {
  assertRunnerError(
    () => parseArguments(["--record-manifest", "--manifest", "m.json"], "m"),
    "invalid-argument",
    "--record-manifest needs --tag",
  );
  assertRunnerError(
    () => parseArguments(["--record-manifest", "--tag", "t1"], "m"),
    "invalid-argument",
    "--record-manifest needs --manifest",
  );
});

test("parseArguments rejects an orphan manifest option", () => {
  assertRunnerError(
    () => parseArguments(["--manifest", "m.json"], "m"),
    "invalid-argument",
    "--manifest applies to --record-manifest only",
  );
});

test("parseArguments rejects an invalid check-manifest tag", () => {
  assertRunnerError(
    () => parseArguments(["--check-manifest", "!!"], "m"),
    "invalid-argument",
    "tag !! is not a valid tag",
  );
});

const existingOptionCases: ReadonlyArray<
  readonly [name: string, argv: readonly string[]]
> = [
  ["verdict", ["--verdict", "t1"]],
  ["record-verify", ["--record-verify", "--tag", "t1"]],
  [
    "record-acceptance",
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
  ],
  ["mint-tag", ["--mint-tag"]],
  ["reclaim", ["--reclaim", "t1"]],
];

for (const [name, argv] of existingOptionCases) {
  test(`parseArguments rejects --check-manifest with ${name} in either order`, () => {
    assert.throws(
      () => parseArguments(["--check-manifest", "t1", ...argv], "m"),
      RunnerError,
    );
    assert.throws(
      () => parseArguments([...argv, "--check-manifest", "t1"], "m"),
      RunnerError,
    );
  });

  test(`parseArguments rejects --record-manifest with ${name} in either order`, () => {
    const recordManifestOption = [
      "--record-manifest",
      "--tag",
      "t1",
      "--manifest",
      "m.json",
    ];
    assert.throws(
      () => parseArguments([...recordManifestOption, ...argv], "m"),
      RunnerError,
    );
    assert.throws(
      () => parseArguments([...argv, ...recordManifestOption], "m"),
      RunnerError,
    );
  });
}

test("parseArguments lets the last manifest option value win", () => {
  assert.deepEqual(
    parseArguments(
      [
        "--record-manifest",
        "--tag",
        "t1",
        "--manifest",
        "first.json",
        "--manifest",
        "last.json",
      ],
      "m",
    ),
    { recordManifest: { tag: "t1", manifestFile: "last.json" } },
  );
});

test("parseArguments rejects check-manifest with tag or a positional scenario", () => {
  assert.throws(
    () => parseArguments(["--check-manifest", "t1", "--tag", "t1"], "m"),
    RunnerError,
  );
  assert.throws(
    () => parseArguments(["--check-manifest", "t1", "P1-E1"], "m"),
    RunnerError,
  );
});

test("main exits zero and writes no stderr for a complete manifest", async (t) => {
  await withTempCwd(async () => {
    await writeCompleteRun("t1");
    let captured = "";
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    });

    const code = await main(["--check-manifest", "t1"]);

    assert.equal(code, 0);
    assert.equal(captured, "");
  });
});

test("main exits one and prints the manifest failure for an assertion failure", async (t) => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    await writeManifestValue("t1", {
      ...run.manifest,
      schemaVersion: 2,
    });
    let captured = "";
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    });

    const code = await main(["--check-manifest", "t1"]);

    assert.equal(code, 1);
    assert.equal(
      captured,
      "e2e: manifest: the manifest names schema version 2; this runner writes 1\n",
    );
  });
});

test("main exits three when the manifest is absent", async () => {
  await withTempCwd(async () => {
    assert.equal(await main(["--check-manifest", "t1"]), 3);
  });
});

test("main uses the first manifest failure for its exit status", async (t) => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("t1");
    const first = scenarioEntry(run.manifest, "P1-E1");
    const second = scenarioEntry(run.manifest, "P1-E2");
    await rm(first.bundlePath);
    await writeManifestValue("t1", {
      ...run.manifest,
      scenarios: run.manifest.scenarios.map((scenario) =>
        scenario.id === second.id
          ? { ...scenario, sha256: "0".repeat(64) }
          : scenario,
      ),
    });
    const failures = await checkManifest("t1");
    const firstFailure = failures[0];
    assert.ok(firstFailure !== undefined);
    let captured = "";
    t.mock.method(process.stderr, "write", (chunk: string | Uint8Array) => {
      captured += chunk.toString();
      return true;
    });

    const code = await main(["--check-manifest", "t1"]);

    assert.equal(code, exitCodeFor(firstFailure.code));
    assert.equal(
      captured.split("\n").filter((line) => line.length > 0).length,
      2,
    );
  });
});

test("main records a manifest through the record-manifest branch", async () => {
  await withGitParentCwd(async () => {
    const run = await writeCompleteRun("source");
    const sourcePath = join(process.cwd(), "source-manifest.json");
    await writeFile(sourcePath, serializeManifest(run.manifest), "utf8");

    const code = await main([
      "--record-manifest",
      "--tag",
      "main-recorded",
      "--manifest",
      sourcePath,
    ]);

    assert.equal(code, 0);
    assert.ok((await readFile(manifestRecordPath("main-recorded"))).length > 0);
  });
});

test("main returns exit code two when record-manifest reuses a tag", async () => {
  await withTempCwd(async () => {
    const run = await writeCompleteRun("source");
    const sourcePath = join(process.cwd(), "source-manifest.json");
    await writeFile(sourcePath, serializeManifest(run.manifest), "utf8");
    await recordManifest(manifestDependencies(), {
      tag: "t1",
      manifestFile: sourcePath,
    });

    assert.equal(
      await main([
        "--record-manifest",
        "--tag",
        "t1",
        "--manifest",
        sourcePath,
      ]),
      exitCodeFor("tag-reused"),
    );
  });
});
