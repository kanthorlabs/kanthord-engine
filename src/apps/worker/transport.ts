import assert from "node:assert/strict";
import type { MessagePort } from "node:worker_threads";
import { httpClient, portCaller } from "../../gateway/client.ts";
import { createClient } from "../../gateway/client-result.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import { trackingOperations } from "../../tracking/contract.ts";
import type { Operation, ServiceClient } from "../../kernel/operation.ts";

export interface WorkerTransport {
  gateway: ServiceClient<typeof gatewayOperations>;
  worker: ServiceClient<typeof workerOperations>;
  scheduler: ServiceClient<typeof schedulerOperations>;
  mission: ServiceClient<typeof missionOperations>;
  tracking: ServiceClient<typeof trackingOperations>;
}

export function httpTransport(
  endpoint: string,
  token?: string,
): WorkerTransport {
  assert.ok(endpoint);
  const transport = {
    gateway: httpClient(gatewayOperations, endpoint, token),
    worker: httpClient(workerOperations, endpoint, token),
    scheduler: httpClient(schedulerOperations, endpoint, token),
    mission: httpClient(missionOperations, endpoint, token),
    tracking: httpClient(trackingOperations, endpoint, token),
  };
  assert.ok(transport.worker.register);
  return transport;
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
