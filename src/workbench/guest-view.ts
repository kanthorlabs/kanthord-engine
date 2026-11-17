import assert from "node:assert/strict";
import { isString } from "../kernel/values.ts";
import {
  ActionOutcome,
  type Author,
  type MemberEntry,
  QueueClearCause,
  WORKBENCH_ACTION_RESULT_ENTRY,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "./contract.ts";
import { planOf } from "./plan-pipeline.ts";
import { forkSummaryOf, isForkOpening, recordOf } from "./sessions.ts";

const MESSAGE_ENTRY = "message";
const CUSTOM_MESSAGE_ENTRY = "custom_message";
const USER_ROLE = "user";
const ASSISTANT_ROLE = "assistant";
const TEXT_BLOCK = "text";
const TOOL_CALL_BLOCK = "toolCall";
const NO_ITEMS = 0;
const DONE_LINE = "Done by the owner.";
const FAILED_LINE = "Failed";
const QUEUE_CLEAR_LINES: Readonly<Record<QueueClearCause, string>> = {
  [QueueClearCause.Stop]: "The owner stopped the run.",
  [QueueClearCause.Replace]: "The owner replaced the run.",
};

function queueClearLine(cause: QueueClearCause, count: number): string {
  return `${QUEUE_CLEAR_LINES[cause]} ${count} queued messages were cleared.`;
}

export const GUEST_RECORD_KINDS = [
  WorkbenchRecordKind.Note,
  WorkbenchRecordKind.ActionOffer,
  WorkbenchRecordKind.Fork,
  WorkbenchRecordKind.Author,
  WorkbenchRecordKind.QueueClear,
] as const;
export type GuestRecordKind = (typeof GUEST_RECORD_KINDS)[number];

export type GuestBlock =
  | { type: typeof TEXT_BLOCK; text: string }
  | { type: typeof TOOL_CALL_BLOCK; name: string };

export type GuestBody =
  | { kind: "user"; text: string }
  | { kind: "assistant"; content: GuestBlock[] }
  | { kind: "summary"; text: string }
  | { kind: "plan"; markdown: string }
  | { kind: "action_result"; tool_call_id: string; text: string }
  | { kind: typeof WorkbenchRecordKind.Note; text: string; author: Author }
  | {
      kind: typeof WorkbenchRecordKind.ActionOffer;
      tool_call_id: string;
      operation_id: string;
      target_id: string;
    }
  | { kind: typeof WorkbenchRecordKind.Fork; source_title: string }
  | { kind: typeof WorkbenchRecordKind.Author; author: Author }
  | {
      kind: typeof WorkbenchRecordKind.QueueClear;
      count: number;
      cause: QueueClearCause;
      text: string;
    };

export type GuestEntry = {
  id: string;
  session_id: string;
  agent_name: string;
  timestamp: string;
} & GuestBody;

export interface GuestStreaming {
  content: GuestBlock[];
}

type GuestRecord = Extract<WorkbenchRecord, { kind: GuestRecordKind }>;

function isGuestRecord(record: WorkbenchRecord): record is GuestRecord {
  return (GUEST_RECORD_KINDS as readonly string[]).includes(record.kind);
}

function blocksOf(content: unknown): GuestBlock[] {
  if (!Array.isArray(content)) return [];
  return content.flatMap((block): GuestBlock[] => {
    if (block?.type === TEXT_BLOCK && isString(block.text))
      return [{ type: TEXT_BLOCK, text: block.text }];
    if (block?.type === TOOL_CALL_BLOCK && isString(block.name))
      return [{ type: TOOL_CALL_BLOCK, name: block.name }];
    return [];
  });
}

function textOf(content: unknown): string {
  if (isString(content)) return content;
  return blocksOf(content)
    .flatMap((block) => (block.type === TEXT_BLOCK ? [block.text] : []))
    .join("");
}

function projectRecord(record: WorkbenchRecord): GuestBody | null {
  if (!isGuestRecord(record)) return null;
  switch (record.kind) {
    case WorkbenchRecordKind.Note:
      return {
        kind: record.kind,
        text: record.text,
        author: { kind: record.author.kind, name: record.author.name },
      };
    case WorkbenchRecordKind.ActionOffer:
      return {
        kind: record.kind,
        tool_call_id: record.tool_call_id,
        operation_id: record.operation_id,
        target_id: record.target_id,
      };
    case WorkbenchRecordKind.Fork:
      return { kind: record.kind, source_title: record.source_title };
    case WorkbenchRecordKind.Author:
      return {
        kind: record.kind,
        author: { kind: record.author.kind, name: record.author.name },
      };
    case WorkbenchRecordKind.QueueClear:
      return {
        kind: record.kind,
        count: record.count,
        cause: record.cause,
        text: queueClearLine(record.cause, record.count),
      };
    default:
      return assert.fail("A guest record kind has a projection.");
  }
}

function projectMessage(entry: MemberEntry): GuestBody | null {
  const message = entry.message as
    { role?: unknown; content?: unknown } | undefined;
  if (message?.role === USER_ROLE) {
    const text = textOf(message.content);
    if (!isForkOpening(text)) return { kind: "user", text };
    const summary = forkSummaryOf(text);
    return summary === null ? null : { kind: "summary", text: summary };
  }
  if (message?.role !== ASSISTANT_ROLE) return null;
  const content = blocksOf(message.content);
  return content.length === NO_ITEMS ? null : { kind: "assistant", content };
}

function actionResultLine(outcome: unknown, errorCode: unknown): string | null {
  if (outcome === ActionOutcome.Done) return DONE_LINE;
  if (outcome !== ActionOutcome.Failed) return null;
  return isString(errorCode)
    ? `${FAILED_LINE}: ${errorCode}.`
    : `${FAILED_LINE}.`;
}

function projectActionResult(entry: MemberEntry): GuestBody | null {
  const details = entry.details as
    | { tool_call_id?: unknown; outcome?: unknown; error_code?: unknown }
    | undefined;
  const text = actionResultLine(details?.outcome, details?.error_code);
  if (text === null || !isString(details?.tool_call_id)) return null;
  return { kind: "action_result", tool_call_id: details.tool_call_id, text };
}

function projectCustomMessage(entry: MemberEntry): GuestBody | null {
  const plan = planOf(entry);
  if (plan !== null) return { kind: "plan", markdown: plan.text };
  if (entry.customType === WORKBENCH_ACTION_RESULT_ENTRY)
    return projectActionResult(entry);
  return null;
}

function projectBody(entry: MemberEntry): GuestBody | null {
  if (entry.type === MESSAGE_ENTRY) return projectMessage(entry);
  if (entry.type === CUSTOM_MESSAGE_ENTRY) return projectCustomMessage(entry);
  const record = recordOf(entry);
  return record === null ? null : projectRecord(record);
}

export function projectEntries(entries: readonly MemberEntry[]): GuestEntry[] {
  return entries.flatMap((entry): GuestEntry[] => {
    if (entry.phase !== undefined) return [];
    const body = projectBody(entry);
    if (body === null) return [];
    return [
      {
        id: entry.id,
        session_id: entry.session_id,
        agent_name: entry.agent_name,
        timestamp: entry.timestamp,
        ...body,
      },
    ];
  });
}

export function projectStreaming(
  message: Record<string, unknown> | null,
): GuestStreaming | null {
  if (message === null) return null;
  return { content: blocksOf(message.content) };
}
