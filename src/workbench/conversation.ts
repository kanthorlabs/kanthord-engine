import { getAgentDeclaration, workbenchAgentNames } from "../agent/catalog.ts";
import { AgentErrorCode } from "../agent/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { isString } from "../kernel/values.ts";
import { PromptTemplate, type PromptTemplates } from "../agent/contract.ts";
import {
  renderTemplate,
  SHIPPED_TEMPLATES,
} from "../agent/prompt-templates.ts";
import {
  FORK_SOURCE_MAX_BYTES,
  type MemberEntry,
  type SessionEntry,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WorkbenchRecordKind,
} from "./contract.ts";
import {
  forkSummaryOf,
  openingIds,
  OpeningKind,
  recordOf,
} from "./sessions.ts";
import type { Dependencies } from "./service.ts";

const MENTION_PREFIX = "@";
const NAME_CHARACTER = /[A-Za-z0-9 _-]/;
const WHITESPACE = /\s/;
const AFTER_PREFIX = 1;
const FIRST_TOKEN = 0;
const MESSAGE_ENTRY = "message";
const ASSISTANT_ROLE = "assistant";
const FINAL_STOP_REASON = "stop";
const NO_CHARACTERS = 0;
const NOT_FOUND = -1;
const FIRST_AFTER = 1;
const PAIR_SEPARATOR = ",";
const PAIR_DELIMITER = ":";
const USER_ROLE = "user";
const TEXT_BLOCK = "text";
const ITEM_SEPARATOR = "\n\n";
const BEFORE_ALL = -Infinity;
const BYTES_ENCODING = "utf8";

export const RELAY_MAX_BYTES = 65536;

export interface MentionName {
  agent_name: string;
  display_name: string;
}

export interface MentionMatch extends MentionName {
  rest: string;
}

export const MentionKind = { Known: "known", Unknown: "unknown" } as const;
export type MentionKind = (typeof MentionKind)[keyof typeof MentionKind];

export type LeadingMention =
  | ({ kind: typeof MentionKind.Known } & MentionMatch)
  | { kind: typeof MentionKind.Unknown; mention: string };

function endsName(character: string | undefined): boolean {
  return (
    character === undefined ||
    WHITESPACE.test(character) ||
    !NAME_CHARACTER.test(character)
  );
}

export function leadingMention(
  text: string,
  names: readonly MentionName[],
): LeadingMention | null {
  if (!text.startsWith(MENTION_PREFIX)) return null;
  const body = text.slice(AFTER_PREFIX);
  if (
    body.length === NO_CHARACTERS ||
    WHITESPACE.test(body.charAt(FIRST_TOKEN))
  )
    return null;
  const lowered = body.toLowerCase();
  const matched = [...names]
    .sort((a, b) => b.display_name.length - a.display_name.length)
    .find(
      ({ display_name }) =>
        lowered.startsWith(display_name.toLowerCase()) &&
        endsName(body[display_name.length]),
    );
  if (!matched)
    return {
      kind: MentionKind.Unknown,
      mention: body.split(WHITESPACE)[FIRST_TOKEN] ?? "",
    };
  return {
    kind: MentionKind.Known,
    agent_name: matched.agent_name,
    display_name: matched.display_name,
    rest: body.slice(matched.display_name.length).trimStart(),
  };
}

function workbenchMentionNames(): MentionName[] {
  return workbenchAgentNames().map((agentName) => {
    const declaration = getAgentDeclaration(agentName);
    if (!declaration) throw new Error(`Undeclared agent ${agentName}.`);
    return {
      agent_name: declaration.agent_name,
      display_name: declaration.display_name,
    };
  });
}

export function resolveMention(
  tx: Transaction,
  text: string,
  dependencies: Pick<Dependencies, "agentConfiguration">,
): MentionMatch | null {
  const mention = leadingMention(text, workbenchMentionNames());
  if (mention === null) return null;
  if (mention.kind === MentionKind.Unknown)
    throw new OperationError(
      HttpStatus.NotFound,
      AgentErrorCode.AgentNotFound,
      "Agent not found.",
      { mention: mention.mention },
    );
  dependencies.agentConfiguration.validateEntry(tx, mention.agent_name, null);
  return {
    agent_name: mention.agent_name,
    display_name: mention.display_name,
    rest: mention.rest,
  };
}

export interface Answerer {
  id: string;
  entries: readonly SessionEntry[];
}

function isFinalAnswer(entry: SessionEntry): boolean {
  const message = entry.message as
    { role?: unknown; stopReason?: unknown } | undefined;
  return (
    entry.type === MESSAGE_ENTRY &&
    message?.role === ASSISTANT_ROLE &&
    message.stopReason === FINAL_STOP_REASON
  );
}

function lastAnswerAt(entries: readonly SessionEntry[]): number | null {
  const answer = entries.findLast(isFinalAnswer);
  return answer === undefined ? null : Date.parse(answer.timestamp);
}

