import assert from "node:assert/strict";
import { test } from "node:test";
import { temporary } from "../../kernel/test-support.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SYNTHETIC_PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const EXIT_SUCCESS = 0;
const EXIT_FAILURE = 1;
const EMPTY_OUTPUT = "";
const EMPTY_TOKEN = "";
const SCHEDULER = "scheduler";
const QUEUE = "queue";
const LIST = "list";
const PEEK = "peek";
const INVALID_PROJECT_ID = "badid";
const LIMIT_OPTION = "--limit";
const INVALID_LIMIT = "1001";
const CURSOR_OPTION = "--cursor";
const MALFORMED_CURSOR = "dGVzdA";
const INVALID_PROJECT_ID_CODE = "cli.scheduler.queue.list.invalid_project_id:";
const TOKEN_REQUIRED_CODE = "cli.scheduler.queue.list.token_required:";
const LIMIT_OUT_OF_RANGE_CODE = "cli.pagination.limit_out_of_range:";
const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid:";

const EMPTY_LIST = { items: [], next_cursor: null };
const EMPTY_PEEK = { job: null };

test("E02.1 queue list returns empty items for an empty project", async (t) => {
  const fixture = await gatewayFixture(t);
  const result = await kanthord(
    [SCHEDULER, QUEUE, LIST, SYNTHETIC_PROJECT_ID],
    {
      ...environment(temporary(t)),
      KANTHORD_ENDPOINT: fixture.endpoint,
      KANTHORD_TOKEN: fixture.token,
    },
  );
  assert.equal(result.code, EXIT_SUCCESS, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), EMPTY_LIST);
  assert.equal(result.stderr, EMPTY_OUTPUT);
});

test("E02.2 queue peek returns null job for an empty project", async (t) => {
  const fixture = await gatewayFixture(t);
  const result = await kanthord(
    [SCHEDULER, QUEUE, PEEK, SYNTHETIC_PROJECT_ID],
    {
      ...environment(temporary(t)),
      KANTHORD_ENDPOINT: fixture.endpoint,
      KANTHORD_TOKEN: fixture.token,
    },
  );
  assert.equal(result.code, EXIT_SUCCESS, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), EMPTY_PEEK);
  assert.equal(result.stderr, EMPTY_OUTPUT);
});

test("E02.3 invalid project-id refusal", async (t) => {
  const fixture = await gatewayFixture(t);
  const result = await kanthord([SCHEDULER, QUEUE, LIST, INVALID_PROJECT_ID], {
    ...environment(temporary(t)),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  });
  assert.equal(result.code, EXIT_FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(INVALID_PROJECT_ID_CODE), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
});

test("E02.4 missing token refusal", async (t) => {
  const fixture = await gatewayFixture(t);
  const result = await kanthord(
    [SCHEDULER, QUEUE, LIST, SYNTHETIC_PROJECT_ID],
    {
      ...environment(temporary(t)),
      KANTHORD_ENDPOINT: fixture.endpoint,
      KANTHORD_TOKEN: EMPTY_TOKEN,
    },
  );
  assert.equal(result.code, EXIT_FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(TOKEN_REQUIRED_CODE), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
});

test("E02.5 limit out of range refusal", async (t) => {
  const fixture = await gatewayFixture(t);
  const result = await kanthord(
    [SCHEDULER, QUEUE, LIST, SYNTHETIC_PROJECT_ID, LIMIT_OPTION, INVALID_LIMIT],
    {
      ...environment(temporary(t)),
      KANTHORD_ENDPOINT: fixture.endpoint,
      KANTHORD_TOKEN: fixture.token,
    },
  );
  assert.equal(result.code, EXIT_FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(LIMIT_OUT_OF_RANGE_CODE), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
});

test("E02.6 malformed cursor refusal", async (t) => {
  const fixture = await gatewayFixture(t);
  const result = await kanthord(
    [
      SCHEDULER,
      QUEUE,
      LIST,
      SYNTHETIC_PROJECT_ID,
      CURSOR_OPTION,
      MALFORMED_CURSOR,
    ],
    {
      ...environment(temporary(t)),
      KANTHORD_ENDPOINT: fixture.endpoint,
      KANTHORD_TOKEN: fixture.token,
    },
  );
  assert.equal(result.code, EXIT_FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(CURSOR_INVALID_CODE), result.stderr);
  assert.equal(result.stdout, EMPTY_OUTPUT);
});
