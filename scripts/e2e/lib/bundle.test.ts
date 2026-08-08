import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  bundleSchemaVersion,
  createBundleWriter,
  hashFixtures,
  serializeBundle,
  writeBundle,
} from "./bundle.ts";
import { RunnerError } from "./errors.ts";
import type { CommandRecord } from "./command.ts";
import { redactedMarker, secrets } from "./redact.ts";

function baseInput() {
  return {
    scenarioId: "P1-E1" as const,
    mode: "deterministic" as const,
    driver: "local" as const,
    profile: "fixture" as const,
    tag: "20260101000000-abc123",
    commit: "deadbeefcafef00d",
    startedAt: "2026-01-01T00:00:00.000Z",
    identity: {
      hostname: "runner-host",
      platform: "linux",
      architecture: "x64",
    },
    fixtureHashes: [
      { path: "a.md", sha256: "0".repeat(64) },
      { path: "b.md", sha256: "1".repeat(64) },
    ],
  };
}

const noteKeysInOrder = [
  "productDigest",
  "baseDigest",
  "imageId",
  "architecture",
  "podmanRootless",
  "bindAddress",
  "daemonNamespace",
  "clientNamespace",
] as const;

test("bundleSchemaVersion is 1", () => {
  assert.equal(bundleSchemaVersion, 1);
});

test("serializeBundle emits the exact bytes for a fully populated bundle, keys in Bundle declaration order", () => {
  const input = baseInput();
  const writer = createBundleWriter(input);

  writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });

  for (const key of noteKeysInOrder) {
    writer.note(key, `value-${key}`);
  }

  writer.noteHost("daemon", {
    hostname: "daemon-host",
    platform: "linux",
    architecture: "arm64",
  });
  writer.noteHost("client", {
    hostname: "client-host",
    platform: "darwin",
    architecture: "arm64",
  });

  writer.noteObject("aObjective", "01AAA");
  writer.noteObject("bTask", "01BBB");

  writer.attachLog("stdout", "hello world");

  writer.assert("status ok", 200, 200);

  const command: CommandRecord = {
    argv: ["git", "log"],
    cwd: "/repo",
    exitCode: 0,
    stdout: "log output",
    stderr: "",
  };
  writer.sink.record(command);

  const bundle = writer.finish({
    outcome: "passed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  const expectedOrdered = {
    schemaVersion: 1,
    scenarioId: input.scenarioId,
    mode: input.mode,
    driver: input.driver,
    profile: input.profile,
    tag: input.tag,
    commit: input.commit,
    startedAt: input.startedAt,
    finishedAt: "2026-01-01T00:05:00.000Z",
    identity: input.identity,
    hosts: {
      daemon: {
        hostname: "daemon-host",
        platform: "linux",
        architecture: "arm64",
      },
      client: {
        hostname: "client-host",
        platform: "darwin",
        architecture: "arm64",
      },
    },
    versions: { daemon: "1.0.0", cli: "1.0.0", git: "2.43.0", podman: null },
    fixtureHashes: input.fixtureHashes,
    notes: {
      productDigest: "value-productDigest",
      baseDigest: "value-baseDigest",
      imageId: "value-imageId",
      architecture: "value-architecture",
      podmanRootless: "value-podmanRootless",
      bindAddress: "value-bindAddress",
      daemonNamespace: "value-daemonNamespace",
      clientNamespace: "value-clientNamespace",
    },
    objectIds: { aObjective: "01AAA", bTask: "01BBB" },
    assertions: [
      { name: "status ok", passed: true, expected: 200, actual: 200 },
    ],
    commands: [command],
    cleanupFailures: [],
    outcome: "passed",
    logs: { stdout: "hello world" },
  };

  const expected = `${JSON.stringify(expectedOrdered, null, 2)}\n`;

  assert.equal(serializeBundle(bundle), expected);
});

test("serializeBundle produces the same bytes when note and noteObject calls arrive in a different order", () => {
  function build(noteOrder: readonly (typeof noteKeysInOrder)[number][]) {
    const input = baseInput();
    const writer = createBundleWriter(input);
    writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });

    for (const key of noteOrder) {
      writer.note(key, `value-${key}`);
    }

    writer.noteHost("daemon", {
      hostname: "daemon-host",
      platform: "linux",
      architecture: "arm64",
    });
    writer.noteHost("client", {
      hostname: "client-host",
      platform: "darwin",
      architecture: "arm64",
    });

    return writer.finish({
      outcome: "passed",
      cleanupFailures: [],
      finishedAt: "2026-01-01T00:05:00.000Z",
    });
  }

  const forward = build([...noteKeysInOrder]);
  const backward = build([...noteKeysInOrder].reverse());

  assert.equal(serializeBundle(forward), serializeBundle(backward));

  function buildWithObjects(
    order: readonly ["aObjective", "bTask"] | readonly ["bTask", "aObjective"],
  ) {
    const input = baseInput();
    const writer = createBundleWriter(input);
    writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });

    for (const key of order) {
      writer.noteObject(key, key === "aObjective" ? "01AAA" : "01BBB");
    }

    return writer.finish({
      outcome: "passed",
      cleanupFailures: [],
      finishedAt: "2026-01-01T00:05:00.000Z",
    });
  }

  const objectsForward = buildWithObjects(["aObjective", "bTask"]);
  const objectsBackward = buildWithObjects(["bTask", "aObjective"]);

  assert.equal(
    serializeBundle(objectsForward),
    serializeBundle(objectsBackward),
  );
});

