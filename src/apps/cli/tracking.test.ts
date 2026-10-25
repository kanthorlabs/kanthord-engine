import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HttpMethod, HttpStatus } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import { TRACE_QUERY_MAX_CHARACTERS } from "../../tracking/contract.ts";
import { ExitCode } from "./constants.ts";
import { runKanthord } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRACE_LIST_PATH = "/api/tracking/trace";
const FACET_GET_PATH = "/api/tracking/facet";
const LIST_ANSWER = { items: [], next_cursor: null };
const FACET_ANSWER = {
  worker_names: ["worker-one"],
  agent_names: ["coder"],
  models: ["qwen"],
  error_types: [],
};
const NO_REQUESTS = 0;
const ONE_REQUEST = 1;
const LIMIT_LISTED = "10";
const LIMIT_TOO_LARGE = "1001";
const LIMIT_NOT_NUMBER = "many";

interface Seen {
  method: string | undefined;
  url: string | undefined;
}

async function fakeServer(
  t: TestContext,
  answer: unknown,
  status: number = HttpStatus.OK,
): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(status, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

async function run(t: TestContext, args: string[], endpoint: string) {
  const directory = temporary(t);
  return runKanthord(
    ["tracking", ...args, "--endpoint", endpoint, "--token", "human"],
    {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      KANTHORD_ENDPOINT: undefined,
      KANTHORD_TOKEN: undefined,
    },
    t.signal,
  );
}

test("trace list sends its filters as query fields and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(
    t,
    [
      "trace",
      "list",
      "--project",
      PROJECT_ID,
      "--node",
      NODE_ID,
      "--state",
      "open",
      "--query",
      "qwen",
      "--sort",
      "cost_usd",
      "--limit",
      LIMIT_LISTED,
      "--cursor",
      "opaque",
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, TRACE_LIST_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    project_id: PROJECT_ID,
    node_id: NODE_ID,
    state: "open",
    q: "qwen",
    sort: "cost_usd",
    limit: LIMIT_LISTED,
    cursor: "opaque",
  });
  assert.deepEqual(JSON.parse(result.stdout), LIST_ANSWER);
});

test("trace list sends from and to as query fields", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(
    t,
    ["trace", "list", "--from", "1000", "--to", "2000"],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    from: "1000",
    to: "2000",
    sort: "started_at",
    limit: "100",
  });
});

test("trace list without an option sends the default sort and limit", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(t, ["trace", "list"], endpoint);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    sort: "started_at",
    limit: "100",
  });
});

const INVALID_LIST_OPTIONS: readonly (readonly [string[], string])[] = [
  [["--project", "invalid"], "cli.tracking.trace.list.invalid_project_id"],
  [["--node", "invalid"], "cli.tracking.trace.list.invalid_node_id"],
  [["--state", "unknown"], "cli.tracking.trace.list.invalid_state"],
  [["--sort", "unknown"], "cli.tracking.trace.list.invalid_sort"],
  [["--query", ""], "cli.tracking.trace.list.invalid_query"],
  [
    ["--query", "x".repeat(TRACE_QUERY_MAX_CHARACTERS + 1)],
    "cli.tracking.trace.list.invalid_query",
  ],
  [["--from", "-1"], "cli.tracking.trace.list.invalid_query"],
  [["--from", "soon"], "cli.tracking.trace.list.invalid_query"],
  [["--to", "1.5"], "cli.tracking.trace.list.invalid_query"],
  [["--limit", LIMIT_NOT_NUMBER], "cli.pagination.limit_invalid"],
  [["--limit", LIMIT_TOO_LARGE], "cli.pagination.limit_out_of_range"],
];

for (const [options, code] of INVALID_LIST_OPTIONS)
  test(`trace list ${options.join(" ")} exits with ${code} before any request`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
    const result = await run(t, ["trace", "list", ...options], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(seen.length, NO_REQUESTS);
  });

test("facet get sends the project and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, FACET_ANSWER);
  const result = await run(
    t,
    ["facet", "get", "--project", PROJECT_ID],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  assert.equal(
    seen[0]?.url,
    `${FACET_GET_PATH}?project_id=${encodeURIComponent(PROJECT_ID)}`,
  );
  assert.deepEqual(JSON.parse(result.stdout), FACET_ANSWER);
});

