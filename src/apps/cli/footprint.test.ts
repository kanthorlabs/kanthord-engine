import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { createIdentity } from "../../kernel/identity.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { HttpMethod } from "../../kernel/http.ts";
import { addFootprintCommand } from "./footprint.ts";
import { PROGRAM_NAME } from "./constants.ts";

const TRACE_A = "a".repeat(32);
const TRACE_B = "b".repeat(32);
const LIVE_TRACE = "c".repeat(32);
const NO_PROMPTS = 0;
const TOO_MANY_KEYS = "cli.footprint.cleanup.create.too_many_keys";

function candidate(key: string, refusal: string | null = null) {
  return {
    key,
    at: 1,
    bytes: null,
    project_id: null,
    node_id: null,
    execution_id: null,
    refusal,
    kept: false,
  };
}

function record(keys: string[]) {
  return {
    cleanup_id: createIdentity("cleanup"),
    kind: "trace",
    instance_name: null,
    rule: { name: "older_than", older_than_days: 40 },
    keys,
    requested_by: { kind: "human", account: "ulrich", name: "Ulrich" },
    requested_at: 1,
    state: "queued",
    finished_at: null,
    outcome: null,
  };
}

function program(): Command {
  const root = new Command(PROGRAM_NAME);
  addFootprintCommand(root);
  return root;
}

const ARGUMENTS = [
  "footprint",
  "--endpoint",
  "http://localhost:31415",
  "--token",
  "human-token",
  "cleanup",
  "create",
  "trace",
  "--rule",
  "older_than",
  "--older-than-days",
  "40",
];

test("cleanup create --rule sends the candidate keys and asks no question", async (t) => {
  const bodies: unknown[] = [];
  const urls: string[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (url: unknown, init: RequestInit) => {
      urls.push(String(url));
      if (init.method === HttpMethod.Get)
        return Response.json({
          items: [
            candidate(TRACE_A),
            candidate(TRACE_B),
            candidate(LIVE_TRACE, "live"),
          ],
          next_cursor: null,
          total_count: 3,
          total_bytes: null,
          bytes_estimated: true,
        });
      const body = JSON.parse(init.body as string) as { keys: string[] };
      bodies.push(body);
      return Response.json(record(body.keys), { status: 201 });
    },
  );
  t.mock.method(process.stdout, "write", () => true);
  const stdin = t.mock.method(process.stdin, "read", () => null);
  await program().parseAsync(ARGUMENTS, { from: "user" });
  assert.ok(urls[0]?.includes("older_than_days=40"));
  assert.deepEqual(bodies, [
    {
      kind: "trace",
      instance_name: null,
      rule: { name: "older_than", older_than_days: 40 },
      keys: [TRACE_A, TRACE_B],
    },
  ]);
  assert.equal(stdin.mock.callCount(), NO_PROMPTS);
});

test("cleanup create --rule above 1000 keys answers too_many_keys", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json({
      items: [candidate(TRACE_A)],
      next_cursor: null,
      total_count: 1001,
      total_bytes: null,
      bytes_estimated: true,
    }),
  );
  await assert.rejects(
    program().parseAsync(ARGUMENTS, { from: "user" }),
    (error: unknown) =>
      error instanceof Diagnostic && error.code === TOO_MANY_KEYS,
  );
});
