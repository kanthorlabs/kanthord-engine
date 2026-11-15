import { getAgentDeclaration, workbenchAgentNames } from "../agent/catalog.ts";
import { AgentErrorCode } from "../agent/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import type { Dependencies } from "./service.ts";

const MENTION_PREFIX = "@";
const NAME_CHARACTER = /[A-Za-z0-9 _-]/;
const WHITESPACE = /\s/;
const AFTER_PREFIX = 1;
const FIRST_TOKEN = 0;
const NO_CHARACTERS = 0;

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
