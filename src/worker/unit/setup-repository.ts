import assert from "node:assert/strict";
import type { ExecutionSetup } from "../contract.ts";

export interface SetupHolder {
  input: { setup: Pick<ExecutionSetup, "repositories"> };
}

export interface BindingRef {
  binding_id: string;
}

export function repositoryOf(
  state: SetupHolder,
  checkout: BindingRef,
): ExecutionSetup["repositories"][number] {
  const repository = state.input.setup.repositories.find(
    (row) => row.binding_id === checkout.binding_id,
  );
  assert.ok(repository);
  return repository;
}

export function mergedBranchesOf(
  state: SetupHolder,
  checkout: BindingRef,
): string[] {
  const { base_branch, upstream_branch } = repositoryOf(
    state,
    checkout,
  ).strategy;
  return upstream_branch === undefined
    ? [base_branch]
    : [base_branch, upstream_branch];
}
