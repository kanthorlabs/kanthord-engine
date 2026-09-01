import { z } from "zod";

import { deliverable } from "./deliverable.ts";
import type { Deliverable } from "./deliverable.ts";
import type { NodeKind } from "./state.ts";
import { nodeKind } from "./state.ts";
import { verifyBlock } from "./verify-block.ts";
import type { VerifyBlock } from "./verify-block.ts";
import { workerKind } from "./worker.ts";

const planFrontmatterKeys = new Set([
  "id",
  "kind",
  "title",
  "depends_on",
  "worker",
  "repo",
  "deliverable",
  "verify",
]);

const planFrontmatterBase = z
  .object({
    id: z.string().optional(),
    kind: nodeKind,
    title: z.string().min(1),
    depends_on: z.array(z.string().min(1)).optional(),
    worker: workerKind.optional(),
    repo: z.string().min(1).optional(),
    deliverable: deliverable.optional(),
    verify: verifyBlock.optional(),
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

export const planFrontmatter = planFrontmatterBase.superRefine(
  (value, context) => {
    if (value.worker !== undefined && value.deliverable !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["deliverable"],
        message: "frontmatter-invalid",
      });
    }
    if (value.deliverable !== undefined && value.verify === undefined) {
      context.addIssue({
        code: "custom",
        path: ["verify"],
        message: "frontmatter-invalid",
      });
    }
  },
);

export type ParsedDocument = Readonly<{
  path: string;
  kind: NodeKind;
  id: string | null;
  title: string;
  dependsOn: readonly string[];
  worker: string | null;
  repo: string | null;
  deliverable: Deliverable | null;
  verify: VerifyBlock | null;
  derivedParentPath: string | null;
  instruction: string;
  acceptance: string | null;
}>;
