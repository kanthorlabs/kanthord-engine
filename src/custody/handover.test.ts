import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
import { OperationRegistry, type CallerContext } from "../kernel/operation.ts";
import { background } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
  HandoverOpenError,
} from "../kernel/handover.ts";
import { redactionPaths } from "../kernel/log.ts";
import { custodyMigrations } from "./migrations.ts";
import { CustodyComponent } from "./service.ts";
import { CUSTODY_REPORT_INVALID, REVISION_REVOKED } from "./handover.ts";
import {
  CUSTODY_SERVICE_NAME,
  custodyOperations,
  handoverPayloadSchema,
  SecretShape,
  type CredentialAnswer,
  type CustodyExecution,
} from "./contract.ts";

const SECRET = Buffer.alloc(32, 9).toString("base64");
const FIRST = { type: SecretShape.ApiKey, key: "private-first" };
const SECOND = { type: SecretShape.ApiKey, key: "private-second" };
const NOW = 1000;
const REVISION_COUNT = 1;

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: CUSTODY_SERVICE_NAME, migrations: custodyMigrations },
  ]);
  const logs: string[] = [];
  const logger = pino(
    { redact: redactionPaths },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );
  const row: CustodyExecution = {
    executionId: createIdentity("execution"),
    projectId: createIdentity("project"),
    workerBindingId: createIdentity("binding"),
    resourceIdentity: "worker:kanthord:general",
    runtimeIdentity: createIdentity("worker_instance"),
    credentials: [],
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: row.projectId,
      resourceIdentity: row.resourceIdentity,
      name: "machine",
      issuedAt: 0,
    },
    "jti",
    row.runtimeIdentity,
  );
  let running = true;
  let authorized = true;
  const component = new CustodyComponent({
    store,
    logger,
    envelopeKey: Buffer.alloc(32, 7),
    clientSecret: () => SECRET,
    bindingsNaming: () => [],
    agentProvidersDependentOn: () => [],
    enablementsDependentOnModel: () => [],
    executions: {
      requireRunning: (tx, executionId, runtimeIdentity) => {
        assert(tx.database.isTransaction);
        assert.equal(executionId, row.executionId);
        assert.equal(runtimeIdentity, row.runtimeIdentity);
        if (!running)
          throw new OperationError(
            HttpStatus.Conflict,
            "scheduler.execution.not_running",
            "Execution is not running.",
          );
        return { ...row, credentials: [...row.credentials] };
      },
      pinCredential: (_tx, _id, credentialId) => {
        row.credentials.push(credentialId);
      },
      liveExecutionsPinning: (_tx, id) =>
        row.credentials.includes(id) ? [row.executionId] : [],
    },
    authorization: {
      authorizeModelInference: () => {
        if (!authorized)
          throw new OperationError(
            HttpStatus.Forbidden,
            "project.authorization.refused",
            "Refused.",
          );
        return {
          credential: "anthro-1",
          platform: "anthropic",
          providerId: "anthropic",
          agentProvider: "default",
        };
      },
    },
  });
  const registry = new OperationRegistry();
  component.declare(registry);
  const caller: CallerContext = {
    identity,
    context: background,
    requestId: "request",
    commit: (fn) => store.transaction(fn),
  };
  const created = registry.get(custodyOperations.create.id).handler(
    {
      params: {},
      query: {},
      body: {
        name: "anthro-1",
        platform: "anthropic",
        metadata: null,
        secret: { key: FIRST.key },
      },
    },
    caller,
  ) as CredentialAnswer;
  const credentialId = created.revisions[0]!.id;
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(row.executionId, row.runtimeIdentity);
  const handover = () =>
    store.transaction((tx) => component.handover(tx, identity, row, NOW));
  const report = (envelope: ReturnType<typeof sealEnvelope>) =>
    store.transaction((tx) =>
      component.report(tx, identity, row, envelope, NOW),
    );
  const refresh = { credentialId, digest: digest(FIRST), credential: SECOND };
  return {
    store,
    logs,
    row,
    credentialId,
    keys,
    aad,
    handover,
    report,
    refresh,
    setRunning: (value: boolean) => {
      running = value;
    },
    setAuthorized: (value: boolean) => {
      authorized = value;
    },
  };
}

test("handover and refresh reports preserve a single pinned revision and sanitized attribution", (t) => {
  const f = fixture(t);
  const first = f.handover();
  assert.deepEqual(
    handoverPayloadSchema.parse(openEnvelope(f.keys.handover, f.aad, first)),
    {
      items: [
        {
          credentialId: f.credentialId,
          providerId: "anthropic",
          credential: FIRST,
        },
      ],
    },
  );
  assert.throws(
    () => openEnvelope(f.keys.report, f.aad, first),
    HandoverOpenError,
  );
  assert.throws(
    () =>
      openEnvelope(
        f.keys.handover,
        handoverAad("other", f.row.runtimeIdentity),
        first,
      ),
    HandoverOpenError,
  );
  f.report(sealEnvelope(f.keys.report, f.aad, f.refresh));
  f.report(sealEnvelope(f.keys.report, f.aad, f.refresh));
  const next = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  assert.deepEqual(next.items[0]!.credential, SECOND);
  assert.equal(
    f.store.database.prepare("SELECT COUNT(*) AS count FROM credential").get()!
      .count,
    REVISION_COUNT,
  );
  for (const message of [
    "credential handover",
    "credential report",
    "credential report stale",
  ]) {
    const record = f.logs
      .map((line) => JSON.parse(line))
      .find((line) => line.msg === message);
    assert.equal(record.executionId, f.row.executionId);
    assert.equal(record.credentialId, f.credentialId);
  }
  for (const value of [FIRST.key, SECOND.key])
    assert.equal(f.logs.join("").includes(value), false);
});

test("reports refuse authentication, schema, pin and revision failures without material", (t) => {
  const f = fixture(t);
  f.handover();
  const malformed = [
    sealEnvelope(f.keys.handover, f.aad, f.refresh),
    { nonce: "AAAA", ciphertext: "AAAA" },
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credentialId: createIdentity("credential"),
    }),
    sealEnvelope(f.keys.report, f.aad, { ...f.refresh, digest: "malformed" }),
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential: {
        type: SecretShape.OAuth,
        refresh: "r",
        access: "a",
        expires: 1,
      },
    }),
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential: { ...SECOND, extra: FIRST.key },
    }),
  ];
  for (const envelope of malformed)
    assert.throws(
      () => f.report(envelope),
      (error) => {
        assert(error instanceof OperationError);
        assert.equal(error.status, HttpStatus.BadRequest);
        assert.equal(error.code, CUSTODY_REPORT_INVALID);
        assert.equal(JSON.stringify(error).includes(FIRST.key), false);
        return true;
      },
    );
  f.store.database
    .prepare("UPDATE credential SET ended_at = ? WHERE id = ?")
    .run(NOW, f.credentialId);
  assert.throws(() => f.report(sealEnvelope(f.keys.report, f.aad, f.refresh)), {
    code: REVISION_REVOKED,
  });
  f.setRunning(false);
  assert.throws(f.handover, { code: "scheduler.execution.not_running" });
  assert.throws(() => f.report({ nonce: "bad", ciphertext: "bad" }), {
    code: "scheduler.execution.not_running",
  });
});

test("authorization refusal reaches no material or pin", (t) => {
  const f = fixture(t);
  f.setAuthorized(false);
  f.store.database
    .prepare("UPDATE credential SET ciphertext = ?")
    .run(Buffer.from("corrupt"));
  assert.throws(f.handover, { code: "project.authorization.refused" });
  assert.deepEqual(f.row.credentials, []);
});
