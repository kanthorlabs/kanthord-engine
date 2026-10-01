import assert from "node:assert/strict";
import { hkdfSync } from "node:crypto";
import { test } from "node:test";
import {
  deriveHandoverKeys,
  handoverAad,
  HANDOVER_KEY_INFO,
  REPORT_KEY_INFO,
  HandoverOpenError,
  openEnvelope,
  sealEnvelope,
} from "./handover.ts";

const SECRET = Buffer.alloc(32, 7).toString("base64");
const VALUE = { credential: "test-material", count: 2 };
const EXECUTION = "execution-one";
const RUNTIME = "runtime-one";

test("handover keys match HKDF and directions are independent", () => {
  const keys = deriveHandoverKeys(SECRET);
  for (const [key, info] of [
    [keys.handover, HANDOVER_KEY_INFO],
    [keys.report, REPORT_KEY_INFO],
  ] as const) {
    assert.deepEqual(
      key,
      Buffer.from(
        hkdfSync(
          "sha256",
          Buffer.from(SECRET, "base64"),
          Buffer.alloc(0),
          info,
          32,
        ),
      ),
    );
  }
  assert.notDeepEqual(keys.handover, keys.report);
  assert.notDeepEqual(handoverAad("ab", "c"), handoverAad("a", "bc"));
});

test("handover round trip uses fresh nonces and refuses every broken proof", () => {
  const keys = deriveHandoverKeys(SECRET);
  const aad = handoverAad(EXECUTION, RUNTIME);
  const envelope = sealEnvelope(keys.handover, aad, VALUE);
  assert.deepEqual(openEnvelope(keys.handover, aad, envelope), VALUE);
  assert.notEqual(
    sealEnvelope(keys.handover, aad, VALUE).nonce,
    envelope.nonce,
  );
  const changed = Buffer.from(envelope.ciphertext, "base64");
  changed[0] = changed[0]! ^ 1;
  const failures = [
    () => openEnvelope(keys.report, aad, envelope),
    () =>
      openEnvelope(keys.handover, handoverAad("another", RUNTIME), envelope),
    () =>
      openEnvelope(keys.handover, handoverAad(EXECUTION, "another"), envelope),
    () =>
      openEnvelope(keys.handover, aad, {
        ...envelope,
        ciphertext: changed.toString("base64"),
      }),
    () => openEnvelope(keys.handover, aad, { ...envelope, ciphertext: "AAAA" }),
    () => openEnvelope(keys.handover, aad, { ...envelope, nonce: "AAAA" }),
    () =>
      openEnvelope(keys.handover, aad, { ...envelope, nonce: "not base64!" }),
    () =>
      openEnvelope(keys.handover, aad, {
        ...envelope,
        ciphertext: envelope.ciphertext + "\n",
      }),
  ];
  for (const fail of failures) {
    assert.throws(fail, (error) => {
      assert(error instanceof HandoverOpenError);
      assert.equal(Object.hasOwn(error, "cause"), false);
      assert.equal(JSON.stringify(error).includes(VALUE.credential), false);
      return true;
    });
  }
});
