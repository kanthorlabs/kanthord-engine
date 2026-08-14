import { z } from "zod";

import { identity } from "./identity.ts";
import { blobHash } from "./blob.ts";

export const revisionOrigins = ["import", "node-write"] as const;
export type RevisionOrigin = (typeof revisionOrigins)[number];

export const planRevisionRow = z
  .object({
    id: identity("planRevision"),
    projectId: identity("project"),
    parentId: identity("planRevision").nullable(),
    origin: z.enum(revisionOrigins),
    importId: z.string().nullable(),
    submittedBlob: blobHash.nullable(),
    choicesBlob: blobHash.nullable(),
    acceptedBlob: blobHash,
  })
  .refine(
    (row) =>
      row.origin === "import"
        ? row.importId !== null &&
          row.submittedBlob !== null &&
          row.choicesBlob !== null
        : row.importId === null &&
          row.submittedBlob === null &&
          row.choicesBlob === null,
    {
      message:
        "(origin = 'import') = (import_id IS NOT NULL AND submitted_blob IS NOT NULL AND choices_blob IS NOT NULL)",
    },
  );
export type PlanRevisionRow = z.infer<typeof planRevisionRow>;
