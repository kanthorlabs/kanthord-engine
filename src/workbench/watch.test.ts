import assert from "node:assert/strict";
import { test } from "node:test";
import { CancellationContext } from "../kernel/context.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { type Operation, OperationResultType } from "../kernel/operation.ts";
import { missionOperations, NodeState } from "../mission/contract.ts";
import {
  type NoticeRecord,
  type SessionEntry,
  WORKBENCH_RECORD_ENTRY,
  WORKBENCH_WATCH_CHECK_MS,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "./contract.ts";
import { recordOf } from "./sessions.ts";
import { WatchChecker, type WatchConversation } from "./watch.ts";

const CONVERSATION_ID = "workbench_session_A";
const PROJECT_NAME = "shop";
const START_MS = 1_000_000;
const ENDED_MS = 500_000;
const TEST_TIMEOUT_MS = 10_000;
const NODE_GET = missionOperations["node.get"].id;
const OUTCOME_LIST = missionOperations["outcome.list"].id;
const PAIR = 2;
const SINGLE = 1;
const NO_ITEMS = 0;
const ERROR_STATUS = 500;

interface NodeScript {
  name: string;
  state: string;
  retired_at: number | null;
  fail?: true;
}

function harness() {
  const projectId = createIdentity("project");
  const nodes = new Map<string, NodeScript>();
  const calls: string[] = [];
  const holds: Promise<void>[] = [];
  const entries: SessionEntry[] = [];
  const clock = { now: START_MS };
  const nodeId = (script: Partial<NodeScript> = {}): string => {
    const id = createIdentity("node");
    nodes.set(id, {
      name: `node ${nodes.size}`,
      state: NodeState.Completed,
      retired_at: null,
      ...script,
    });
    return id;
  };
  const invoke = async (operation: Operation, input: unknown) => {
    calls.push(operation.id);
    const held = holds.shift();
    if (held !== undefined) await held;
    const { params } = input as { params: { node_id: string } };
    const script = nodes.get(params.node_id)!;
    if (script.fail === true)
      return {
        type: OperationResultType.Failure,
        status: ERROR_STATUS,
        error: {
          error: { code: "mission.test", message: "failed", details: null },
          request_id: createIdentity("request"),
        },
      } as const;
    const data =
      operation.id === OUTCOME_LIST
        ? { items: [{ created_at: ENDED_MS }], next_cursor: null }
        : {
            state: script.state,
            retired_at: script.retired_at,
            content: { name: script.name },
          };
    return { type: OperationResultType.Completed, status: 200, data } as const;
  };
  const append = (record: WorkbenchRecord): string => {
    const id = `entry_${entries.length}`;
    entries.push({
      type: "custom",
      customType: WORKBENCH_RECORD_ENTRY,
      data: record,
      id,
      parentId: null,
      timestamp: new Date(clock.now).toISOString(),
    });
    return id;
  };
  const conversation: WatchConversation = {
    id: CONVERSATION_ID,
    entries: () => entries,
    append: (record) => void append(record),
  };
  const checker = new WatchChecker({
    invoke,
    projectOf: () => projectId,
    projectNames: () => new Map([[projectId, PROJECT_NAME]]),
    now: () => clock.now,
  });
  const options = () => ({
    identity: testHumanIdentity("account", "Account", "token"),
    context: new CancellationContext(),
  });
  const watch = (...nodeIds: string[]): string =>
    append({ kind: WorkbenchRecordKind.Watch, node_ids: nodeIds });
  const notices = (): NoticeRecord[] =>
    entries.flatMap((entry) => {
      const record = recordOf(entry);
      return record?.kind === WorkbenchRecordKind.Notice ? [record] : [];
    });
  const count = (operationId: string): number =>
    calls.filter((id) => id === operationId).length;
  return {
    nodeId,
    calls,
    holds,
    entries,
    clock,
    conversation,
    checker,
    options,
    watch,
    notices,
    count,
  };
}

test(
  "two concurrent checks append one notice and read once",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const h = harness();
    h.watch(h.nodeId(), h.nodeId());
    await Promise.all([
      h.checker.check(h.conversation, h.options()),
      h.checker.check(h.conversation, h.options()),
    ]);
    assert.equal(h.notices().length, SINGLE);
    assert.equal(h.count(NODE_GET), PAIR);
    assert.equal(h.count(OUTCOME_LIST), PAIR);
  },
);

test(
  "a watch appended during a check stays open for the next check",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const h = harness();
    const first = h.watch(h.nodeId());
    let release: () => void = () => undefined;
    h.holds.push(new Promise<void>((resolve) => (release = resolve)));
    const running = h.checker.check(h.conversation, h.options());
    const second = h.watch(h.nodeId());
    release();
    await running;
    assert.deepEqual(
      h.notices().map((notice) => notice.watch_entry_id),
      [first],
    );
    h.clock.now += WORKBENCH_WATCH_CHECK_MS;
    await h.checker.check(h.conversation, h.options());
    assert.deepEqual(
      h.notices().map((notice) => notice.watch_entry_id),
      [first, second],
    );
  },
);

test(
  "a failed node read gives no notice and no error",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const h = harness();
    h.watch(h.nodeId({ fail: true }));
    const before = h.entries.length;
    await h.checker.check(h.conversation, h.options());
    assert.equal(h.entries.length, before);
    assert.equal(h.notices().length, NO_ITEMS);
  },
);

test(
  "a watch of one retired node gives no notice and is read again",
  { timeout: TEST_TIMEOUT_MS },
  async () => {
    const h = harness();
    h.watch(h.nodeId({ retired_at: ENDED_MS }));
    const before = h.entries.length;
    await h.checker.check(h.conversation, h.options());
    assert.equal(h.entries.length, before);
    h.clock.now += WORKBENCH_WATCH_CHECK_MS;
    await h.checker.check(h.conversation, h.options());
    assert.equal(h.count(NODE_GET), PAIR);
    assert.equal(h.notices().length, NO_ITEMS);
  },
);
