import { actor } from "./actor.ts";
import { credential } from "./credential.ts";
import { event } from "./event.ts";
import { execution } from "./execution.ts";
import { graph } from "./graph.ts";
import { instruction } from "./instruction.ts";
import { integration } from "./integration.ts";
import { idempotencyOf, methods } from "./operation.ts";
import type { Operation } from "./operation.ts";
import { outcome } from "./outcome.ts";
import { project } from "./project.ts";
import { renderPath } from "./path.ts";
import {
  resourceSegments,
  subresourceSegments,
  actionSegments,
  systemLeafSegments,
  systemNamespaceSegments,
  systemSegments,
} from "./path.ts";
import type { Segment } from "./path.ts";
import { repository } from "./repository.ts";
import { system } from "./system.ts";

export const registry: readonly Operation[] = [
  ...actor,
  ...system,
  ...credential,
  ...repository,
  ...project,
  ...graph,
  ...outcome,
  ...execution,
  ...instruction,
  ...integration,
  ...event,
].sort((a, b) =>
  Buffer.compare(Buffer.from(a.operationId), Buffer.from(b.operationId)),
);

export function findOperation(operationId: string): Operation | undefined {
  return registry.find((entry) => entry.operationId === operationId);
}

export type RouteMatch = Readonly<{
  operation: Operation;
  parameters: Readonly<Record<string, string>>;
}>;

export function matchRoute(
  method: string,
  pathname: string,
): RouteMatch | null {
  if (!(methods as readonly string[]).includes(method)) {
    return null;
  }

  const parts = pathname.split("/");
  if (parts[0] === "") parts.shift();
  if (parts[parts.length - 1] === "") parts.pop();
  if (parts[0] !== "v1") return null;
  const concrete = parts.slice(1);

  const candidates: Array<{
    operation: Operation;
    parameters: Record<string, string>;
  }> = [];
  for (const entry of registry) {
    if (entry.method !== method || entry.path.length !== concrete.length) {
      continue;
    }
    const parameters: Record<string, string> = {};
    let matches = true;
    for (let i = 0; i < entry.path.length; i += 1) {
      const segment = entry.path[i];
      const value = concrete[i];
      if (segment === undefined || value === undefined) {
        matches = false;
        break;
      }
      if (segment.kind === "parameter") {
        if (value === "") {
          matches = false;
          break;
        }
        parameters[segment.value] = value;
      } else if (segment.value !== value) {
        matches = false;
        break;
      }
    }
    if (matches) {
      candidates.push({ operation: entry, parameters });
    }
  }

  if (candidates.length === 0) {
    return null;
  }

  candidates.sort((a, b) => {
    const aParameters = a.operation.path.filter(
      (segment) => segment.kind === "parameter",
    ).length;
    const bParameters = b.operation.path.filter(
      (segment) => segment.kind === "parameter",
    ).length;
    return aParameters - bParameters;
  });

  const best = candidates[0];
  if (best === undefined) {
    return null;
  }
  return { operation: best.operation, parameters: best.parameters };
}

export type RegistryFault = Readonly<{ operationId: string; reason: string }>;