test("facet get with an invalid project exits before any request", async (t) => {
  const { endpoint, seen } = await fakeServer(t, FACET_ANSWER);
  const result = await run(
    t,
    ["facet", "get", "--project", "invalid"],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(
    result.stderr.includes("cli.tracking.facet.get.invalid_project_id"),
    result.stderr,
  );
  assert.equal(seen.length, NO_REQUESTS);
});

const TRACE_ID = "a".repeat(32);
const SESSION_ID = "2".repeat(16);
const ENTRY_ID = "e1";
const ENTRY_LIST_PATH = `/api/tracking/trace/${TRACE_ID}/session/${SESSION_ID}/entry`;
const ENTRY_GET_PATH = `${ENTRY_LIST_PATH}/${ENTRY_ID}`;
const ENTRY_ANSWER = {
  trace_id: TRACE_ID,
  session_id: SESSION_ID,
  entry_id: ENTRY_ID,
  parent_entry_id: null,
  sequence: 1,
  entry_type: "message",
  entry_time: 1000,
  tool_call_id: null,
  truncated: false,
  entry: { role: "user" },
  created_at: 1000,
};
const TOOL_CALL = "call_1";
const LIMIT_FIVE = "5";

test("session entry list sends its filters as query fields and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(
    t,
    [
      "session",
      "entry",
      "list",
      TRACE_ID,
      SESSION_ID,
      "--tool-call",
      TOOL_CALL,
      "--limit",
      LIMIT_FIVE,
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, ENTRY_LIST_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    tool_call_id: TOOL_CALL,
    limit: LIMIT_FIVE,
  });
  assert.deepEqual(JSON.parse(result.stdout), LIST_ANSWER);
});

test("session entry get sends the entry path and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, ENTRY_ANSWER);
  const result = await run(
    t,
    ["session", "entry", "get", TRACE_ID, SESSION_ID, ENTRY_ID],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  assert.equal(seen[0]?.url, ENTRY_GET_PATH);
  assert.deepEqual(JSON.parse(result.stdout), ENTRY_ANSWER);
});

const INVALID_ENTRY_ARGUMENTS: readonly (readonly [string[], string])[] = [
  [
    ["list", "invalid", SESSION_ID],
    "cli.tracking.session.entry.list.invalid_trace_id",
  ],
  [
    ["list", TRACE_ID, "invalid"],
    "cli.tracking.session.entry.list.invalid_session_id",
  ],
  [
    ["list", TRACE_ID, SESSION_ID, "--limit", LIMIT_NOT_NUMBER],
    "cli.pagination.limit_invalid",
  ],
  [
    ["list", TRACE_ID, SESSION_ID, "--limit", LIMIT_TOO_LARGE],
    "cli.pagination.limit_out_of_range",
  ],
  [
    ["get", "invalid", SESSION_ID, ENTRY_ID],
    "cli.tracking.session.entry.get.invalid_trace_id",
  ],
  [
    ["get", TRACE_ID, "invalid", ENTRY_ID],
    "cli.tracking.session.entry.get.invalid_session_id",
  ],
  [
    ["get", TRACE_ID, SESSION_ID, "Invalid_Entry"],
    "cli.tracking.session.entry.get.invalid_entry_id",
  ],
];

for (const [args, code] of INVALID_ENTRY_ARGUMENTS)
  test(`session entry ${args.join(" ")} exits with ${code} before any request`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
    const result = await run(t, ["session", "entry", ...args], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(seen.length, NO_REQUESTS);
  });

const EXECUTION_ID = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TIMELINE_PATH = "/api/tracking/timeline";
const TIMELINE_LEAF = "cli.tracking.timeline.list";

test("timeline list sends its scope and filters as query fields and writes the page", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(
    t,
    [
      "timeline",
      "list",
      "--node",
      NODE_ID,
      "--depth",
      "1",
      "--from",
      "1000",
      "--to",
      "2000",
      "--limit",
      LIMIT_LISTED,
      "--cursor",
      "opaque",
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, TIMELINE_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    node_id: NODE_ID,
    depth: "1",
    from: "1000",
    to: "2000",
    limit: LIMIT_LISTED,
    cursor: "opaque",
  });
  assert.deepEqual(JSON.parse(result.stdout), LIST_ANSWER);
});

