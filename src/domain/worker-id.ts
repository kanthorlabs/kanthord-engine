import { z } from "zod";

export const WORKER_ID_PATTERN: RegExp = /^[a-z][a-z0-9-]*@[1-9][0-9]*$/;

export const workerId = z.string().regex(WORKER_ID_PATTERN);

export type WorkerId = Readonly<{
  name: string;
  version: number;
  id: string;
}>;

export class WorkerIdError extends Error {
  readonly code = "worker-id-invalid";

  constructor(raw: string) {
    super(`invalid worker id: ${raw}`);
    this.name = "WorkerIdError";
  }
}

export function parseWorkerId(raw: string): WorkerId {
  if (!WORKER_ID_PATTERN.test(raw)) {
    throw new WorkerIdError(raw);
  }

  const [name, versionSegment] = raw.split("@");
  const version = Number(versionSegment);
  if (version > Number.MAX_SAFE_INTEGER) {
    throw new WorkerIdError(raw);
  }

  return { name: name!, version, id: raw };
}
