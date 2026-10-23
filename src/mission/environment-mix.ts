import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { bindingKind } from "./content.ts";
import { MissionBindingKind, MissionErrorCode } from "./contract.ts";
import type { Dependencies } from "./service.ts";

const MIN_MIXED_BINDINGS = 2;

export function guardEnvironmentMix(
  tx: Transaction,
  dependencies: Pick<Dependencies, "bindings" | "environments">,
  projectId: string,
  bindingIds: readonly string[],
): void {
  const repositories = bindingIds.flatMap((bindingId) => {
    const revision = dependencies.bindings.getBindingRevision(tx, bindingId);
    assert.ok(revision, "A resolved binding must have a revision.");
    return bindingKind(revision) === MissionBindingKind.Repository
      ? [{ bindingId, resourceIdentity: revision.resource_identity }]
      : [];
  });
  if (repositories.length < MIN_MIXED_BINDINGS) return;
  const mixed = dependencies.environments.environmentsMixed(
    tx,
    projectId,
    repositories.map(({ resourceIdentity }) => resourceIdentity),
  );
  if (!mixed) return;
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.EnvironmentMixed,
    "The repository bindings of the node need different environment images.",
    { bindings: repositories.map(({ bindingId }) => bindingId) },
  );
}
