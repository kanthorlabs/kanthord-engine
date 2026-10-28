import assert from "node:assert/strict";
import { isWorkerIdentity } from "../kernel/caller.ts";
import type { OperationRegistry } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { HeldCopy } from "../custody/contract.ts";
import type { CopyHealth } from "../llm/contract.ts";
import {
  instanceOperations,
  type registrationRecordSchema,
} from "./contract.ts";
import type { HeartbeatClock } from "./heartbeat.ts";
import type { WorkerInstances } from "./instances.ts";
import type { RegistrationRow } from "./registration-rows.ts";

export interface InstanceOperationDependencies {
  instances: WorkerInstances;
  heartbeatClock: HeartbeatClock;
  instancesChanged: () => void;
  registrationRecordOf: (
    tx: Transaction,
    row: RegistrationRow,
  ) => typeof registrationRecordSchema._output;
  heldCopies: (
    tx: Transaction,
    holder: string,
  ) => (HeldCopy & { health: CopyHealth })[];
}

function dropEnded(clock: HeartbeatClock, ended: readonly string[]): void {
  for (const runtimeIdentity of ended) clock.drop(runtimeIdentity);
}

function declareHumanReads(
  registry: OperationRegistry,
  {
    instances,
    registrationRecordOf,
    heldCopies,
  }: InstanceOperationDependencies,
): void {
  registry.register(instanceOperations["instance.list"], ({ query }, caller) =>
    caller.commit((tx) => instances.list(tx, query)),
  );
  registry.register(instanceOperations["instance.get"], ({ params }, caller) =>
    caller.commit((tx) => {
      const record = instances.requireLatest(tx, params.instance_name);
      return {
        ...record,
        connection: instances.connectionOf(record.id),
        bindings: instances.bindingsListing(tx, record.name).map((binding) => ({
          project_id: binding.project_id,
          binding: binding.name,
        })),
        registrations: instances
          .liveRegistrationsOf(tx, record.name)
          .map((row) => registrationRecordOf(tx, row)),
        credentials: heldCopies(tx, record.name),
      };
    }),
  );
}

function declareHumanWrites(
  registry: OperationRegistry,
  {
    instances,
    heartbeatClock,
    instancesChanged,
  }: InstanceOperationDependencies,
): void {
  registry.register(
    instanceOperations["instance.create"],
    async ({ body }, caller) => {
      const answer = await instances.create(
        (write) => caller.commit(write),
        body,
      );
      instancesChanged();
      return answer;
    },
  );
  registry.register(
    instanceOperations["instance.rotate"],
    async ({ params, body }, caller) => {
      let previous: string | undefined;
      let registrations: string[] = [];
      const answer = await instances.rotate(
        (write) => caller.commit(write),
        params.instance_name,
        body,
        (instanceId, ended) => {
          previous = instanceId;
          registrations = ended;
        },
      );
      assert.ok(previous);
      instances.dropConnection(previous);
      dropEnded(heartbeatClock, registrations);
      return answer;
    },
  );
  registry.register(
    instanceOperations["instance.archive"],
    ({ params, body }, caller) => {
      let ended: string[] = [];
      const record = caller.commit((tx) => {
        const result = instances.archive(
          tx,
          params.instance_name,
          body.expected_revision,
        );
        ended = result.ended;
        return result.record;
      });
      instances.dropConnection(record.id);
      dropEnded(heartbeatClock, ended);
      instancesChanged();
      return record;
    },
  );
}

function declareExchange(
  registry: OperationRegistry,
  { instances }: InstanceOperationDependencies,
): void {
  registry.register(instanceOperations["instance.token"], ({ body }) =>
    instances.token(body.instance_id),
  );
  registry.register(
    instanceOperations["instance.connect"],
    ({ body }, caller) => {
      const identity = caller.identity;
      assert.ok(isWorkerIdentity(identity));
      return instances.connect(identity.instanceId, body);
    },
  );
  registry.register(
    instanceOperations["instance.heartbeat"],
    ({ body }, caller) => {
      const identity = caller.identity;
      assert.ok(isWorkerIdentity(identity));
      return instances.heartbeat(
        identity.instanceId,
        identity.name,
        body.connection_id,
        body.connection_name,
      );
    },
  );
}

export function declareInstances(
  registry: OperationRegistry,
  dependencies: InstanceOperationDependencies,
): void {
  declareHumanReads(registry, dependencies);
  declareHumanWrites(registry, dependencies);
  declareExchange(registry, dependencies);
}
