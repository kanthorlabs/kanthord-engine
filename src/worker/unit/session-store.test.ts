import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createIdentity } from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import { SESSION_ENTRY_FULL_MAX_BYTES } from "../../tracking/contract.ts";
import { type SessionRead, SessionReadOutcome } from "../contract.ts";
import {
  executionSessionDirectory,
  readSessionFileEntry,
} from "./session-store.ts";

const DIRECTORY_MODE_MASK = 0o7777;
const PRIVATE_DIRECTORY_MODE = 0o700;
const FORMER_KEPT_COUNT = 50;
const CHUNK_BYTES = 65536;
const CHUNK_COUNT_ABOVE_BOUND = 512;
const NEEDLE_LEAD = 3;
const PARSED_HEAD_LENGTH = 40;
const SESSION_ID = "0123456789abcdef";
const OTHER_SESSION_ID = "fedcba9876543210";
const ENTRY_ID = "a1b2c3d4";
const OTHER_ENTRY_ID = "e5f6a7b8";
const ENTRY_TYPE = "message";
const SECRET_TEXT = "foreign-session-content";
const signal = new AbortController().signal;

function entryLine(entry: Record<string, unknown>): string {
  return `${JSON.stringify(entry)}\n`;
}

const ENTRY = {
  type: ENTRY_TYPE,
  id: ENTRY_ID,
  parentId: null,
  timestamp: "2026-11-04T00:00:00.000Z",
  message: { role: "assistant", content: [{ type: "text", text: "full" }] },
};

function sessionFixture(t: TestContext) {
  const root = join(temporary(t), "sessions");
  const executionId = createIdentity("execution");
  const directory = join(root, "execution", executionId);
  mkdirSync(directory, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  const read: SessionRead = {
    execution_id: executionId,
    session_id: SESSION_ID,
    entry_id: ENTRY_ID,
    entry_type: ENTRY_TYPE,
  };
  const file = (sessionId = SESSION_ID, stamp = "2026-11-04T00-00-00-000Z") =>
    join(directory, `${stamp}_${sessionId}.jsonl`);
  return { root, directory, read, file };
}

test("an execution directory has mode 0700 under the session root", (t) => {
  const root = join(temporary(t), "sessions");
  const id = createIdentity("execution");
  const directory = executionSessionDirectory(root, id);
  assert.equal(directory, join(root, id));
  assert.equal(
    statSync(directory).mode & DIRECTORY_MODE_MASK,
    PRIVATE_DIRECTORY_MODE,
  );
});

test("a new execution directory after 50 directories keeps every directory", (t) => {
  const root = join(temporary(t), "sessions");
  const seeded = Array.from({ length: FORMER_KEPT_COUNT }, () =>
    executionSessionDirectory(root, createIdentity("execution")),
  );
  const directory = executionSessionDirectory(
    root,
    createIdentity("execution"),
  );
  assert.equal(readdirSync(root).length, FORMER_KEPT_COUNT + 1);
  for (const kept of [...seeded, directory]) assert.ok(existsSync(kept));
});

test("an invalid execution identity throws", (t) => {
  const root = join(temporary(t), "sessions");
  assert.throws(() => executionSessionDirectory(root, "../escape"));
  assert.throws(() =>
    executionSessionDirectory(root, "node_01ARZ3NDEKTSV4RRFFQ69G5FAA"),
  );
  assert.equal(existsSync(root), false);
});

test("a session read answers the entry with the identity and the type", async (t) => {
  const { root, read, file } = sessionFixture(t);
  writeFileSync(
    file(),
    entryLine({ type: "session", id: SESSION_ID, version: 3 }) +
      entryLine({ ...ENTRY, type: "custom", id: OTHER_ENTRY_ID }) +
      entryLine(ENTRY),
  );
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.Resolved,
    entry: ENTRY,
  });
});

test("a session read without the session answers session_absent", async (t) => {
  const { root, directory, read, file } = sessionFixture(t);
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.SessionAbsent,
  });
  writeFileSync(file(OTHER_SESSION_ID), entryLine(ENTRY));
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.SessionAbsent,
  });
  assert.deepEqual(
    await readSessionFileEntry(
      root,
      { ...read, execution_id: createIdentity("execution") },
      signal,
    ),
    { outcome: SessionReadOutcome.SessionAbsent },
  );
  assert.deepEqual(
    await readSessionFileEntry(join(directory, "absent"), read, signal),
    { outcome: SessionReadOutcome.SessionAbsent },
  );
});

test("a symlinked execution directory or a symlinked root of the executions answers unreadable", async (t) => {
  const { root, directory, read, file } = sessionFixture(t);
  writeFileSync(file(), entryLine(ENTRY));
  const moved = join(temporary(t), "moved");
  renameSync(directory, moved);
  symlinkSync(moved, directory);
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.Unreadable,
  });
  const executions = join(temporary(t), "executions");
  mkdirSync(join(executions, read.execution_id), { recursive: true });
  writeFileSync(
    join(executions, read.execution_id, `x_${SESSION_ID}.jsonl`),
    entryLine(ENTRY),
  );
  const linkedRoot = join(temporary(t), "linked");
  mkdirSync(linkedRoot);
  symlinkSync(executions, join(linkedRoot, "execution"));
  assert.deepEqual(await readSessionFileEntry(linkedRoot, read, signal), {
    outcome: SessionReadOutcome.Unreadable,
  });
});

test("a symlinked session file is skipped", async (t) => {
  const { root, read, file } = sessionFixture(t);
  const foreign = join(temporary(t), "foreign.jsonl");
  writeFileSync(foreign, entryLine({ ...ENTRY, secret: SECRET_TEXT }));
  symlinkSync(foreign, file());
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.EntryAbsent,
  });
});

