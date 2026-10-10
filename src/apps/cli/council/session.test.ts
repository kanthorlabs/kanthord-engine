import assert from "node:assert/strict";
import { test } from "node:test";
import type {
  SessionEntry,
  SessionEvents,
} from "../../../workbench/contract.ts";
import { CouncilErrorCode } from "./contract.ts";
import {
  askInSession,
  SESSION_DEADLINE_MS,
  type WorkbenchPort,
} from "./session.ts";

const CONFIGURATION = {
  agent_provider: "main",
  model_identifier: "claude-sonnet-4-5",
  reasoning_effort: "medium",
} as const;
const FINAL_ANSWER = "final";
const ABORT_LOG = "abort";
const SESSION_ID = "workbench_session_01JABCDEFGHJKMNPQRSTVWXYZ0";

function snapshot(
  overrides: Partial<SessionEvents["snapshot"]>,
): SessionEvents {
  return {
    entries: [],
    version: 1,
    snapshot: {
      streaming_message: null,
      pending_tool_calls: [],
      pending_approval: null,
      run_active: false,
      error_message: null,
      ...overrides,
    },
  };
}

function assistant(text: string): SessionEntry {
  return {
    type: "message",
    id: "e2",
    parentId: "e1",
    timestamp: "2026-10-09T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text }] },
  };
}

function fakePort(events: SessionEvents[], entries: SessionEntry[]) {
  const log: string[] = [];
  const port: WorkbenchPort = {
    async create(agentName) {
      log.push(`create ${agentName}`);
      return SESSION_ID;
    },
    async message(_id, text) {
      log.push(`message ${text}`);
    },
    async events() {
      log.push("events");
      return events.shift() ?? snapshot({ run_active: true });
    },
    async entries() {
      return entries;
    },
    async abort() {
      log.push(ABORT_LOG);
    },
  };
  return { port, log };
}

test("askInSession returns the text of the last assistant message", async () => {
  const { port, log } = fakePort(
    [snapshot({ run_active: true }), snapshot({ run_active: false })],
    [assistant("first"), assistant(FINAL_ANSWER)],
  );
  assert.equal(
    await askInSession(port, "po@1", CONFIGURATION, "hello"),
    FINAL_ANSWER,
  );
  assert.deepEqual(log, ["create po@1", "message hello", "events", "events"]);
});

test("a pending approval aborts the run and fails the session", async () => {
  const { port, log } = fakePort(
    [
      snapshot({
        run_active: true,
        pending_approval: {
          tool_call_id: "t",
          operation_id: "project.create",
          input: {},
        },
      }),
    ],
    [],
  );
  await assert.rejects(askInSession(port, "po@1", CONFIGURATION, "hello"), {
    code: CouncilErrorCode.AgentSessionFailed,
  });
  assert.equal(log.at(-1), ABORT_LOG);
});

test("a run error fails the session", async () => {
  const { port } = fakePort([snapshot({ error_message: "quota" })], []);
  await assert.rejects(askInSession(port, "po@1", CONFIGURATION, "hello"), {
    code: CouncilErrorCode.AgentSessionFailed,
    message: /quota/,
  });
});

test("a run with no assistant text fails the session", async () => {
  const { port } = fakePort([snapshot({ run_active: false })], []);
  await assert.rejects(askInSession(port, "po@1", CONFIGURATION, "hello"), {
    code: CouncilErrorCode.AgentSessionFailed,
  });
});

test("a run past the deadline is aborted and fails the session", async () => {
  const { port, log } = fakePort([], []);
  let clock = 0;
  const now = () => (clock += SESSION_DEADLINE_MS);
  await assert.rejects(
    askInSession(port, "po@1", CONFIGURATION, "hello", now),
    {
      code: CouncilErrorCode.AgentSessionFailed,
    },
  );
  assert.equal(log.at(-1), ABORT_LOG);
});

test("a failed operation fails the session", async () => {
  const { port } = fakePort([], []);
  port.message = async () => {
    throw new Error("server stopped");
  };
  await assert.rejects(askInSession(port, "po@1", CONFIGURATION, "hello"), {
    code: CouncilErrorCode.AgentSessionFailed,
    message: /server stopped/,
  });
});
