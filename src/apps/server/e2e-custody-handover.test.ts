import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { parse, stringify } from "yaml";
import { ulid } from "ulid";
import { configuration } from "../../config/index.ts";
import {
  handoverPayloadSchema,
  type CredentialAnswer,
} from "../../custody/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import { writePrivate } from "../../kernel/files.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  HandoverOpenError,
  openEnvelope,
  sealEnvelope,
  type HandoverEnvelope,
} from "../../kernel/handover.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { ulidSchema } from "../../kernel/identity.ts";
import { digest } from "../../kernel/json.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  type ExecutionRecord,
  WorkPullKind,
} from "../../scheduler/contract.ts";
import { workerOperations } from "../../worker/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const INVALID_REPORT_COUNT = 4;
const STRING_TYPE = "string";
const NUMBER_TYPE = "number";
const HANDOVER_LOG_MESSAGE = "credential handover";
const EMPTY = "";
const SPAWN_TIMEOUT = 10000;
const JOURNEY_TIMEOUT = 180000;
const UNKNOWN_EXECUTION = "execution_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const NAME = "anthro-1";
const PROVIDER = "anthropic";
const SECRETS = [
  "e2e-handover-secret-one",
  "e2e-handover-secret-two",
  "e2e-handover-secret-three",
  "e2e-handover-refreshed",
  "e2e-handover-second",
  "e2e-handover-third",
] as const;
const [FIRST, SECOND, THIRD, REFRESHED, NEXT, LAST] = SECRETS;
const CONFIGURATION = {
  agentProvider: "default",
  modelIdentifier: "claude-sonnet-4-5",
  reasoningEffort: "off",
};
const CONTENT = {
  name: "Recover accounts",
  requirement: "Recover accounts",
  criterion: "Accounts recover",
  verifications: ["true"],
  bindings: [],
};
type Pull = { kind: string; execution: ExecutionRecord };
type Change = { revisions: { nodeId: string }[] };
const credential = (key: string) => ({ type: "api_key" as const, key });

function noSecrets(text: string): void {
  assert.equal(typeof text, STRING_TYPE);
  assert.ok(SECRETS.every((secret) => !text.includes(secret)));
}

function completed<T>(result: OperationResult<T>): T {
  assert.equal(result.type, OperationResultType.Completed);
  assert.ok(result.type === OperationResultType.Completed);
  return result.data;
}

function refused(
  result: OperationResult<unknown>,
  status: number,
  code: string,
): void {
  assert.equal(result.type, OperationResultType.Failure);
  assert.ok(result.type === OperationResultType.Failure);
  assert.equal(result.status, status);
  assert.equal(result.error.error.code, code);
  noSecrets(JSON.stringify(result));
}

function cli(directory: string, env: NodeJS.ProcessEnv) {
  let sequence = 0;
  const read = async <T>(args: string[], caller = env): Promise<T> => {
    const result = await kanthord(args, caller);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.equal(result.stderr, EMPTY);
    noSecrets(result.stdout);
    return JSON.parse(result.stdout) as T;
  };
  const write = <T>(args: string[], body: unknown, caller = env) => {
    assert.ok(directory.startsWith("/"));
    assert.ok(args.length);
    const path = join(directory, `${++sequence}.json`);
    writePrivate(path, JSON.stringify(body));
    return read<T>([...args, "--file", path], caller);
  };
  const refuses = async (args: string[], code: string, caller = env) => {
    const result = await kanthord(args, caller);
    assert.equal(result.code, FAILURE, result.stderr);
    assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
    assert.equal(result.stdout, EMPTY);
    noSecrets(result.stderr);
  };
  return { read, write, refuses };
}

function machine(
  directory: string,
  projectId: string,
  name: string,
  env: NodeJS.ProcessEnv,
) {
  const args = [
    "jwt",
    "generate",
    "--project",
    projectId,
    "--binding",
    "general",
    "--name",
    name,
    "--config",
    join(directory, "server.yaml"),
  ];
  const entry = new URL("../../main.ts", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `process.stdout.isTTY=true;process.argv=[process.execPath,'kanthord',...${JSON.stringify(args)}];await import(${JSON.stringify(entry)});`,
    ],
    { env, encoding: "utf8", timeout: SPAWN_TIMEOUT },
  );
  assert.equal(result.status, SUCCESS, result.stderr);
  assert.equal(result.stderr, EMPTY);
  const fragment = parse(result.stdout) as {
    token: string;
    clientSecret: string;
  };
  assert.ok(fragment.token && fragment.clientSecret);
  return fragment;
}

