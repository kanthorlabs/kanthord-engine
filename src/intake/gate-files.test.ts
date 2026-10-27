import assert from "node:assert/strict";
import { join } from "node:path";
import { setImmediate as nextMacrotask } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import {
  GrantKind,
  SshIdentitySubjectKind,
  type GrantRequest,
} from "../custody/contract.ts";
import { background } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, ExecutionClaim } from "../kernel/operation.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { temporary } from "../kernel/test-support.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import {
  GATE_DECLARATION_INVALID,
  type GitWriter,
  type SshAccess,
} from "../repository/index.ts";
import { ProjectErrorCode } from "../project/contract.ts";
import { readGateFiles } from "./gate-files.ts";
import { SSH_HOST, sshAccessOf, sshCustody, sshStore } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const EXECUTION_ID = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RUNTIME_IDENTITY = "worker_registration_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKER_BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAW";
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ADDRESS = `git@${SSH_HOST}:owner/gated.git`;
const BASE_BRANCH = "main";
const NODE_MISMATCH_REASON = "node_mismatch";
const NO_REVISION = 0;
const UNNAMING_REVISION = 2;
const COMMIT = "0123456789abcdef0123456789abcdef01234567";
const FIRST_REVISION = 1;
const PINNED_BINDINGS = new Map([[FIRST_REVISION, [BINDING_ID]]]);
const GATE_PATHS = ["package.json", "scripts/gate.mjs"];
const GIT_FAILED_CODE = "repository.connector.git_failed";
const BAD_GATEWAY_STATUS = 502;
const TEST_TIMEOUT_MS = 30000;
const IDLE_TURNS = 5;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const NO_RUNS = 0;

const claim: ExecutionClaim = {
  executionId: EXECUTION_ID,
  projectId: PROJECT_ID,
  nodeId: NODE_ID,
  attempt: FIRST_REVISION,
  pinnedRevision: FIRST_REVISION,
  nodeBranch: `kanthord/${NODE_ID}`,
  runtimeIdentity: RUNTIME_IDENTITY,
  workerBindingId: WORKER_BINDING_ID,
};
const machine = testMachineIdentity(
  {
    clientId: "client_identity_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    projectId: PROJECT_ID,
    resourceIdentity: "worker:kanthord:general",
    name: "harness",
    issuedAt: 0,
  },
  "jti",
  RUNTIME_IDENTITY,
);

interface GateCall {
  input: Parameters<GitWriter["changedGateFiles"]>[0];
  ssh: SshAccess;
}

type GateAnswer = (call: GateCall) => Promise<string[]>;

function harness(t: TestContext, answer: GateAnswer) {
  const { store, pin } = sshStore(t);
  pin(SSH_HOST);
  const fake = sshCustody({
    facts: null,
    sshFacts: { binding_id: BINDING_ID, address: ADDRESS },
    credential: null,
    platform: "github",
    project_id: PROJECT_ID,
    execution: {
      execution_id: EXECUTION_ID,
      project_id: PROJECT_ID,
      worker_binding_id: WORKER_BINDING_ID,
      resource_identity: "worker:kanthord:general",
      runtime_identity: RUNTIME_IDENTITY,
      credentials: [],
    },
    secret: {},
    refusal: null,
  });
  const calls: GateCall[] = [];
  const unexpected = () => assert.fail("A gate file read pushes nothing.");
  const gitWriter: GitWriter = {
    mergePushFresh: unexpected,
    pushSnapshotFresh: unexpected,
    landedOn: unexpected,
    changedGateFiles: async (input, _context, _deadline, ssh) => {
      const call = { input, ssh };
      calls.push(call);
      return answer(call);
    },
    sshAccessOf: sshAccessOf(),
  };
  const stateDirectory = temporary(t);
  const runs = new Map<string, Promise<unknown>>();
  const caller: CallerContext = {
    identity: machine,
    execution: claim,
    context: background,
    requestId: "request_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    commit: (write) => store.transaction(write),
  };
  const read = () =>
    readGateFiles(
      { store, custody: fake.custody, gitWriter, stateDirectory, runs },
      caller,
      { binding_id: BINDING_ID, base_branch: BASE_BRANCH, commit: COMMIT },
    );
  const sshRequests = () =>
    fake.requests.filter(
      (
        request,
      ): request is Extract<
        GrantRequest,
        { kind: typeof GrantKind.SshIdentity }
      > => request.kind === GrantKind.SshIdentity,
    );
  return {
    calls,
    read,
    runs,
    sshRequests,
    stateDirectory,
    custody: fake.custody,
    caller,
  };
}

async function idle(): Promise<void> {
  for (let turn = 0; turn < IDLE_TURNS; turn++) await nextMacrotask();
}

