import assert from "node:assert/strict";
import { join } from "node:path";
import type {
  SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ensureDirectory } from "../kernel/files.ts";
import { isString } from "../kernel/values.ts";
import { AGENT_DECLARATIONS } from "../agent/catalog.ts";
import { loadPi, PI_DIRECTORY_NAME } from "../agent/pi.ts";
import {
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_DIRECTORY_NAME,
  type SessionEntry,
  type WorkbenchConfiguration,
} from "./contract.ts";

const SESSIONS_DIRECTORY_NAME = "sessions";
const EntryType = {
  Custom: "custom",
  ModelChange: "model_change",
  ThinkingLevelChange: "thinking_level_change",
} as const;

export interface SessionPlace {
  cwd: string;
  sessionDir: string;
}

export function sessionPlace(
  stateDirectory: string,
  agentName: string,
): SessionPlace {
  assert.ok(stateDirectory);
  assert.ok(Object.hasOwn(AGENT_DECLARATIONS, agentName));
  const place = {
    cwd: join(stateDirectory, WORKBENCH_DIRECTORY_NAME, agentName),
    sessionDir: join(
      stateDirectory,
      PI_DIRECTORY_NAME,
      SESSIONS_DIRECTORY_NAME,
      WORKBENCH_DIRECTORY_NAME,
      agentName,
    ),
  };
  ensureDirectory(place.cwd);
  ensureDirectory(place.sessionDir);
  return place;
}

export async function listSessions(place: SessionPlace) {
  const pi = await loadPi();
  const sessions: SessionInfo[] = await pi.SessionManager.list(
    place.cwd,
    place.sessionDir,
  );
  return sessions.map((session) => ({
    id: session.id,
    name: session.name ?? null,
    created: session.created.getTime(),
    modified: session.modified.getTime(),
    messageCount: session.messageCount,
    firstMessage: session.firstMessage,
  }));
}

export async function createSession(
  place: SessionPlace,
  id: string,
): Promise<SessionManager> {
  const pi = await loadPi();
  const manager = pi.SessionManager.create(place.cwd, place.sessionDir, { id });
  assert.equal(manager.getSessionId(), id);
  return manager;
}

export async function findSession(
  stateDirectory: string,
  id: string,
): Promise<{ agentName: string; manager: SessionManager } | null> {
  const pi = await loadPi();
  for (const agentName of Object.keys(AGENT_DECLARATIONS)) {
    const place = sessionPlace(stateDirectory, agentName);
    const path = pi.SessionManager.findById(place.cwd, id, place.sessionDir);
    if (path === undefined) continue;
    const manager = pi.SessionManager.open(path, place.sessionDir);
    assert.equal(manager.getSessionId(), id);
    return { agentName, manager };
  }
  return null;
}

function lastOfType(
  entries: readonly SessionEntry[],
  type: string,
  matches: (entry: SessionEntry) => boolean = () => true,
): SessionEntry | undefined {
  return entries.findLast((entry) => entry.type === type && matches(entry));
}

export function storedConfiguration(
  entries: readonly SessionEntry[],
): Record<keyof WorkbenchConfiguration, unknown> {
  const custom = lastOfType(
    entries,
    EntryType.Custom,
    (entry) => entry.customType === WORKBENCH_CONFIGURATION_ENTRY,
  );
  const model = lastOfType(entries, EntryType.ModelChange);
  const thinking = lastOfType(entries, EntryType.ThinkingLevelChange);
  const data = custom?.data as { agentProvider?: unknown } | undefined;
  return {
    agentProvider: data?.agentProvider,
    modelIdentifier: model?.modelId,
    reasoningEffort: thinking?.thinkingLevel,
  };
}

export function lastModel(
  entries: readonly SessionEntry[],
): { provider: string; modelId: string } | undefined {
  const entry = lastOfType(entries, EntryType.ModelChange);
  if (!entry || !isString(entry.provider) || !isString(entry.modelId))
    return undefined;
  return { provider: entry.provider, modelId: entry.modelId };
}

export function lastThinkingLevel(
  entries: readonly SessionEntry[],
): string | undefined {
  const entry = lastOfType(entries, EntryType.ThinkingLevelChange);
  return isString(entry?.thinkingLevel) ? entry.thinkingLevel : undefined;
}
