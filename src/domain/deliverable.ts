import { z } from "zod";

export const deliverables = [
  "test",
  "implementation",
  "review",
  "expansion",
] as const;

export const deliverable = z.enum(deliverables);

export type Deliverable = z.infer<typeof deliverable>;
