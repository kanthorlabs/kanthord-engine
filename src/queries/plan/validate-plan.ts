import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { DocumentReader } from "../../services/document/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import { repairSuggestions } from "../../domain/plan-candidate.ts";
import type {
  Choice,
  ChoiceLegality,
  ChoiceVerdict,
  DifferingField,
  Presence,
} from "../../domain/plan-choice.ts";
import { choiceVerdict } from "../../domain/plan-choice.ts";
import { containmentMovable } from "../../domain/plan-containment.ts";
import { canonicalPaths } from "../../domain/plan-canonical-path.ts";
import type { Deliverable } from "../../domain/deliverable.ts";
import type { StoredNode } from "../../domain/plan-graph.ts";
import {
  differingFields,
  storedValues,
  submittedValues,
} from "../../domain/plan-diff.ts";
import type { ChoiceValues } from "../../domain/plan-diff.ts";
import type { Finding } from "../../domain/plan-finding.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import { comparePaths } from "../../domain/plan-path.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";
import { renderDocumentSet } from "../../domain/plan-render.ts";
import type { NodeKind, NodeState } from "../../domain/state.ts";
import { validateDocuments } from "../../domain/plan-validate.ts";
import type { VerifyBlock } from "../../domain/verify-block.ts";

export type ValidatePlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  reader: DocumentReader;
  graph: Graph;
  ids: IdGenerator;
}>;

export type ValidatePlanInput = Readonly<{
  projectId: string;
  fromRevision: string | null;
  documents: readonly Readonly<{ path: string; content: string }>[];
}>;

export type ChoiceBranch = ChoiceLegality & Readonly<{ values: ChoiceValues }>;

export type ChoiceEntry = Readonly<{
  id: string;
  kind: NodeKind;
  presence: Presence;
  state: NodeState | null;
  suggested: Choice;
  fields: readonly DifferingField[];
  path: string | null;
  submitted: ChoiceBranch;
  database: ChoiceBranch;
}>;

export type ValidatePlanResult = Readonly<{
  findings: readonly Finding[];
  documents: readonly RenderedDocument[];
  documentsHash: string;
  revision: string | null;
  choices: readonly ChoiceEntry[];
}>;

export type ValidatePlanRefusal = "project-not-found" | "repository-unknown";

export class ValidatePlanError extends Error {
  readonly refusal: ValidatePlanRefusal;

  constructor(refusal: ValidatePlanRefusal, message: string) {
    super(message);
    this.name = "ValidatePlanError";
    this.refusal = refusal;
  }
}

const encoder = new TextEncoder();

function readRepositoryNamesById(
  transaction: Transaction,
): ReadonlyMap<string, string> {
  const rows = transaction.all(
    "SELECT id, name FROM repository",
  ) as readonly Readonly<{ id: string; name: string }>[];
  return new Map(rows.map((row) => [row.id, row.name]));
}

const storedPaths = (
  nodes: readonly StoredNode[],
): ReadonlyMap<string, string> => {
  const byIdentity = canonicalPaths(
    nodes.map((node) => ({
      identity: node.id,
      kind: node.kind,
      title: node.title,
      parentIdentity: node.parentId,
      dependencies: node.dependencies,
    })),
  );
  return new Map(
    [...byIdentity.entries()].map(([identity, path]) => [path, identity]),
  );
};