test("a FIFO with the session file name is skipped without a block", async (t) => {
  const { root, read, file } = sessionFixture(t);
  execFileSync("mkfifo", [file(SESSION_ID, "2026-11-03T00-00-00-000Z")]);
  writeFileSync(file(), entryLine(ENTRY));
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.Resolved,
    entry: ENTRY,
  });
});

test("an execution directory swapped for a symlink before the open answers unreadable and no foreign content", async (t) => {
  const { root, directory, read, file } = sessionFixture(t);
  writeFileSync(file(), entryLine({ ...ENTRY, type: "custom" }));
  const foreign = join(temporary(t), "foreign");
  mkdirSync(foreign);
  writeFileSync(
    join(foreign, `2026-11-04T00-00-00-000Z_${SESSION_ID}.jsonl`),
    entryLine({ ...ENTRY, secret: SECRET_TEXT }),
  );
  const result = await readSessionFileEntry(root, read, signal, {
    beforeOpen: () => {
      renameSync(directory, join(temporary(t), "kept"));
      symlinkSync(foreign, directory);
    },
  });
  assert.deepEqual(result, { outcome: SessionReadOutcome.Unreadable });
  assert.ok(!JSON.stringify(result).includes(SECRET_TEXT));
});

test("a file that grows during the read ends at its fstat size", async (t) => {
  const { root, read, file } = sessionFixture(t);
  writeFileSync(file(), entryLine({ ...ENTRY, type: "custom" }));
  const probe = await open(file());
  const prototype = Object.getPrototypeOf(probe) as {
    stat: (this: unknown) => Promise<unknown>;
  };
  await probe.close();
  const stat = prototype.stat;
  t.mock.method(prototype, "stat", async function (this: unknown) {
    const stats = await stat.call(this);
    appendFileSync(file(), entryLine(ENTRY));
    return stats;
  });
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.EntryAbsent,
  });
  assert.ok(readFileSync(file(), "utf8").endsWith(entryLine(ENTRY)));
});

test("a malformed line and a partly written last line are skipped", async (t) => {
  const { root, read, file } = sessionFixture(t);
  writeFileSync(
    file(),
    `{"type":"message","id":"${ENTRY_ID}"\n` +
      "[1, 2]\n" +
      "\n" +
      entryLine(ENTRY) +
      `{"type":"message","id":"${OTHER_ENTRY_ID}","par`,
  );
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.Resolved,
    entry: ENTRY,
  });
  assert.deepEqual(
    await readSessionFileEntry(
      root,
      { ...read, entry_id: OTHER_ENTRY_ID },
      signal,
    ),
    { outcome: SessionReadOutcome.EntryAbsent },
  );
});

function parsedTexts(t: TestContext): { bytes: number; head: string }[] {
  const texts: { bytes: number; head: string }[] = [];
  const parse = JSON.parse;
  t.mock.method(JSON, "parse", (text: string) => {
    texts.push({
      bytes: Buffer.byteLength(text, "utf8"),
      head: text.slice(0, PARSED_HEAD_LENGTH),
    });
    return parse(text);
  });
  return texts;
}

test("a line above the bound answers too_large with its byte length and is never parsed", async (t) => {
  const { root, read, file } = sessionFixture(t);
  const prefix = `{"type":"message","id":"${ENTRY_ID}","text":"`;
  const suffix = '"}';
  const line =
    prefix +
    "é".repeat((SESSION_ENTRY_FULL_MAX_BYTES - prefix.length) / 2) +
    suffix;
  const bytes = Buffer.byteLength(line, "utf8");
  assert.ok(bytes > SESSION_ENTRY_FULL_MAX_BYTES);
  writeFileSync(file(), `${line}\n${entryLine({ ...ENTRY, type: "custom" })}`);
  const texts = parsedTexts(t);
  assert.deepEqual(await readSessionFileEntry(root, read, signal), {
    outcome: SessionReadOutcome.TooLarge,
    bytes,
  });
  assert.ok(
    texts.every((parsed) => parsed.bytes <= SESSION_ENTRY_FULL_MAX_BYTES),
  );
  assert.ok(
    texts.every(({ head }) => head !== prefix.slice(0, PARSED_HEAD_LENGTH)),
  );
});

test("a custom_message above the bound with its content before the id answers too_large", async (t) => {
  const { root, read, file } = sessionFixture(t);
  const prefix = '{"type":"custom_message","customType":"note","content":"';
  const needleStart = CHUNK_COUNT_ABOVE_BOUND * CHUNK_BYTES - NEEDLE_LEAD;
  const content = "x".repeat(needleStart - prefix.length - '",'.length);
  const line = `${prefix}${content}","id":"${ENTRY_ID}","parentId":null}`;
  assert.equal(line.indexOf(`"id":"${ENTRY_ID}"`), needleStart);
  writeFileSync(file(), `${line}\n`);
  assert.deepEqual(
    await readSessionFileEntry(
      root,
      { ...read, entry_type: "custom_message" },
      signal,
    ),
    { outcome: SessionReadOutcome.TooLarge, bytes: line.length },
  );
  assert.deepEqual(
    await readSessionFileEntry(
      root,
      { ...read, entry_id: OTHER_ENTRY_ID, entry_type: "custom_message" },
      signal,
    ),
    { outcome: SessionReadOutcome.EntryAbsent },
  );
});

test("an aborted signal rejects the read", async (t) => {
  const { root, read, file } = sessionFixture(t);
  writeFileSync(file(), entryLine(ENTRY));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(readSessionFileEntry(root, read, controller.signal));
});
