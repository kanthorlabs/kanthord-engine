import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { INTAKE_SERVICE_NAME } from "../../intake/contract.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import {
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  PlatformAddressKind,
} from "../../mission/contract.ts";
import {
  HARNESS_ACTION_KEY,
  HARNESS_CREDENTIAL,
  HARNESS_PLATFORM,
  authorizationHarness,
} from "../../mission/test-support.ts";

function refuses(fn: () => unknown, reason: string) {
  assert.throws(fn, {
    status: 403,
    code: MissionErrorCode.AuthorizationRefused,
    details: { reason },
  });
}

function serviceHarness(t: TestContext) {
  const h = authorizationHarness(
    t,
    testHumanIdentity("ulrich", "Ulrich", "token"),
  );
  const evidenceId = h.request();
  const authorize = (service: string) =>
    h.store.transaction((tx) =>
      h.service.authorizeRequestEvidence(
        tx,
        mintServiceIdentity(service),
        evidenceId,
        null,
      ),
    );
  return { ...h, evidenceId, authorize };
}

test("the Mission service identity authorizes a request evidence without a claim", (t) => {
  const h = serviceHarness(t);
  h.dependencies.schedulerClaims.liveExecutionOf = () => null;
  const authorized = h.authorize(MISSION_SERVICE_NAME);
  assert.equal(authorized.credential, HARNESS_CREDENTIAL);
  assert.equal(authorized.platform, HARNESS_PLATFORM);
  assert.equal(authorized.project_id, h.project_id);
  assert.equal(authorized.facts.address.kind, PlatformAddressKind.PullRequest);
  assert.equal(authorized.facts.repository.binding_id, h.repositoryId);
});

test("another service identity refuses a request evidence with service_mismatch", (t) => {
  const h = serviceHarness(t);
  refuses(() => h.authorize(INTAKE_SERVICE_NAME), "service_mismatch");
  assert.equal(
    h.authorize(MISSION_SERVICE_NAME).facts.frozen_action.key,
    HARNESS_ACTION_KEY,
  );
});

test("a disabled or removed binding refuses the request evidence of the Mission service identity", (t) => {
  const h = serviceHarness(t);
  const original = h.dependencies.bindings.getBindingRevision;
  for (const [field, reason] of [
    ["disabled", "binding_disabled"],
    ["tombstone", "binding_removed"],
  ] as const) {
    h.dependencies.bindings.getBindingRevision = (tx, id) => {
      const revision = original(tx, id);
      assert.ok(revision);
      return { ...revision, [field]: true };
    };
    refuses(() => h.authorize(MISSION_SERVICE_NAME), reason);
  }
  h.dependencies.bindings.getBindingRevision = original;
  refuses(() => h.authorize(INTAKE_SERVICE_NAME), "service_mismatch");
});
