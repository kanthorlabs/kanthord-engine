import assert from "node:assert/strict";
import type { Transaction } from "../kernel/store.ts";
import { InboundEventState } from "./contract.ts";
import { eventState, oldestPendingEvent } from "./event-store.ts";

const NO_LENGTH = 0;
const MAX_IN_FLIGHT = 1;

export function nextCandidate(
  tx: Transaction,
  inFlight: ReadonlySet<string>,
): string | null {
  assert.ok(inFlight.size <= MAX_IN_FLIGHT, "One handoff runs at a time.");
  const id = oldestPendingEvent(tx, inFlight);
  assert.ok(id === null || !inFlight.has(id), "A candidate is not in flight.");
  return id;
}

export function reserve(
  tx: Transaction,
  inFlight: Set<string>,
  id: string,
): boolean {
  assert.ok(id.length > NO_LENGTH, "An event row identity is required.");
  assert.ok(inFlight.size < MAX_IN_FLIGHT, "One handoff runs at a time.");
  if (eventState(tx, id) !== InboundEventState.Pending) return false;
  inFlight.add(id);
  return true;
}