export function lastTurnEntry(entries: readonly SessionEntry[]): string | null {
  return entries.findLast(isFinalAnswer)?.id ?? null;
}

export function lastAnswerer(members: readonly Answerer[]): string | null {
  let latest: { id: string; at: number } | null = null;
  for (const { id, entries } of members) {
    const at = lastAnswerAt(entries);
    if (at !== null && (latest === null || at > latest.at)) latest = { id, at };
  }
  return latest?.id ?? null;
}

export interface RelayMember {
  id: string;
  displayName: string;
  entries: readonly SessionEntry[];
}

export type RelayInput = {
  members: readonly RelayMember[];
  startEntry: string | null;
  authorName: string;
  templates?: PromptTemplates;
};

interface RelayItem {
  at: number;
  text: string;
}

function textOf(content: unknown): string {
  if (isString(content)) return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block?.type === TEXT_BLOCK)
    .map((block) => block.text as string)
    .join("");
}

function relayItemOf(
  author: RelayMember,
  entry: SessionEntry,
  authorName: string,
): string | null {
  const message = entry.message as
    { role?: unknown; content?: unknown } | undefined;
  if (entry.type !== MESSAGE_ENTRY) return null;
  const text = textOf(message?.content);
  if (text.length === NO_CHARACTERS) return null;
  if (message?.role === USER_ROLE)
    return `${authorName} to @${author.displayName}: ${text}`;
  return isFinalAnswer(entry) ? `${author.displayName}: ${text}` : null;
}

function relayItems(member: RelayMember, input: RelayInput): string[] {
  const since = input.startEntry
    ? Date.parse(
        member.entries.find((entry) => entry.id === input.startEntry)
          ?.timestamp ?? "",
      )
    : BEFORE_ALL;
  const items: RelayItem[] = [];
  for (const author of input.members) {
    if (author.id === member.id) continue;
    const opening = openingIds(author.entries);
    for (const entry of author.entries) {
      const at = Date.parse(entry.timestamp);
      if (opening.hidden.has(entry.id) || !(at > since)) continue;
      const text = relayItemOf(author, entry, input.authorName);
      if (text !== null) items.push({ at, text });
    }
  }
  return items
    .sort((left, right) => left.at - right.at)
    .map(({ text }) => text);
}

export function relayText(
  member: RelayMember,
  input: RelayInput,
): string | null {
  const items = relayItems(member, input);
  const head = renderTemplate(
    input.templates ?? SHIPPED_TEMPLATES,
    PromptTemplate.Relay,
    {},
  );
  const content = () => [head, ...items].join(ITEM_SEPARATOR);
  while (
    items.length > NO_CHARACTERS &&
    Buffer.byteLength(content(), BYTES_ENCODING) > RELAY_MAX_BYTES
  )
    items.shift();
  return items.length > NO_CHARACTERS ? content() : null;
}

const CUSTOM_MESSAGE_ENTRY = "custom_message";
const FORK_SUMMARY_LABEL = "Summary of an earlier conversation:\n";
const REPLACEMENT_CHARACTERS = /\uFFFD+$/;
const NO_TEXT = "";

export interface ForkConversation {
  members: readonly RelayMember[];
  authorName: string;
}

const ForkItemKind = {
  Summary: "summary",
  Human: "human",
  Other: "other",
} as const;
type ForkItemKind = (typeof ForkItemKind)[keyof typeof ForkItemKind];

interface ForkItem extends RelayItem {
  kind: ForkItemKind;
}

function isActionResult(entry: SessionEntry): boolean {
  return (
    entry.type === CUSTOM_MESSAGE_ENTRY &&
    entry.customType === WORKBENCH_ACTION_RESULT_ENTRY
  );
}

function settledCards(members: readonly RelayMember[]): Set<string> {
  const settled = new Set<string>();
  for (const { entries } of members)
    for (const entry of entries) {
      const details = entry.details as { tool_call_id?: unknown } | undefined;
      if (isActionResult(entry) && isString(details?.tool_call_id))
        settled.add(details.tool_call_id);
    }
  return settled;
}

function cardLineOf(
  entry: SessionEntry,
  settled: ReadonlySet<string>,
): string | null {
  const record = recordOf(entry);
  if (
    record?.kind !== WorkbenchRecordKind.ActionOffer ||
    settled.has(record.tool_call_id)
  )
    return null;
  return `Open action card: ${record.operation_id} on ${record.target_id}. The owner has not run it.`;
}

interface ForkContext {
  authorName: string;
  settled: ReadonlySet<string>;
}

interface ForkLine {
  kind: ForkItemKind;
  text: string;
}

function messageLineOf(
  author: RelayMember,
  entry: SessionEntry,
  authorName: string,
): ForkLine | null {
  const message = entry.message as
    { role?: unknown; content?: unknown } | undefined;
  const human = entry.type === MESSAGE_ENTRY && message?.role === USER_ROLE;
  const summary = human ? forkSummaryOf(textOf(message?.content)) : null;
  if (summary !== null)
    return {
      kind: ForkItemKind.Summary,
      text: `${FORK_SUMMARY_LABEL}${summary}`,
    };
  const text = relayItemOf(author, entry, authorName);
  if (text === null) return null;
  return { kind: human ? ForkItemKind.Human : ForkItemKind.Other, text };
}

