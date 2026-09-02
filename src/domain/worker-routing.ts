import type { WorkerEntry } from "./worker-registry.ts";

export type WorkerRoutingErrorCode =
  | "worker-unknown-id"
  | "worker-duplicate-id"
  | "authorized-not-capable"
  | "available-not-authorized";

export class WorkerRoutingError extends Error {
  readonly code: WorkerRoutingErrorCode;

  constructor(code: WorkerRoutingErrorCode) {
    super(code);
    this.name = "WorkerRoutingError";
    this.code = code;
  }
}

type CapabilityInput = Readonly<{
  kind: string;
  deliverable: string;
}>;

type RouteWorkerInput = Readonly<{
  registry: readonly WorkerEntry[];
  kind: string;
  deliverable: string;
  authorized: readonly string[];
  available: readonly string[];
}>;

export const routingFailedSets = [
  "capable",
  "authorized",
  "available",
] as const;

export type RoutingFailedSet = (typeof routingFailedSets)[number];

type RouteWorkerResult =
  | Readonly<{ routed: true; worker: WorkerEntry }>
  | Readonly<{
      routed: false;
      refusal: "unroutable";
      failedSet: RoutingFailedSet;
    }>;

export function capableWorkers(
  registry: readonly WorkerEntry[],
  input: CapabilityInput,
): readonly string[] {
  return registry
    .filter(
      (entry) =>
        entry.claims.includes(input.kind) &&
        entry.deliverables.includes(input.deliverable),
    )
    .map((entry) => entry.worker);
}

function hasDuplicate(ids: readonly string[]): boolean {
  return new Set(ids).size !== ids.length;
}

export function routeWorker(input: RouteWorkerInput): RouteWorkerResult {
  const registryIds = new Set(input.registry.map((entry) => entry.worker));
  for (const id of [...input.authorized, ...input.available]) {
    if (!registryIds.has(id)) {
      throw new WorkerRoutingError("worker-unknown-id");
    }
  }

  if (hasDuplicate(input.authorized) || hasDuplicate(input.available)) {
    throw new WorkerRoutingError("worker-duplicate-id");
  }

  const capable = capableWorkers(input.registry, input);
  if (input.authorized.some((id) => !capable.includes(id))) {
    throw new WorkerRoutingError("authorized-not-capable");
  }

  if (input.available.some((id) => !input.authorized.includes(id))) {
    throw new WorkerRoutingError("available-not-authorized");
  }

  if (capable.length === 0) {
    return { routed: false, refusal: "unroutable", failedSet: "capable" };
  }

  const authorizedCapable = capable.filter((id) =>
    input.authorized.includes(id),
  );
  if (authorizedCapable.length === 0) {
    return { routed: false, refusal: "unroutable", failedSet: "authorized" };
  }

  const availableAuthorized = authorizedCapable.filter((id) =>
    input.available.includes(id),
  );
  if (availableAuthorized.length === 0) {
    return { routed: false, refusal: "unroutable", failedSet: "available" };
  }

  return {
    routed: true,
    worker: input.registry.find(
      (entry) => entry.worker === availableAuthorized[0],
    )!,
  };
}
