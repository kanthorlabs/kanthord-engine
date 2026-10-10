import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { createIdentity } from "../../kernel/identity.ts";
import { temporary } from "../../kernel/test-support.ts";
import { fileTranscript, TRANSCRIPT_RETENTION } from "./transcript-file.ts";

const PRIVATE_FILE_MODE = 0o600;
const EXTRA_EXECUTIONS = 2;
const SECONDS_STEP = 10;

function entry(executionId: string, text: string) {
  return {
    executionId,
    attempt: 1,
    traceId: "trace",
    messages: [{ role: "assistant", content: text }],
  };
}

test("the file transcript appends one private JSONL file for each execution", (t) => {
  const state = temporary(t);
  const sink = fileTranscript(state);
  const executionId = createIdentity("execution");
  sink.record(entry(executionId, "first agent"));
  sink.record(entry(executionId, "second agent"));
  const path = join(state, "transcripts", `${executionId}.jsonl`);
  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.deepEqual(
    lines.map((line) => JSON.parse(line).messages[0].content),
    ["first agent", "second agent"],
  );
  assert.equal(statSync(path).mode & 0o7777, PRIVATE_FILE_MODE);
});

test("the file transcript keeps only the newest executions", (t) => {
  const state = temporary(t);
  const sink = fileTranscript(state);
  const directory = join(state, "transcripts");
  const ids: string[] = [];
  for (
    let index = 0;
    index < TRANSCRIPT_RETENTION + EXTRA_EXECUTIONS;
    index++
  ) {
    const executionId = createIdentity("execution");
    ids.push(executionId);
    sink.record(entry(executionId, "agent"));
    const seconds = index * SECONDS_STEP;
    utimesSync(join(directory, `${executionId}.jsonl`), seconds, seconds);
  }
  const kept = readdirSync(directory);
  assert.equal(kept.length, TRANSCRIPT_RETENTION);
  for (const executionId of ids.slice(0, EXTRA_EXECUTIONS))
    assert.ok(!kept.includes(`${executionId}.jsonl`));
});
