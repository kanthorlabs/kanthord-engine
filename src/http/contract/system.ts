import { z } from "zod";

import { blockReason, nodeKind, nodeState } from "../../domain/state.ts";
import { healthStatuses, dependencyStatuses } from "../../domain/health.ts";
import { leaseSubjectKinds } from "../../domain/lease.ts";
import { KANTHORD_VERSION } from "../../domain/version.ts";
import { baselineErrors } from "./error-baseline.ts";
import {
  EXAMPLE_AT as A,
  EXAMPLE_ULID as U,
  EXAMPLE_LANDING_OID as OID_L,
  EXAMPLE_UPSTREAM_OID as OID_U,
} from "./example-literal.ts";
import { hash, resource, system as systemSegment } from "./path.ts";
import { operations } from "./operation.ts";
import type { OperationExamples } from "./operation.ts";

export const systemHealthResponse = z.strictObject({
  status: z.enum(healthStatuses),
  dependencies: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.enum(dependencyStatuses),
    }),
  ),
});

export const systemDbResponse = z.strictObject({
  migrations: z.array(
    z.strictObject({
      version: z.number().int().positive(),
      name: z.string().min(1),
      applied: z.boolean(),
      appliedAt: z.number().int().nullable(),
    }),
  ),
});

export const systemStatusResponse = z.strictObject({
  version: z.string().min(1),
  bind: z.string().min(1),
  startedAt: z.string().min(1),
  status: z.enum(healthStatuses),
  dependencies: z.array(
    z.strictObject({
      name: z.string().min(1),
      status: z.enum(dependencyStatuses),
    }),
  ),
  nodes: z.array(
    z.strictObject({
      kind: nodeKind,
      state: nodeState,
      blockReason: blockReason.nullable(),
      count: z.number().int().positive(),
    }),
  ),
  repositories: z.array(
    z.strictObject({
      id: z.string().min(1),
      name: z.string().min(1),
      divergedLandingOid: z.string().min(1),
      divergedUpstreamOid: z.string().min(1),
    }),
  ),
  leases: z.array(
    z.strictObject({
      subjectKind: z.enum(leaseSubjectKinds),
      subjectId: z.string().min(1),
      owner: z.string().nullable(),
      fence: z.number().int(),
      expiresAt: z.number().int(),
    }),
  ),
});

export const systemHealthExamples: OperationExamples = {
  success: {
    status: "ok",
    dependencies: [{ name: "storage", status: "ok" }],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const systemDbExamples: OperationExamples = {
  success: {
    migrations: [
      { version: 1, name: "core-entities", applied: true, appliedAt: A },
    ],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const systemStatusExamples: OperationExamples = {
  success: {
    version: KANTHORD_VERSION,
    bind: "127.0.0.1:7777",
    startedAt: "2025-02-01T00:00:00.000Z",
    status: "ok",
    dependencies: [{ name: "storage", status: "ok" }],
    nodes: [{ kind: "task", state: "ready", blockReason: null, count: 1 }],
    repositories: [
      {
        id: `repo_${U}`,
        name: "atlas",
        divergedLandingOid: OID_L,
        divergedUpstreamOid: OID_U,
      },
    ],
    leases: [
      {
        subjectKind: "node",
        subjectId: `task_${U}`,
        owner: null,
        fence: 1,
        expiresAt: A,
      },
    ],
  },
  error: {
    error: {
      code: "service-unavailable",
      message: "the daemon is shutting down",
    },
  },
};

export const system = operations([
  {
    operationId: "system.health",
    method: "GET",
    path: [systemSegment("health")],
    introducedIn: "phase-1",
    status: "routed",
    response: systemHealthResponse,
    errors: { ...baselineErrors },
    examples: systemHealthExamples,
  },
  {
    operationId: "system.db",
    method: "GET",
    path: [systemSegment("db"), systemSegment("status")],
    introducedIn: "phase-1",
    status: "routed",
    response: systemDbResponse,
    errors: { ...baselineErrors },
    examples: systemDbExamples,
  },
  {
    operationId: "system.status",
    method: "GET",
    path: [systemSegment("status")],
    introducedIn: "phase-1",
    status: "routed",
    response: systemStatusResponse,
    errors: { ...baselineErrors },
    examples: systemStatusExamples,
  },
  {
    operationId: "blob.show",
    method: "GET",
    path: [resource("blob"), hash()],
    introducedIn: "phase-1",
    status: "routed",
    errors: { ...baselineErrors },
  },
]);
