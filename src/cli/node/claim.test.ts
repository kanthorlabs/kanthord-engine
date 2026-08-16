import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeClaim } from "./claim.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW";
const OBJECTIVE = "objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV";
const ACTOR = "actor_01JQ8Z7G3HZZZZZZZZZZZZZZZU";
const RUN = "run_01JQ8Z7G3HZZZZZZZZZZZZZZZT";
const OBJECTIVE_RUN = "run_01JQ8Z7G3HZZZZZZZZZZZZZZZS";
const ATTEMPT = "attempt_01JQ8Z7G3HZZZZZZZZZZZZZZZR";

const NODE = {
  id: TASK,
  projectId: "project_01JQ8Z7G3HZZZZZZZZZZZZZZZQ",
  kind: "task",
  title: "add the health route",
  state: "running",
  blockReason: null,
  discardReason: null,
  parentId: OBJECTIVE,
  dependencies: [],
  instructionBlob: `sha256:${"a".repeat(64)}`,
  acceptanceBlob: null,
  instruction: "# atlas\n",
  acceptance: null,
  worker: null,
  repositoryId: "repo_01JQ8Z7G3HZZZZZZZZZZZZZZZP",
  repo: "atlas",
  revision: "revision_01JQ8Z7G3HZZZZZZZZZZZZZZZO",
  updatedAt: 1738368000000,
};

const claimedBody = (attemptNo: number | null) => ({
  lease: {
    subjectId: TASK,
    owner: ACTOR,
    ownerKind: "actor",
    fence: 1,
    expiresAt: 1722800300000,
  },
  objectiveLease: {
    subjectId: OBJECTIVE,
    owner: ACTOR,
    ownerKind: "actor",
    fence: 2,
    expiresAt: 1722800300000,
  },
  runId: RUN,
  objectiveRunId: OBJECTIVE_RUN,
  attemptId: ATTEMPT,
  attemptNo,
  heartbeatIntervalMs: 100000,
  node: NODE,
});

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
  opts: { respond?: (operationId: string, body: unknown) => CallResult } = {},
): {
  program: Command;
  calls(): readonly RecordedCall[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: RecordedCall[] = [];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
      options?: CallOptions,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters, options });
      if (opts.respond !== undefined) {
        return opts.respond(operationId, body);
      }
      return { ok: true as const, status: 200, body: claimedBody(1) };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerNodeClaim({
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
    randomBytes: (size) => Buffer.alloc(size, 0xab),
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

describe("src/cli/node/claim.test", () => {
  it("node claim sends an empty body with the id parameter", async () => {
    const h = harness();
    await run(h.program, ["node", "claim", TASK]);

    assert.deepEqual(h.calls()[0]?.operationId, "node.claim");
    assert.deepEqual(h.calls()[0]?.parameters, { id: TASK });
    assert.deepEqual(h.calls()[0]?.body, {});
    assert.equal(h.failCalls(), 0);
  });

  it("node claim prints its two lines exactly", async () => {
    const h = harness();
    await run(h.program, ["node", "claim", TASK]);

    assert.equal(
      h.stdoutText(),
      `kanthord: claimed ${TASK} fence 1 expires 1722800300000 heartbeat 100000ms\n` +
        `kanthord: run ${RUN} attempt 1 objective-run ${OBJECTIVE_RUN} objective-fence 2\n`,
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node claim prints a dash for a null attempt number", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: claimedBody(null),
      }),
    });
    await run(h.program, ["node", "claim", TASK]);

    assert.equal(
      h.stdoutText(),
      `kanthord: claimed ${TASK} fence 1 expires 1722800300000 heartbeat 100000ms\n` +
        `kanthord: run ${RUN} attempt - objective-run ${OBJECTIVE_RUN} objective-fence 2\n`,
    );
    assert.equal(h.failCalls(), 0);
  });

  it("node claim sends an Idempotency-Key of 32 lowercase hex characters", async () => {
    const h = harness();
    await run(h.program, ["node", "claim", TASK]);

    const key = h.calls()[0]?.options?.idempotencyKey ?? "";
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.equal(h.failCalls(), 0);
  });

  it("node claim prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 409,
        code: "lease-held",
        message: `the claim of ${TASK} conflicts with a lease held by another owner`,
        details: undefined,
      }),
    });
    await run(h.program, ["node", "claim", TASK]);

    assert.equal(h.stdoutText(), "");
    assert.equal(
      h.stderrText(),
      `kanthord: lease-held: the claim of ${TASK} conflicts with a lease held by another owner\n`,
    );
    assert.equal(h.failCalls(), 1);
  });
});
