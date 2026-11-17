import assert from "node:assert/strict";
import { test } from "node:test";
import type { Api, Model } from "@earendil-works/pi-ai";
import { loadPi } from "../agent/pi.ts";
import {
  type MemberEntry,
  type SessionEntry,
  WORKBENCH_ACTION_RESULT_ENTRY,
  WORKBENCH_FORK_ACK,
  WORKBENCH_PLAN_ENTRY,
  WorkbenchRecordKind,
} from "./contract.ts";
import { mergeEntries } from "./conversation.ts";
import {
  type GuestEntry,
  projectEntries,
  projectStreaming,
} from "./guest-view.ts";
import { appendForkOpening, appendRecord } from "./sessions.ts";

const SESSION_ID = "workbench_session_A";
const AGENT_NAME = "yumi@1";
const SOURCE_ID = "workbench_session_01M78TVZCNWCDNTBPNNYJT3EDX";
const SECRET = "secret";
const EVIDENCE_RESULT = "EVIDENCE-FILE-CONTENT";
const SUMMARY = "The owner paused the billing project.";
const MODEL = { api: "fake", provider: "fake", id: "fake" } as Model<Api>;
const PLAN_DETAILS = {
  phases: [
    { phase: "planner", session_id: "workbench_session_P" },
    { phase: "reviewer", session_id: "workbench_session_R" },
  ],
  unresolved: null,
};

const ENVELOPE_FIELDS = ["id", "session_id", "agent_name", "timestamp"];

function bodies(view: readonly GuestEntry[]): Record<string, unknown>[] {
  return view.map((projected) =>
    Object.fromEntries(
      Object.entries(projected).filter(
        ([field]) => !ENVELOPE_FIELDS.includes(field),
      ),
    ),
  );
}

function entry(id: number, fields: Record<string, unknown>): MemberEntry {
  return {
    id: `entry_${id}`,
    parentId: null,
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    session_id: SESSION_ID,
    agent_name: AGENT_NAME,
    ...fields,
  } as MemberEntry;
}

function message(id: number, role: string, content: unknown): MemberEntry {
  return entry(id, { type: "message", message: { role, content } });
}

function customMessage(
  id: number,
  customType: string,
  content: string,
  details: unknown,
): MemberEntry {
  return entry(id, { type: "custom_message", customType, content, details });
}

function recordEntry(id: number, data: unknown): MemberEntry {
  return entry(id, {
    type: "custom",
    customType: "kanthord.workbench.record",
    data,
  });
}

test("security: guest view keeps the plan as Markdown and redacts the phase transcripts", () => {
  const view = projectEntries([
    customMessage(1, WORKBENCH_PLAN_ENTRY, "# Plan", PLAN_DETAILS),
    {
      ...message(2, "assistant", [{ type: "text", text: "planner text" }]),
      phase: "planner",
    },
    {
      ...message(3, "assistant", [{ type: "text", text: "reviewer text" }]),
      phase: "reviewer",
    },
  ]);
  assert.deepEqual(bodies(view), [{ kind: "plan", markdown: "# Plan" }]);
});

test("security: guest view redacts tool results, relays, thinking, configuration and denied records", () => {
  const view = projectEntries([
    message(1, "user", [{ type: "text", text: "hello" }]),
    message(2, "assistant", [
      { type: "thinking", thinking: SECRET },
      { type: "text", text: "I look." },
      {
        type: "toolCall",
        id: "call_1",
        name: "mission_get",
        arguments: { token: SECRET },
      },
    ]),
    message(3, "toolResult", [{ type: "text", text: SECRET }]),
    customMessage(4, "kanthord.workbench.relay", SECRET, undefined),
    entry(5, {
      type: "custom",
      customType: "kanthord.workbench.configuration",
      data: { agent_provider: SECRET },
    }),
    entry(6, { type: "thinking_level_change", thinkingLevel: SECRET }),
    recordEntry(7, { kind: WorkbenchRecordKind.AutoMode, enabled: true }),
    recordEntry(8, {
      kind: WorkbenchRecordKind.Guard,
      tool_call_id: "call_1",
      operation_id: "project.pause",
      reason: SECRET,
    }),
  ]);
  assert.deepEqual(bodies(view), [
    { kind: "user", text: "hello" },
    {
      kind: "assistant",
      content: [
        { type: "text", text: "I look." },
        { type: "toolCall", name: "mission_get" },
      ],
    },
  ]);
  assert.equal(JSON.stringify(view).includes(SECRET), false);
});

