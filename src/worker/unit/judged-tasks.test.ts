import assert from "node:assert/strict";
import { test } from "node:test";
import { temporary } from "../../kernel/test-support.ts";
import { headSetOf, judgedAt, recordJudged } from "./judged-tasks.ts";

const API = {
  binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAA",
  name: "api",
  directory: "/w/checkouts/api",
  head: "a".repeat(40),
};
const WEB = {
  binding_id: "binding_01ARZ3NDEKTSV4RRFFQ69G5FAB",
  name: "web",
  directory: "/w/checkouts/web",
  head: "b".repeat(40),
};
const TASK = {
  attempt: 1,
  revision: 1,
  taskId: "task_01ARZ3NDEKTSV4RRFFQ69G5FAA",
};

test("one binding stores the commit", (t) => {
  const directory = temporary(t);
  assert.equal(headSetOf([API]), API.head);
  recordJudged(directory, TASK, headSetOf([API]));
  assert.equal(judgedAt(directory, TASK), API.head);
});

test("the judged value is name=commit,... in binding order", (t) => {
  const directory = temporary(t);
  const headSet = headSetOf([API, WEB]);
  assert.equal(headSet, `api=${API.head},web=${WEB.head}`);
  assert.equal(headSetOf([WEB, API]), `web=${WEB.head},api=${API.head}`);
  recordJudged(directory, TASK, headSet);
  assert.equal(judgedAt(directory, TASK), headSet);
  assert.notEqual(
    judgedAt(directory, TASK),
    headSetOf([API, { ...WEB, head: "c".repeat(40) }]),
  );
});
