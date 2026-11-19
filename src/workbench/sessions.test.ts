import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { test } from "node:test";
import { loadPi } from "../agent/pi.ts";
import { temporary } from "../kernel/test-support.ts";
import {
  WORKBENCH_RECORD_ENTRY,
  type WorkbenchRecord,
  WorkbenchRecordKind,
} from "./contract.ts";
import { appendRecord, recordOf, variantSessionDirectory } from "./sessions.ts";

const NO_ENTRIES: unknown[] = [];
const VALID_RECORD: WorkbenchRecord = {
  kind: WorkbenchRecordKind.ActionOffer,
  tool_call_id: "call_1",
  operation_id: "project.pause",
  target_id: "project_X",
  seen: { name: "Billing", paused: false },
};

function recordEntry(data: unknown) {
  return {
    type: "custom",
    id: "entry_1",
    parentId: null,
    timestamp: "2026-01-01T00:00:00.000Z",
    customType: WORKBENCH_RECORD_ENTRY,
    data,
  };
}

test("security: recordOf answers null for a record entry whose data fails the schema", () => {
  assert.equal(
    recordOf(recordEntry({ ...VALID_RECORD, kind: "unknown" })),
    null,
  );
  assert.equal(recordOf(recordEntry({ ...VALID_RECORD, extra: 1 })), null);
  assert.equal(recordOf(recordEntry(undefined)), null);
});

test("invariant guard: appendRecord throws on invalid data and appends nothing", async () => {
  const pi = await loadPi();
  const manager = pi.SessionManager.inMemory();
  const invalid = { ...VALID_RECORD, extra: 1 } as unknown as WorkbenchRecord;
  assert.throws(() => appendRecord(manager, invalid));
  assert.deepEqual(manager.getEntries(), NO_ENTRIES);
});

test("variantSessionDirectory names the variant directory and creates nothing", (t) => {
  const state = temporary(t);
  const directory = variantSessionDirectory(state, {
    agentName: "ops@1",
    variantId: "agent_variant_X",
  });
  assert.ok(directory.endsWith("/sessions/workbench/ops@1/agent_variant_X"));
  assert.equal(existsSync(directory), false);
});
