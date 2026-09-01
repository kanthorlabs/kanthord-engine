import { parseIdentity } from "./identity.ts";
import { completenessFindings } from "./plan-completeness.ts";
import type { Deliverable } from "./deliverable.ts";
import { nodePairLegality } from "./node-pair.ts";
import type { Choice, ChoiceVerdict } from "./plan-choice.ts";
import type { Finding } from "./plan-finding.ts";
import { findingScope, sortFindings } from "./plan-finding.ts";
import type { StoredNode, ValidationContext } from "./plan-graph.ts";
import type { ResolvedDocument } from "./plan-identity.ts";
import { comparePaths } from "./plan-path.ts";
import type { CycleFinder } from "./plan-validate.ts";
import type { NodeKind } from "./state.ts";
import { decodeVerifyBlock } from "./verify-block.ts";

export type CandidateNode = Readonly<{
  id: string;
  kind: NodeKind;
  parentId: string | null;
  title: string;
  instructionBlob: string;
  acceptanceBlob: string | null;
  worker: string | null;
  repositoryId: string | null;
  deliverable: string | null;
  verifyJson: string | null;
  dependencies: readonly string[];
  source: "submitted" | "database";
}>;

export type Candidate = Readonly<{
  nodes: readonly CandidateNode[];
}>;

export function buildCandidate(
  input: Readonly<{
    submitted: readonly ResolvedDocument[];
    stored: readonly StoredNode[];
    choices: readonly Readonly<{ id: string; take: Choice }>[];
    blobHashes: ReadonlyMap<
      string,
      Readonly<{ instruction: string; acceptance: string | null }>
    >;
  }>,
): Candidate {
  const { submitted, stored, choices, blobHashes } = input;
  const submittedByIdentity = new Map(
    submitted.map((document) => [document.identity, document]),
  );
  const storedByIdentity = new Map(stored.map((node) => [node.id, node]));

  const nodes: CandidateNode[] = [];
  for (const choice of choices) {
    const document = submittedByIdentity.get(choice.id);
    const node = storedByIdentity.get(choice.id);
    if (choice.take === "submitted" && document !== undefined) {
      const blobs = blobHashes.get(choice.id);
      if (blobs === undefined) {
        throw new Error(`no blob hashes for the submitted node ${choice.id}`);
      }
      nodes.push({
        id: choice.id,
        kind: document.kind,
        parentId: document.parentIdentity,
        title: document.title,
        instructionBlob: blobs.instruction,
        acceptanceBlob: blobs.acceptance,
        worker: document.worker,
        repositoryId: document.repo,
        deliverable: document.deliverable,
        verifyJson:
          document.verify === null ? null : JSON.stringify(document.verify),
        dependencies: [...document.dependencies],
        source: "submitted",
      });
    } else if (choice.take === "database" && node !== undefined) {
      nodes.push({
        id: node.id,
        kind: node.kind,
        parentId: node.parentId,
        title: node.title,
        instructionBlob: node.instructionBlob,
        acceptanceBlob: node.acceptanceBlob,
        worker: node.worker,
        repositoryId: node.repositoryId,
        deliverable: node.deliverable,
        verifyJson: node.verifyJson,
        dependencies: [...node.dependencies],
        source: "database",
      });
    }
  }
  nodes.sort((left, right) => comparePaths(left.id, right.id));
  return { nodes };
}