async function resources(c: ReturnType<typeof cli>) {
  await c.write(["credential", "create"], {
    name: NAME,
    platform: PROVIDER,
    metadata: null,
    secret: { key: FIRST },
  });
  await c.write(["credential", "create"], {
    name: "github",
    platform: "github",
    metadata: null,
    secret: { key: "test-secret" },
  });
  const enabled = await c.write<{ revision: number }>(
    ["worker", "agent", "enablement", "put", "swe@1"],
    {
      agentProviders: [
        { name: "default", provider: PROVIDER, credential: NAME },
      ],
      defaultConfiguration: CONFIGURATION,
    },
  );
  assert.equal(enabled.revision, ONE);
  const project = await c.read<{ id: string }>([
    "project",
    "create",
    "--name",
    "handover",
  ]);
  const applied = await c.write<{
    bindingSetVersion: number;
    bindings: Record<string, { id: string }>;
  }>(["project", "binding", "apply", project.id], {
    version: ONE,
    bindings: {
      repo: {
        kind: "repository",
        config: {
          available: true,
          platform: "github",
          address: "git@github.com:owner/repo.git",
          strategy: { baseBranch: "main" },
          credential: "github",
        },
      },
      general: {
        kind: "worker",
        config: {
          worker: "general@1",
          instanceCount: ONE,
          entries: [{ agent: "swe@1", ...CONFIGURATION }],
        },
      },
    },
  });
  assert.equal(applied.bindingSetVersion, TWO);
  return { projectId: project.id, bindingId: applied.bindings.repo!.id };
}

async function graph(
  c: ReturnType<typeof cli>,
  projectId: string,
  bindingId: string,
): Promise<void> {
  const mission = await c.read<{ id: string }>(["mission", "get", projectId]);
  const initiative = await c.write<Change>(
    ["mission", "node", "create", mission.id],
    {
      filename: "initiative-1.md",
      kind: "initiative",
      content: CONTENT,
      reason: "plan",
      expectedMissionVersion: ONE,
    },
  );
  assert.ok(initiative.revisions[0]);
  const objective = await c.write<Change>(
    ["mission", "node", "create", mission.id],
    {
      filename: "objective-1.md",
      kind: "objective",
      content: { ...CONTENT, bindings: [bindingId] },
      reason: "plan",
      parentId: initiative.revisions[0].nodeId,
      expectedParentRevision: ONE,
      expectedMissionVersion: TWO,
    },
  );
  assert.ok(objective.revisions[0]);
}

async function setup(t: TestContext) {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: {
      gitLsRemote: async () => {},
      resolveSshHostname: async () => "github.com",
    },
  });
  const directory = temporary(t);
  const human = {
    ...environment(directory),
    KANTHORD_ENDPOINT: fixture.endpoint,
    KANTHORD_TOKEN: fixture.token,
  };
  const c = cli(directory, human);
  const { projectId, bindingId } = await resources(c);
  await graph(c, projectId, bindingId);
  writePrivate(
    join(directory, "server.yaml"),
    stringify(
      configuration({ masterKey: fixture.config.masterKey }).getProperties(),
    ),
  );
  const general = machine(directory, projectId, "general-a", human);
  const spare = machine(directory, projectId, "general-b", human);
  const env = { ...human, KANTHORD_TOKEN: general.token };
  const registration = await c.read<{ runtimeIdentity: string }>(
    ["worker", "register"],
    env,
  );
  const pull = () =>
    c.write<Pull>(
      ["scheduler", "work", "pull"],
      {
        resourceIdentity: "worker:kanthord:general",
        runtimeIdentity: registration.runtimeIdentity,
      },
      env,
    );
  const claim = await pull();
  assert.equal(claim.kind, WorkPullKind.Claimed);
  const stored = await c.read<CredentialAnswer>(["credential", "get", NAME]);
  assert.ok(stored.revisions[0]);
  const keys = deriveHandoverKeys(general.clientSecret);
  t.after(() => {
    keys.handover.fill(0);
    keys.report.fill(0);
  });
  const client = httpClient(workerOperations, fixture.endpoint, general.token);
  const handover = (executionId: string, key = ulid()) =>
    client.handover(
      { params: {}, query: {}, body: { executionId } },
      { idempotencyKey: key },
    );
  const report = (executionId: string, envelope: HandoverEnvelope) =>
    client.credential(
      { params: {}, query: {}, body: { executionId, ...envelope } },
      { idempotencyKey: ulid() },
    );
  const aad = (executionId: string) =>
    handoverAad(executionId, registration.runtimeIdentity);
  const open = (executionId: string, envelope: HandoverEnvelope) =>
    handoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad(executionId), envelope),
    );
  const seal = (executionId: string, value: unknown) =>
    sealEnvelope(keys.report, aad(executionId), value);
  return {
    ...c,
    fixture,
    env,
    human,
    spare,
    keys,
    aad,
    open,
    seal,
    handover,
    report,
    pull,
    executionId: claim.execution.executionId,
    credentialId: stored.revisions[0].id,
  };
}

