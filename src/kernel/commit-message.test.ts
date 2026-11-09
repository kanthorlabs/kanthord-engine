import assert from "node:assert/strict";
import { test } from "node:test";
import {
  COMMIT_HEADER_MAX_LENGTH,
  commitHeader,
  commitMessage,
  CommitType,
  isCommitHeader,
  isCommitMessage,
} from "./commit-message.ts";

const UNIT_ID = "task_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const STOPPED_HEADER = "feat: a";
const EMOJI = "\u{1F600}";
const HIGH_SURROGATE = /[\uD800-\uDBFF]$/;
const KEPT_HEADER = "fix: keep the session";
const ADDED_HEADER = "feat: add the form";

test("the header lowers the first letter and removes a final full stop", () => {
  assert.equal(commitHeader(CommitType.Fix, "Keep the session."), KEPT_HEADER);
  assert.equal(
    commitHeader(CommitType.Feat, "  Add\n the   form "),
    ADDED_HEADER,
  );
});

test("the header removes every final full stop and space", () => {
  for (const subject of ["a..", "a. .", "A . . "])
    assert.equal(commitHeader(CommitType.Feat, subject), STOPPED_HEADER);
});

test("the cut keeps no half of a surrogate pair", () => {
  const prefix = `${CommitType.Feat}: `;
  const room = COMMIT_HEADER_MAX_LENGTH - prefix.length;
  const header = commitHeader(
    CommitType.Feat,
    `${"a".repeat(room - 1)}${EMOJI}`,
  );
  assert.equal(header, `${prefix}${"a".repeat(room - 1)}`);
  assert.equal(HIGH_SURROGATE.test(header), false);
  assert.equal(header.isWellFormed(), true);
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
    "feat: add.",
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
