import { z } from "zod";
import {
  AccessPolicy,
  StoreName,
  OperationLifetime,
  emptyInput,
  type Operation,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
export const MAX_RUNTIME_IDENTITY_LENGTH = 128;
export interface VerifiedClient {
  clientId: string;
  name: string;
  workerBindingId: string;
  projectId: string;
}
export interface Registration extends VerifiedClient {
  runtimeIdentity: string;
}

export interface WorkerRegistrations {
  register(transaction: Transaction, client: VerifiedClient): Registration;
  findByClient(clientId: string): Registration | undefined;
  deregister(runtimeIdentity: string): void;
}

export const WORKER_SERVICE_NAME = "worker";
export const workerOperations = {
  register: {
    service: WORKER_SERVICE_NAME,
    store: StoreName.Operational,
    lifetime: OperationLifetime.Unary,
    id: "worker.register",
    method: HttpMethod.Post,
    path: "/api/worker/register",
    access: AccessPolicy.Client,
    requiresRegistration: false,
    timeoutMs: 10000,
    mutation: true,
    maxBodyBytes: 40 * 1024,
    status: HttpStatus.OK,
    input: emptyInput,
    output: z.strictObject({
      runtimeIdentity: z
        .string()
        .min(1)
        .max(MAX_RUNTIME_IDENTITY_LENGTH)
        .refine((value) => !!value.trim()),
    }),
    description:
      "Register a worker instance with a bearer machine JWT and an empty body. Returns its runtime identity, not a token. A client identity holds at most one live registration. Repeating the key replays that identity while live; a replay after the registration ends answers 409. Cancellation does not deregister an accepted registration.",
  },
} as const satisfies Record<string, Operation>;
