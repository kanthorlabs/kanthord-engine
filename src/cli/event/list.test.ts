import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult, DaemonClient } from "../client.ts";
import { registerEventList, renderPayload } from "./list.ts";

type CallOptions = Readonly<{
  query?: Readonly<Record<string, string | undefined>>;
  idempotencyKey?: string;
}>;

type RecordedCall = Readonly<{
  operationId: string;
  body: unknown;
  parameters: Readonly<Record<string, string>> | undefined;
  options: CallOptions | undefined;
}>;

const harness = (
  options: { respond?: () => CallResult } = {},
): {
  program: Command;
  calls(): readonly RecordedCall[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
} => {
  const program = new Command();
  program.exitOverride();
  registerClientOptions(program);
  const calls: RecordedCall[] = [];
  const client: DaemonClient = {
    call: async (
      operationId,
      body,
      parameters,
      callOptions,
    ): Promise<CallResult> => {
      calls.push({
        operationId,
        body,
        parameters,
        options: callOptions,
      });
      if (options.respond !== undefined) {
        return options.respond();
      }
      return { ok: true, status: 200, body: { events: [] } };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerEventList({
    program,
    client,
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    fail: () => {
      failCalls += 1;
    },
  });
  return {
    program,
    calls: () => calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/event/list.test", () => {
  it("sends every supplied option on the query", async () => {
    const h = harness();
    await run(h.program, [
      "event",
      "list",
      "--subject-kind",
      "node",
      "--subject",
      "task_01JQ8Z7G3HZZZZZZZZZZZZZZZX",
      "--type",
      "node.created",
      "--actor-kind",
      "harness",
      "--actor",
      "actor_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
      "--after",
      "event_01JQ8Z7G3HZZZZZZZZZZZZZZZY",
      "--before",
      "event_01HZY8QF3M4N5P6R7S8T9V0WB0",
      "--limit",
      "25",
      "--order",
      "desc",
    ]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "event.list",
        body: undefined,
        parameters: undefined,
        options: {
          query: {
            subjectKind: "node",
            subject: "task_01JQ8Z7G3HZZZZZZZZZZZZZZZX",
            type: "node.created",
            actorKind: "harness",
            actor: "actor_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
            after: "event_01JQ8Z7G3HZZZZZZZZZZZZZZZY",
            before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0",
            limit: "25",
            order: "desc",
          },
        },
      },
    ]);
  });

  it("sends tail options without a body or path parameters", async () => {
    const h = harness();
    await run(h.program, [
      "event",
      "list",
      "--order",
      "desc",
      "--before",
      "event_01HZY8QF3M4N5P6R7S8T9V0WB0",
    ]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "event.list",
        body: undefined,
        parameters: undefined,
        options: {
          query: {
            before: "event_01HZY8QF3M4N5P6R7S8T9V0WB0",
            order: "desc",
          },
        },
      },
    ]);
  });

  it("leaves call options undefined when neither tail flag is supplied", async () => {
    const h = harness();
    await run(h.program, ["event", "list"]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "event.list",
        body: undefined,
        parameters: undefined,
        options: undefined,
      },
    ]);
  });

  it("passes an unvalidated order value to the daemon", async () => {
    const h = harness();
    await run(h.program, ["event", "list", "--order", "sideways"]);

    assert.deepEqual(h.calls()[0]?.options, {
      query: { order: "sideways" },
    });
  });

  it("reports the daemon refusal for an invalid order", async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 400,
        code: "invalid-request",
        message: "the event filters are not valid",
        details: undefined,
      }),
    });
    await run(h.program, ["event", "list", "--order", "sideways"]);

    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: the event filters are not valid\n",
    );
    assert.equal(h.failCalls(), 1);
    assert.equal(h.stdoutText(), "");
  });

  it("omits an absent option from the query", async () => {
    const h = harness();
    await run(h.program, ["event", "list", "--type", "node.updated"]);

    assert.deepEqual(h.calls()[0]?.options, {
      query: { type: "node.updated" },
    });
  });

  it("prints one record per event in the order the response returns", async () => {
    const h = harness({
      respond: () => ({
        ok: true,
        status: 200,
        body: {
          events: [
            {
              id: "event_03",
              type: "node.created",
              subjectKind: "node",
              subjectId: "task_03",
              actorKind: "harness",
              actorId: "actor_03",
              payload: { title: "third" },
              createdAt: 1722800000003,
            },
            {
              id: "event_01",
              type: "node.updated",
              subjectKind: "node",
              subjectId: "task_01",
              actorKind: "human",
              actorId: "human_01",
              payload: { title: "first" },
              createdAt: 1722800000001,
            },
            {
              id: "event_02",
              type: "node.deleted",
              subjectKind: "node",
              subjectId: "task_02",
              actorKind: "daemon",
              actorId: "kanthord",
              payload: { title: "second" },
              createdAt: 1722800000002,
            },
          ],
        },
      }),
    });
    await run(h.program, ["event", "list"]);

    assert.equal(
      h.stdoutText(),
      'kanthord: event 1722800000003 event_03 harness/actor_03 node.created node/task_03 {"title":"third"}\n' +
        'kanthord: event 1722800000001 event_01 human/human_01 node.updated node/task_01 {"title":"first"}\n' +
        'kanthord: event 1722800000002 event_02 daemon/kanthord node.deleted node/task_02 {"title":"second"}\n',
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("prints a payload with every key sorted bytewise at every depth", async () => {
    const h = harness({
      respond: () => ({
        ok: true,
        status: 200,
        body: {
          events: [
            {
              id: "event_nested",
              type: "node.created",
              subjectKind: "node",
              subjectId: "task_nested",
              actorKind: "daemon",
              actorId: "kanthord",
              payload: {
                z: 1,
                nested: {
                  z: 2,
                  a: [{ z: 3, a: 4 }, "keep-order"],
                },
                a: true,
              },
              createdAt: 1722800000010,
            },
          ],
        },
      }),
    });
    await run(h.program, ["event", "list"]);

    assert.equal(
      h.stdoutText(),
      'kanthord: event 1722800000010 event_nested daemon/kanthord node.created node/task_nested {"a":true,"nested":{"a":[{"a":4,"z":3},"keep-order"],"z":2},"z":1}\n',
    );
  });

  it("prints the same payload bytes for two key orders of one payload", () => {
    const first = {
      outer: { z: 1, a: 2 },
      items: [{ y: 3, x: 4 }],
    };
    const second = {
      items: [{ x: 4, y: 3 }],
      outer: { a: 2, z: 1 },
    };

    assert.equal(renderPayload(first), renderPayload(second));
  });

  it("prints kanthord: no event on an empty list", async () => {
    const h = harness();
    await run(h.program, ["event", "list"]);

    assert.equal(h.stdoutText(), "kanthord: no event\n");
    assert.equal(h.failCalls(), 0);
  });

  it("prints the error line and fails on a refused call", async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 400,
        code: "invalid-request",
        message: "limit must not exceed 500",
        details: undefined,
      }),
    });
    await run(h.program, ["event", "list", "--limit", "501"]);

    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: limit must not exceed 500\n",
    );
    assert.equal(h.failCalls(), 1);
    assert.equal(h.stdoutText(), "");
  });
});
