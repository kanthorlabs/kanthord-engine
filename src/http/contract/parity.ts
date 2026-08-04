import type { Operation } from "./operation.ts";
import { renderPath } from "./path.ts";

export type ParityRow = Readonly<{
  operationId: string;
  method: string;
  path: string;
  introducedIn: string;
  status: string;
}>;

export type ParityReport = Readonly<{
  missingFromRegistry: readonly string[];
  missingFromProposal: readonly string[];
  mismatched: readonly string[];
}>;

export function registryRows(
  entries: readonly Operation[],
): readonly ParityRow[] {
  return entries.map((entry) => ({
    operationId: entry.operationId,
    method: entry.method,
    path: renderPath(entry.path),
    introducedIn: entry.introducedIn,
    status: entry.status,
  }));
}

export function compareRouteSets(
  registry: readonly ParityRow[],
  proposal: readonly ParityRow[],
): ParityReport {
  const registryById = new Map(registry.map((row) => [row.operationId, row]));
  const proposalById = new Map(proposal.map((row) => [row.operationId, row]));

  const missingFromRegistry = proposal
    .filter((row) => !registryById.has(row.operationId))
    .map((row) => row.operationId)
    .sort(bytewise);

  const missingFromProposal = registry
    .filter((row) => !proposalById.has(row.operationId))
    .map((row) => row.operationId)
    .sort(bytewise);

  const mismatched: string[] = [];
  for (const [operationId, registryRow] of registryById) {
    const proposalRow = proposalById.get(operationId);
    if (proposalRow === undefined) continue;
    const fields: ReadonlyArray<{
      field: string;
      registry: string;
      proposal: string;
    }> = [
      {
        field: "method",
        registry: registryRow.method,
        proposal: proposalRow.method,
      },
      { field: "path", registry: registryRow.path, proposal: proposalRow.path },
      {
        field: "introducedIn",
        registry: registryRow.introducedIn,
        proposal: proposalRow.introducedIn,
      },
      {
        field: "status",
        registry: registryRow.status,
        proposal: proposalRow.status,
      },
    ];
    for (const { field, registry: a, proposal: b } of fields) {
      if (a !== b) {
        mismatched.push(
          `${operationId} ${field}: registry ${a}, proposal ${b}`,
        );
      }
    }
  }
  mismatched.sort(bytewise);

  return { missingFromRegistry, missingFromProposal, mismatched };
}

function bytewise(a: string, b: string): number {
  return Buffer.compare(Buffer.from(a), Buffer.from(b));
}
