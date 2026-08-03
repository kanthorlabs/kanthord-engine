import { z } from "zod";

export const workerKinds = ["general@1", "tdd@1", "git@1"] as const;

export const workerKind = z.enum(workerKinds);

export type WorkerKind = z.infer<typeof workerKind>;
