import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { deepStrictEqual } from "node:assert/strict";

import { RunnerError } from "./errors.ts";
import { redact } from "./redact.ts";
import type { ScenarioId } from "./tag.ts";
import type { CommandInput, CommandRecord, CommandSink } from "./command.ts";
import { runCommand } from "./command.ts";
import type { ResourceFailure } from "./resources.ts";
import type { DriverName } from "./driver/index.ts";
import type { ProfileName } from "./profile/index.ts";

export const bundleSchemaVersion = 1;

export type AssertionRecord = Readonly<{
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}>;

export type HashRecord = Readonly<{ path: string; sha256: string }>;

export type BundleVersions = Readonly<{
  daemon: string;
  cli: string;
  git: string;
  podman: string | null;
}>;

export type BundleIdentity = Readonly<{
  hostname: string;
  platform: string;
  architecture: string;
}>;

export type Bundle = Readonly<{
  schemaVersion: number;
  scenarioId: ScenarioId;
  mode: "deterministic" | "integration" | "deployment";
  driver: DriverName;
  profile: ProfileName;
  tag: string;
  commit: string;
  startedAt: string;
  finishedAt: string;
  identity: BundleIdentity;
  hosts: Readonly<Record<string, BundleIdentity>>;
  versions: BundleVersions;
  fixtureHashes: readonly HashRecord[];
  notes: Readonly<Record<string, string>>;
  objectIds: Readonly<Record<string, string>>;
  assertions: readonly AssertionRecord[];
  commands: readonly CommandRecord[];
  cleanupFailures: readonly ResourceFailure[];
  outcome: "passed" | "failed" | "unavailable";
  logs: Readonly<Record<string, string>>;
}>;

export type BundleWriter = Readonly<{
  sink: CommandSink;
  assert(name: string, expected: unknown, actual: unknown): void;
  note(key: string, value: string): void;
  noteHost(name: string, identity: BundleIdentity): void;
  noteObject(key: string, id: string): void;
  attachLog(name: string, text: string): void;
  setVersions(versions: Partial<BundleVersions>): void;
  logs(): Readonly<Record<string, string>>;
  printedLines(): readonly string[];
  assertionNames(): readonly string[];
  commandsRecorded(): readonly CommandRecord[];
  finish(
    input: Readonly<{
      outcome: Bundle["outcome"];
      cleanupFailures: readonly ResourceFailure[];
      finishedAt: string;
    }>,
  ): Bundle;
}>;

const noteKeys = [
  "productDigest",
  "baseDigest",
  "imageId",
  "architecture",
  "podmanRootless",
  "bindAddress",
  "daemonNamespace",
  "clientNamespace",
  "takeoverLatency",
] as const;

type NoteKey = (typeof noteKeys)[number];

function isNoteKey(key: string): key is NoteKey {
  return (noteKeys as readonly string[]).includes(key);
}

function byPathBytes(a: HashRecord, b: HashRecord): number {
  return Buffer.compare(Buffer.from(a.path), Buffer.from(b.path));
}