export function validateCandidate(
  dependencies: Readonly<{ findCycles: CycleFinder }>,
  input: Readonly<{ candidate: Candidate; context: ValidationContext }>,
): readonly Finding[] {
  const { candidate, context } = input;
  const findings: Finding[] = [];
  const byId = new Map(candidate.nodes.map((node) => [node.id, node]));

  for (const node of candidate.nodes) {
    if (node.kind === "initiative" && node.parentId !== null) {
      findings.push({
        code: "parent-missing",
        path: null,
        id: node.id,
        message: "an initiative holds a parent",
      });
    }
    if (
      (node.kind === "objective" || node.kind === "task") &&
      node.parentId === null
    ) {
      findings.push({
        code: "parent-missing",
        path: null,
        id: node.id,
        message: "an objective or task holds no parent",
      });
    }
    if (node.parentId !== null && !byId.has(node.parentId)) {
      findings.push({
        code: "parent-missing",
        path: null,
        id: node.id,
        message: `the parent ${node.parentId} is absent from the candidate`,
      });
    }
    const parent = node.parentId === null ? undefined : byId.get(node.parentId);
    if (parent !== undefined) {
      const required = node.kind === "objective" ? "initiative" : "objective";
      if (node.kind !== "initiative" && parent.kind !== required) {
        findings.push({
          code: "parent-missing",
          path: null,
          id: node.id,
          message: `the parent ${node.parentId} is not an ${required}`,
        });
      }
    }
  }

  findings.push(
    ...completenessFindings({
      subject: "record",
      parents: candidate.nodes.map((node) => ({
        kind: node.kind,
        key: node.id,
        path: null,
        id: node.id,
      })),
      children: candidate.nodes.map((node) => ({
        kind: node.kind,
        parentKey: node.parentId,
      })),
    }),
  );

  for (const node of candidate.nodes) {
    if (node.worker !== null && !context.workerKinds.includes(node.worker)) {
      findings.push({
        code: "worker-unknown",
        path: null,
        id: node.id,
        message: `${node.worker} is not a known worker kind`,
      });
    }
    if (node.kind === "task" && node.repositoryId !== null) {
      findings.push({
        code: "repo-on-task",
        path: null,
        id: node.id,
        message: "a task carries a repository",
      });
    }
    if (node.kind === "objective" && node.repositoryId === null) {
      findings.push({
        code: "repo-missing",
        path: null,
        id: node.id,
        message: "an objective carries no repository",
      });
    }
    if (node.kind === "objective" && node.repositoryId !== null) {
      if (!context.knownRepositories.includes(node.repositoryId)) {
        findings.push({
          code: "repository-unknown",
          path: null,
          id: node.id,
          message: `${node.repositoryId} is not a known repository`,
        });
      } else if (!context.boundRepositories.includes(node.repositoryId)) {
        findings.push({
          code: "repository-unbound",
          path: null,
          id: node.id,
          message: `${node.repositoryId} is not bound to the project`,
        });
      }
    }
    if (node.deliverable !== null) {
      if (!nodePairLegality(node.kind, node.deliverable as Deliverable).legal) {
        findings.push({
          code: "pair-illegal",
          path: null,
          id: node.id,
          message:
            "pair-illegal: kind and deliverable combination is not legal",
        });
      }
      if (node.verifyJson === null) {
        findings.push({
          code: "verify-invalid",
          path: null,
          id: node.id,
          message: "a node with a deliverable has no verify block",
        });
        continue;
      }
      if (!decodeVerifyBlock(node.verifyJson).ok) {
        findings.push({
          code: "verify-invalid",
          path: null,
          id: node.id,
          message: "the stored verify block is invalid",
        });
      }
    }
  }

  for (const node of candidate.nodes) {
    for (const dependency of node.dependencies) {
      if (dependency === node.id) {
        findings.push({
          code: "dependency-self",
          path: null,
          id: node.id,
          message: "a node depends on itself",
        });
        continue;
      }
      const target = byId.get(dependency);
      if (target === undefined) {
        findings.push({
          code: "reference-unresolved",
          path: null,
          id: node.id,
          message: `${dependency} names no node of the candidate`,
        });
        continue;
      }
      if (target.parentId !== node.parentId) {
        findings.push({
          code: "dependency-cross-parent",
          path: null,
          id: node.id,
          message: "the dependency lives under a different parent",
        });
      }
    }
  }

  const payloadPrefixes = new Map<string, Set<string>>();
  for (const node of candidate.nodes) {
    const parsed = parseIdentity(node.id);
    if (parsed === null) continue;
    let prefixes = payloadPrefixes.get(parsed.ulid);
    if (prefixes === undefined) {
      prefixes = new Set();
      payloadPrefixes.set(parsed.ulid, prefixes);
    }
    prefixes.add(parsed.prefix);
  }
  for (const [payload, prefixes] of payloadPrefixes) {
    if (prefixes.size < 2) continue;
    for (const node of candidate.nodes) {
      const parsed = parseIdentity(node.id);
      if (parsed === null || parsed.ulid !== payload) continue;
      findings.push({
        code: "identity-kind-mismatch",
        path: null,
        id: null,
        message: `${node.id} reuses a ULID payload of another kind`,
      });
    }
  }

  const graph = candidateGraph(candidate);
  for (const component of dependencies.findCycles(graph)) {
    findings.push({
      code: "dependency-cycle",
      path: null,
      id: component[0] ?? null,
      message: component.join(" -> "),
    });
  }

  return sortFindings(findings);
}