test("security: guest view of a fork redacts the prefix, the source session id and the ack", async () => {
  const pi = await loadPi();
  const manager = pi.SessionManager.inMemory();
  appendForkOpening(manager, {
    model: MODEL,
    sourceId: SOURCE_ID,
    summary: SUMMARY,
  });
  appendRecord(manager, {
    kind: WorkbenchRecordKind.Fork,
    source_title: "Billing",
  });
  const entries = manager.getEntries() as SessionEntry[];
  const view = projectEntries(
    mergeEntries([{ sessionId: SESSION_ID, agentName: AGENT_NAME, entries }]),
  );
  assert.deepEqual(bodies(view), [
    { kind: "summary", text: SUMMARY },
    { kind: "fork", source_title: "Billing" },
  ]);
  const text = JSON.stringify(view);
  assert.equal(text.includes(SOURCE_ID), false);
  assert.equal(text.includes("Forked from"), false);
  assert.equal(text.includes(WORKBENCH_FORK_ACK), false);
});

test("security: guest view redacts the result of an evidence_read call", () => {
  const view = projectEntries([
    message(1, "assistant", [
      {
        type: "toolCall",
        id: "call_1",
        name: "evidence_read",
        arguments: { asset_id: "asset_1" },
      },
    ]),
    entry(2, {
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "call_1",
        toolName: "evidence_read",
        content: [{ type: "text", text: EVIDENCE_RESULT }],
      },
    }),
    message(3, "assistant", [{ type: "text", text: "I read it." }]),
  ]);
  assert.equal(JSON.stringify(view).includes(EVIDENCE_RESULT), false);
  assert.deepEqual(bodies(view), [
    {
      kind: "assistant",
      content: [{ type: "toolCall", name: "evidence_read" }],
    },
    {
      kind: "assistant",
      content: [{ type: "text", text: "I read it." }],
    },
  ]);
});

test("security: projectStreaming redacts thinking and tool input", () => {
  const streaming = projectStreaming({
    role: "assistant",
    content: [
      { type: "thinking", thinking: SECRET },
      { type: "text", text: "Looking" },
      { type: "toolCall", name: "mission_get", arguments: { token: SECRET } },
    ],
  });
  assert.deepEqual(streaming, {
    content: [
      { type: "text", text: "Looking" },
      { type: "toolCall", name: "mission_get" },
    ],
  });
  assert.equal(projectStreaming(null), null);
});

test("guest view projects a note, an action card and its result lines", () => {
  const view = projectEntries([
    recordEntry(1, { kind: WorkbenchRecordKind.Note, text: "Ask Mai." }),
    recordEntry(2, {
      kind: WorkbenchRecordKind.ActionOffer,
      tool_call_id: "call_1",
      operation_id: "project.pause",
      target_id: "project_X",
      seen: { name: SECRET, paused: false },
    }),
    customMessage(3, WORKBENCH_ACTION_RESULT_ENTRY, SECRET, {
      tool_call_id: "call_1",
      outcome: "done",
      error_code: null,
    }),
    customMessage(4, WORKBENCH_ACTION_RESULT_ENTRY, SECRET, {
      tool_call_id: "call_1",
      outcome: "failed",
      error_code: "project.pause.refused",
    }),
    customMessage(5, WORKBENCH_ACTION_RESULT_ENTRY, SECRET, {
      tool_call_id: "call_1",
      outcome: "failed",
      error_code: null,
    }),
  ]);
  assert.deepEqual(bodies(view), [
    { kind: "note", text: "Ask Mai." },
    {
      kind: "action_offer",
      tool_call_id: "call_1",
      operation_id: "project.pause",
      target_id: "project_X",
    },
    {
      kind: "action_result",
      tool_call_id: "call_1",
      text: "Done by the owner.",
    },
    {
      kind: "action_result",
      tool_call_id: "call_1",
      text: "Failed: project.pause.refused.",
    },
    { kind: "action_result", tool_call_id: "call_1", text: "Failed." },
  ]);
  assert.equal(JSON.stringify(view).includes(SECRET), false);
});
