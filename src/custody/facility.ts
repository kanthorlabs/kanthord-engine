import assert from "node:assert/strict";
import { canonicalJSON } from "../kernel/json.ts";
import type { Grant, Material } from "./contract.ts";

const grants = new WeakSet<object>();

export class FacilityError extends Error {
  constructor() {
    super("The credential facility refuses this use.");
    this.name = "FacilityError";
  }
}

export function mintGrant(fields: Grant): Grant {
  assert(fields.credential.length);
  assert(fields.execution.executionId.length);
  const grant = Object.freeze({
    credential: fields.credential,
    platform: fields.platform,
    execution: Object.freeze({
      ...fields.execution,
      credentials: Object.freeze([...fields.execution.credentials]),
    }),
  });
  grants.add(grant);
  return grant;
}

export function consumeGrant(grant: Grant): void {
  if (!grants.delete(grant)) throw new FacilityError();
  assert(Object.isFrozen(grant));
  assert(Object.isFrozen(grant.execution));
}

export class MaterialBuffer implements Material {
  readonly credentialId: string;
  readonly platform: string;
  #bytes: Buffer | undefined;

  constructor(credentialId: string, platform: string, secret: unknown) {
    assert(credentialId.length);
    assert(platform.length);
    this.credentialId = credentialId;
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
