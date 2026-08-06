import { BodySplitError, normalizeBody, splitBody } from "./plan-body.ts";
import { planFrontmatter } from "./plan-document.ts";
import type { ParsedDocument } from "./plan-document.ts";
import type { Finding } from "./plan-finding.ts";
import { sortFindings } from "./plan-finding.ts";
import type { ValidationContext } from "./plan-graph.ts";
import { resolveIdentities } from "./plan-identity.ts";
import type { ResolvedDocument } from "./plan-identity.ts";
import {
  comparePaths,
  derivedParentPath,
  parseSubmittedPath,
  SubmittedPathError,
} from "./plan-path.ts";
import type { NodeKind } from "./state.ts";

export type FrontmatterReader = (
  text: string,
) => Readonly<{ frontmatter: unknown; body: string }>;

export type CycleFinder = (
  input: Readonly<{
    nodes: readonly Readonly<{ id: string; parentId: string | null }>[];
    edges: readonly Readonly<{ from: string; to: string }>[];
  }>,
) => readonly (readonly string[])[];

export type ValidationResult = Readonly<{
  documents: readonly ResolvedDocument[];
  findings: readonly Finding[];
}>;

export function validateDocuments(
  dependencies: Readonly<{
    readFrontmatter: FrontmatterReader;
    findCycles: CycleFinder;
    mint: (kind: NodeKind) => string;
  }>,
  input: Readonly<{
    submitted: readonly Readonly<{ path: string; content: string }>[];
    context: ValidationContext;
    databaseIdentities: readonly string[];
    databasePaths: ReadonlyMap<string, string>;
  }>,
): ValidationResult {
  const { readFrontmatter, findCycles, mint } = dependencies;
  const { submitted, context, databaseIdentities, databasePaths } = input;

  const findings: Finding[] = [];

  const occurrenceCounts = new Map<string, number>();
  for (const entry of submitted) {
    occurrenceCounts.set(
      entry.path,
      (occurrenceCounts.get(entry.path) ?? 0) + 1,
    );
  }
  const parsedPaths = new Map<string, { kind: NodeKind }>();
  const excluded = new Set<string>();
  const duplicateReports = new Map<string, number>();
  for (const entry of submitted) {
    const total = occurrenceCounts.get(entry.path)!;
    if (total > 1) {
      const reported = (duplicateReports.get(entry.path) ?? 0) + 1;
      duplicateReports.set(entry.path, reported);
      if (reported > 1) {
        findings.push({
          code: "path-duplicate",
          path: entry.path,
          id: null,
          message: "the path appears more than once",
        });
      }
      excluded.add(entry.path);
      continue;
    }
    try {
      parsedPaths.set(entry.path, parseSubmittedPath(entry.path));
    } catch (error) {
      if (error instanceof SubmittedPathError) {
        findings.push({
          code: "path-invalid",
          path: entry.path,
          id: null,
          message: `${error.code}: ${error.message}`,
        });
      } else {
        throw error;
      }
      excluded.add(entry.path);
    }
  }

  const documents: ParsedDocument[] = [];
  for (const entry of submitted) {
    if (excluded.has(entry.path)) continue;
    const pathShape = parsedPaths.get(entry.path)!;

    let readResult: Readonly<{ frontmatter: unknown; body: string }>;
    try {
      readResult = readFrontmatter(entry.content);
    } catch (error) {
      if (error instanceof Error && isDocumentError(error)) {
        findings.push({
          code: "document-unparsable",
          path: entry.path,
          id: null,
          message: `${error.code}: ${error.message}`,
        });
      } else {
        throw error;
      }
      excluded.add(entry.path);
      continue;
    }

    const schemaResult = planFrontmatter.safeParse(readResult.frontmatter);
    if (!schemaResult.success) {
      for (const issue of schemaResult.error.issues) {
        const issuePath = issue.path.join(".");
        findings.push({
          code: "frontmatter-invalid",
          path: entry.path,
          id: null,
          message:
            issuePath.length > 0
              ? `${issuePath}: ${issue.message}`
              : issue.message,
        });
      }
      excluded.add(entry.path);
      continue;
    }
    const frontmatter = schemaResult.data;

    let bodySplit: Readonly<{ instruction: string; acceptance: string | null }>;
    try {
      bodySplit = splitBody(normalizeBody(readResult.body));
    } catch (error) {
      if (error instanceof BodySplitError) {
        findings.push({
          code: error.code,
          path: entry.path,
          id: null,
          message: error.message,
        });
      } else {
        throw error;
      }
      excluded.add(entry.path);
      continue;
    }

    documents.push({
      path: entry.path,
      kind: pathShape.kind,
      id: frontmatter.id ?? null,
      title: frontmatter.title,
      dependsOn: frontmatter.depends_on ?? [],
      worker: frontmatter.worker ?? null,
      repo: frontmatter.repo ?? null,
      derivedParentPath: derivedParentPath(entry.path),
      instruction: bodySplit.instruction,
      acceptance: bodySplit.acceptance,
    });
  }
  documents.sort((left, right) => comparePaths(left.path, right.path));

  const kindChecked: ParsedDocument[] = [];
  for (const document of documents) {
    const pathShape = parsedPaths.get(document.path)!;
    if (document.kind !== pathShape.kind) {
      findings.push({
        code: "frontmatter-invalid",
        path: document.path,
        id: null,
        message: "kind: the frontmatter kind does not match the path kind",
      });
      continue;
    }
    if (document.kind !== "task" && document.acceptance !== null) {
      findings.push({
        code: "acceptance-unexpected",
        path: document.path,
        id: null,
        message: "an objective or initiative carries an acceptance section",
      });
    }
    if (document.kind === "task" && document.acceptance === null) {
      findings.push({
        code: "acceptance-missing",
        path: document.path,
        id: null,
        message: "a task carries no acceptance criteria section",
      });
    }
    if (document.kind === "task" && document.repo !== null) {
      findings.push({
        code: "repo-on-task",
        path: document.path,
        id: null,
        message: "a task carries a repository",
      });
    }
    if (document.kind === "objective" && document.repo === null) {
      findings.push({
        code: "repo-missing",
        path: document.path,
        id: null,
        message: "an objective carries no repository",
      });
    }
    kindChecked.push(document);
  }

  const identityResult = resolveIdentities(
    { mint },
    { documents: kindChecked, databaseIdentities, databasePaths },
  );
  findings.push(...identityResult.findings);
  const resolved = [...identityResult.resolved];
  const resolvedByPath = new Map(resolved.map((r) => [r.path, r]));
  const resolvedByIdentity = new Map(resolved.map((r) => [r.identity, r]));

  const submittedPaths = new Set(parsedPaths.keys());
  for (const resolvedDocument of resolved) {
    const parentPath = resolvedDocument.derivedParentPath;
    if (
      parentPath !== null &&
      !submittedPaths.has(parentPath) &&
      !databasePaths.has(parentPath)
    ) {
      findings.push({
        code: "parent-missing",
        path: resolvedDocument.path,
        id: null,
        message: `${parentPath} is neither submitted nor stored`,
      });
    }
  }
  for (const resolvedDocument of resolved) {
    if (resolvedDocument.kind === "initiative") {
      const hasObjective = kindChecked.some(
        (candidate) => candidate.derivedParentPath === resolvedDocument.path,
      );
      if (!hasObjective) {
        findings.push({
          code: "initiative-without-objective",
          path: resolvedDocument.path,
          id: null,
          message: "the initiative holds no objective document",
        });
      }
    }
    if (resolvedDocument.kind === "objective") {
      const hasTask = kindChecked.some(
        (candidate) => candidate.derivedParentPath === resolvedDocument.path,
      );
      if (!hasTask) {
        findings.push({
          code: "objective-without-task",
          path: resolvedDocument.path,
          id: null,
          message: "the objective holds no task document",
        });
      }
    }
  }

  for (const resolvedDocument of resolved) {
    for (const dependency of resolvedDocument.dependencies) {
      if (dependency === resolvedDocument.identity) {
        findings.push({
          code: "dependency-self",
          path: resolvedDocument.path,
          id: null,
          message: "a document depends on itself",
        });
        continue;
      }
      const target = resolvedByIdentity.get(dependency);
      if (target !== undefined) {
        if (resolvedDocument.derivedParentPath !== target.derivedParentPath) {
          findings.push({
            code: "dependency-cross-parent",
            path: resolvedDocument.path,
            id: null,
            message: "the dependency lives under a different parent",
          });
        }
      }
    }
  }

  for (const resolvedDocument of resolved) {
    if (
      resolvedDocument.worker !== null &&
      !context.workerKinds.includes(resolvedDocument.worker)
    ) {
      findings.push({
        code: "worker-unknown",
        path: resolvedDocument.path,
        id: null,
        message: `${resolvedDocument.worker} is not a known worker kind`,
      });
    }
    if (
      resolvedDocument.kind === "objective" &&
      resolvedDocument.repo !== null
    ) {
      if (!context.knownRepositories.includes(resolvedDocument.repo)) {
        findings.push({
          code: "repository-unknown",
          path: resolvedDocument.path,
          id: null,
          message: `${resolvedDocument.repo} is not a known repository`,
        });
      } else if (!context.boundRepositories.includes(resolvedDocument.repo)) {
        findings.push({
          code: "repository-unbound",
          path: resolvedDocument.path,
          id: null,
          message: `${resolvedDocument.repo} is not bound to the project`,
        });
      }
    }
  }

  const cycleNodes = resolved.map((resolvedDocument) => ({
    id: resolvedDocument.identity,
    parentId:
      resolvedDocument.parentIdentity !== null &&
      resolvedByIdentity.has(resolvedDocument.parentIdentity)
        ? resolvedDocument.parentIdentity
        : null,
  }));
  const cycleEdges: Readonly<{ from: string; to: string }>[] = [];
  for (const resolvedDocument of resolved) {
    for (const dependency of resolvedDocument.dependencies) {
      if (
        dependency !== resolvedDocument.identity &&
        resolvedByIdentity.has(dependency)
      ) {
        cycleEdges.push({ from: resolvedDocument.identity, to: dependency });
      }
    }
  }
  for (const component of findCycles({
    nodes: cycleNodes,
    edges: cycleEdges,
  })) {
    findings.push({
      code: "dependency-cycle",
      path: null,
      id: component[0] ?? null,
      message: component.join(" -> "),
    });
  }

  return {
    documents: resolved,
    findings: sortFindings(findings),
  };
}

function isDocumentError(
  error: Error,
): error is Error & Readonly<{ code: string }> {
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" && code.startsWith("document-");
}