test("hashFixtures returns records sorted by path under Buffer.compare, with the exact sha256 of each file's bytes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kanthord-e2e-bundle-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
  });

  await writeFile(join(root, "b.md"), "content of b");
  await writeFile(join(root, "a.md"), "content of a");
  await mkdir(join(root, "nested"), { recursive: true });
  await writeFile(join(root, "nested", "á.md"), "nested content");

  const records = await hashFixtures(root);

  assert.deepEqual(
    records.map((record) => record.path),
    ["a.md", "b.md", "nested/á.md"],
  );

  const expectedShas = {
    "a.md": createHash("sha256").update("content of a").digest("hex"),
    "b.md": createHash("sha256").update("content of b").digest("hex"),
    "nested/á.md": createHash("sha256").update("nested content").digest("hex"),
  };

  for (const record of records) {
    assert.equal(
      record.sha256,
      expectedShas[record.path as keyof typeof expectedShas],
    );
  }
});

test("assert throws assertion-failed named after the assertion, and finish still holds the failing record last", () => {
  const writer = createBundleWriter(baseInput());

  writer.assert("prior check", 1, 1);

  try {
    writer.assert("x", 1, 2);
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "assertion-failed");
    assert.equal(error.message, "x");
  }

  const bundle = writer.finish({
    outcome: "failed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  assert.deepEqual(bundle.assertions[bundle.assertions.length - 1], {
    name: "x",
    passed: false,
    expected: 1,
    actual: 2,
  });
});

test("finish on a local-driver writer produces versions.podman === null", () => {
  const writer = createBundleWriter(baseInput());
  writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });

  const bundle = writer.finish({
    outcome: "passed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  assert.equal(bundle.versions.podman, null);
});

test("note writes into notes, note refuses an undeclared key, and notes serializes with the eight declared keys in declared order regardless of call order", () => {
  const writer = createBundleWriter(baseInput());
  writer.note("productDigest", "sha256:a");

  try {
    writer.note("nope", "x");
    assert.fail("expected a throw");
  } catch (error) {
    assert.ok(error instanceof RunnerError);
    assert.equal(error.code, "invalid-argument");
  }

  for (const key of noteKeysInOrder) {
    if (key !== "productDigest") {
      writer.note(key, `value-${key}`);
    }
  }

  const bundle = writer.finish({
    outcome: "passed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  assert.deepEqual(Object.keys(bundle.notes), [...noteKeysInOrder]);
});

test("writeBundle creates bundle.json and one file per log entry, and re-reading them deep-equals the bundle", async (t) => {
  const writer = createBundleWriter(baseInput());
  writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });
  writer.attachLog("stdout", "log body one");
  writer.attachLog("stderr", "log body two");

  const bundle = writer.finish({
    outcome: "passed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  const directory = await mkdtemp(join(tmpdir(), "kanthord-e2e-bundle-write-"));
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await writeBundle(directory, bundle);

  const writtenJson = await readFile(join(directory, "bundle.json"), "utf8");
  assert.deepEqual(JSON.parse(writtenJson), bundle);

  const stdoutLog = await readFile(
    join(directory, "logs", "stdout.log"),
    "utf8",
  );
  const stderrLog = await readFile(
    join(directory, "logs", "stderr.log"),
    "utf8",
  );
  assert.equal(stdoutLog, "log body one");
  assert.equal(stderrLog, "log body two");
});

test("SECURITY: serializeBundle redacts a held secret out of a recorded command's stdout and an attached log", () => {
  const heldSecret = "bundle-serialize-secret-1";
  secrets.hold(heldSecret);

  const writer = createBundleWriter(baseInput());
  writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });
  writer.attachLog("stdout", `daemon printed ${heldSecret} on startup`);
  writer.sink.record({
    argv: ["kanthord", "serve"],
    cwd: "/repo",
    exitCode: 0,
    stdout: `command echoed ${heldSecret}`,
    stderr: "",
  });

  const bundle = writer.finish({
    outcome: "passed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  const serialized = serializeBundle(bundle);

  assert.equal(serialized.includes(heldSecret), false);
  assert.equal(serialized.includes(redactedMarker), true);
});

test("SECURITY: writeBundle writes a redacted bundle.json and a redacted log file to disk", async (t) => {
  const heldSecret = "bundle-write-secret-1";
  secrets.hold(heldSecret);

  const writer = createBundleWriter(baseInput());
  writer.setVersions({ daemon: "1.0.0", cli: "1.0.0", git: "2.43.0" });
  writer.attachLog("stdout", `daemon printed ${heldSecret} on startup`);

  const bundle = writer.finish({
    outcome: "passed",
    cleanupFailures: [],
    finishedAt: "2026-01-01T00:05:00.000Z",
  });

  const directory = await mkdtemp(
    join(tmpdir(), "kanthord-e2e-bundle-write-redacted-"),
  );
  t.after(async () => {
    await rm(directory, { recursive: true, force: true });
  });
  await writeBundle(directory, bundle);

  const writtenJson = await readFile(join(directory, "bundle.json"), "utf8");
  const stdoutLog = await readFile(
    join(directory, "logs", "stdout.log"),
    "utf8",
  );

  assert.equal(writtenJson.includes(heldSecret), false);
  assert.equal(stdoutLog.includes(heldSecret), false);
  assert.equal(stdoutLog.includes(redactedMarker), true);
});
