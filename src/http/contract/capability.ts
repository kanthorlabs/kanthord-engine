import { z } from "zod";

import type { Operation } from "./operation.ts";

export const capabilityOperations = {
  "external-drive": [
    "node.claim",
    "node.heartbeat",
    "node.release",
    "node.report",
  ],
  "per-node-write": ["node.create", "node.update", "node.delete"],
  "project-graph": ["project.nodes", "project.graph"],
} as const satisfies Readonly<Record<string, readonly string[]>>;

export type CapabilityName = keyof typeof capabilityOperations;

export const capabilityName = z.enum(
  Object.keys(capabilityOperations) as [CapabilityName, ...CapabilityName[]],
);

export function declaredCapabilities(
  operations: readonly Operation[],
): readonly CapabilityName[] {
  const statuses = new Map(
    operations.map(
      (operation) => [operation.operationId, operation.status] as const,
    ),
  );

  return (Object.keys(capabilityOperations) as CapabilityName[])
    .filter((name) =>
      capabilityOperations[name].every(
        (operationId) => statuses.get(operationId) === "routed",
      ),
    )
    .sort((a, b) =>
      Buffer.compare(Buffer.from(a, "utf8"), Buffer.from(b, "utf8")),
    );
}
