import assert from "node:assert/strict";
import { test } from "node:test";
import {
  IdentityKind,
  isHumanIdentity,
  isMachineIdentity,
  isServiceIdentity,
} from "../../kernel/caller.ts";
import { mintServiceIdentity } from "../../kernel/service-mint.ts";

const SERVICE_NAME = "intake";
const INVALID_SERVICE_NAMES = [
  "",
  "Intake",
  "1intake",
  "in_take",
  "a".repeat(64),
];

test("a minted service identity passes only the service predicate", () => {
  const identity = mintServiceIdentity(SERVICE_NAME);
  assert.equal(isServiceIdentity(identity), true);
  assert.equal(isHumanIdentity(identity), false);
  assert.equal(isMachineIdentity(identity), false);
  assert.deepEqual(identity, {
    kind: IdentityKind.Service,
    service: SERVICE_NAME,
  });
});

test("a structural copy of a service identity fails the service predicate", () => {
  const copy = { kind: IdentityKind.Service, service: SERVICE_NAME };
  assert.equal(isServiceIdentity(copy), false);
  assert.equal(
    isServiceIdentity({ ...mintServiceIdentity(SERVICE_NAME) }),
    false,
  );
});

test("a minted service identity is frozen", () => {
  const identity = mintServiceIdentity(SERVICE_NAME);
  assert.equal(Object.isFrozen(identity), true);
  assert.throws(() => {
    (identity as { service: string }).service = "mission";
  }, TypeError);
});

test("an invalid service name throws", () => {
  for (const name of INVALID_SERVICE_NAMES)
    assert.throws(() => mintServiceIdentity(name), assert.AssertionError);
});
