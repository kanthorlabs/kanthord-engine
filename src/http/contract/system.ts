import { z } from "zod";

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
  },
  {
    operationId: "blob.show",
    method: "GET",
    path: [resource("blob"), hash()],
    introducedIn: "phase-1",
    status: "routed",
  },
]);
