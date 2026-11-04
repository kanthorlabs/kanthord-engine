import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  type SessionReadEntry,
  SessionReadOutcome,
  type SessionReadResult,
  WorkerErrorCode,
} from "../../worker/contract.ts";
import { EXCHANGE_UNAVAILABLE, ExchangeFailure } from "./instance-exchange.ts";
import { SessionReads } from "./session-reads.ts";

const SESSION_ID = "0123456789abcdef";
const ENTRY_ID = "a1b2c3d4";
const ENTRY_TYPE = "message";
const RETRY_MS = 1;
const FAILED_REPORTS = 2;
const NOT_FOUND = 404;
const TWO_REPORTS = 2;
const ONE_REPORT = 1;
const ONE_KEY = 1;
const SETTLE_MS = RETRY_MS * 10;
const ENTRY_TEXT = "full entry text";
const ENTRY = {
  type: ENTRY_TYPE,
  id: ENTRY_ID,
  parentId: null,
  message: { role: "assistant", content: [{ type: "text", text: ENTRY_TEXT }] },
};

interface Report {
  readId: string;
  result: SessionReadResult;
  idempotencyKey: string;
}

function readsFixture(
  t: TestContext,
  fail: (attempt: number) => Error | null = () => null,
) {
  const root = join(temporary(t), "sessions");
  const executionId = createIdentity("execution");
  const directory = join(root, "execution", executionId);
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, `2026-11-04T00-00-00-000Z_${SESSION_ID}.jsonl`),
    `${JSON.stringify(ENTRY)}\n`,
  );
  const reports: Report[] = [];
  const logs: Record<string, unknown>[] = [];
  let attempts = 0;
  const controller = new AbortController();
  t.after(() => controller.abort());
  const reads = new SessionReads({
    sessionRoot: root,
    signal: controller.signal,
    retryMs: RETRY_MS,
    report: async (readId, result, idempotencyKey) => {
      const failure = fail(attempts++);
      reports.push({ readId, result, idempotencyKey });
      if (failure) throw failure;
    },
    log: (record) => logs.push(record),
  });
  const entry = (
    readId = createIdentity("session_read"),
    entryId = ENTRY_ID,
  ): SessionReadEntry => ({
    read_id: readId,
    execution_id: executionId,
    session_id: SESSION_ID,
    entry_id: entryId,
    entry_type: ENTRY_TYPE,
  });
  return { reads, reports, logs, entry, controller };
}

async function drained(reports: Report[], count: number): Promise<void> {
  while (reports.length < count)
    await new Promise((resolve) => setImmediate(resolve));
}

test("each listed session read runs once, also while it runs and after its report, and reports its outcome", async (t) => {
  const f = readsFixture(t);
  const found = f.entry();
  const absent = f.entry(undefined, "e5f6a7b8");
  f.reads.sync([found, absent]);
  f.reads.sync([found, absent]);
  await drained(f.reports, TWO_REPORTS);
  f.reads.sync([found, absent]);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  assert.equal(f.reports.length, TWO_REPORTS);
  const byId = new Map(f.reports.map((report) => [report.readId, report]));
  assert.deepEqual(byId.get(found.read_id)?.result, {
    outcome: SessionReadOutcome.Resolved,
    entry: ENTRY,
  });
  assert.deepEqual(byId.get(absent.read_id)?.result, {
    outcome: SessionReadOutcome.EntryAbsent,
  });
});

test("a report failure of an indeterminate answer repeats with the same idempotency key", async (t) => {
  const f = readsFixture(t, (attempt) =>
    attempt < FAILED_REPORTS
      ? new ExchangeFailure(EXCHANGE_UNAVAILABLE, "indeterminate", null)
      : null,
  );
  f.reads.sync([f.entry()]);
  await drained(f.reports, FAILED_REPORTS + 1);
  assert.equal(
    new Set(f.reports.map((report) => report.idempotencyKey)).size,
    ONE_KEY,
  );
  assert.deepEqual(f.logs, []);
});

test("a refused report stops, and the log record holds no entry content", async (t) => {
  const f = readsFixture(
    t,
    () =>
      new ExchangeFailure(
        WorkerErrorCode.SessionReadNotFound,
        NOT_FOUND.toString(),
        NOT_FOUND,
      ),
  );
  const listed = f.entry();
  f.reads.sync([listed]);
  await drained(f.reports, ONE_REPORT);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  assert.equal(f.reports.length, ONE_REPORT);
  assert.deepEqual(f.logs, [
    {
      msg: "Worker instance session read report failed",
      read_id: listed.read_id,
      outcome: SessionReadOutcome.Resolved,
      code: WorkerErrorCode.SessionReadNotFound,
    },
  ]);
  assert.ok(!JSON.stringify(f.logs).includes(ENTRY_TEXT));
});

test("a sync after the stop signal runs no read", async (t) => {
  const f = readsFixture(t);
  f.controller.abort();
  f.reads.sync([f.entry()]);
  await new Promise((resolve) => setTimeout(resolve, SETTLE_MS));
  assert.deepEqual(f.reports, []);
});
