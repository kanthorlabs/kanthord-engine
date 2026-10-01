import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mintGrant,
  consumeGrant,
  MaterialBuffer,
  FacilityError,
} from "./facility.ts";

const FIELDS = {
  credential: "anthro-1",
  platform: "anthropic",
  execution: {
    executionId: "execution-one",
    projectId: "project-one",
    workerBindingId: "binding-one",
    resourceIdentity: "worker:kanthord:general",
    runtimeIdentity: "runtime-one",
    credentials: [] as string[],
  },
};
const SECRET = { key: "private-material" };

test("grants freeze a snapshot and reject fabrication, copies and repeated consumption", () => {
  const grant = mintGrant(FIELDS);
  assert(Object.isFrozen(grant));
  assert(Object.isFrozen(grant.execution.credentials));
  assert.notEqual(grant.execution, FIELDS.execution);
  assert.throws(() => consumeGrant(FIELDS), FacilityError);
  assert.throws(() => consumeGrant(Object.freeze({ ...grant })), FacilityError);
  consumeGrant(grant);
  assert.throws(() => consumeGrant(grant), FacilityError);
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
