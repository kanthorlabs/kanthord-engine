import type { Transaction } from "../storage/index.ts";
import type { BlobStore } from "../blob/index.ts";
import type { PlanStore } from "../plan/index.ts";
import type { CanonicalNode } from "../../domain/plan-canonical-path.ts";
import { renderDocumentSet } from "../../domain/plan-render.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import {
  RevisionError,
  type Revision,
  type RevisionRecordInput,
  type RevisionRenderInput,
} from "./index.ts";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export type NodeWriteRevisionDependencies = Readonly<{
  blobs: BlobStore;
  plan: PlanStore;
}>;

export class NodeWriteRevision implements Revision {
  readonly #blobs: BlobStore;
  readonly #plan: PlanStore;

  constructor(dependencies: NodeWriteRevisionDependencies) {
    this.#blobs = dependencies.blobs;
    this.#plan = dependencies.plan;
  }

  render(
    transaction: Transaction,
    input: RevisionRenderInput,
  ): readonly RenderedDocument[] {
    const repositoryNamesById = this.#readRepositoryNamesById(transaction);
    const bodies = new Map<
      string,
      Readonly<{
        instruction: string;
        acceptance: string | null;
        worker: string | null;
        repo: string | null;
      }>
    >();
    for (const node of input.nodes) {
      const instruction = this.#blobs.get(node.instructionBlob, transaction);
      if (instruction === null) {
        throw new Error(
          `blob ${node.instructionBlob} is missing from the store`,
        );
      }
      let acceptance: string | null = null;
      if (node.acceptanceBlob !== null) {
        const acceptanceBlob = this.#blobs.get(
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
      let repo: string | null = null;
      if (node.repositoryId !== null) {
        const name = repositoryNamesById.get(node.repositoryId);
        if (name === undefined) {
          throw new RevisionError(
            "repository-unknown",
            `repository ${node.repositoryId} is not registered`,
          );
        }
        repo = name;
      }
      bodies.set(node.id, {
        instruction: decoder.decode(instruction.content),
        acceptance,
        worker: node.worker,
        repo,
      });
    }
    const canonicalNodes: readonly CanonicalNode[] = input.nodes.map(
      (node) => ({
        identity: node.id,
        kind: node.kind,
        title: node.title,
        parentIdentity: node.parentId,
        dependencies: node.dependencies,
      }),
    );
    return renderDocumentSet(canonicalNodes, bodies);
  }

  record(transaction: Transaction, input: RevisionRecordInput): void {
    const hash = this.#blobs.put(
      transaction,
      encoder.encode(canonicalDocumentsJson(input.documents)),
    );
    this.#plan.insertRevision(transaction, {
      id: input.revisionId,
      projectId: input.projectId,
      parentId: input.parentRevision,
      origin: "node-write",
      importId: null,
      submittedBlob: null,
      choicesBlob: null,
      acceptedBlob: hash,
    });
  }

  #readRepositoryNamesById(
    transaction: Transaction,
  ): ReadonlyMap<string, string> {
    const rows = transaction.all(
      "SELECT id, name FROM repository",
    ) as readonly Readonly<{ id: string; name: string }>[];
    return new Map(rows.map((row) => [row.id, row.name]));
  }
}