export function registryFaults(
  entries: readonly Operation[],
): readonly RegistryFault[] {
  const faults: RegistryFault[] = [];

  const seenIds = new Set<string>();
  for (const entry of entries) {
    if (seenIds.has(entry.operationId)) {
      faults.push({
        operationId: entry.operationId,
        reason: "duplicate operationId",
      });
    }
    seenIds.add(entry.operationId);
  }

  const seenPaths = new Map<string, string>();
  for (const entry of entries) {
    const key = `${entry.method} ${renderPath(entry.path)}`;
    if (seenPaths.has(key)) {
      faults.push({
        operationId: entry.operationId,
        reason: "method and path collide",
      });
    } else {
      seenPaths.set(key, entry.operationId);
    }
  }

  for (let i = 0; i < entries.length; i += 1) {
    for (let j = i + 1; j < entries.length; j += 1) {
      const a = entries[i];
      const b = entries[j];
      if (a === undefined || b === undefined) continue;
      if (a.method !== b.method || a.path.length !== b.path.length) continue;
      let ambiguous = true;
      for (let k = 0; k < a.path.length; k += 1) {
        const sa = a.path[k];
        const sb = b.path[k];
        if (sa === undefined || sb === undefined) {
          ambiguous = false;
          break;
        }
        const same = sa.kind === sb.kind && sa.value === sb.value;
        const eitherParameter =
          sa.kind === "parameter" || sb.kind === "parameter";
        if (!same && !eitherParameter) {
          ambiguous = false;
          break;
        }
      }
      if (ambiguous) {
        faults.push({
          operationId: a.operationId,
          reason: "path is ambiguous",
        });
      }
    }
  }

  for (const entry of entries) {
    for (const segment of entry.path) {
      if (!segmentIsValid(segment)) {
        faults.push({
          operationId: entry.operationId,
          reason: "segment is invalid in its declared kind",
        });
      }
      if (
        (segment.kind === "resource" || segment.kind === "subresource") &&
        segment.value.endsWith("s") &&
        !segment.value.endsWith("us")
      ) {
        faults.push({
          operationId: entry.operationId,
          reason: "resource segment is plural",
        });
      }
    }

    const carriesHash = entry.path.some(
      (segment) => segment.kind === "parameter" && segment.value === "hash",
    );
    const first = entry.path[0];
    if (
      carriesHash &&
      (first === undefined ||
        first.kind !== "resource" ||
        first.value !== "blob")
    ) {
      faults.push({
        operationId: entry.operationId,
        reason: "non-minted locator outside blob",
      });
    }

    const carriesDeferred = entry.path.some(
      (segment) =>
        segment.kind === "parameter" &&
        segment.value === "id" &&
        segment.identity === "deferred",
    );
    if (carriesDeferred && entry.operationId !== "template.show") {
      faults.push({
        operationId: entry.operationId,
        reason: "deferred identity outside template.show",
      });
    }

    if (!isLegalPath(entry.path)) {
      faults.push({
        operationId: entry.operationId,
        reason: "segment sequence is not a legal path",
      });
    }

    if (entry.status === "stubbed" && entry.query !== undefined) {
      faults.push({
        operationId: entry.operationId,
        reason: "query-on-stubbed",
      });
    }

    if (entry.response !== undefined && entry.responseMedia !== undefined) {
      faults.push({
        operationId: entry.operationId,
        reason: "response and responseMedia both declared",
      });
    }
  }

  for (const entry of entries) {
    if (entry.method !== "POST" && idempotencyOf(entry) !== "none") {
      faults.push({
        operationId: entry.operationId,
        reason: "idempotency policy outside POST",
      });
    }
    if (
      idempotencyOf(entry) === "durable" &&
      entry.operationId !== "plan.import"
    ) {
      faults.push({
        operationId: entry.operationId,
        reason: "durable idempotency outside plan.import",
      });
    }
    if (entry.replayable !== undefined && idempotencyOf(entry) !== "memory") {
      faults.push({
        operationId: entry.operationId,
        reason: "replayable outcome without a memory policy",
      });
    }
    if (
      idempotencyOf(entry) === "memory" &&
      (entry.replayable === undefined || entry.replayable.length === 0)
    ) {
      faults.push({
        operationId: entry.operationId,
        reason: "memory idempotency without a replayable outcome",
      });
    }
    if (entry.replayable !== undefined) {
      const distinct = new Set(entry.replayable);
      const legal = entry.replayable.every(
        (status) => Number.isInteger(status) && status >= 100 && status <= 599,
      );
      if (!legal || distinct.size !== entry.replayable.length) {
        faults.push({
          operationId: entry.operationId,
          reason: "replayable outcome is not a distinct status list",
        });
      }
    }
  }

  return faults;
}

function segmentIsValid(segment: Segment): boolean {
  switch (segment.kind) {
    case "resource":
      return (resourceSegments as readonly string[]).includes(segment.value);
    case "subresource":
      return (subresourceSegments as readonly string[]).includes(segment.value);
    case "action":
      return (actionSegments as readonly string[]).includes(segment.value);
    case "system":
      return (systemSegments as readonly string[]).includes(segment.value);
    case "parameter":
      return true;
  }
}

function isLegalPath(segments: readonly Segment[]): boolean {
  const first = segments[0];
  if (first === undefined) return false;

  if (first.kind === "system") {
    if (segments.length === 1) {
      return (systemLeafSegments as readonly string[]).includes(first.value);
    }
    if (segments.length === 2) {
      const second = segments[1];
      return (
        second !== undefined &&
        second.kind === "system" &&
        (systemNamespaceSegments as readonly string[]).includes(first.value) &&
        (systemLeafSegments as readonly string[]).includes(second.value)
      );
    }
    return false;
  }

  if (first.kind !== "resource") {
    return false;
  }

  let previous: Segment["kind"] = first.kind;
  for (let i = 1; i < segments.length; i += 1) {
    const current = segments[i];
    if (current === undefined) return false;
    const kind = current.kind;
    if (previous === "resource") {
      if (kind !== "parameter" && kind !== "subresource" && kind !== "action") {
        return false;
      }
    } else if (previous === "parameter") {
      if (kind !== "subresource" && kind !== "action") {
        return false;
      }
    } else if (previous === "subresource") {
      if (kind !== "subresource" && kind !== "action") {
        return false;
      }
    } else if (previous === "action") {
      return false;
    }
    previous = kind;
  }
  return true;
}
