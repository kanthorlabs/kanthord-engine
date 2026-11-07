import type { OperationRegistry } from "../kernel/operation.ts";
import { machineOperations } from "./contract.ts";
import type { WorkerMachines } from "./machines.ts";

export interface MachineOperationDependencies {
  machines: WorkerMachines;
}

export function declareMachines(
  registry: OperationRegistry,
  { machines }: MachineOperationDependencies,
): void {
  registry.register(machineOperations["machine.create"], ({ body }, caller) =>
    machines.create((write) => caller.commit(write), body),
  );
  registry.register(machineOperations["machine.list"], ({ query }, caller) =>
    caller.commit((tx) => machines.list(tx, query)),
  );
  registry.register(machineOperations["machine.get"], ({ params }, caller) =>
    caller.commit((tx) => machines.get(tx, params.machine_name)),
  );
  registry.register(
    machineOperations["machine.rotate"],
    ({ params, body }, caller) =>
      machines.rotate(
        (write) => caller.commit(write),
        params.machine_name,
        body,
      ),
  );
  registry.register(
    machineOperations["machine.archive"],
    ({ params, body }, caller) =>
      caller.commit((tx) => machines.archive(tx, params.machine_name, body)),
  );
}
