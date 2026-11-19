import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import { MissionErrorCode, missionOperations } from "../../mission/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { TasksOutput } from "../../worker/unit/index.ts";
import { uploadEvidence } from "./evidence-upload.ts";
import { localHostTools } from "./tasks-host-tools.ts";
import { testClaim } from "./test-support.ts";
import { httpTransport } from "./transport.ts";

const CAPTURED = "captured";
const LINK_UPDATE_COUNT = 3;

function methodClaim() {
  const claim = testClaim();
  return {
    execution_id: claim.execution_id,
    node_id: claim.node_id,
    attempt: claim.attempt,
    pinned_revision: claim.pinned_revision,
    node_branch: claim.node_branch,
    created_at: claim.created_at,
    expired_at: claim.expired_at,
    trace_id: "trace",
    root_span_id: "1".repeat(16),
  };
}

test("the CLI evidence upload records the operation and the body that the worker evidence upload sends", async (t) => {
  const workspace = temporary(t);
  await writeFile(join(workspace, "a.txt"), "evidence bytes");
  const api = httpTransport("http://127.0.0.1:1");
  const sent: unknown[] = [];
  t.mock.method(
    api.mission,
    "evidence.submit",
    async (input: { body: unknown }) => {
      sent.push(input.body);
      throw new Error(CAPTURED);
    },
  );
  await assert.rejects(
    uploadEvidence({
      workspace,
      path: "a.txt",
      claim: testClaim(),
      api,
      context: background,
    }),
    new RegExp(CAPTURED),
  );
  const output = TasksOutput.create(
    join(temporary(t), "out"),
    { credential: [], passed: [] },
    () => {},
  );
  const tools = localHostTools({
    output,
    claim: methodClaim(),
    linkUpdates: [],
  })(workspace);
  const result = await tools.evidenceUpload("a.txt", background.signal);
  assert.match(result.uri, /^s3:\/\//);
  assert.deepEqual(
    output.outbox().map((entry) => entry.operation),
    [missionOperations["evidence.submit"].id],
  );
  assert.deepEqual(
    output.outbox().map((entry) => entry.body),
    sent,
  );
});

test("the CLI link update list pages over the seed and refuses a cursor that names no page", async (t) => {
  const output = TasksOutput.create(
    join(temporary(t), "out"),
    { credential: [], passed: [] },
    () => {},
  );
  const items = Array.from({ length: LINK_UPDATE_COUNT }, (_, index) => ({
    index,
  })) as unknown as Parameters<typeof localHostTools>[0]["linkUpdates"];
  const tools = localHostTools({
    output,
    claim: methodClaim(),
    linkUpdates: items,
  })(temporary(t));
  const first = await tools.linkUpdateList({ limit: 2 }, background.signal);
  assert.deepEqual(first, {
    items: items.slice(0, 2),
    next_cursor: "2",
    total: LINK_UPDATE_COUNT,
  });
  const last = await tools.linkUpdateList(
    { cursor: "2", limit: 2 },
    background.signal,
  );
  assert.equal(last.next_cursor, null);
  for (const cursor of ["x", "-1", "1.5", "9"])
    await assert.rejects(
      tools.linkUpdateList({ cursor, limit: 2 }, background.signal),
      {
        code: MissionErrorCode.CursorInvalid,
      },
    );
  assert.ok(
    output
      .outbox()
      .every(
        (entry) =>
          entry.operation === workerOperations["execution.link_update.get"].id,
      ),
  );
});