test("a gate file read releases the SSH identity of the binding under the execution claim", async (t) => {
  const h = harness(t, async () => GATE_PATHS);
  assert.deepEqual(await h.read(), { paths: GATE_PATHS });
  assert.deepEqual(h.sshRequests(), [
    {
      kind: GrantKind.SshIdentity,
      identity: machine,
      subject: { kind: SshIdentitySubjectKind.Binding, binding_id: BINDING_ID },
      claim,
    },
  ]);
  assert.equal(h.calls.length, ONE_CALL);
  assert.deepEqual(h.calls[0]?.input, {
    address: ADDRESS,
    base_branch: BASE_BRANCH,
    commit: COMMIT,
    directory: join(
      h.stateDirectory,
      "intake",
      "repositories",
      `${BINDING_ID}.git`,
    ),
  });
  assert.ok(h.calls[0]?.ssh && "private_key" in h.calls[0].ssh);
  assert.equal(h.runs.size, NO_RUNS);
});

test(
  "two gate file reads of one binding pass the same directory and run one at a time",
  { timeout: TEST_TIMEOUT_MS },
  async (t) => {
    const events: string[] = [];
    const releases: (() => void)[] = [];
    const h = harness(t, (call) => {
      events.push(`start ${call.input.directory}`);
      return new Promise((resolve) =>
        releases.push(() => {
          events.push("end");
          resolve(GATE_PATHS);
        }),
      );
    });
    const first = h.read();
    const second = h.read();
    await idle();
    assert.equal(h.calls.length, ONE_CALL);
    releases[0]?.();
    await first;
    await idle();
    assert.equal(h.calls.length, TWO_CALLS);
    releases[1]?.();
    assert.deepEqual(await second, { paths: GATE_PATHS });
    const directory = h.calls[0]?.input.directory;
    assert.equal(h.calls[1]?.input.directory, directory);
    assert.deepEqual(events, [
      `start ${directory}`,
      "end",
      `start ${directory}`,
      "end",
    ]);
    assert.equal(h.runs.size, NO_RUNS);
  },
);

test("a gate file read after a failed read of the same binding runs", async (t) => {
  let attempt = 0;
  const h = harness(t, async () => {
    attempt += 1;
    if (attempt === ONE_CALL) throw new Error("first read fails");
    return GATE_PATHS;
  });
  const first = h.read();
  const second = h.read();
  await assert.rejects(first, { message: "first read fails" });
  assert.deepEqual(await second, { paths: GATE_PATHS });
  assert.equal(h.calls.length, TWO_CALLS);
  assert.equal(h.runs.size, NO_RUNS);
});

test("a git failure of a gate file read answers 502 with the git code", async (t) => {
  const h = harness(t, async () => {
    throw new Diagnostic(GIT_FAILED_CODE, "changed gate files: git failed.");
  });
  await assert.rejects(
    h.read(),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === GIT_FAILED_CODE,
  );
});

test("an invalid declaration answers 502 with repository.gate_declaration.invalid", async (t) => {
  const h = harness(t, async () => {
    throw new Diagnostic(
      GATE_DECLARATION_INVALID,
      "The gate declaration of the base branch is invalid.",
    );
  });
  await assert.rejects(
    h.read(),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === BAD_GATEWAY_STATUS &&
      error.code === GATE_DECLARATION_INVALID,
  );
});

test("a gate file read refuses a binding that the claim does not name", async (t) => {
  const h = harness(t, async () => GATE_PATHS);
  const authorize = h.custody.authorizeOperation;
  h.custody.authorizeOperation = ((tx, request, now) => {
    assert.equal(request.kind, GrantKind.SshIdentity);
    assert.notEqual(request.subject.kind, SshIdentitySubjectKind.Draft);
    const named = PINNED_BINDINGS.get(
      request.claim?.pinnedRevision ?? NO_REVISION,
    );
    if (
      request.subject.kind !== SshIdentitySubjectKind.Binding ||
      !named?.includes(request.subject.binding_id)
    )
      throw new OperationError(
        HttpStatus.Forbidden,
        ProjectErrorCode.AuthorizationRefused,
        "The facility refuses the operation.",
        { reason: NODE_MISMATCH_REASON },
      );
    return authorize(tx, request, now);
  }) as typeof authorize;
  h.caller.execution = { ...claim, pinnedRevision: UNNAMING_REVISION };
  await assert.rejects(
    h.read(),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.Forbidden &&
      error.code === ProjectErrorCode.AuthorizationRefused &&
      canonicalJSON(error.details) ===
        canonicalJSON({ reason: NODE_MISMATCH_REASON }),
  );
  assert.equal(h.calls.length, NO_RUNS);
});
