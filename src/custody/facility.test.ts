import assert from "node:assert/strict";
import { test } from "node:test";
import { GrantKind } from "./contract.ts";
import {
  mintGrant,
  consumeGrant,
  grantFacts,
  MaterialBuffer,
  FacilityError,
} from "./facility.ts";

const FIELDS = {
  kind: GrantKind.ModelInference,
  credential: "anthro-1",
  platform: "anthropic",
  project_id: "project-one",
  execution: {
    execution_id: "execution-one",
    project_id: "project-one",
    worker_binding_id: "binding-one",
    resource_identity: "worker:kanthord:general",
    runtime_identity: "runtime-one",
    credentials: [] as string[],
  },
  facts: { provider_id: "anthropic", agent_provider: "default" },
};
const SECRET = { key: "private-material" };

test("grants freeze a snapshot and reject fabrication, copies and repeated consumption", () => {
  const grant = mintGrant(FIELDS);
  assert(Object.isFrozen(grant));
  assert(Object.isFrozen(grant.execution!.credentials));
  assert(Object.isFrozen(grant.facts));
  assert.notEqual(grant.execution, FIELDS.execution);
  assert.notEqual(grant.facts, FIELDS.facts);
  assert.throws(() => consumeGrant(FIELDS), FacilityError);
  assert.throws(() => consumeGrant(Object.freeze({ ...grant })), FacilityError);
  consumeGrant(grant);
  assert.throws(() => consumeGrant(grant), FacilityError);
});

test("grant facts answer the project, the credential and frozen facts without consumption", () => {
  const fields = {
    ...FIELDS,
    kind: GrantKind.RequestEvidence,
    credential: null,
    execution: null,
    facts: { nested: { values: ["one"] } },
  } as unknown as Parameters<
    typeof mintGrant<typeof GrantKind.RequestEvidence>
  >[0];
  const grant = mintGrant(fields);
  const answer = grantFacts(grant);
  assert.deepEqual(answer, {
    project_id: "project-one",
    credential: null,
    facts: { nested: { values: ["one"] } },
  });
  assert(Object.isFrozen(answer));
  assert(
    Object.isFrozen((answer.facts as unknown as { nested: object }).nested),
  );
  assert.deepEqual(grantFacts(grant), answer);
  consumeGrant(grant);
  assert.deepEqual(grantFacts(grant), answer);
  assert.throws(() => grantFacts(Object.freeze({ ...grant })), FacilityError);
});

test("material clears its owned bytes on success and holder failure", (t) => {
  const fill = Buffer.prototype.fill;
  const cleared: Buffer[] = [];
  t.mock.method(
    Buffer.prototype,
    "fill",
    function (this: Buffer, ...args: Parameters<typeof fill>) {
      const result = Reflect.apply(fill, this, args);
      cleared.push(this);
      return result;
    },
  );
  for (const fail of [false, true]) {
    const material = new MaterialBuffer("credential-one", "anthropic", SECRET);
    const holder = () => {
      try {
        assert.deepEqual(material.value(), SECRET);
        assert.equal(JSON.stringify(material).includes(SECRET.key), false);
        if (fail) throw new Error("holder failed");
      } finally {
        material.drop();
      }
    };
    if (fail) assert.throws(holder);
    else holder();
    assert.throws(() => material.value(), FacilityError);
    material.drop();
  }
  assert(cleared.length);
  for (const bytes of cleared)
    assert.deepEqual(bytes, Buffer.alloc(bytes.length));
});
