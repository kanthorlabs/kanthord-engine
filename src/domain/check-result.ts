import { z } from "zod";

import { identity, nodeIdentity, anyIdentity } from "./identity.ts";
import { epochMillis, objectId, jsonText } from "./column.ts";
import { blobHash } from "./blob.ts";

export const checkResultRow = z
  .object({
    id: identity("checkResult"),
    subjectKind: z.enum([
      "candidate",
      "merge",
      "task-diagnostic",
      "reconcile",
      "profile-gate",
      "initiative-e2e",
    ]),
    subjectId: anyIdentity.nullable(),
    nodeId: nodeIdentity.nullable(),
    runId: identity("run").nullable(),
    commitOid: objectId.nullable(),
    manifestBlob: blobHash.nullable(),
    checkName: z.string(),
    commandJson: jsonText,
    cwd: z.string(),
    envIdentity: z.string(),
    toolchainVersion: z.string(),
    timeoutMs: z.int(),
    authoritative: z.int(),
    result: z.enum([
      "running",
      "passed",
      "failed",
      "error",
      "timed-out",
      "cancelled",
      "not-applicable",
    ]),
    exitCode: z.int().nullable(),
    outputBlob: blobHash.nullable(),
    profileBlob: blobHash.nullable(),
    conventionVersion: z.string(),
    invalidatedAt: epochMillis.nullable(),
    endedAt: epochMillis.nullable(),
  })
  .refine(
    (row) =>
      row.result === "not-applicable" ||
      row.commitOid !== null ||
      row.manifestBlob !== null,
    {
      message:
        "result = 'not-applicable' OR commit_oid IS NOT NULL OR manifest_blob IS NOT NULL",
    },
  );
export type CheckResultRow = z.infer<typeof checkResultRow>;
