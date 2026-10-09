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

export interface WorkerDeclaration {
  name: string;
  host: WorkerHost;
  method?: WorkerMethod;
  agent_names?: readonly string[];
  harness?: string;
  resource_budget: { turns?: number; wall_time_ms: number };
  declared_node_states: readonly string[];
  required_node_format: readonly string[];
}

const NATIVE_RESOURCE_BUDGET = { turns: 200, wall_time_ms: 7200000 };
const EXTERNAL_RESOURCE_BUDGET = { wall_time_ms: 7200000 };
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const FIRST_ITEM = 0;

export const WORKER_CATALOG: Readonly<Record<string, WorkerDeclaration>> = {
  "general@1": {
    name: "general@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Steps,
    agent_names: ["swe@1"],
    resource_budget: NATIVE_RESOURCE_BUDGET,
    declared_node_states: ["Available"],
    required_node_format: REQUIRED_NODE_FORMAT,
  },
  "reviewer@1": {
    name: "reviewer@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.Evaluation,
    agent_names: ["re@1"],
    resource_budget: NATIVE_RESOURCE_BUDGET,
    declared_node_states: ["Waiting", "External.Requested"],
    required_node_format: REQUIRED_NODE_FORMAT,
  },
  "developer@1": {
    name: "developer@1",
    host: WorkerHost.Kanthord,
    method: WorkerMethod.ReviewedSteps,
    agent_names: ["swe@1", "re@1"],
    resource_budget: NATIVE_RESOURCE_BUDGET,
    declared_node_states: ["Available"],
    required_node_format: REQUIRED_NODE_FORMAT,
  },
  "claude@1": {
    name: "claude@1",
    host: WorkerHost.ExternalHarness,
    harness: "claude-code",
    resource_budget: EXTERNAL_RESOURCE_BUDGET,
    declared_node_states: ["Available", "Waiting", "External.Requested"],
    required_node_format: REQUIRED_NODE_FORMAT,
  },
  "opencode@1": {
    name: "opencode@1",
    host: WorkerHost.ExternalHarness,
    harness: "opencode",
    resource_budget: EXTERNAL_RESOURCE_BUDGET,
    declared_node_states: ["Available", "Waiting", "External.Requested"],
    required_node_format: REQUIRED_NODE_FORMAT,
  },
};

export const RELEASED_WORKER_NAMES: readonly string[] = ["developer@1"];

export function getWorkerDeclaration(
  workerName: string,
): WorkerDeclaration | undefined {
  if (!Object.hasOwn(WORKER_CATALOG, workerName)) return undefined;
  return WORKER_CATALOG[workerName];
}

export function agentsOfWorker(workerName: string): string[] {
  const declaration = getWorkerDeclaration(workerName);
  if (declaration?.host !== WorkerHost.Kanthord || !declaration.agent_names)
    return [];
  return [...declaration.agent_names];
}

export function listWorkerDeclarations(limit: number, cursor: string | null) {
  assert.ok(Number.isSafeInteger(limit));
  assert.ok(limit > FIRST_ITEM);
  const after = cursor === null ? null : decodeCatalogCursor(cursor);
  const names = [...RELEASED_WORKER_NAMES]
    .sort()
    .filter((name) => after === null || name > after);
  const items = names.slice(FIRST_ITEM, limit).map((name) => {
    const { host, declared_node_states, required_node_format } =
      WORKER_CATALOG[name]!;
    return {
      name,
      host,
      declared_node_states: [...declared_node_states],
      required_node_format: [...required_node_format],
    };
  });
  const nextCursor =
    names.length > limit
      ? Buffer.from(items.at(-1)!.name, TEXT_ENCODING).toString(CURSOR_ENCODING)
      : null;
  return { items, next_cursor: nextCursor };
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
