import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { DocumentReader } from "../../services/document/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { EventLog } from "../../services/event/index.ts";
import type { Choice, DifferingField } from "../../domain/plan-choice.ts";
import { choiceVerdict } from "../../domain/plan-choice.ts";
import {
  assertChoiceSet,
  ChoiceSetError,
} from "../../domain/plan-choice-set.ts";
import { containmentMovable } from "../../domain/plan-containment.ts";
import { differingFields } from "../../domain/plan-diff.ts";
import type { StoredEdge, StoredNode } from "../../domain/plan-graph.ts";
import {
  canonicalChoicesJson,
  canonicalDocumentsJson,
} from "../../domain/plan-hash.ts";
import { comparePaths } from "../../domain/plan-path.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";
import { renderDocumentSet } from "../../domain/plan-render.ts";
import { canonicalPaths } from "../../domain/plan-canonical-path.ts";
import {
  buildCandidate,
  validateCandidate,
} from "../../domain/plan-candidate.ts";
import type { Candidate } from "../../domain/plan-candidate.ts";
import type { ResolvedDocument } from "../../domain/plan-identity.ts";
import { validateDocuments } from "../../domain/plan-validate.ts";
import type { NodeState } from "../../domain/state.ts";

export type ImportPlanDependencies = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  reader: DocumentReader;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
}>;

export type ImportPlanInput = Readonly<{
  projectId: string;
  fromRevision: string | null;
  importId: string;
  documents: readonly Readonly<{ path: string; content: string }>[];
  choices: readonly Readonly<{ id: string; take: Choice }>[];
  validatedRevision: string | null;
  documentsHash: string;
  actor: string;
}>;

export type ImportPlanResult = Readonly<{
  revision: string;
  documents: readonly RenderedDocument[];
  absent: readonly string[];
  retried: boolean;
}>;

export type ImportPlanRefusal =
  | "project-not-found"
  | "plan-invalid"
  | "choices-invalid"
  | "choices-stale"
  | "choices-changed"
  | "stale-revision"
  | "idempotency-mismatch"
  | "documents-hash-mismatch"
  | "choice-duplicate"
  | "choice-missing"
  | "choice-extra"
  | "repository-unknown";

export class ImportPlanError extends Error {
  readonly refusal: ImportPlanRefusal;
  readonly details: unknown;

  constructor(refusal: ImportPlanRefusal, message: string, details?: unknown) {
    super(message);
    this.name = "ImportPlanError";
    this.refusal = refusal;
    this.details = details;
  }
}

const encoder = new TextEncoder();

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

const decoder = new TextDecoder();

function readRepositoryNamesById(
  transaction: Transaction,
): ReadonlyMap<string, string> {
  const rows = transaction.all(
    "SELECT id, name FROM repository",
  ) as readonly Readonly<{ id: string; name: string }>[];
  return new Map(rows.map((row) => [row.id, row.name]));
}

function readRepositoryIdsByName(
  transaction: Transaction,
): ReadonlyMap<string, string> {
  const rows = transaction.all(
    "SELECT id, name FROM repository",
  ) as readonly Readonly<{ id: string; name: string }>[];
  return new Map(rows.map((row) => [row.name, row.id]));
}