test(
  "E05 custody handover CLI and encrypted report journey",
  { timeout: JOURNEY_TIMEOUT },
  async (t) => {
    const h = await setup(t);
    const X = h.executionId;
    const C1 = h.credentialId;
    const K1 = ulid();
    let C2: string;
    let X2: string;
    const R1 = {
      credentialId: C1,
      digest: digest(credential(FIRST)),
      credential: credential(REFRESHED),
    };
    const R2 = {
      credentialId: C1,
      digest: digest(credential(REFRESHED)),
      credential: credential(NEXT),
    };

    await t.test(
      "E05.1 CLI prints only receipt and pins the first revision",
      async () => {
        const receipt = await h.read<{
          received: boolean;
          idempotencyKey: string;
        }>(["worker", "handover", X], h.env);
        assert.deepEqual(Object.keys(receipt).sort(), [
          "idempotencyKey",
          "received",
        ]);
        assert.equal(receipt.received, true);
        assert.ok(ulidSchema.safeParse(receipt.idempotencyKey).success);
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          X,
        ]);
        assert.deepEqual(execution.credentials, [C1]);
      },
    );
    await t.test(
      "E05.2 only the handover key and execution AAD open the envelope",
      async () => {
        const envelope = completed(await h.handover(X, K1));
        assert.deepEqual(h.open(X, envelope), {
          items: [
            {
              credentialId: C1,
              providerId: PROVIDER,
              credential: credential(FIRST),
            },
          ],
        });
        assert.throws(
          () =>
            openEnvelope(h.keys.handover, h.aad(UNKNOWN_EXECUTION), envelope),
          HandoverOpenError,
        );
        assert.throws(
          () => openEnvelope(h.keys.report, h.aad(X), envelope),
          HandoverOpenError,
        );
        assert.ok(
          h.fixture.logs
            .map((line) => JSON.parse(line))
            .some(
              (record) =>
                record.msg === HANDOVER_LOG_MESSAGE &&
                record.executionId === X &&
                record.credentialId === C1,
            ),
        );
        noSecrets(JSON.stringify(h.fixture.logs));
      },
    );
    await t.test(
      "E05.3 replay loses its envelope while a fresh key reads the same pin",
      async () => {
        const replay = await h.handover(X, K1);
        assert.equal(replay.type, OperationResultType.Failure);
        assert.ok(replay.type === OperationResultType.Failure);
        assert.equal(replay.status, HttpStatus.Conflict);
        assert.ok(!JSON.stringify(replay).includes("ciphertext"));
        assert.equal(
          h.open(X, completed(await h.handover(X))).items[0]?.credentialId,
          C1,
        );
      },
    );
    await t.test(
      "E05.4 rotation retains the pinned older revision",
      async () => {
        await h.write(["credential", "rotate", NAME], {
          expectedRevision: ONE,
          secret: { key: SECOND },
        });
        const stored = await h.read<CredentialAnswer>([
          "credential",
          "get",
          NAME,
        ]);
        assert.deepEqual(
          stored.revisions.map((row) => [row.revision, row.endedAt]),
          [
            [TWO, null],
            [ONE, null],
          ],
        );
        C2 = stored.revisions[0]!.id;
        assert.deepEqual(h.open(X, completed(await h.handover(X))).items[0], {
          credentialId: C1,
          providerId: PROVIDER,
          credential: credential(FIRST),
        });
      },
    );
    await t.test(
      "E05.5 refresh updates in place and stale digest reports do not overwrite",
      async () => {
        for (const value of [R1, R2, R1])
          assert.equal(completed(await h.report(X, h.seal(X, value))), null);
        assert.deepEqual(
          h.open(X, completed(await h.handover(X))).items[0]?.credential,
          credential(NEXT),
        );
        const stored = await h.read<CredentialAnswer>([
          "credential",
          "get",
          NAME,
        ]);
        assert.deepEqual(
          stored.revisions.map((row) => row.revision),
          [TWO, ONE],
        );
      },
    );
    await t.test(
      "E05.6 invalid direction, truncation, pin and type refuse",
      async () => {
        const envelopes = [
          sealEnvelope(h.keys.handover, h.aad(X), R2),
          { nonce: h.seal(X, R2).nonce, ciphertext: "AAAA" },
          h.seal(X, { ...R2, credentialId: C2 }),
          h.seal(X, {
            ...R2,
            credential: {
              type: "oauth",
              refresh: "r",
              access: "a",
              expires: ONE,
            },
          }),
        ];
        assert.equal(envelopes.length, INVALID_REPORT_COUNT);
        for (const envelope of envelopes)
          refused(
            await h.report(X, envelope),
            HttpStatus.BadRequest,
            "custody.handover.report_invalid",
          );
      },
    );
    await t.test(
      "E05.7 CLI validates caller, proof, argument, mutation key and token",
      async () => {
        await h.refuses(
          ["worker", "handover", X],
          "gateway.authentication.unauthorized",
        );
        await h.refuses(
          ["worker", "handover", X, "--token", h.spare.token],
          "gateway.registration.required",
        );
        await h.refuses(
          ["worker", "handover", UNKNOWN_EXECUTION],
          "gateway.invocation.execution_proof_failed",
          h.env,
        );
        await h.refuses(
          ["worker", "handover", "invalid"],
          "cli.worker.handover.invalid_execution_id",
          h.env,
        );
        await h.refuses(
          ["worker", "handover", X, "--idempotency-key", "bad"],
          "cli.idempotency_key.invalid",
          h.env,
        );
        await h.refuses(
          ["worker", "handover", X],
          "cli.worker.handover.token_required",
          { ...h.env, KANTHORD_TOKEN: EMPTY },
        );
      },
    );
    await t.test(
      "E05.8 revoke refuses both handover and refresh of the pin",
      async () => {
        await h.read(["credential", "revoke", NAME, String(ONE)]);
        const stored = await h.read<CredentialAnswer>([
          "credential",
          "get",
          NAME,
        ]);
        assert.equal(stored.revisions[0]?.endedAt, null);
        assert.equal(typeof stored.revisions[1]?.endedAt, NUMBER_TYPE);
        await h.refuses(
          ["worker", "handover", X],
          "credential.revision.revoked",
          h.env,
        );
        refused(
          await h.report(
            X,
            h.seal(X, {
              credentialId: C1,
              digest: digest(credential(NEXT)),
              credential: credential(LAST),
            }),
          ),
          HttpStatus.Conflict,
          "credential.revision.revoked",
        );
      },
    );
    await t.test(
      "E05.9 released execution loses both handover and report proof",
      async () => {
        await h.write(
          ["scheduler", "execution", "release", X],
          { furtherWork: true },
          h.env,
        );
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          X,
        ]);
        assert.equal(typeof execution.endedAt, NUMBER_TYPE);
        await h.refuses(
          ["worker", "handover", X],
          "gateway.invocation.execution_proof_failed",
          h.env,
        );
        refused(
          await h.report(X, h.seal(X, R2)),
          HttpStatus.Forbidden,
          "gateway.invocation.execution_proof_failed",
        );
      },
    );
    await t.test(
      "E05.10 a new execution pins revision two and keeps it through rotation",
      async () => {
        const claim = await h.pull();
        assert.equal(claim.kind, WorkPullKind.Claimed);
        X2 = claim.execution.executionId;
        const receipt = await h.read<{ received: boolean }>(
          ["worker", "handover", X2],
          h.env,
        );
        assert.equal(receipt.received, true);
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          X2,
        ]);
        assert.deepEqual(execution.credentials, [C2]);
        await h.write(["credential", "rotate", NAME], {
          expectedRevision: TWO,
          secret: { key: THIRD },
        });
        const stored = await h.read<CredentialAnswer>([
          "credential",
          "get",
          NAME,
        ]);
        assert.deepEqual(
          stored.revisions
            .slice(0, TWO)
            .map((row) => [row.revision, row.endedAt]),
          [
            [THREE, null],
            [TWO, null],
          ],
        );
      },
    );
    await t.test(
      "E05.11 credential read drains revision two after its last holder releases",
      async () => {
        await h.write(
          ["scheduler", "execution", "release", X2],
          { furtherWork: true },
          h.env,
        );
        const stored = await h.read<CredentialAnswer>([
          "credential",
          "get",
          NAME,
        ]);
        assert.equal(stored.revisions[0]?.revision, THREE);
        assert.equal(stored.revisions[0]?.endedAt, null);
        assert.equal(typeof stored.revisions[1]?.endedAt, NUMBER_TYPE);
      },
    );
    await t.test(
      "E05.12 disabled enablement refuses handover before creating a pin",
      async () => {
        const claim = await h.pull();
        assert.equal(claim.kind, WorkPullKind.Claimed);
        await h.read([
          "worker",
          "agent",
          "enablement",
          "disable",
          "swe@1",
          "--expected-revision",
          String(ONE),
        ]);
        await h.refuses(
          ["worker", "handover", claim.execution.executionId],
          "worker.agent.enablement.unavailable",
          h.env,
        );
        const execution = await h.read<ExecutionRecord>([
          "scheduler",
          "execution",
          "get",
          claim.execution.executionId,
        ]);
        assert.deepEqual(execution.credentials, []);
        noSecrets(JSON.stringify(h.fixture.logs));
      },
    );
  },
);
