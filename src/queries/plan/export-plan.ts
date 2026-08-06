import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { CanonicalNode } from "../../domain/plan-canonical-path.ts";
import { renderDocumentSet } from "../../domain/plan-render.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";

export type ExportPlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
}>;

export type ExportPlanResult = Readonly<{
  revision: string | null;
  documents: readonly RenderedDocument[];
}>;

export type ExportPlanRefusal = "project-not-found";

export class ExportPlanError extends Error {
  readonly refusal: ExportPlanRefusal;

  constructor(refusal: ExportPlanRefusal, message: string) {
    super(message);
    this.name = "ExportPlanError";
    this.refusal = refusal;
  }
}

const decoder = new TextDecoder();

export function exportPlan(
  dependencies: ExportPlanDependencies,
  input: Readonly<{ projectId: string }>,
): ExportPlanResult {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ExportPlanError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    const revision = dependencies.plan.newestRevision(
      transaction,
      input.projectId,
    );
    if (revision === null) {
      return { revision: null, documents: [] };
    }
    const { nodes } = dependencies.plan.readGraph(transaction, input.projectId);
    const bodies = new Map<
      string,
      Readonly<{
        instruction: string;
        acceptance: string | null;
        worker: string | null;
        repo: string | null;
      }>
    >();
    for (const node of nodes) {
      const instruction = dependencies.blobs.get(
        node.instructionBlob,
        transaction,
      );
      if (instruction === null) {
        throw new Error(
          `blob ${node.instructionBlob} is missing from the store`,
        );
      }
      let acceptance: string | null = null;
      if (node.acceptanceBlob !== null) {
        const acceptanceBlob = dependencies.blobs.get(
          node.acceptanceBlob,
          transaction,
        );
        if (acceptanceBlob === null) {
          throw new Error(
            `blob ${node.acceptanceBlob} is missing from the store`,
          );
        }
        acceptance = decoder.decode(acceptanceBlob.content);
      }
      bodies.set(node.id, {
        instruction: decoder.decode(instruction.content),
        acceptance,
        worker: node.worker,
        repo: node.repositoryId,
      });
    }
    const canonicalNodes: readonly CanonicalNode[] = nodes.map((node) => ({
      identity: node.id,
      kind: node.kind,
      title: node.title,
      parentIdentity: node.parentId,
      dependencies: node.dependencies,
    }));
    return {
      revision,
      documents: renderDocumentSet(canonicalNodes, bodies),
    };
  });
}
