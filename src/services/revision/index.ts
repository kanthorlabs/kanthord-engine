import type { Transaction } from "../storage/index.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";

export type RevisionRenderInput = Readonly<{
  nodes: readonly StoredNode[];
}>;

export type RevisionRecordInput = Readonly<{
  projectId: string;
  revisionId: string;
  parentRevision: string | null;
  documents: readonly RenderedDocument[];
}>;

export type RevisionRefusal = "repository-unknown";

export class RevisionError extends Error {
  readonly refusal: RevisionRefusal;
  constructor(refusal: RevisionRefusal, message: string) {
    super(message);
    this.name = "RevisionError";
    this.refusal = refusal;
  }
}

export interface Revision {
  render(
    transaction: Transaction,
    input: RevisionRenderInput,
  ): readonly RenderedDocument[];
  record(transaction: Transaction, input: RevisionRecordInput): void;
}
