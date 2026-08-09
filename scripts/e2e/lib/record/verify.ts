import { mkdir, writeFile } from "node:fs/promises";

import { redact } from "../redact.ts";
import { runDirectory, verifyRecordPath } from "../tag.ts";

export const verifyRecordSchemaVersion = 1;

export const verifyCommand: readonly string[] = ["npm", "run", "verify"];

export type VerifyRecord = Readonly<{
  schemaVersion: number;
  tag: string;
  command: readonly string[];
  exitCode: number;
  commit: string;
  proposalRevision: string;
  startedAt: string;
  finishedAt: string;
}>;

export type RecordVerifyDependencies = Readonly<{
  run(argv: readonly string[]): Promise<number>;
  readCommit(): Promise<string>;
  readProposalRevision(): Promise<string>;
  now(): Date;
}>;

export function serializeVerifyRecord(record: VerifyRecord): string {
  const ordered = {
    schemaVersion: record.schemaVersion,
    tag: record.tag,
    command: record.command,
    exitCode: record.exitCode,
    commit: record.commit,
    proposalRevision: record.proposalRevision,
    startedAt: record.startedAt,
    finishedAt: record.finishedAt,
  };

  return redact(`${JSON.stringify(ordered, null, 2)}\n`);
}

export async function recordVerify(
  dependencies: RecordVerifyDependencies,
  tag: string,
): Promise<VerifyRecord> {
  const startedAt = dependencies.now().toISOString();
  const commit = await dependencies.readCommit();
  const proposalRevision = await dependencies.readProposalRevision();
  const exitCode = await dependencies.run(verifyCommand);
  const finishedAt = dependencies.now().toISOString();

  const record: VerifyRecord = {
    schemaVersion: verifyRecordSchemaVersion,
    tag,
    command: verifyCommand,
    exitCode,
    commit,
    proposalRevision,
    startedAt,
    finishedAt,
  };

  await mkdir(runDirectory(tag), { recursive: true });
  await writeFile(verifyRecordPath(tag), serializeVerifyRecord(record), "utf8");

  return record;
}
