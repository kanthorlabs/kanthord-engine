import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  GrantKind,
  InboundOperation,
  type CredentialPlatformSet,
} from "../../custody/contract.ts";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import type { ServiceIdentity } from "../../kernel/caller.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { MISSION_SERVICE_NAME } from "../../mission/contract.ts";
import { REPOSITORY_PLATFORMS } from "../../repository/credential-platform.ts";
import {
  FAKE_SSH_CREDENTIAL_BODY,
  TEST_PROJECT_ID,
  gatewayFixture,
} from "./test-support.ts";

const CREDENTIAL = "github-inbound";
const PLATFORM = "github";
const INBOUND_ID = "inbound_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const RESOURCE = "owner/repository";
const FIRST_KEY = "first-key";
const SECOND_KEY = "second-key";
const FIRST_REVISION = 1;
const HUMAN = "ulrich";
const NO_CALLS = 0;
const FACILITY_REFUSAL = { name: "FacilityError" };
const SET: CredentialPlatformSet = { platforms: REPOSITORY_PLATFORMS };

async function releaseFixture(t: TestContext) {
  const fixture = await gatewayFixture(t);
  const { custody, store } = fixture;
  store.transaction((tx) => {
    custody.create(
      tx,
      SET,
      {
        name: CREDENTIAL,
        platform: PLATFORM,
        metadata: null,
        secret: { key: FIRST_KEY },
      },
      HUMAN,
    );
    custody.rotate(
      tx,
      SET,
      CREDENTIAL,
      { expected_revision: FIRST_REVISION, secret: { key: SECOND_KEY } },
      HUMAN,
    );
    custody.create(tx, SET, FAKE_SSH_CREDENTIAL_BODY, HUMAN);
  });
  const authorize = (
    identity: ServiceIdentity,
    overrides: { credential?: string; operation?: string } = {},
  ) =>
    store.transaction((tx) =>
      custody.authorizeOperation(
        tx,
        {
          kind: GrantKind.Inbound,
          identity,
          inbound: {
            inboundId: INBOUND_ID,
            projectId: TEST_PROJECT_ID,
            credential: overrides.credential ?? CREDENTIAL,
            platform: PLATFORM,
            resource: RESOURCE,
          },
          operation: (overrides.operation ??
            InboundOperation.Poll) as InboundOperation,
        },
        Date.now(),
      ),
    );
  return { ...fixture, authorize };
}

test("a poll release under the Intake service identity decrypts the newest live revision and pins nothing", async (t) => {
  const h = await releaseFixture(t);
  const pin = t.mock.method(h.scheduler, "pinCredential");
  const grant = h.authorize(mintServiceIdentity(INTAKE_SERVICE_NAME));
  assert.equal(grant.kind, GrantKind.Inbound);
  assert.equal(grant.credential, CREDENTIAL);
  assert.equal(grant.platform, PLATFORM);
  assert.equal(grant.project_id, TEST_PROJECT_ID);
  assert.equal(grant.execution, null);
  assert.deepEqual(grant.facts, {
    inbound_id: INBOUND_ID,
    resource: RESOURCE,
  });
  const material = h.store.transaction((tx) =>
    h.custody.release(tx, grant, Date.now()),
  );
  try {
    assert.equal(material.platform, PLATFORM);
    assert.deepEqual(material.value(), { key: SECOND_KEY });
  } finally {
    material.drop();
  }
  assert.equal(pin.mock.callCount(), NO_CALLS);
});

test("the Mission service identity, a forged identity and an operation other than poll throw FacilityError before the suitability check", async (t) => {
  const h = await releaseFixture(t);
  const suitability = t.mock.method(h.custody, "custodySuitability");
  const forged = Object.freeze({
    kind: "service",
    service: INTAKE_SERVICE_NAME,
  }) as ServiceIdentity;
  assert.throws(
    () => h.authorize(mintServiceIdentity(MISSION_SERVICE_NAME)),
    FACILITY_REFUSAL,
  );
  assert.throws(() => h.authorize(forged), FACILITY_REFUSAL);
  assert.throws(
    () =>
      h.authorize(mintServiceIdentity(INTAKE_SERVICE_NAME), {
        operation: "push",
      }),
    FACILITY_REFUSAL,
  );
  assert.equal(suitability.mock.callCount(), NO_CALLS);
});

test("a credential of another platform refuses the inbound grant", async (t) => {
  const h = await releaseFixture(t);
  assert.throws(
    () =>
      h.authorize(mintServiceIdentity(INTAKE_SERVICE_NAME), {
        credential: FAKE_SSH_CREDENTIAL_BODY.name,
      }),
    { status: 400, code: "credential.platform.mismatch" },
  );
});

test("a consumed inbound grant refuses a second release", async (t) => {
  const h = await releaseFixture(t);
  const grant = h.authorize(mintServiceIdentity(INTAKE_SERVICE_NAME));
  h.store.transaction((tx) => h.custody.release(tx, grant, Date.now())).drop();
  assert.throws(
    () => h.store.transaction((tx) => h.custody.release(tx, grant, Date.now())),
    FACILITY_REFUSAL,
  );
});