export function createBundleWriter(
  input: Readonly<{
    scenarioId: ScenarioId;
    mode: Bundle["mode"];
    driver: DriverName;
    profile: ProfileName;
    tag: string;
    commit: string;
    startedAt: string;
    identity: BundleIdentity;
    fixtureHashes: readonly HashRecord[];
  }>,
): BundleWriter {
  const commands: CommandRecord[] = [];
  const assertions: AssertionRecord[] = [];
  const hosts: Record<string, BundleIdentity> = {};
  const objectIds: Record<string, string> = {};
  const notes: Partial<Record<NoteKey, string>> = {};
  const logs: Record<string, string> = {};
  const printedLines: string[] = [];
  let versions: BundleVersions = {
    daemon: "",
    cli: "",
    git: "",
    podman: null,
  };

  const sink: CommandSink = {
    print(line: string): void {
      process.stdout.write(`${line}\n`);
      printedLines.push(line);
    },
    record(entry: CommandRecord): void {
      commands.push(entry);
    },
  };

  return {
    sink,
    logs(): Readonly<Record<string, string>> {
      return { ...logs };
    },
    printedLines(): readonly string[] {
      return [...printedLines];
    },
    assertionNames(): readonly string[] {
      return assertions.map(({ name }) => name);
    },
    commandsRecorded(): readonly CommandRecord[] {
      return [...commands];
    },
    assert(name: string, expected: unknown, actual: unknown): void {
      let passed = true;
      try {
        deepStrictEqual(actual, expected);
      } catch {
        passed = false;
      }

      assertions.push({ name, passed, expected, actual });

      if (!passed) {
        throw new RunnerError("assertion-failed", name);
      }
    },
    note(key: string, value: string): void {
      if (!isNoteKey(key)) {
        throw new RunnerError("invalid-argument", `unknown note key ${key}`);
      }

      notes[key] = value;
    },
    noteHost(name: string, identity: BundleIdentity): void {
      hosts[name] = identity;
    },
    noteObject(key: string, id: string): void {
      objectIds[key] = id;
    },
    attachLog(name: string, text: string): void {
      logs[name] = text;
    },
    setVersions(partial: Partial<BundleVersions>): void {
      versions = { ...versions, ...partial };
    },
    finish(
      finishInput: Readonly<{
        outcome: Bundle["outcome"];
        cleanupFailures: readonly ResourceFailure[];
        finishedAt: string;
      }>,
    ): Bundle {
      const orderedNotes: Record<string, string> = {};
      for (const key of noteKeys) {
        if (Object.hasOwn(notes, key)) {
          orderedNotes[key] = notes[key] as string;
        }
      }

      const orderedObjectIds: Record<string, string> = {};
      for (const key of Object.keys(objectIds).sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      )) {
        orderedObjectIds[key] = objectIds[key] as string;
      }

      return {
        schemaVersion: bundleSchemaVersion,
        scenarioId: input.scenarioId,
        mode: input.mode,
        driver: input.driver,
        profile: input.profile,
        tag: input.tag,
        commit: input.commit,
        startedAt: input.startedAt,
        finishedAt: finishInput.finishedAt,
        identity: input.identity,
        hosts: { ...hosts },
        versions: {
          ...versions,
          podman: input.driver === "podman" ? versions.podman : null,
        },
        fixtureHashes: input.fixtureHashes,
        notes: orderedNotes,
        objectIds: orderedObjectIds,
        assertions: [...assertions],
        commands: [...commands],
        cleanupFailures: finishInput.cleanupFailures,
        outcome: finishInput.outcome,
        logs: { ...logs },
      };
    },
  };
}

export function serializeBundle(bundle: Bundle): string {
  const ordered = {
    schemaVersion: bundle.schemaVersion,
    scenarioId: bundle.scenarioId,
    mode: bundle.mode,
    driver: bundle.driver,
    profile: bundle.profile,
    tag: bundle.tag,
    commit: bundle.commit,
    startedAt: bundle.startedAt,
    finishedAt: bundle.finishedAt,
    identity: bundle.identity,
    hosts: bundle.hosts,
    versions: bundle.versions,
    fixtureHashes: bundle.fixtureHashes,
    notes: bundle.notes,
    objectIds: bundle.objectIds,
    assertions: bundle.assertions,
    commands: bundle.commands,
    cleanupFailures: bundle.cleanupFailures,
    outcome: bundle.outcome,
    logs: bundle.logs,
  };

  return redact(`${JSON.stringify(ordered, null, 2)}\n`);
}

export async function writeBundle(
  directory: string,
  bundle: Bundle,
): Promise<void> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "bundle.json"),
    serializeBundle(bundle),
    "utf8",
  );

  const logEntries = Object.entries(bundle.logs);
  if (logEntries.length > 0) {
    const logsDirectory = join(directory, "logs");
    await mkdir(logsDirectory, { recursive: true });

    for (const [name, text] of logEntries) {
      const logPath = join(logsDirectory, `${name}.log`);
      await mkdir(dirname(logPath), { recursive: true });
      await writeFile(logPath, redact(text), "utf8");
    }
  }
}

export async function hashFixtures(
  root: string,
): Promise<readonly HashRecord[]> {
  const records: HashRecord[] = [];

  async function walk(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(directory, entry.name);

      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile()) {
        const relativePath = relative(root, fullPath).split(sep).join("/");
        const content = await readFile(fullPath);
        const sha256 = createHash("sha256").update(content).digest("hex");
        records.push({ path: relativePath, sha256 });
      }
    }
  }

  await walk(root);

  return records.sort(byPathBytes);
}

export type CommandExecutor = (
  sink: CommandSink,
  input: CommandInput,
) => Promise<CommandRecord>;

export async function readCommit(
  sink: CommandSink,
  git: string,
  execute: CommandExecutor = runCommand,
): Promise<string> {
  const record = await execute(sink, { argv: [git, "rev-parse", "HEAD"] });
  return record.stdout.trim();
}

export async function readProposalRevision(
  sink: CommandSink,
  git: string,
  execute: CommandExecutor = runCommand,
): Promise<string> {
  const record = await execute(sink, {
    argv: [git, "log", "-1", "--format=%H", "--", "docs/proposal"],
  });
  return record.stdout.trim();
}
