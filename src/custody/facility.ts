import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import { isObject } from "../kernel/values.ts";
import type {
  Grant,
  GrantFacts,
  GrantOf,
  GrantKind,
  Material,
  WorkbenchGrant,
} from "./contract.ts";

const grants = new WeakSet<object>();
const minted = new WeakSet<object>();
const DEEP_FREEZE_DEPTH_LIMIT = 32;

export class FacilityError extends Error {
  constructor() {
    super("The credential facility refuses this use.");
    this.name = "FacilityError";
  }
}

function deepFrozen<T>(value: T, depth = 0): T {
  assert(depth <= DEEP_FREEZE_DEPTH_LIMIT);
  if (!isObject(value)) return value;
  for (const item of Object.values(value)) deepFrozen(item, depth + 1);
  return Object.freeze(value);
}

export function mintGrant<K extends GrantKind>(fields: GrantOf<K>): GrantOf<K> {
  assert(fields.credential === null || fields.credential.length);
  assert(fields.project_id.length);
  assert(
    fields.execution === null ||
      fields.execution.project_id === fields.project_id,
  );
  const grant: GrantOf<K> = Object.freeze({
    kind: fields.kind,
    credential: fields.credential,
    platform: fields.platform,
    project_id: fields.project_id,
    execution:
      fields.execution === null
        ? null
        : Object.freeze({
            ...fields.execution,
            credentials: Object.freeze([...fields.execution.credentials]),
          }),
    facts: deepFrozen(structuredClone(fields.facts)),
  });
  grants.add(grant);
  minted.add(grant);
  return grant;
}

export function grantFacts<G extends Grant>(grant: G): GrantFacts<G> {
  if (!minted.has(grant)) throw new FacilityError();
  assert(Object.isFrozen(grant));
  assert(Object.isFrozen(grant.facts));
  return Object.freeze({
    project_id: grant.project_id,
    credential: grant.credential,
    facts: grant.facts,
  });
}

export function mintWorkbenchGrant(fields: WorkbenchGrant): WorkbenchGrant {
  assert(fields.credential.length);
  assert(fields.session_id.length);
  const grant = Object.freeze({
    credential: fields.credential,
    platform: fields.platform,
    session_id: fields.session_id,
  });
  grants.add(grant);
  return grant;
}

export function consumeWorkbenchGrant(grant: WorkbenchGrant): void {
  if (!grants.delete(grant)) throw new FacilityError();
  assert(Object.isFrozen(grant));
}

export function consumeGrant(grant: Grant): void {
  if (!grants.delete(grant)) throw new FacilityError();
  assert(Object.isFrozen(grant));
  assert(grant.execution === null || Object.isFrozen(grant.execution));
}

export class MaterialBuffer implements Material {
  readonly credential_id: string;
  readonly platform: string;
  #bytes: Buffer | undefined;

  constructor(credentialId: string, platform: string, secret: unknown) {
    assert(credentialId.length);
    assert(platform.length);
    this.credential_id = credentialId;
    this.platform = platform;
    this.#bytes = Buffer.from(canonicalJSON(secret), "utf8");
  }

  value(): unknown {
    if (!this.#bytes) throw new FacilityError();
    return JSON.parse(this.#bytes.toString("utf8"));
  }

  drop(): void {
    this.#bytes?.fill(0);
    this.#bytes = undefined;
  }
}
