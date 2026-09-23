import assert from "node:assert/strict";
import { z } from "zod";
import {
  isMachineIdentity,
  type Authentication,
} from "../gateway/authentication.ts";
import type { WorkerRegistrations } from "../gateway/contracts.ts";
import {
  emptyInput,
  type Operation,
  type OperationRegistry,
} from "../gateway/registry.ts";
import {
  AccessPolicy,
  MAX_RUNTIME_IDENTITY_LENGTH,
} from "../gateway/constants.ts";
import { HttpMethod, HttpStatus } from "../shared/http.ts";
import { unauthorized } from "../gateway/errors.ts";

export const WORKER_SERVICE_NAME = "worker";
export const workerOperations = {
  register: {
    service: WORKER_SERVICE_NAME,
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

export function registerWorkerOperations(
  registry: OperationRegistry,
  authentication: Authentication,
  worker?: WorkerRegistrations,
): void {
  assert.equal(workerOperations.register.service, WORKER_SERVICE_NAME);
  assert.equal(workerOperations.register.access, AccessPolicy.Client);
  registry.register(
    {
      ...workerOperations.register,
      replayGuard: (recorded, identity) => {
        if (!isMachineIdentity(identity)) return false;
        const result = workerOperations.register.output.safeParse(recorded);
        return (
          result.success &&
          worker?.findByClient(identity.clientId)?.runtimeIdentity ===
            result.data.runtimeIdentity
        );
      },
    },
    (_input, caller) => {
      const identity = caller.identity;
      if (!isMachineIdentity(identity) || !worker) throw unauthorized();
      const previous = worker.findByClient(identity.clientId)?.runtimeIdentity;
      let runtimeIdentity: string | undefined;
      try {
        return caller.commit((transaction) => {
          runtimeIdentity = authentication.register(
            transaction,
            identity,
          ).runtimeIdentity;
          assert.ok(
            runtimeIdentity,
            "Registration must return a runtime identity.",
          );
          return { runtimeIdentity };
        });
      } catch (error) {
        const accepted =
          runtimeIdentity ??
          worker.findByClient(identity.clientId)?.runtimeIdentity;
        if (accepted !== undefined && accepted !== previous)
          worker.deregister(accepted);
        throw error;
      }
    },
  );
}
