import assert from "node:assert/strict";
import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import type { GuardClass } from "../agent/contract.ts";
import type { Operation } from "../kernel/operation.ts";
import { guardClassOf } from "./guard.ts";

export interface PlanMutation {
  operation_id: string;
  guard_class: GuardClass;
}

export function planMutations(
  operations: readonly Operation[],
): PlanMutation[] {
  const byId = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  return AGENT_DECLARATIONS["ops@1"].tools.operation.flatMap((id) => {
    const operation = byId.get(id);
    assert.ok(operation, id);
    return operation.mutation
      ? [{ operation_id: id, guard_class: guardClassOf(operation) }]
      : [];
  });
}
