import { parseIdentity } from "./identity.ts";
import type { ParsedDocument } from "./plan-document.ts";
import type { Finding } from "./plan-finding.ts";
import { comparePaths, resolveRelativePath } from "./plan-path.ts";
import type { NodeKind } from "./state.ts";

export type IdentityInput = Readonly<{
  documents: readonly ParsedDocument[];
  databaseIdentities: readonly string[];
  databasePaths: ReadonlyMap<string, string>;
}>;

export type ResolvedDocument = ParsedDocument &
  Readonly<{
    identity: string;
    minted: boolean;
    parentIdentity: string | null;
    dependencies: readonly string[];
  }>;

export type ResolveIdentitiesResult = Readonly<{
  resolved: readonly ResolvedDocument[];
  findings: readonly Finding[];
}>;

type MutableResolvedDocument = ParsedDocument & {
  identity: string;
  minted: boolean;
  parentIdentity: string | null;
  dependencies: string[];
};

export function resolveIdentities(
  dependencies: Readonly<{ mint: (kind: NodeKind) => string }>,
  input: IdentityInput,
): ResolveIdentitiesResult {
  const { documents, databaseIdentities, databasePaths } = input;
  const { mint } = dependencies;
  const findings: Finding[] = [];

  const sorted = [...documents].sort((left, right) =>
    comparePaths(left.path, right.path),
  );

  const resolved: MutableResolvedDocument[] = [];
  const resolvedByPath = new Map<string, MutableResolvedDocument>();
  const resolvedByIdentity = new Map<string, MutableResolvedDocument>();
  for (const document of sorted) {
    let identity: string;
    let minted: boolean;
    if (document.id === null) {
      identity = mint(document.kind);
      minted = true;
    } else {
      const parsed = parseIdentity(document.id);
      if (parsed === null) {
        findings.push({
          code: "identity-invalid",
          path: document.path,
          id: null,
          message: `${document.id} is not an identity`,
        });
        continue;
      }
      if (parsed.kind !== document.kind) {
        findings.push({
          code: "identity-kind-mismatch",
          path: document.path,
          id: null,
          message: `${document.id} is a ${parsed.kind} identity on a ${document.kind} document`,
        });
        continue;
      }
      if (resolvedByIdentity.has(document.id)) {
        findings.push({
          code: "identity-duplicate",
          path: document.path,
          id: null,
          message: `${document.id} is claimed by another document`,
        });
        continue;
      }
      identity = document.id;
      minted = false;
    }
    const resolvedDocument: MutableResolvedDocument = {
      ...document,
      identity,
      minted,
      parentIdentity: null,
      dependencies: [],
    };
    resolved.push(resolvedDocument);
    resolvedByPath.set(document.path, resolvedDocument);
    resolvedByIdentity.set(identity, resolvedDocument);
  }

  const payloadPrefixes = new Map<string, Set<string>>();
  for (const resolvedDocument of resolved) {
    if (resolvedDocument.minted) continue;
    const parsed = parseIdentity(resolvedDocument.identity)!;
    let prefixes = payloadPrefixes.get(parsed.ulid);
    if (prefixes === undefined) {
      prefixes = new Set();
      payloadPrefixes.set(parsed.ulid, prefixes);
    }
    prefixes.add(parsed.prefix);
  }
  const mismatched = new Set<MutableResolvedDocument>();
  for (const [payload, prefixes] of payloadPrefixes) {
    if (prefixes.size < 2) continue;
    for (const resolvedDocument of resolved) {
      if (resolvedDocument.minted) continue;
      if (parseIdentity(resolvedDocument.identity)!.ulid !== payload) continue;
      findings.push({
        code: "identity-kind-mismatch",
        path: resolvedDocument.path,
        id: null,
        message: `${resolvedDocument.identity} reuses a ULID payload of another kind`,
      });
      mismatched.add(resolvedDocument);
    }
  }
  if (mismatched.size > 0) {
    for (const removed of mismatched) {
      resolvedByPath.delete(removed.path);
      resolvedByIdentity.delete(removed.identity);
    }
    const kept = resolved.filter((document) => !mismatched.has(document));
    resolved.length = 0;
    resolved.push(...kept);
  }

  for (const resolvedDocument of resolved) {
    const directory = resolvedDocument.path.slice(
      0,
      resolvedDocument.path.lastIndexOf("/"),
    );
    const dependencies = new Set<string>();
    for (const entry of resolvedDocument.dependsOn) {
      const identityReference = parseIdentity(entry);
      if (identityReference !== null) {
        if (resolvedByIdentity.has(entry)) {
          dependencies.add(entry);
        } else if (databaseIdentities.includes(entry)) {
          dependencies.add(entry);
        } else {
          findings.push({
            code: "reference-unresolved",
            path: resolvedDocument.path,
            id: null,
            message: `${entry} names no document or database identity`,
          });
        }
        continue;
      }
      const matches = new Set<string>();
      const siblingPath = resolveRelativePath(directory, entry);
      if (siblingPath !== null) matches.add(siblingPath);
      const rootPath = resolveAgainstPlanRoot(entry);
      if (rootPath !== null) matches.add(rootPath);
      const submittedMatches = [...matches].filter((path) =>
        resolvedByPath.has(path),
      );
      if (submittedMatches.length === 0) {
        findings.push({
          code: "reference-unresolved",
          path: resolvedDocument.path,
          id: null,
          message: `${entry} resolves to no submitted path`,
        });
        continue;
      }
      if (submittedMatches.length > 1) {
        findings.push({
          code: "reference-ambiguous",
          path: resolvedDocument.path,
          id: null,
          message: `${entry} resolves to more than one submitted path: ${[...submittedMatches].sort(comparePaths).join(", ")}`,
        });
        continue;
      }
      dependencies.add(resolvedByPath.get(submittedMatches[0]!)!.identity);
    }
    resolvedDocument.dependencies = [...dependencies].sort(comparePaths);
  }

  for (const resolvedDocument of resolved) {
    const parentPath = resolvedDocument.derivedParentPath;
    if (parentPath === null) continue;
    resolvedDocument.parentIdentity =
      resolvedByPath.get(parentPath)?.identity ??
      databasePaths.get(parentPath) ??
      null;
  }

  return { resolved, findings };
}

function resolveAgainstPlanRoot(reference: string): string | null {
  if (reference.startsWith("plan/")) return reference;
  return resolveRelativePath("plan", reference);
}
