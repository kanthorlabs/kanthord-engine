import { z } from "zod";

import type { NodeKind } from "./state.ts";
import { nodeKind } from "./state.ts";
import { workerKind } from "./worker.ts";

const planFrontmatterKeys = new Set([
  "id",
  "kind",
  "title",
  "depends_on",
  "worker",
  "repo",
]);

export const planFrontmatter = z
  .object({
    id: z.string().optional(),
    kind: nodeKind,
    title: z.string().min(1),
    depends_on: z.array(z.string().min(1)).optional(),
    worker: workerKind.optional(),
    repo: z.string().min(1).optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    for (const key of Object.keys(value)) {
      if (!planFrontmatterKeys.has(key)) {
        context.addIssue({
          code: "custom",
          path: [key],
          message: "unknown frontmatter key",
        });
      }
    }
  });

export type ParsedDocument = Readonly<{
  path: string;
  kind: NodeKind;
  id: string | null;
  title: string;
  dependsOn: readonly string[];
  worker: string | null;
  repo: string | null;
  derivedParentPath: string | null;
  instruction: string;
  acceptance: string | null;
}>;