export function validateCandidateStructural(
  dependencies: Readonly<{ findCycles: CycleFinder }>,
  input: Readonly<{ candidate: Candidate; context: ValidationContext }>,
): readonly Finding[] {
  return validateCandidate(dependencies, input).filter(
    (finding) => findingScope[finding.code] === "structural",
  );
}

export function validateCandidateCompleteness(
  dependencies: Readonly<{ findCycles: CycleFinder }>,
  input: Readonly<{ candidate: Candidate; context: ValidationContext }>,
): readonly Finding[] {
  return validateCandidate(dependencies, input).filter(
    (finding) => findingScope[finding.code] === "completeness",
  );
}

export type ComponentFinder = (
  input: Readonly<{
    nodes: readonly Readonly<{ id: string; parentId: string | null }>[];
    edges: readonly Readonly<{ from: string; to: string }>[];
  }>,
) => readonly (readonly string[])[];

export function repairSuggestions(
  dependencies: Readonly<{
    findCycles: CycleFinder;
    findComponents: ComponentFinder;
  }>,
  input: Readonly<{
    submitted: readonly ResolvedDocument[];
    stored: readonly StoredNode[];
    verdicts: ReadonlyMap<string, ChoiceVerdict>;
    blobHashes: ReadonlyMap<
      string,
      Readonly<{ instruction: string; acceptance: string | null }>
    >;
    context: ValidationContext;
  }>,
): ReadonlyMap<string, Choice> {
  const { submitted, stored, verdicts, blobHashes, context } = input;
  const choices = new Map<string, Choice>();
  for (const [id, verdict] of verdicts) {
    choices.set(id, verdict.suggested);
  }
  const cap = verdicts.size;

  for (let resets = 0; ;) {
    const candidate = buildCandidate({
      submitted,
      stored,
      choices: [...choices.entries()].map(([id, take]) => ({ id, take })),
      blobHashes,
    });
    const findings = validateCandidateStructural(
      { findCycles: dependencies.findCycles },
      { candidate, context },
    );
    if (findings.length === 0) return choices;
    if (resets >= cap) {
      throw new Error("repairSuggestions exceeded its iteration cap");
    }
    resets += 1;

    if (findings.some((finding) => finding.id === null)) {
      for (const id of choices.keys()) {
        choices.set(id, "database");
      }
      continue;
    }
    const named = new Set(
      findings
        .map((finding) => finding.id)
        .filter((id): id is string => id !== null),
    );
    for (const component of dependencies.findComponents(
      candidateGraph(candidate),
    )) {
      if (!component.some((id) => named.has(id))) continue;
      for (const id of component) {
        choices.set(id, "database");
      }
    }
  }
}

function candidateGraph(candidate: Candidate): Readonly<{
  nodes: readonly Readonly<{ id: string; parentId: string | null }>[];
  edges: readonly Readonly<{ from: string; to: string }>[];
}> {
  const ids = new Set(candidate.nodes.map((node) => node.id));
  const nodes = candidate.nodes.map((node) => ({
    id: node.id,
    parentId:
      node.parentId !== null && ids.has(node.parentId) ? node.parentId : null,
  }));
  const edges: Readonly<{ from: string; to: string }>[] = [];
  for (const node of candidate.nodes) {
    for (const dependency of node.dependencies) {
      if (dependency !== node.id && ids.has(dependency)) {
        edges.push({ from: node.id, to: dependency });
      }
    }
  }
  return { nodes, edges };
}