for (const [flag, value, field] of [
  ["--execution", EXECUTION_ID, "execution_id"],
  ["--project", PROJECT_ID, "project_id"],
] as const)
  test(`timeline list ${flag} sends ${field}`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
    const result = await run(t, ["timeline", "list", flag, value], endpoint);
    assert.equal(result.code, ExitCode.Success, result.stderr);
    const url = new URL(seen[0]?.url ?? "", endpoint);
    assert.equal(url.searchParams.get(field), value);
  });

const INVALID_TIMELINE_OPTIONS: readonly (readonly [string[], string])[] = [
  [[], `${TIMELINE_LEAF}.invalid_query`],
  [
    ["--node", NODE_ID, "--project", PROJECT_ID],
    `${TIMELINE_LEAF}.invalid_query`,
  ],
  [["--node", NODE_ID, "--from", "soon"], `${TIMELINE_LEAF}.invalid_query`],
  [["--execution", "invalid"], `${TIMELINE_LEAF}.invalid_execution_id`],
  [["--node", "invalid"], `${TIMELINE_LEAF}.invalid_node_id`],
  [["--project", "invalid"], `${TIMELINE_LEAF}.invalid_project_id`],
  [["--node", NODE_ID, "--depth", "3"], `${TIMELINE_LEAF}.invalid_depth`],
  [
    ["--node", NODE_ID, "--limit", LIMIT_NOT_NUMBER],
    "cli.pagination.limit_invalid",
  ],
  [
    ["--node", NODE_ID, "--limit", LIMIT_TOO_LARGE],
    "cli.pagination.limit_out_of_range",
  ],
];

for (const [options, code] of INVALID_TIMELINE_OPTIONS)
  test(`timeline list ${options.join(" ")} exits with ${code} before any request`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
    const result = await run(t, ["timeline", "list", ...options], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(seen.length, NO_REQUESTS);
  });

