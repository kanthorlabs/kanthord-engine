import assert from "node:assert/strict";
import { httpClient } from "../../gateway/client.ts";
import { gatewayOperations } from "../../gateway/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { schedulerOperations } from "../../scheduler/contract.ts";
import { missionOperations } from "../../mission/contract.ts";
import { trackingOperations } from "../../tracking/contract.ts";
import type { ServiceClient } from "../../kernel/operation.ts";

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
