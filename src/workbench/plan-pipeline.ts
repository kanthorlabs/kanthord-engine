import assert from "node:assert/strict";
import { join } from "node:path";
import type { SessionManager } from "@earendil-works/pi-coding-agent";
import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import type { GuardClass } from "../agent/contract.ts";
import { loadPi } from "../agent/pi.ts";
import { ensureDirectory } from "../kernel/files.ts";
import type { Operation } from "../kernel/operation.ts";
import { isString } from "../kernel/values.ts";
import {
  type PlanDetails,
  planDetailsSchema,
  type SessionEntry,
  UNRESOLVED_MISSING,
  WORKBENCH_PLAN_ENTRY,
} from "./contract.ts";
import { guardClassOf } from "./guard.ts";
import { type SessionPlace, sessionPlace } from "./sessions.ts";

export interface PlanMutation {
  operation_id: string;
  guard_class: GuardClass;
}

export function planMutations(
  operations: readonly Operation[],
): PlanMutation[] {
  const byId = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  return AGENT_DECLARATIONS["ops@1"].tools.operation.flatMap((id) => {
    const operation = byId.get(id);
    assert.ok(operation, id);
    return operation.mutation
      ? [{ operation_id: id, guard_class: guardClassOf(operation) }]
      : [];
  });
}

const PLAN_AGENT = "plan@1";
const PHASE_DIRECTORY_NAME = "phases";
const REVIEW_HEADING = "## Review";
const LINE_BREAK = /\r?\n/;
const BULLET = /^\s*[-*]\s/;
const OPEN_STATUS = "status:OPEN";
const YES_ACTION = "action:YES";
const NO_FINDINGS = 0;
const NOT_FOUND = -1;
const FIRST_LINE_OFFSET = 1;
const CUSTOM_MESSAGE_ENTRY = "custom_message";

function phasePlace(stateDirectory: string): SessionPlace {
  const place = sessionPlace(stateDirectory, PLAN_AGENT);
  const sessionDir = join(place.sessionDir, PHASE_DIRECTORY_NAME);
  ensureDirectory(sessionDir);
  return { cwd: place.cwd, sessionDir };
}

export async function createPhaseSession(
  stateDirectory: string,
  sessionId: string,
): Promise<SessionManager> {
  const pi = await loadPi();
  const place = phasePlace(stateDirectory);
  const manager = pi.SessionManager.create(place.cwd, place.sessionDir, {
    id: sessionId,
  });
  assert.equal(manager.getSessionId(), sessionId);
  return manager;
}

export async function openPhaseSession(
  stateDirectory: string,
  sessionId: string,
): Promise<SessionManager | null> {
  const pi = await loadPi();
  const place = phasePlace(stateDirectory);
  const path = pi.SessionManager.findById(
    place.cwd,
    sessionId,
    place.sessionDir,
  );
  if (path === undefined) return null;
  const manager = pi.SessionManager.open(path, place.sessionDir);
  assert.equal(manager.getSessionId(), sessionId);
  return manager;
}

export function unresolvedOf(text: string): number | "missing" | null {
  const lines = text.split(LINE_BREAK);
  const heading = lines.lastIndexOf(REVIEW_HEADING);
  if (heading === NOT_FOUND) return UNRESOLVED_MISSING;
  const open = lines
    .slice(heading + FIRST_LINE_OFFSET)
    .filter(
      (line) =>
        BULLET.test(line) &&
        line.includes(OPEN_STATUS) &&
        line.includes(YES_ACTION),
    ).length;
  return open > NO_FINDINGS ? open : null;
}

export function appendPlan(
  manager: SessionManager,
  text: string,
  details: PlanDetails,
): string {
  const parsed = planDetailsSchema.parse(details);
  return manager.appendCustomMessageEntry(
    WORKBENCH_PLAN_ENTRY,
    text,
    true,
    parsed,
  );
}

export function planOf(
  entry: SessionEntry,
): { text: string; details: PlanDetails } | null {
  if (
    entry.type !== CUSTOM_MESSAGE_ENTRY ||
    entry.customType !== WORKBENCH_PLAN_ENTRY ||
    !isString(entry.content)
  )
    return null;
  const parsed = planDetailsSchema.safeParse(entry.details);
  return parsed.success ? { text: entry.content, details: parsed.data } : null;
}
