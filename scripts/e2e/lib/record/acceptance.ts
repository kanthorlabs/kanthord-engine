import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { redact } from "../redact.ts";
import {
  acceptanceRecordPath,
  bundleDirectory,
  runDirectory,
  type ScenarioId,
} from "../tag.ts";
import { RunnerError } from "../errors.ts";

export const acceptanceRecordSchemaVersion = 1;

export const driveValues = ["confirmed", "not-confirmed"] as const;
export const judgmentValues = ["accepted", "rejected"] as const;

export type Drive = (typeof driveValues)[number];
export type Judgment = (typeof judgmentValues)[number];

export type AcceptanceRecord = Readonly<{
  schemaVersion: number;
  tag: string;
  by: string;
  drive: Drive;
  judgment: Judgment;
  note: string;
  commit: string;
  proposalRevision: string;
  recordedAt: string;
}>;

export type RecordAcceptanceInput = Readonly<{
  tag: string;
  by: string;
  drive: Drive;
  judgment: Judgment;
  noteFile: string | null;
}>;

export type RecordAcceptanceDependencies = Readonly<{
  readCommit(): Promise<string>;
  readProposalRevision(): Promise<string>;
  now(): Date;
}>;

export function serializeAcceptanceRecord(record: AcceptanceRecord): string {
  const ordered = {
    schemaVersion: record.schemaVersion,
    tag: record.tag,
    by: record.by,
    drive: record.drive,
    judgment: record.judgment,
    note: record.note,
    commit: record.commit,
    proposalRevision: record.proposalRevision,
    recordedAt: record.recordedAt,
  };

  return redact(`${JSON.stringify(ordered, null, 2)}\n`);
}

const knownScenarioIds: readonly ScenarioId[] = [
  "P1-E1",
  "P1-E2",
  "P1-E4",
  "P1-E5",
];

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

export async function recordAcceptance(
  dependencies: RecordAcceptanceDependencies,
  input: RecordAcceptanceInput,
): Promise<AcceptanceRecord> {
  let hasBundle = false;
  for (const scenarioId of knownScenarioIds) {
    if (
      await exists(join(bundleDirectory(input.tag, scenarioId), "bundle.json"))
    ) {
      hasBundle = true;
      break;
    }
  }
  if (!hasBundle) {
    throw new RunnerError("unavailable", `tag ${input.tag} holds no bundle`);
  }

  if (await exists(acceptanceRecordPath(input.tag))) {
    throw new RunnerError(
      "tag-reused",
      `tag ${input.tag} already holds an acceptance record`,
    );
  }

  let note = "";
  if (input.noteFile !== null) {
    try {
      note = await readFile(input.noteFile, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new RunnerError(
          "invalid-argument",
          `--note-file ${input.noteFile} does not exist`,
        );
      }
      throw error;
    }
  }

  const commit = await dependencies.readCommit();
  const proposalRevision = await dependencies.readProposalRevision();
  const recordedAt = dependencies.now().toISOString();

  const record: AcceptanceRecord = {
    schemaVersion: acceptanceRecordSchemaVersion,
    tag: input.tag,
    by: input.by,
    drive: input.drive,
    judgment: input.judgment,
    note,
    commit,
    proposalRevision,
    recordedAt,
  };

  await mkdir(runDirectory(input.tag), { recursive: true });
  await writeFile(
    acceptanceRecordPath(input.tag),
    serializeAcceptanceRecord(record),
    "utf8",
  );

  return record;
}