test("timeline list without a token exits with token_required", async (t) => {
  const directory = temporary(t);
  const result = await runKanthord(
    ["tracking", "timeline", "list", "--node", NODE_ID],
    {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      KANTHORD_ENDPOINT: undefined,
      KANTHORD_TOKEN: undefined,
    },
    t.signal,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(
    result.stderr.includes(`${TIMELINE_LEAF}.token_required`),
    result.stderr,
  );
});

test("timeline list with a lost answer exits with indeterminate", async (t) => {
  const server = createServer((request, response) => {
    request.resume();
    response.destroy();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const result = await run(
    t,
    ["timeline", "list", "--node", NODE_ID],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(
    result.stderr.includes(`${TIMELINE_LEAF}.indeterminate`),
    result.stderr,
  );
});

const ANALYTICS_COST_PATH = "/api/tracking/analytics/cost";
const ANALYTICS_DURATION_PATH = "/api/tracking/analytics/duration";
const ANALYTICS_COST_LEAF = "cli.tracking.analytics.cost";
const ANALYTICS_DURATION_LEAF = "cli.tracking.analytics.duration";
const ANALYTICS_ANSWER = { items: [], truncated: false };
const RANGE_INVALID_ANSWER = {
  error: {
    code: "tracking.filter.range_invalid",
    message: "The range is invalid.",
    details: null,
  },
  request_id: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
};

test("analytics cost sends its options as query fields and writes the page", async (t) => {
  const { endpoint, seen } = await fakeServer(t, ANALYTICS_ANSWER);
  const result = await run(
    t,
    [
      "analytics",
      "cost",
      "--group-by",
      "agent_name",
      "--bucket",
      "week",
      "--project",
      PROJECT_ID,
      "--from",
      "1000",
      "--to",
      "2000",
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, ANALYTICS_COST_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    group_by: "agent_name",
    bucket: "week",
    project_id: PROJECT_ID,
    from: "1000",
    to: "2000",
  });
  assert.deepEqual(JSON.parse(result.stdout), ANALYTICS_ANSWER);
});

test("analytics duration sends its options as query fields and writes the page", async (t) => {
  const { endpoint, seen } = await fakeServer(t, ANALYTICS_ANSWER);
  const result = await run(
    t,
    [
      "analytics",
      "duration",
      "--measure",
      "tool_latency",
      "--group-by",
      "tool_name",
      "--node",
      NODE_ID,
      "--operation",
      "agent.tool",
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, ANALYTICS_DURATION_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    measure: "tool_latency",
    group_by: "tool_name",
    bucket: "none",
    node_id: NODE_ID,
    operation: "agent.tool",
  });
  assert.deepEqual(JSON.parse(result.stdout), ANALYTICS_ANSWER);
});

const INVALID_ANALYTICS_OPTIONS: readonly (readonly [
  string,
  string[],
  string,
])[] = [
  [
    "cost",
    ["--project", "invalid"],
    `${ANALYTICS_COST_LEAF}.invalid_project_id`,
  ],
  ["cost", ["--node", "invalid"], `${ANALYTICS_COST_LEAF}.invalid_node_id`],
  ["cost", ["--bucket", "month"], `${ANALYTICS_COST_LEAF}.invalid_query`],
  ["cost", ["--group-by", "tool_name"], `${ANALYTICS_COST_LEAF}.invalid_query`],
  ["cost", ["--from", "soon"], `${ANALYTICS_COST_LEAF}.invalid_query`],
  ["cost", ["--to", "-1"], `${ANALYTICS_COST_LEAF}.invalid_query`],
  [
    "duration",
    ["--measure", "tool_latency", "--project", "invalid"],
    `${ANALYTICS_DURATION_LEAF}.invalid_project_id`,
  ],
  [
    "duration",
    ["--measure", "tool_latency", "--node", "invalid"],
    `${ANALYTICS_DURATION_LEAF}.invalid_node_id`,
  ],
  ["duration", [], `${ANALYTICS_DURATION_LEAF}.invalid_query`],
  [
    "duration",
    ["--measure", "latency"],
    `${ANALYTICS_DURATION_LEAF}.invalid_query`,
  ],
  [
    "duration",
    ["--measure", "tool_latency", "--group-by", "model_name"],
    `${ANALYTICS_DURATION_LEAF}.invalid_query`,
  ],
  [
    "duration",
    ["--measure", "tool_latency", "--bucket", "month"],
    `${ANALYTICS_DURATION_LEAF}.invalid_query`,
  ],
  [
    "duration",
    ["--measure", "tool_latency", "--from", "soon"],
    `${ANALYTICS_DURATION_LEAF}.invalid_query`,
  ],
  [
    "duration",
    ["--measure", "tool_latency", "--to", "soon"],
    `${ANALYTICS_DURATION_LEAF}.invalid_query`,
  ],
];

for (const [leaf, options, code] of INVALID_ANALYTICS_OPTIONS)
  test(`analytics ${leaf} ${options.join(" ")} exits with ${code} before any request`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, ANALYTICS_ANSWER);
    const result = await run(t, ["analytics", leaf, ...options], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(seen.length, NO_REQUESTS);
  });

for (const [leaf, prefix, options] of [
  ["cost", ANALYTICS_COST_LEAF, []],
  ["duration", ANALYTICS_DURATION_LEAF, ["--measure", "tool_latency"]],
] as const) {
  test(`analytics ${leaf} without a token exits with token_required`, async (t) => {
    const directory = temporary(t);
    const result = await runKanthord(
      ["tracking", "analytics", leaf, ...options],
      {
        ...process.env,
        XDG_CONFIG_HOME: directory,
        XDG_DATA_HOME: join(directory, "data"),
        XDG_STATE_HOME: join(directory, "state"),
        KANTHORD_ENDPOINT: undefined,
        KANTHORD_TOKEN: undefined,
      },
      t.signal,
    );
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(
      result.stderr.includes(`${prefix}.token_required`),
      result.stderr,
    );
  });

  test(`analytics ${leaf} with a lost answer exits with indeterminate`, async (t) => {
    const server = createServer((request, response) => {
      request.resume();
      response.destroy();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(() => server.close());
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const result = await run(t, ["analytics", leaf, ...options], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(`${prefix}.indeterminate`), result.stderr);
  });

  test(`analytics ${leaf} prints the server error of an invalid range`, async (t) => {
    const { endpoint } = await fakeServer(
      t,
      RANGE_INVALID_ANSWER,
      HttpStatus.BadRequest,
    );
    const result = await run(t, ["analytics", leaf, ...options], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(
      result.stderr.includes("tracking.filter.range_invalid"),
      result.stderr,
    );
  });
}
