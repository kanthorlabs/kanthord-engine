import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
import { Store, IN_MEMORY_DATABASE } from "../kernel/store.ts";
import { createIdentity } from "../kernel/identity.ts";
import { testMachineIdentity } from "../kernel/test-identity.ts";
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
  handoverPayloadSchema,
  SecretShape,
  type CredentialPlatformSet,
  type CustodyExecution,
} from "./contract.ts";
import { INTAKE_SERVICE_NAME } from "../intake/contract.ts";

const SECRET = Buffer.alloc(32, 9).toString("base64");
const FIRST = { type: SecretShape.ApiKey, key: "private-first" };
const SECOND = { type: SecretShape.ApiKey, key: "private-second" };
const NOW = 1000;
const REVISION_COUNT = 1;
const TEST_PLATFORM = "key-platform";
const TEST_SET: CredentialPlatformSet = {
  platforms: {
    [TEST_PLATFORM]: {
      secret_shape: SecretShape.ApiKey,
      login_modes: [],
      metadata_schema: null,
      capability: "none",
      probe: null,
    },
  },
};

function fixture(t: TestContext, names: readonly string[] = ["anthro-1"]) {
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
    execution_id: createIdentity("execution"),
    project_id: createIdentity("project"),
    worker_binding_id: createIdentity("binding"),
    resource_identity: "worker:kanthord:general",
    runtime_identity: createIdentity("worker_instance"),
    credentials: [],
  };
  const identity = testMachineIdentity(
    {
      clientId: createIdentity("client_identity"),
      projectId: row.project_id,
      resourceIdentity: row.resource_identity,
      name: "machine",
      issuedAt: 0,
    },
    "jti",
    row.runtime_identity,
  );
  let running = true;
  let authorized = true;
  const component = new CustodyComponent({
    store,
    logger,
    envelopeKey: Buffer.alloc(32, 7),
    clientSecret: () => SECRET,
    bindingsNaming: () => [],
    inboundsNaming: () => [],
    intakeServiceName: INTAKE_SERVICE_NAME,
    agentProvidersDependentOn: () => [],
    platforms: TEST_SET.platforms,
    executions: {
      requireRunning: (tx, executionId, runtimeIdentity) => {
        assert(tx.database.isTransaction);
        assert.equal(executionId, row.execution_id);
        assert.equal(runtimeIdentity, row.runtime_identity);
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
        row.credentials.includes(id) ? [row.execution_id] : [],
    },
    authorization: {
      authorizeModelInference: () => {
        if (!authorized)
          throw new OperationError(
            HttpStatus.Forbidden,
            "worker.authorization.refused",
            "Refused.",
          );
        return names.map((credential) => ({
          credential,
          platform: TEST_PLATFORM,
          provider_id: TEST_PLATFORM,
          agent_provider: "default",
        }));
      },
    },
    missionAuthorization: {
      frozenAction: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      requestEvidence: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      evidenceAsset: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
      objectPut: () => {
        throw new Error("UNEXPECTED_COLLABORATION");
      },
    },
  });
  const credentialIds = names.map(
    (name) =>
      store.transaction((tx) =>
        component.create(
          tx,
          TEST_SET,
          {
            name,
            platform: TEST_PLATFORM,
            metadata: null,
            secret: { key: FIRST.key },
          },
          undefined,
        ),
      ).revisions[0]!.id,
  );
  const credentialId = credentialIds[0]!;
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(row.execution_id, row.runtime_identity);
  const claim = {
    executionId: row.execution_id,
    runtimeIdentity: row.runtime_identity,
  };
  const handover = () =>
    store.transaction((tx) => component.handover(tx, identity, claim, NOW));
  const report = (envelope: ReturnType<typeof sealEnvelope>) =>
    store.transaction((tx) =>
      component.report(tx, identity, claim, envelope, NOW),
    );
  const refresh = {
    credential_id: credentialId,
    digest: digest(FIRST),
    credential: SECOND,
  };
  return {
    store,
    logs,
    row,
    credentialId,
    credentialIds,
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
          credential_id: f.credentialId,
          provider_id: TEST_PLATFORM,
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
        handoverAad("other", f.row.runtime_identity),
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
    assert.equal(record.execution_id, f.row.execution_id);
    assert.equal(record.credential_id, f.credentialId);
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
      credential_id: createIdentity("credential"),
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
  assert.throws(f.handover, { code: "worker.authorization.refused" });
  assert.deepEqual(f.row.credentials, []);
});

test("handover seals and pins one item per credential and accepts a refresh of the second", (t) => {
  const f = fixture(t, ["worker-key", "reviewer-key"]);
  const payload = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  assert.deepEqual(
    payload.items.map((item) => item.credential_id),
    f.credentialIds,
  );
  assert.deepEqual(f.row.credentials, f.credentialIds);
  f.report(
    sealEnvelope(f.keys.report, f.aad, {
      ...f.refresh,
      credential_id: f.credentialIds[1]!,
    }),
  );
  const refreshed = handoverPayloadSchema.parse(
    openEnvelope(f.keys.handover, f.aad, f.handover()),
  );
  assert.deepEqual(
    refreshed.items.map((item) => item.credential),
    [FIRST, SECOND],
  );
});
