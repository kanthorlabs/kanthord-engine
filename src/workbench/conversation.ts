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
import type { SessionEntry } from "./contract.ts";
import { openingIds } from "./sessions.ts";
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
      if (opening.has(entry.id) || !(at > since)) continue;
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
