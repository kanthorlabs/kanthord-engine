import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMIT_HEADER_MAX_LENGTH,
  CommitType,
  commitHeader,
  commitMessage,
  commitTypeOf,
  isCommitHeader,
  isCommitMessage,
} from "./commit-message.ts";

const UNIT_ID = "task_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const KEPT_HEADER = "fix: keep the session";
const ADDED_HEADER = "feat: add the form";

test("an absent commit type reads as feat", () => {
  assert.equal(commitTypeOf(undefined), CommitType.Feat);
  assert.equal(commitTypeOf(CommitType.Docs), CommitType.Docs);
});

test("the header lowers the first letter and removes a final full stop", () => {
  assert.equal(commitHeader(CommitType.Fix, "Keep the session."), KEPT_HEADER);
  assert.equal(
    commitHeader(CommitType.Feat, "  Add\n the   form "),
    ADDED_HEADER,
  );
});

test("the header is cut to 100 characters", () => {
  const header = commitHeader(CommitType.Refactor, `Move ${"x".repeat(200)}`);
  assert.equal(header.length, COMMIT_HEADER_MAX_LENGTH);
  assert.ok(header.startsWith("refactor: move x"));
});

test("a subject with no text fails the header rule", () => {
  assert.throws(() => commitHeader(CommitType.Feat, "."));
  assert.throws(() => commitHeader(CommitType.Feat, " "));
});

test("the header rule accepts a type, an optional scope and a subject", () => {
  for (const header of ["feat: add", "fix(worker): keep", "chore: merge main"])
    assert.equal(isCommitHeader(header), true, header);
  for (const header of [
    "kanthord: task task_1 attempt 1",
    "kanthord node_1",
    "feat:add",
    "feat: ",
    "build: add",
    `feat: ${"x".repeat(COMMIT_HEADER_MAX_LENGTH)}`,
  ])
    assert.equal(isCommitHeader(header), false, header);
});

test("the message holds the header, a blank line and the unit id", () => {
  assert.equal(
    commitMessage(CommitType.Test, "Cover the form", UNIT_ID),
    `test: cover the form\n\n${UNIT_ID}`,
  );
  assert.throws(() => commitMessage(CommitType.Test, "Cover", "Key: value"));
  assert.equal(isCommitMessage(`feat: add\n\n${UNIT_ID}`), true);
  assert.equal(isCommitMessage("kanthord: task task_1 attempt 1"), false);
});
