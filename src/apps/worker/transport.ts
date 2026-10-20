import assert from "node:assert/strict";
import type { MessagePort } from "node:worker_threads";
import { httpClient, portCaller } from "../../gateway/client.ts";
import { createClient } from "../../gateway/client-result.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import { trackingOperations } from "../../tracking/contract.ts";
import type {
  Operation,
  OperationResult,
  ServiceClient,
} from "../../kernel/operation.ts";

export interface WorkerTransport {
  gateway: ServiceClient<typeof gatewayOperations>;
  worker: ServiceClient<typeof workerOperations>;
  scheduler: ServiceClient<typeof schedulerOperations>;
  mission: ServiceClient<typeof missionOperations>;
  tracking: ServiceClient<typeof trackingOperations>;
}

export function httpTransport(
  endpoint: string,
  bearer?: string | (() => string | undefined),
): WorkerTransport {
  assert.ok(endpoint);
  const transport = {
    gateway: httpClient(gatewayOperations, endpoint, bearer),
    worker: httpClient(workerOperations, endpoint, bearer),
    scheduler: httpClient(schedulerOperations, endpoint, bearer),
    mission: httpClient(missionOperations, endpoint, bearer),
    tracking: httpClient(trackingOperations, endpoint, bearer),
  };
  assert.ok(transport.worker.register);
  return transport;
}

export function observedTransport(
  transport: WorkerTransport,
  observe: (result: OperationResult<unknown>) => void,
): WorkerTransport {
  const wrap = <T extends object>(client: T): T =>
    Object.fromEntries(
      Object.entries(client).map(([key, call]) => [
        key,
        async (...args: unknown[]) => {
          const result = await (
            call as (...input: unknown[]) => Promise<OperationResult<unknown>>
          )(...args);
          observe(result);
          return result;
        },
      ]),
    ) as T;
  return {
    gateway: wrap(transport.gateway),
    worker: wrap(transport.worker),
    scheduler: wrap(transport.scheduler),
    mission: wrap(transport.mission),
    tracking: wrap(transport.tracking),
  };
}

export function portTransport(port: MessagePort): WorkerTransport {
  const call = portCaller(port);
  const client = <T extends Record<string, Operation>>(operations: T) =>
    createClient(operations, call);
  return {
    gateway: client(gatewayOperations),
    worker: client(workerOperations),
    scheduler: client(schedulerOperations),
    mission: client(missionOperations),
    tracking: client(trackingOperations),
  };
}
