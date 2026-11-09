import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import {
  audit,
  FileKind,
  readPrivate,
  writePrivate,
} from "../../kernel/files.ts";
import { identitySchema } from "../../kernel/identity.ts";
import {
  type PushRecord,
  pushRecordSchema,
} from "../../repository/contract.ts";

export const PUSHED_DIRECTORY = "pushed";
const BRANCH_KEY_LENGTH = 32;

export interface PushRecordKey {
  nodeKey: string;
  nodeBranch: string;
  bindingId: string;
}

export function branchKeyOf(branch: string): string {
  return createHash("sha256")
    .update(branch)
    .digest("hex")
    .slice(0, BRANCH_KEY_LENGTH);
}

function directoryOf(key: PushRecordKey): string {
  return join(key.nodeKey, PUSHED_DIRECTORY, branchKeyOf(key.nodeBranch));
}

function recordPath(key: PushRecordKey): string {
  return join(directoryOf(key), identitySchema("binding").parse(key.bindingId));
}

function auditOrRemove(path: string, kind: FileKind): void {
  try {
    audit(path, kind, true);
  } catch {
    rmSync(path, { recursive: true, force: true });
  }
}

export function readPushRecord(key: PushRecordKey): PushRecord | null {
  try {
    for (const directory of [
      join(key.nodeKey, PUSHED_DIRECTORY),
      directoryOf(key),
    ])
      if (!audit(directory, FileKind.Directory, true)) return null;
    const record = pushRecordSchema.parse(
      JSON.parse(readPrivate(recordPath(key))),
    );
    return record.confirmed === null && record.pending === null ? null : record;
  } catch {
    return null;
  }
}

export function writePushRecord(
  key: PushRecordKey,
  record: PushRecord | null,
): void {
  const path = recordPath(key);
  auditOrRemove(join(key.nodeKey, PUSHED_DIRECTORY), FileKind.Directory);
  auditOrRemove(directoryOf(key), FileKind.Directory);
  auditOrRemove(path, FileKind.File);
  if (record === null) {
    rmSync(path, { force: true });
    return;
  }
  writePrivate(path, JSON.stringify(pushRecordSchema.parse(record)), true);
}