function forkItemOf(
  author: RelayMember,
  entry: SessionEntry,
  context: ForkContext,
): ForkLine | null {
  if (isActionResult(entry)) {
    const text = textOf(entry.content);
    return text.length === NO_CHARACTERS
      ? null
      : { kind: ForkItemKind.Other, text };
  }
  const card = cardLineOf(entry, context.settled);
  if (card !== null) return { kind: ForkItemKind.Other, text: card };
  return messageLineOf(author, entry, context.authorName);
}

function forkItems(conversation: ForkConversation): ForkItem[] {
  const settled = settledCards(conversation.members);
  const items: ForkItem[] = [];
  for (const author of conversation.members) {
    const { hidden } = openingIds(author.entries);
    for (const entry of author.entries) {
      if (hidden.has(entry.id)) continue;
      const item = forkItemOf(author, entry, {
        authorName: conversation.authorName,
        settled,
      });
      if (item !== null)
        items.push({ ...item, at: Date.parse(entry.timestamp) });
    }
  }
  return items.sort((left, right) => left.at - right.at);
}

function clippedToBytes(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, BYTES_ENCODING);
  if (bytes.length <= maxBytes) return text;
  return bytes
    .subarray(NO_CHARACTERS, maxBytes)
    .toString(BYTES_ENCODING)
    .replace(REPLACEMENT_CHARACTERS, NO_TEXT);
}

export function forkMaterial(conversation: ForkConversation): string {
  const items = forkItems(conversation);
  const summary = items.find(({ kind }) => kind === ForkItemKind.Summary);
  const first = items.find(({ kind }) => kind === ForkItemKind.Human);
  const pinned = [summary, first].flatMap((item) => (item ? [item.text] : []));
  const rest = items
    .filter((item) => item !== summary && item !== first)
    .map(({ text }) => text);
  const kept = [...rest];
  const content = () => {
    const omitted = rest.length - kept.length;
    return [
      ...pinned,
      ...(omitted > NO_CHARACTERS
        ? [`${omitted} earlier messages are not shown.`]
        : []),
      ...kept,
    ].join(ITEM_SEPARATOR);
  };
  while (
    kept.length > NO_CHARACTERS &&
    Buffer.byteLength(content(), BYTES_ENCODING) > FORK_SOURCE_MAX_BYTES
  )
    kept.shift();
  return clippedToBytes(content(), FORK_SOURCE_MAX_BYTES);
}

export interface MergeMember {
  sessionId: string;
  agentName: string;
  entries: readonly SessionEntry[];
}

export function parseCursor(
  after: string | undefined,
  hostId: string,
): Map<string, string> {
  const cursor = new Map<string, string>();
  if (after === undefined) return cursor;
  for (const pair of after.split(PAIR_SEPARATOR)) {
    const split = pair.indexOf(PAIR_DELIMITER);
    if (split === NOT_FOUND) cursor.set(hostId, pair);
    else
      cursor.set(
        pair.slice(NO_CHARACTERS, split),
        pair.slice(split + PAIR_DELIMITER.length),
      );
  }
  return cursor;
}

export function mergeEntries(
  members: readonly MergeMember[],
  after: ReadonlyMap<string, string> = new Map(),
): MemberEntry[] {
  const queues = members.map(({ sessionId, agentName, entries }) => {
    const { kind, hidden } = openingIds(entries);
    const dropped =
      kind === OpeningKind.Opening
        ? [...hidden].slice(NO_CHARACTERS, FIRST_AFTER)
        : [...hidden];
    const cursor = after.get(sessionId);
    const start =
      cursor === undefined
        ? NO_CHARACTERS
        : entries.findIndex((entry) => entry.id === cursor) + FIRST_AFTER;
    return entries
      .slice(start)
      .filter((entry) => !dropped.includes(entry.id))
      .map((entry): MemberEntry => ({
        ...entry,
        session_id: sessionId,
        agent_name: agentName,
      }));
  });
  const heads = queues.map(() => NO_CHARACTERS);
  const total = queues.reduce(
    (sum, queue) => sum + queue.length,
    NO_CHARACTERS,
  );
  const merged: MemberEntry[] = [];
  while (merged.length < total) {
    let next = NOT_FOUND;
    let earliest = Number.POSITIVE_INFINITY;
    for (const [member, queue] of queues.entries()) {
      const head = queue[heads[member]!];
      if (head === undefined) continue;
      const at = Date.parse(head.timestamp);
      if (next !== NOT_FOUND && at >= earliest) continue;
      earliest = at;
      next = member;
    }
    merged.push(queues[next]![heads[next]!++]!);
  }
  return merged;
}
