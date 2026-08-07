import { z } from "zod";

import { blockReason, nodeKind, nodeState } from "../../domain/state.ts";
import { hash, resource, system as systemSegment } from "./path.ts";
import { operations } from "./operation.ts";

export const dependencyStatuses = ["ok", "failed", "not-implemented"] as const;

export const systemHealthResponse = z.strictObject({
  status: z.enum(["ok", "degraded"]),
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
  status: z.enum(["ok", "degraded"]),
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
      subjectKind: z.enum(["node", "repository"]),
      subjectId: z.string().min(1),
      owner: z.string().nullable(),
      fence: z.number().int(),
      expiresAt: z.number().int(),
    }),
  ),
});

export const system = operations([
  {
    operationId: "system.health",
    method: "GET",
    path: [systemSegment("health")],
    introducedIn: "phase-1",
    status: "routed",
    response: systemHealthResponse,
  },
  {
    operationId: "system.db",
    method: "GET",
    path: [systemSegment("db"), systemSegment("status")],
    introducedIn: "phase-1",
    status: "routed",
    response: systemDbResponse,
  },
  {
    operationId: "system.status",
    method: "GET",
    path: [systemSegment("status")],
    introducedIn: "phase-1",
    status: "routed",
    response: systemStatusResponse,
  },
  {
    operationId: "blob.show",
    method: "GET",
    path: [resource("blob"), hash()],
    introducedIn: "phase-1",
    status: "routed",
  },
]);
