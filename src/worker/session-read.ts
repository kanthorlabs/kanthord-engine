import type { Logger } from "pino";
import type { Store } from "../kernel/store.ts";
import {
  SessionAbsentReason,
  type SessionReadAnswer,
  UnreachableReason,
} from "../tracking/contract.ts";
import {
  InstancePlacement,
  type PoolHost,
  type SessionRead,
  SessionReadOutcome,
  type SessionReadResult,
} from "./contract.ts";
import { readInstanceById, readLiveInstance } from "./instance-rows.ts";
import { readRow } from "./registration-rows.ts";

export interface SessionReadDependencies {
  store: Store;
  host: PoolHost | null;
  logger: Logger | null;
}

function checked(
  result: SessionReadResult,
  read: SessionRead,
  instance: string,
  logger: Logger | null,
): SessionReadResult {
  if (
    result.outcome !== SessionReadOutcome.Resolved ||
    (result.entry.id === read.entry_id && result.entry.type === read.entry_type)
  )
    return result;
  logger?.error(
    {
      instance,
      execution_id: read.execution_id,
      session_id: read.session_id,
      entry_id: read.entry_id,
      outcome: SessionReadOutcome.Unreadable,
    },
    "worker.session_read.entry_mismatch",
  );
  return { outcome: SessionReadOutcome.Unreadable };
}

export async function readSessionEntry(
  dependencies: SessionReadDependencies,
  runtimeIdentity: string | null,
  read: SessionRead,
  signal: AbortSignal,
): Promise<SessionReadAnswer> {
  const located = dependencies.store.transaction((tx) => {
    const instanceId =
      runtimeIdentity === null
        ? null
        : (readRow(tx, runtimeIdentity)?.instance_id ?? null);
    const recorded = instanceId ? readInstanceById(tx, instanceId) : null;
    if (!recorded) return null;
    return { recorded, live: readLiveInstance(tx, recorded.name) };
  });
  if (!located)
    return {
      session_absent: SessionAbsentReason.InstanceUnknown,
      instance: null,
      placement: null,
    };
  const { recorded, live } = located;
  if (!live)
    return {
      session_absent: SessionAbsentReason.Archived,
      instance: recorded.name,
      placement: recorded.placement,
    };
  const target = { instance: live.name, placement: live.placement };
  if (live.placement !== InstancePlacement.Server)
    return { unreachable: UnreachableReason.Offline, ...target };
  if (!dependencies.host) throw new Error("worker: no pool host");
  const result = await dependencies.host.readSessionEntry(
    {
      id: live.id,
      name: live.name,
      placement: live.placement,
      created_at: live.created_at,
    },
    read,
    signal,
  );
  return {
    result: checked(result, read, live.name, dependencies.logger),
    ...target,
  };
}
