import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";

import { WorkerHost, WorkerMethod } from "./contract.ts";
export { WorkerHost, WorkerMethod } from "./contract.ts";

export const REQUIRED_NODE_FORMAT: readonly string[] = [
  "name",
  "requirement",
  "criterion",
  "verifications",
  "bindings",
];

export interface AgentDeclaration {
  agentName: string;
  overridableFields: readonly string[];
}

export interface WorkerDeclaration {
  name: string;
  host: WorkerHost;
  method?: WorkerMethod;
  agentName?: string;
  harness?: string;
  resourceBudget: { turns?: number; wallTimeMs: number };
  declaredNodeStates: readonly string[];
  requiredNodeFormat: readonly string[];
}

const NATIVE_RESOURCE_BUDGET = { turns: 200, wallTimeMs: 7200000 };
const EXTERNAL_RESOURCE_BUDGET = { wallTimeMs: 7200000 };
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const FIRST_ITEM = 0;

export const AGENT_DECLARATIONS: Readonly<Record<string, AgentDeclaration>> = {
  "swe@1": {
    agentName: "swe@1",
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  },
  "re@1": {
    agentName: "re@1",
    overridableFields: ["agentProvider", "modelIdentifier", "reasoningEffort"],
  },
};

export const WORKER_CATALOG: Readonly<Record<string, WorkerDeclaration>> = {
  "general@1": {
    name: "general@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Steps,
    agentName: "swe@1",
    resourceBudget: NATIVE_RESOURCE_BUDGET,
    declaredNodeStates: ["Available"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
  "reviewer@1": {
    name: "reviewer@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Evaluation,
    agentName: "re@1",
    resourceBudget: NATIVE_RESOURCE_BUDGET,
    declaredNodeStates: ["Waiting", "External.Requested"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
  "claude@1": {
    name: "claude@1",
    host: WorkerHost.ExternalHarness,
    harness: "claude-code",
    resourceBudget: EXTERNAL_RESOURCE_BUDGET,
    declaredNodeStates: ["Available", "Waiting", "External.Requested"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
  "opencode@1": {
    name: "opencode@1",
    host: WorkerHost.ExternalHarness,
    harness: "opencode",
    resourceBudget: EXTERNAL_RESOURCE_BUDGET,
    declaredNodeStates: ["Available", "Waiting", "External.Requested"],
    requiredNodeFormat: REQUIRED_NODE_FORMAT,
  },
};

export function getAgentDeclaration(
  agentName: string,
): AgentDeclaration | undefined {
  if (!Object.hasOwn(AGENT_DECLARATIONS, agentName)) return undefined;
  return AGENT_DECLARATIONS[agentName];
}

export function getWorkerDeclaration(
  workerName: string,
): WorkerDeclaration | undefined {
  if (!Object.hasOwn(WORKER_CATALOG, workerName)) return undefined;
  return WORKER_CATALOG[workerName];
}

export function agentsOfWorker(workerName: string): string[] {
  const declaration = getWorkerDeclaration(workerName);
  if (declaration?.host !== WorkerHost.Kanthord || !declaration.agentName)
    return [];
  return [declaration.agentName];
}

export function listWorkerDeclarations(limit: number, cursor: string | null) {
  assert.ok(Number.isSafeInteger(limit));
  assert.ok(limit > FIRST_ITEM);
  const after = cursor === null ? null : decodeCatalogCursor(cursor);
  const names = Object.keys(WORKER_CATALOG)
    .sort()
    .filter((name) => after === null || name > after);
  const items = names.slice(FIRST_ITEM, limit).map((name) => {
    const { host, declaredNodeStates, requiredNodeFormat } =
      WORKER_CATALOG[name]!;
    return {
      name,
      host,
      declaredNodeStates: [...declaredNodeStates],
      requiredNodeFormat: [...requiredNodeFormat],
    };
  });
  const nextCursor =
    names.length > limit
      ? Buffer.from(items.at(-1)!.name, TEXT_ENCODING).toString(CURSOR_ENCODING)
      : null;
  return { items, nextCursor };
}

function decodeCatalogCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (
    !CURSOR_PATTERN.test(cursor) ||
    Buffer.from(decoded, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      "system.pagination.cursor_invalid",
      "Invalid cursor.",
    );
  assert.ok(decoded.length > FIRST_ITEM);
  assert.equal(Buffer.from(decoded).toString(CURSOR_ENCODING), cursor);
  return decoded;
}
