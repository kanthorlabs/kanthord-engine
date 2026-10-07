import assert from "node:assert/strict";
import {
  callerProvenance,
  IdentityKind,
  type ServiceIdentity,
} from "./caller.ts";
export const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,62}$/;
export function mintServiceIdentity(service: string): ServiceIdentity {
  assert.ok(SERVICE_NAME_PATTERN.test(service));
  const value = Object.freeze({ kind: IdentityKind.Service, service });
  assert.ok(Object.isFrozen(value));
  callerProvenance.service(value);
  return value;
}
