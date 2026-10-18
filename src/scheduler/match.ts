import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import type {
  ClaimFacts,
  Claimant,
  ClaimNodeState,
  UnmatchedClaim,
} from "./contract.ts";
import type { Dependencies } from "./service.ts";

export function admits(claimant: Claimant, facts: ClaimFacts): boolean {
  return (
    claimant.declared_intents.includes(facts.intent) &&
    facts.tags.every((tag) => claimant.tags.includes(tag))
  );
}

export function covered(
  claimants: readonly Claimant[],
  facts: ClaimFacts,
  state: ClaimNodeState,
): boolean {
  return claimants.some(
    (claimant) =>
      claimant.declared_node_states.includes(state) && admits(claimant, facts),
  );
}

function claimantsOf(
  tx: Transaction,
  dependencies: Pick<Dependencies, "bindings" | "declarations">,
  projectId: string,
): Claimant[] {
  return dependencies.bindings
    .workerBindingsOf(tx, projectId)
    .flatMap((binding) => {
      const declaration = dependencies.declarations.declarationOf(
        binding.worker_name,
      );
      if (declaration === null) return [];
      return [
        {
          declared_node_states: declaration.declared_node_states,
          declared_intents: declaration.declared_intents,
          tags: binding.tags,
        },
      ];
    });
}

export function unmatchedClaims(
  tx: Transaction,
  dependencies: Pick<Dependencies, "bindings" | "declarations" | "facts">,
  projectId: string,
): UnmatchedClaim[] {
  assert.ok(tx.database.isTransaction);
  const claimants = claimantsOf(tx, dependencies, projectId);
  const unmatched: UnmatchedClaim[] = [];
  for (const row of dependencies.facts.claimFactsOf(tx, projectId))
    for (const claim of row.claims)
      if (!covered(claimants, row, claim))
        unmatched.push({
          node_id: row.node_id,
          revision: row.revision,
          claim,
        });
  return unmatched;
}
