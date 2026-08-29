import { z } from "zod";

export const workerKinds = [
  "general@1",
  "tdd@1",
  "git@1",
  "claude.swe@1",
  "claude.te@1",
  "opencode.swe@1",
  "opencode.te@1",
] as const;

export const workerKind = z.enum(workerKinds);

export type WorkerKind = z.infer<typeof workerKind>;