export function validatePlan(
  dependencies: ValidatePlanDependencies,
  input: ValidatePlanInput,
): ValidatePlanResult {
  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ValidatePlanError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }
    const context = dependencies.plan.readValidationContext(
      transaction,
      input.projectId,
    );
    const revision = dependencies.plan.newestRevision(
      transaction,
      input.projectId,
    );
    const { nodes: storedNodes } = dependencies.plan.readGraph(
      transaction,
      input.projectId,
    );
    const repositoryNamesById = readRepositoryNamesById(transaction);
    const nodes = storedNodes.map((node) => {
      if (node.repositoryId === null) {
        return node;
      }
      const name = repositoryNamesById.get(node.repositoryId);
      if (name === undefined) {
        throw new ValidatePlanError(
          "repository-unknown",
          `repository ${node.repositoryId} is not registered`,
        );
      }
      return { ...node, repositoryId: name };
    });
    const databaseIdentities = nodes.map((node) => node.id);

    const validation = validateDocuments(
      {
        readFrontmatter: (text) => dependencies.reader.read(text),
        findCycles: (graphInput) => dependencies.graph.cycles(graphInput),
        mint: (kind) => dependencies.ids.mint(kind),
      },
      {
        submitted: input.documents,
        context,
        databaseIdentities,
        databasePaths: storedPaths(nodes),
      },
    );
    const resolved = [...validation.documents];
    const resolvedByIdentity = new Map(
      resolved.map((document) => [document.identity, document]),
    );
    const storedByIdentity = new Map(nodes.map((node) => [node.id, node]));
    const canonicalNodes = resolved.map((document) => ({
      identity: document.identity,
      kind: document.kind,
      title: document.title,
      parentIdentity: document.parentIdentity,
      dependencies: document.dependencies.filter(
        (dependency) => dependency !== document.identity,
      ),
    }));
    const submittedPaths = canonicalPaths(canonicalNodes);

    const identities = new Set<string>([
      ...resolved.map((document) => document.identity),
      ...databaseIdentities,
    ]);
    const sortedIdentities = [...identities].sort(comparePaths);

    const choices: ChoiceEntry[] = [];
    const verdicts = new Map<string, ChoiceVerdict>();
    const blobHashes = new Map<
      string,
      Readonly<{ instruction: string; acceptance: string | null }>
    >();
    for (const identity of sortedIdentities) {
      const document = resolvedByIdentity.get(identity);
      const node = storedByIdentity.get(identity);
      const presence: Presence =
        document !== undefined && node !== undefined
          ? "both"
          : document !== undefined
            ? "document-only"
            : "database-only";
      const state: NodeState | null =
        presence === "document-only" ? null : node!.state;
      let fields: readonly DifferingField[] = [];
      let movable = true;
      if (document !== undefined) {
        const instruction = dependencies.blobs.hash(
          encoder.encode(document.instruction),
        );
        const acceptance =
          document.acceptance === null
            ? null
            : dependencies.blobs.hash(encoder.encode(document.acceptance));
        blobHashes.set(identity, { instruction, acceptance });
        if (presence === "both") {
          fields = differingFields(node!, document, {
            instruction,
            acceptance,
          });
          if (fields.includes("parent") || fields.includes("repo")) {
            const facts =
              node!.kind === "task"
                ? dependencies.plan.readContainmentFacts(transaction, identity)
                : dependencies.plan.readSubtreeContainmentFacts(
                    transaction,
                    identity,
                  );
            movable = containmentMovable(node!.kind, facts);
          }
        }
      }
      const verdict = choiceVerdict({
        presence,
        state,
        fields,
        containmentMovable: movable,
      });
      verdicts.set(identity, verdict);
      const selected = presence === "both" ? fields : null;
      const submittedBranchValues =
        document === undefined
          ? {}
          : submittedValues(document, blobHashes.get(identity)!, selected);
      const databaseBranchValues =
        node === undefined ? {} : storedValues(node, selected);
      choices.push({
        id: identity,
        kind: document?.kind ?? node!.kind,
        presence,
        state,
        suggested: verdict.suggested,
        fields,
        path: submittedPaths.get(identity) ?? null,
        submitted: { ...verdict.submitted, values: submittedBranchValues },
        database: { ...verdict.database, values: databaseBranchValues },
      });
    }

    const repaired = repairSuggestions(
      {
        findCycles: (graphInput) => dependencies.graph.cycles(graphInput),
        findComponents: (graphInput) =>
          dependencies.graph.components(graphInput),
      },
      {
        submitted: resolved,
        stored: nodes,
        verdicts,
        blobHashes,
        context,
      },
    );
    const repairedChoices = choices.map((entry) => ({
      ...entry,
      suggested: repaired.get(entry.id) ?? entry.suggested,
    }));

    const bodies = new Map<
      string,
      Readonly<{
        instruction: string;
        acceptance: string | null;
        worker: string | null;
        repo: string | null;
        deliverable: Deliverable | null;
        verify: VerifyBlock | null;
      }>
    >();
    for (const document of resolved) {
      bodies.set(document.identity, {
        instruction: document.instruction,
        acceptance: document.acceptance,
        worker: document.worker,
        repo: document.repo,
        deliverable: document.deliverable,
        verify: document.verify,
      });
    }
    const documents = renderDocumentSet(canonicalNodes, bodies);
    const documentsHash = dependencies.blobs.hash(
      encoder.encode(canonicalDocumentsJson(documents)),
    );

    return {
      findings: validation.findings,
      documents,
      documentsHash,
      revision,
      choices: repairedChoices,
    };
  });
}
