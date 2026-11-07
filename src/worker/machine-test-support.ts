import type { Transaction } from "../kernel/store.ts";
import { insertMachine } from "./machine-rows.ts";

export function insertMachineFor(
  tx: Transaction,
  instanceName: string,
  now: number,
): string {
  const name = `${instanceName}-machine`;
  insertMachine(
    tx,
    {
      name,
      public_key: `${name}-key`,
      fingerprint: `${name}-fingerprint`,
    },
    now,
  );
  return name;
}
