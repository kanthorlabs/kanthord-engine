import assert from "node:assert/strict";
import { basename, join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ensureDirectory } from "../kernel/files.ts";
import { homeRelative } from "../kernel/xdg.ts";
import { isString } from "../kernel/values.ts";
import { workbenchAgentNames } from "../agent/catalog.ts";
import { loadPi, PI_DIRECTORY_NAME } from "../agent/pi.ts";
import {
  ActionOutcome,
  type SessionEntry,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_DIRECTORY_NAME,
  WORKBENCH_OPENING_TEXT,
  WORKBENCH_RECORD_ENTRY,
  type WorkbenchConfiguration,
  type WorkbenchRecord,
  WorkbenchRecordKind,
  workbenchRecordSchema,
} from "./contract.ts";

const SESSIONS_DIRECTORY_NAME = "sessions";
const SESSION_FILE_EXTENSION = ".jsonl";
const FILE_NAME_SEPARATOR = "_";
const OPENING_ENTRY_COUNT = 2;
const NOT_FOUND = -1;
const ONE_BLOCK = 1;
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const STOP_REASON = "stop";
const TEXT_BLOCK = "text";
const NO_COST = 0;
const EntryType = {
  Custom: "custom",
  CustomMessage: "custom_message",
  Message: "message",
  ModelChange: "model_change",
  ThinkingLevelChange: "thinking_level_change",
} as const;

export interface SessionPlace {
  cwd: string;
  sessionDir: string;
}

export type CreateSessionOptions = { parentSession?: string };
export type OpeningInput = { model: Model<Api>; greeting: string };

export function hostIdOf(path: string): string {
  const name = basename(path, SESSION_FILE_EXTENSION);
  const separator = name.indexOf(FILE_NAME_SEPARATOR);
  assert.notEqual(separator, NOT_FOUND, "A pi session file name holds an id.");
  return name.slice(separator + FILE_NAME_SEPARATOR.length);
}

function workbenchDirectory(stateDirectory: string, agentName: string): string {
  assert.ok(stateDirectory);
  assert.ok(agentName);
  return join(stateDirectory, WORKBENCH_DIRECTORY_NAME, agentName);
}

export function sessionPlace(
  stateDirectory: string,
  agentName: string,
): SessionPlace {
  assert.ok(stateDirectory);
  assert.ok(workbenchAgentNames().includes(agentName));
  const place = {
    cwd: workbenchDirectory(stateDirectory, agentName),
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

export async function listSessions(place: SessionPlace, agentName: string) {
  const pi = await loadPi();
  const sessions: SessionInfo[] = await pi.SessionManager.list(
    place.cwd,
    place.sessionDir,
  );
  return sessions.map((session) => {
    const opened = session.firstMessage === WORKBENCH_OPENING_TEXT;
    return {
      id: session.id,
      agent_name: agentName,
      name: session.name ?? null,
      created: session.created.getTime(),
      modified: session.modified.getTime(),
      message_count: opened ? session.messageCount - 1 : session.messageCount,
      first_message: opened ? (session.name ?? "") : session.firstMessage,
      host_session_id:
        session.parentSessionPath === undefined
          ? null
          : hostIdOf(session.parentSessionPath),
    };
  });
}

export async function createSession(
  place: SessionPlace,
  id: string,
  options: CreateSessionOptions,
): Promise<SessionManager> {
  const pi = await loadPi();
  const manager = pi.SessionManager.create(place.cwd, place.sessionDir, {
    id,
    parentSession: options.parentSession,
  });
  assert.equal(manager.getSessionId(), id);
  return manager;
}

export function appendOpening(
  manager: SessionManager,
  opening: OpeningInput,
): void {
  const timestamp = Date.now();
  manager.appendMessage({
    role: USER_ROLE,
    content: [{ type: TEXT_BLOCK, text: WORKBENCH_OPENING_TEXT }],
    timestamp,
  });
  manager.appendMessage({
    role: ASSISTANT_ROLE,
    content: [{ type: TEXT_BLOCK, text: opening.greeting }],
    api: opening.model.api,
    provider: opening.model.provider,
    model: opening.model.id,
    usage: {
      input: NO_COST,
      output: NO_COST,
      cacheRead: NO_COST,
      cacheWrite: NO_COST,
      totalTokens: NO_COST,
      cost: {
        input: NO_COST,
        output: NO_COST,
        cacheRead: NO_COST,
        cacheWrite: NO_COST,
        total: NO_COST,
      },
    },
    stopReason: STOP_REASON,
    timestamp,
  });
}

export function openingIds(entries: readonly SessionEntry[]): Set<string> {
  const messages = entries.filter((entry) => entry.type === EntryType.Message);
  const first = messages[0]?.message as
    { role?: unknown; content?: unknown } | undefined;
  const content = first?.content;
  const opened =
    first?.role === USER_ROLE &&
    Array.isArray(content) &&
    content.length === ONE_BLOCK &&
    content[0]?.type === TEXT_BLOCK &&
    content[0].text === WORKBENCH_OPENING_TEXT;
  if (!opened) return new Set();
  return new Set(
    messages.slice(0, OPENING_ENTRY_COUNT).map((entry) => entry.id as string),
  );
}

export async function findSession(
  stateDirectory: string,
  id: string,
): Promise<{ agentName: string; manager: SessionManager } | null> {
  const pi = await loadPi();
  for (const agentName of workbenchAgentNames()) {
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
  const data = custom?.data as { agent_provider?: unknown } | undefined;
  return {
    agent_provider: data?.agent_provider,
    model_identifier: model?.modelId,
    reasoning_effort: thinking?.thinkingLevel,
  };
}

export function appendRecord(
  manager: SessionManager,
  record: WorkbenchRecord,
): string {
  const parsed = workbenchRecordSchema.parse(record);
  return manager.appendCustomEntry(WORKBENCH_RECORD_ENTRY, parsed);
}

export function recordOf(entry: SessionEntry): WorkbenchRecord | null {
  if (
    entry.type !== EntryType.Custom ||
    entry.customType !== WORKBENCH_RECORD_ENTRY
  )
    return null;
  const parsed = workbenchRecordSchema.safeParse(entry.data);
  return parsed.success ? parsed.data : null;
}

export function storedAutoMode(entries: readonly SessionEntry[]): boolean {
  const last = entries
    .map(recordOf)
    .findLast((record) => record?.kind === WorkbenchRecordKind.AutoMode);
  return last?.kind === WorkbenchRecordKind.AutoMode ? last.enabled : true;
}

export function actionSettled(
  entries: readonly SessionEntry[],
  toolCallId: string,
): boolean {
  return entries.some((entry) => {
    const details = entry.details as
      { tool_call_id?: unknown; outcome?: unknown } | undefined;
    return (
      entry.type === EntryType.CustomMessage &&
      entry.customType === WORKBENCH_ACTION_RESULT_ENTRY &&
      details?.tool_call_id === toolCallId &&
      details.outcome === ActionOutcome.Done
    );
  });
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

export function resumeCommand(manager: SessionManager, home: string): string {
  const file = manager.getSessionFile();
  assert.ok(file, "A workbench session is stored in a file.");
  return `pi --session ${homeRelative(file, home)}`;
}
