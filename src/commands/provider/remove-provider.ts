import type { Storage } from "../../services/storage/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { ProviderKind } from "../../domain/provider-payload.ts";

export type RemoveProviderDependencies = Readonly<{
  storage: Storage;
  events: EventLog;
}>;

export type RemoveProviderInput = Readonly<{
  id: string;
  actor: string;
}>;

export type ProviderRemovalBlocker =
  | Readonly<{ kind: "default-chain" }>
  | Readonly<{ kind: "project-binding"; projectId: string }>
  | Readonly<{ kind: "repository"; repositoryId: string }>
  | Readonly<{ kind: "attempt"; attemptId: string }>;

export type RemoveProviderRefusal = "not-found" | "binding-in-use";

export class RemoveProviderError extends Error {
  readonly refusal: RemoveProviderRefusal;
  declare readonly blockers: readonly ProviderRemovalBlocker[] | undefined;

  constructor(
    refusal: RemoveProviderRefusal,
    message: string,
    blockers?: readonly ProviderRemovalBlocker[],
  ) {
    super(message);
    this.name = "RemoveProviderError";
    this.refusal = refusal;
    if (blockers !== undefined) {
      this.blockers = blockers;
    }
  }
}

type ProviderRow = Readonly<{
  id: string;
  name: string;
  kind: ProviderKind;
  set_default_at: number | null;
}>;

function inIdOrder(ids: readonly string[]): readonly string[] {
  return [...ids].sort((a, b) =>
    Buffer.compare(Buffer.from(a), Buffer.from(b)),
  );
}

export function removeProvider(
  dependencies: RemoveProviderDependencies,
  input: RemoveProviderInput,
): Readonly<{ id: string }> {
  dependencies.storage.transact((transaction) => {
    const selected = transaction.get(
      "SELECT id, name, kind, set_default_at FROM provider WHERE id = ?",
      [input.id],
    );
    if (selected === undefined) {
      throw new RemoveProviderError("not-found", `no provider ${input.id}`);
    }
    const target = selected as ProviderRow;
    const blockers: ProviderRemovalBlocker[] = [];
    if (target.set_default_at !== null) {
      blockers.push({ kind: "default-chain" });
    }
    const bindings = transaction.all(
      "SELECT project_id FROM project_binding WHERE kind = 'provider' AND target_id = ?",
      [input.id],
    ) as readonly { project_id: string }[];
    for (const projectId of inIdOrder(
      bindings.map((binding) => binding.project_id),
    )) {
      blockers.push({ kind: "project-binding", projectId });
    }
    const repositories = transaction.all(
      "SELECT id FROM repository WHERE credential_id = ?",
      [input.id],
    ) as readonly { id: string }[];
    for (const repositoryId of inIdOrder(
      repositories.map((repository) => repository.id),
    )) {
      blockers.push({ kind: "repository", repositoryId });
    }
    const attempts = transaction.all(
      "SELECT id FROM attempt WHERE provider_id = ?",
      [input.id],
    ) as readonly { id: string }[];
    for (const attemptId of inIdOrder(attempts.map((attempt) => attempt.id))) {
      blockers.push({ kind: "attempt", attemptId });
    }
    if (blockers.length > 0) {
      throw new RemoveProviderError(
        "binding-in-use",
        `provider ${input.id} is still in use`,
        blockers,
      );
    }
    transaction.run("DELETE FROM provider WHERE id = ?", [input.id]);
    dependencies.events.append(transaction, {
      subjectKind: "provider",
      subjectId: input.id,
      type: "provider.removed",
      actorKind: "human",
      actorId: input.actor,
      payload: { name: target.name, kind: target.kind },
    });
  });
  return { id: input.id };
}