export function importPlan(
  dependencies: ImportPlanDependencies,
  input: ImportPlanInput,
): ImportPlanResult {
  assertNoDuplicateChoices(input.choices);

  return dependencies.storage.transact((transaction) => {
    const project = transaction.get("SELECT id FROM project WHERE id = ?", [
      input.projectId,
    ]);
    if (project === undefined) {
      throw new ImportPlanError(
        "project-not-found",
        `no project ${input.projectId}`,
      );
    }

    const existing = dependencies.plan.findByImportId(
      transaction,
      input.projectId,
      input.importId,
    );
    if (existing !== null) {
      return retryResult(dependencies, transaction, existing, input);
    }

    const newest = dependencies.plan.newestRevision(
      transaction,
      input.projectId,
    );
    if (input.fromRevision !== newest) {
      throw new ImportPlanError(
        "stale-revision",
        `the import names ${String(input.fromRevision)}, the newest revision is ${String(newest)}`,
        { expected: input.fromRevision, current: newest },
      );
    }
    if (input.validatedRevision !== newest) {
      const storedIds = dependencies.plan
        .readGraph(transaction, input.projectId)
        .nodes.map((node) => node.id);
      throw new ImportPlanError(
        "choices-stale",
        `the choices were validated against ${String(input.validatedRevision)}, the newest revision is ${String(newest)}`,
        { conflicts: staleConflicts(input.choices, storedIds) },
      );
    }

    const context = dependencies.plan.readValidationContext(
      transaction,
      input.projectId,
    );
    const { nodes: storedNodes, edges } = dependencies.plan.readGraph(
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
        throw new ImportPlanError(
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
    if (validation.findings.length > 0) {
      throw new ImportPlanError(
        "plan-invalid",
        "the submission is not a valid plan",
        { findings: validation.findings },
      );
    }

    const resolved = [...validation.documents];
    const resolvedByIdentity = new Map(
      resolved.map((document) => [document.identity, document]),
    );
    const storedByIdentity = new Map(nodes.map((node) => [node.id, node]));

    const rendered = renderResolved(resolved);
    if (
      dependencies.blobs.hash(
        encoder.encode(canonicalDocumentsJson(rendered)),
      ) !== input.documentsHash
    ) {
      throw new ImportPlanError(
        "documents-hash-mismatch",
        "the documents hash does not match the validated submission",
        { refusal: "documents-hash-mismatch" },
      );
    }

    const identities = new Set<string>([
      ...resolved.map((document) => document.identity),
      ...databaseIdentities,
    ]);
    const sortedIdentities = [...identities].sort(comparePaths);

    let takes: ReadonlyMap<string, Choice>;
    try {
      takes = assertChoiceSet({
        choices: input.choices,
        required: sortedIdentities,
      });
    } catch (error) {
      if (error instanceof ChoiceSetError) {
        throw new ImportPlanError(error.code, error.message, {
          ids: error.ids,
        });
      }
      throw error;
    }

    const blobHashes = new Map<
      string,
      Readonly<{ instruction: string; acceptance: string | null }>
    >();
    const illegalSelections: Readonly<{ id: string; reason: string }>[] = [];
    for (const identity of sortedIdentities) {
      const document = resolvedByIdentity.get(identity);
      const node = storedByIdentity.get(identity);
      const presence: "both" | "document-only" | "database-only" =
        document !== undefined && node !== undefined
          ? "both"
          : document !== undefined
            ? "document-only"
            : "database-only";
      const state: NodeState | null =
        presence === "document-only" ? null : node!.state;
      let fields: readonly DifferingField[] = [];
      let movable = true;
      const selected = takes.get(identity);
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
      if (selected === "submitted") {
        const legality = choiceVerdict({
          presence,
          state,
          fields,
          containmentMovable: movable,
        }).submitted;
        if (!legality.legal) {
          illegalSelections.push({ id: identity, reason: legality.reason! });
        }
      }
    }
    if (illegalSelections.length > 0) {
      throw new ImportPlanError(
        "choices-changed",
        "a selected outcome is no longer legal",
        { conflicts: illegalSelections },
      );
    }

    const candidate = buildCandidate({
      submitted: resolved,
      stored: nodes,
      choices: [...takes.entries()].map(([id, take]) => ({ id, take })),
      blobHashes,
    });
    const candidateFindings = validateCandidate(
      { findCycles: (graphInput) => dependencies.graph.cycles(graphInput) },
      { candidate, context },
    );
    if (candidateFindings.length > 0) {
      throw new ImportPlanError(
        "choices-invalid",
        "the chosen set builds an invalid graph",
        { findings: candidateFindings },
      );
    }

    const absent = nodes
      .map((node) => node.id)
      .filter((id) => !resolvedByIdentity.has(id));
    const accepted = renderCandidate(
      candidate,
      resolvedByIdentity,
      dependencies,
      transaction,
    );

    const revision = dependencies.ids.mint("planRevision");
    const updatedAt = dependencies.clock.now();

    const canonical = canonicalPaths(
      candidate.nodes.map((node) => ({
        identity: node.id,
        kind: node.kind,
        title: node.title,
        parentIdentity: node.parentId,
        dependencies: node.dependencies,
      })),
    );
    const submittedNodes = candidate.nodes
      .filter((node) => node.source === "submitted")
      .sort((left, right) =>
        comparePaths(canonical.get(left.id)!, canonical.get(right.id)!),
      );
    for (const node of submittedNodes) {
      const document = resolvedByIdentity.get(node.id)!;
      dependencies.blobs.put(transaction, encoder.encode(document.instruction));
      if (document.acceptance !== null) {
        dependencies.blobs.put(
          transaction,
          encoder.encode(document.acceptance),
        );
      }
    }
    const submittedBlob = dependencies.blobs.put(
      transaction,
      encoder.encode(canonicalDocumentsJson(input.documents)),
    );
    const choicesBlob = dependencies.blobs.put(
      transaction,
      encoder.encode(canonicalChoicesJson(input.choices)),
    );
    const acceptedBlob = dependencies.blobs.put(
      transaction,
      encoder.encode(canonicalDocumentsJson(accepted)),
    );

    dependencies.plan.insertRevision(transaction, {
      id: revision,
      projectId: input.projectId,
      parentId: input.fromRevision,
      importId: input.importId,
      submittedBlob,
      choicesBlob,
      acceptedBlob,
    });

    const repositoryIdsByName = readRepositoryIdsByName(transaction);
    for (const node of candidate.nodes) {
      let repositoryId: string | null = null;
      if (node.repositoryId !== null) {
        const id = repositoryIdsByName.get(node.repositoryId);
        if (id === undefined) {
          throw new ImportPlanError(
            "repository-unknown",
            `repository ${node.repositoryId} is not registered`,
          );
        }
        repositoryId = id;
      }
      dependencies.plan.upsertNode(transaction, {
        id: node.id,
        projectId: input.projectId,
        kind: node.kind,
        parentId: node.parentId,
        title: node.title,
        instructionBlob: node.instructionBlob,
        acceptanceBlob: node.acceptanceBlob,
        worker: node.worker,
        repositoryId,
        revision,
        updatedAt,
      });
    }

    const storedPairs = new Map<string, StoredEdge>();
    for (const edge of edges) {
      storedPairs.set(pairKey(edge.fromNode, edge.toNode), edge);
    }
    const candidatePairs = new Map<
      string,
      Readonly<{ fromNode: string; toNode: string }>
    >();
    for (const node of candidate.nodes) {
      for (const dependency of node.dependencies) {
        if (dependency === node.id) continue;
        candidatePairs.set(pairKey(node.id, dependency), {
          fromNode: node.id,
          toNode: dependency,
        });
      }
    }
    for (const [key, edge] of storedPairs) {
      if (!candidatePairs.has(key)) {
        dependencies.plan.deleteEdge(transaction, edge.id);
      }
    }
    const toInsert = [...candidatePairs.values()].filter(
      (pair) => !storedPairs.has(pairKey(pair.fromNode, pair.toNode)),
    );
    toInsert.sort((left, right) => {
      const byFrom = comparePaths(left.fromNode, right.fromNode);
      if (byFrom !== 0) return byFrom;
      return comparePaths(left.toNode, right.toNode);
    });
    for (const pair of toInsert) {
      dependencies.plan.insertEdge(transaction, {
        id: dependencies.ids.mint("edge"),
        fromNode: pair.fromNode,
        toNode: pair.toNode,
      });
    }

    for (const node of candidate.nodes) {
      dependencies.events.append(transaction, {
        subjectKind: "node",
        subjectId: node.id,
        type: "node.imported",
        actorKind: "human",
        actorId: input.actor,
        payload: { revision, source: node.source },
      });
    }
    dependencies.events.append(transaction, {
      subjectKind: "project",
      subjectId: input.projectId,
      type: "plan.imported",
      actorKind: "human",
      actorId: input.actor,
      payload: {
        revision,
        importId: input.importId,
        nodes: candidate.nodes.length,
        absent,
      },
    });

    return { revision, documents: accepted, absent, retried: false };
  });
}

function assertNoDuplicateChoices(
  choices: readonly Readonly<{ id: string; take: Choice }>[],
): void {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const entry of choices) {
    if (seen.has(entry.id)) {
      duplicates.add(entry.id);
    } else {
      seen.add(entry.id);
    }
  }
  if (duplicates.size > 0) {
    throw new ImportPlanError(
      "choice-duplicate",
      `duplicate choices for ${[...duplicates].join(", ")}`,
      { ids: [...duplicates].sort(comparePaths) },
    );
  }
}

function staleConflicts(
  choices: readonly Readonly<{ id: string; take: Choice }>[],
  storedIds: readonly string[],
): readonly Readonly<{ id: string; suggested: Choice }>[] {
  const submitted = new Set(choices.map((entry) => entry.id));
  const stored = new Set(storedIds);
  const union = new Set<string>([...submitted, ...stored]);
  return [...union].sort(comparePaths).map((id) => ({
    id,
    suggested: submitted.has(id) && !stored.has(id) ? "submitted" : "database",
  }));
}

function retryResult(
  dependencies: ImportPlanDependencies,
  transaction: Transaction,
  existing: Readonly<{
    id: string;
    parentId: string | null;
    submittedBlob: string;
    choicesBlob: string;
    acceptedBlob: string;
  }>,
  input: ImportPlanInput,
): ImportPlanResult {
  const submitted = dependencies.blobs.hash(
    encoder.encode(canonicalDocumentsJson(input.documents)),
  );
  const choices = dependencies.blobs.hash(
    encoder.encode(canonicalChoicesJson(input.choices)),
  );
  if (submitted !== existing.submittedBlob) {
    throw idempotencyMismatch("documents");
  }
  if (choices !== existing.choicesBlob) {
    throw idempotencyMismatch("choices");
  }
  if (input.fromRevision !== existing.parentId) {
    throw idempotencyMismatch("fromRevision");
  }
  if (input.validatedRevision !== existing.parentId) {
    throw idempotencyMismatch("validatedRevision");
  }
  const accepted = dependencies.blobs.get(existing.acceptedBlob, transaction);
  if (accepted === null) {
    throw new Error(`blob ${existing.acceptedBlob} is missing from the store`);
  }
  return {
    revision: existing.id,
    documents: JSON.parse(
      decoder.decode(accepted.content),
    ) as RenderedDocument[],
    absent: [],
    retried: true,
  };
}

function idempotencyMismatch(differed: string): ImportPlanError {
  return new ImportPlanError(
    "idempotency-mismatch",
    `the ${differed} differ from the committed import`,
    { differed },
  );
}

function renderResolved(
  resolved: readonly ResolvedDocument[],
): readonly RenderedDocument[] {
  const bodies = new Map(
    resolved.map((document) => [
      document.identity,
      {
        instruction: document.instruction,
        acceptance: document.acceptance,
        worker: document.worker,
        repo: document.repo,
      },
    ]),
  );
  return renderDocumentSet(
    resolved.map((document) => ({
      identity: document.identity,
      kind: document.kind,
      title: document.title,
      parentIdentity: document.parentIdentity,
      dependencies: document.dependencies.filter(
        (dependency) => dependency !== document.identity,
      ),
    })),
    bodies,
  );
}

function renderCandidate(
  candidate: Candidate,
  resolvedByIdentity: ReadonlyMap<string, ResolvedDocument>,
  dependencies: ImportPlanDependencies,
  transaction: Transaction,
): readonly RenderedDocument[] {
  const bodies = new Map<
    string,
    Readonly<{
      instruction: string;
      acceptance: string | null;
      worker: string | null;
      repo: string | null;
    }>
  >();
  for (const node of candidate.nodes) {
    if (node.source === "submitted") {
      const document = resolvedByIdentity.get(node.id);
      if (document === undefined) {
        throw new Error(`no submitted document is known for ${node.id}`);
      }
      bodies.set(node.id, {
        instruction: document.instruction,
        acceptance: document.acceptance,
        worker: document.worker,
        repo: document.repo,
      });
      continue;
    }
    const instruction = dependencies.blobs.get(
      node.instructionBlob,
      transaction,
    );
    if (instruction === null) {
      throw new Error(`blob ${node.instructionBlob} is missing from the store`);
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
  return renderDocumentSet(
    candidate.nodes.map((node) => ({
      identity: node.id,
      kind: node.kind,
      title: node.title,
      parentIdentity: node.parentId,
      dependencies: node.dependencies,
    })),
    bodies,
  );
}

function pairKey(fromNode: string, toNode: string): string {
  return `${fromNode}\u0000${toNode}`;
}
