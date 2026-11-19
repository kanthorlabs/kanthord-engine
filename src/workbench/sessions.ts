import assert from "node:assert/strict";
import { existsSync, readdirSync, rmdirSync } from "node:fs";
import { basename, join } from "node:path";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type {
  SessionInfo,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { ensureDirectory } from "../kernel/files.ts";
import { identitySchema } from "../kernel/identity.ts";
import { homeRelative } from "../kernel/xdg.ts";
import { isString } from "../kernel/values.ts";
import { workbenchAgentNames } from "../agent/catalog.ts";
import { AGENT_VARIANT_PREFIX } from "../agent/contract.ts";
import { loadPi, PI_DIRECTORY_NAME } from "../agent/pi.ts";
import {
  ActionOutcome,
  FORK_SOURCE_TITLE_MAX_CHARS,
  type SessionEntry,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WORKBENCH_CONFIGURATION_ENTRY,
  WORKBENCH_DIRECTORY_NAME,
  WORKBENCH_FORK_ACK,
  WORKBENCH_FORK_FRAME,
  WORKBENCH_FORK_PREFIX,
  WORKBENCH_OPENING_TEXT,
  WORKBENCH_RECORD_ENTRY,
  WORKBENCH_SESSION_PREFIX,
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

export type VariantPlace = { agentName: string; variantId: string };
export type SessionOwner = { agentName: string; variantId: string | null };
export type ExistingVariantPlace = {
  variantId: string;
  place: SessionPlace;
};
export type CreateSessionOptions = { parentSession?: string };
export type OpeningInput = { model: Model<Api>; greeting: string };
export type ForkOpeningInput = {
  model: Model<Api>;
  sourceId: string;
  summary: string;
};

export const OpeningKind = { Opening: "opening", Fork: "fork" } as const;
export type OpeningKind = (typeof OpeningKind)[keyof typeof OpeningKind];

const sessionIdSchema = identitySchema(WORKBENCH_SESSION_PREFIX);
const variantIdSchema = identitySchema(AGENT_VARIANT_PREFIX);
const FORK_ID_END = ".";
const NO_TEXT = "";
const NO_ENTRIES = 0;
const NO_CHARACTERS = 0;
const TITLE_MAX_CHARS = FORK_SOURCE_TITLE_MAX_CHARS;

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

export function variantSessionDirectory(
  stateDirectory: string,
  variant: VariantPlace,
): string {
  assert.ok(stateDirectory);
  assert.ok(variant.agentName);
  assert.ok(variant.variantId);
  return join(
    stateDirectory,
    PI_DIRECTORY_NAME,
    SESSIONS_DIRECTORY_NAME,
    WORKBENCH_DIRECTORY_NAME,
    variant.agentName,
    variant.variantId,
  );
}

export function variantSessionPlace(
  stateDirectory: string,
  variant: VariantPlace,
): SessionPlace {
  assert.ok(workbenchAgentNames().includes(variant.agentName));
  assert.ok(variantIdSchema.safeParse(variant.variantId).success);
  const place = {
    cwd: workbenchDirectory(stateDirectory, variant.agentName),
    sessionDir: variantSessionDirectory(stateDirectory, variant),
  };
  ensureDirectory(place.cwd);
  ensureDirectory(place.sessionDir);
  return place;
}

export function variantHasSessionFile(
  stateDirectory: string,
  variant: VariantPlace,
): boolean {
  const directory = variantSessionDirectory(stateDirectory, variant);
  return (
    existsSync(directory) &&
    readdirSync(directory).some((name) => name.endsWith(SESSION_FILE_EXTENSION))
  );
}

export function removeEmptyVariantDirectory(
  stateDirectory: string,
  variant: VariantPlace,
): void {
  const directory = variantSessionDirectory(stateDirectory, variant);
  if (existsSync(directory) && readdirSync(directory).length === NO_ENTRIES)
    rmdirSync(directory);
}

export function existingVariantPlaces(
  stateDirectory: string,
  agentName: string,
): ExistingVariantPlace[] {
  assert.ok(workbenchAgentNames().includes(agentName));
  const baseDirectory = join(
    stateDirectory,
    PI_DIRECTORY_NAME,
    SESSIONS_DIRECTORY_NAME,
    WORKBENCH_DIRECTORY_NAME,
    agentName,
  );
  if (!existsSync(baseDirectory)) return [];
  return readdirSync(baseDirectory, { withFileTypes: true })
    .filter(
      (entry) =>
        entry.isDirectory() && variantIdSchema.safeParse(entry.name).success,
    )
    .map((entry) => entry.name)
    .sort()
    .map((variantId) => ({
      variantId,
      place: {
        cwd: workbenchDirectory(stateDirectory, agentName),
        sessionDir: variantSessionDirectory(stateDirectory, {
          agentName,
          variantId,
        }),
      },
    }));
}

function messageCountOf(
  session: SessionInfo,
  opened: boolean,
  forked: boolean,
): number {
  if (forked) return session.messageCount - OPENING_ENTRY_COUNT;
  return opened ? session.messageCount - 1 : session.messageCount;
}

export function forkSourceId(text: string): string | null {
  if (!text.startsWith(WORKBENCH_FORK_PREFIX)) return null;
  const rest = text.slice(WORKBENCH_FORK_PREFIX.length);
  const end = rest.indexOf(FORK_ID_END);
  const id = rest.slice(0, end);
  return end !== NOT_FOUND && sessionIdSchema.safeParse(id).success ? id : null;
}

export function isForkOpening(text: string): boolean {
  return forkSourceId(text) !== null;
}

export function forkSummaryOf(text: string): string | null {
  const id = forkSourceId(text);
  if (id === null) return null;
  const head = `${WORKBENCH_FORK_PREFIX}${id}.${WORKBENCH_FORK_FRAME}`;
  return text.startsWith(head) ? text.slice(head.length) : null;
}

export async function listSessions(place: SessionPlace, owner: SessionOwner) {
  const pi = await loadPi();
  const sessions: SessionInfo[] = await pi.SessionManager.list(
    place.cwd,
    place.sessionDir,
  );
  return sessions.map((session) => {
    const opened = session.firstMessage === WORKBENCH_OPENING_TEXT;
    const forked = isForkOpening(session.firstMessage);
    return {
      id: session.id,
      agent_name: owner.agentName,
      variant_id: owner.variantId,
      name: session.name ?? null,
      created: session.created.getTime(),
      modified: session.modified.getTime(),
      message_count: messageCountOf(session, opened, forked),
      first_message:
        opened || forked ? (session.name ?? NO_TEXT) : session.firstMessage,
      host_session_id:
        session.parentSessionPath === undefined
          ? null
          : hostIdOf(session.parentSessionPath),
      forked_from: forkSourceId(session.firstMessage),
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

function assistantMessage(
  model: Model<Api>,
  text: string,
  timestamp: number,
): AssistantMessage {
  return {
    role: ASSISTANT_ROLE,
    content: [{ type: TEXT_BLOCK, text }],
    api: model.api,
    provider: model.provider,
    model: model.id,
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
  };
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
  manager.appendMessage(
    assistantMessage(opening.model, opening.greeting, timestamp),
  );
}

export function appendForkOpening(
  manager: SessionManager,
  opening: ForkOpeningInput,
): void {
  const timestamp = Date.now();
  manager.appendMessage({
    role: USER_ROLE,
    content: [
      {
        type: TEXT_BLOCK,
        text: `${WORKBENCH_FORK_PREFIX}${opening.sourceId}.${WORKBENCH_FORK_FRAME}${opening.summary}`,
      },
    ],
    timestamp,
  });
  manager.appendMessage(
    assistantMessage(opening.model, WORKBENCH_FORK_ACK, timestamp),
  );
}

function messagesOf(entries: readonly SessionEntry[]): SessionEntry[] {
  return entries.filter((entry) => entry.type === EntryType.Message);
}

function firstUserText(messages: readonly SessionEntry[]): string | null {
  const first = messages[0]?.message as
    { role?: unknown; content?: unknown } | undefined;
  const content = first?.content;
  return first?.role === USER_ROLE &&
    Array.isArray(content) &&
    content.length === ONE_BLOCK &&
    content[0]?.type === TEXT_BLOCK &&
    isString(content[0].text)
    ? content[0].text
    : null;
}

export function forkSourceTitle(
  entries: readonly SessionEntry[],
  name: string | undefined,
): string {
  if (name !== undefined) return name.slice(NO_CHARACTERS, TITLE_MAX_CHARS);
  const messages = messagesOf(entries);
  const text = firstUserText(messages);
  const opened = openingKindOf(text) !== null;
  return opened || text === null
    ? NO_TEXT
    : text.slice(NO_CHARACTERS, TITLE_MAX_CHARS);
}

export function forkedFrom(entries: readonly SessionEntry[]): string | null {
  const text = firstUserText(messagesOf(entries));
  return text === null ? null : forkSourceId(text);
}

export function openingIds(entries: readonly SessionEntry[]): {
  kind: OpeningKind | null;
  hidden: Set<string>;
  forkEntry: string | null;
} {
  const messages = messagesOf(entries);
  const kind = openingKindOf(firstUserText(messages));
  const ids = messages
    .slice(0, OPENING_ENTRY_COUNT)
    .map((entry) => entry.id as string);
  if (kind === OpeningKind.Fork)
    return { kind, hidden: new Set(ids.slice(1)), forkEntry: ids[0] ?? null };
  return { kind, hidden: new Set(kind === null ? [] : ids), forkEntry: null };
}

function openingKindOf(text: string | null): OpeningKind | null {
  if (text === WORKBENCH_OPENING_TEXT) return OpeningKind.Opening;
  return text !== null && isForkOpening(text) ? OpeningKind.Fork : null;
}

export async function findSession(
  stateDirectory: string,
  id: string,
): Promise<{
  agentName: string;
  variantId: string | null;
  place: SessionPlace;
  manager: SessionManager;
} | null> {
  const pi = await loadPi();
  for (const agentName of workbenchAgentNames()) {
    const places: { variantId: string | null; place: SessionPlace }[] = [
      { variantId: null, place: sessionPlace(stateDirectory, agentName) },
      ...existingVariantPlaces(stateDirectory, agentName),
    ];
    for (const { variantId, place } of places) {
      const path = pi.SessionManager.findById(place.cwd, id, place.sessionDir);
      if (path === undefined) continue;
      const manager = pi.SessionManager.open(path, place.sessionDir);
      assert.equal(manager.getSessionId(), id);
      return { agentName, variantId, place, manager };
    }
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
