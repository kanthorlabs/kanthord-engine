import assert from "node:assert/strict";
import { test } from "node:test";
import { canonicalJSON } from "../kernel/json.ts";
import {
  apiKeySecretSchema,
  EXECUTION_CREDENTIAL_MAX_BYTES,
  oauthSecretSchema,
  piCredentialSchema,
  s3AccessKeySecretSchema,
  SecretShape,
  type RefreshReport,
  type HandoverPayload,
} from "./contract.ts";
import { executionCredentialStore } from "./client.ts";
import { normalizeCredential, secretOfCredential } from "./payload.ts";

const NEXT_BYTE = EXECUTION_CREDENTIAL_MAX_BYTES + 1;
type Credential = HandoverPayload["items"][number]["credential"];
const ID = "credential_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const PROVIDER = "test-provider";
const NO_REPORTS = 0;
const ONE_REPORT = 1;
const API_KEY_FIELD = "key";

function sized(
  type: typeof SecretShape.ApiKey | typeof SecretShape.OAuth,
  bytes: number,
  prefix: string,
): Credential {
  const base =
    type === SecretShape.ApiKey
      ? { type, key: prefix }
      : { type, refresh: "r".repeat(16000), access: prefix, expires: 1 };
  const remaining = bytes - Buffer.byteLength(canonicalJSON(base));
  assert.ok(remaining > NO_REPORTS);
  const result =
    base.type === SecretShape.ApiKey
      ? { ...base, key: base.key + "x".repeat(remaining) }
      : { ...base, access: base.access + "x".repeat(remaining) };
  assert.equal(Buffer.byteLength(canonicalJSON(result)), bytes);
  return result;
}

for (const type of [SecretShape.ApiKey, SecretShape.OAuth] as const) {
  test(`${type} budget counts canonical UTF-8, escaping and aggregate fields`, async () => {
    for (const prefix of ["ascii", "é🙂", '"\\\n']) {
      const maximum = sized(type, EXECUTION_CREDENTIAL_MAX_BYTES, prefix);
      const oversized = sized(type, NEXT_BYTE, prefix);
      const platformSchema =
        type === SecretShape.ApiKey ? apiKeySecretSchema : oauthSecretSchema;
      assert.ok(piCredentialSchema.safeParse(maximum).success);
      assert.ok(platformSchema.safeParse(secretOfCredential(maximum)).success);
      assert.equal(piCredentialSchema.safeParse(oversized).success, false);
      const { type: _type, ...secret } = oversized;
      assert.ok(_type);
      assert.equal(platformSchema.safeParse(secret).success, false);
      assert.throws(
        () => normalizeCredential(oversized),
        (error: unknown) => {
          assert.ok(error instanceof Error);
          assert.ok(!JSON.stringify(error).includes("x".repeat(100)));
          return true;
        },
      );
      const payload = (credential: Credential) => ({
        items: [{ credentialId: ID, providerId: PROVIDER, credential }],
      });
      assert.throws(() =>
        executionCredentialStore(payload(oversized), async () => {}),
      );
      const reports: RefreshReport[] = [];
      const view = executionCredentialStore(
        payload(maximum),
        async (report) => {
          reports.push(report);
        },
      );
      try {
        await assert.rejects(
          view.store.modify(PROVIDER, async () => oversized),
        );
        assert.deepEqual(await view.store.read(PROVIDER), maximum);
        assert.equal(reports.length, NO_REPORTS);
        await view.release();
        assert.equal(reports.length, ONE_REPORT);
        assert.deepEqual(reports[0]?.credential, maximum);
      } finally {
        view.discard();
      }
    }
  });
}

test("storage access keys are outside the execution credential budget", () => {
  const secret = { accessKeyId: "id", secretAccessKey: "x".repeat(NEXT_BYTE) };
  assert.ok(s3AccessKeySecretSchema.safeParse(secret).success);
  assert.equal(
    piCredentialSchema.safeParse({ type: SecretShape.S3AccessKey, ...secret })
      .success,
    false,
  );
});

for (const field of ["key", "refresh", "access"] as const) {
  test(`${field} rejects lone surrogates without throwing or replacing the execution credential`, async () => {
    const valid: Credential =
      field === API_KEY_FIELD
        ? { type: SecretShape.ApiKey, key: "test_é🙂" }
        : {
            type: SecretShape.OAuth,
            refresh: "test_é🙂",
            access: "test_é🙂",
            expires: 1,
          };
    assert.deepEqual(piCredentialSchema.safeParse(valid), {
      success: true,
      data: valid,
    });
    const reports: RefreshReport[] = [];
    const view = executionCredentialStore(
      {
        items: [{ credentialId: ID, providerId: PROVIDER, credential: valid }],
      },
      async (report) => {
        reports.push(report);
      },
    );
    try {
      for (const surrogate of ["\ud800", "\udc00"]) {
        const invalid = { ...valid, [field]: surrogate };
        assert.doesNotThrow(() => {
          assert.equal(piCredentialSchema.safeParse(invalid).success, false);
          const { type, ...secret } = invalid;
          const schema =
            type === SecretShape.ApiKey
              ? apiKeySecretSchema
              : oauthSecretSchema;
          assert.equal(schema.safeParse(secret).success, false);
        });
        await assert.rejects(view.store.modify(PROVIDER, async () => invalid));
        assert.deepEqual(await view.store.read(PROVIDER), valid);
        assert.equal(reports.length, NO_REPORTS);
      }
      await view.release();
      assert.equal(reports.length, ONE_REPORT);
      assert.deepEqual(reports[0]?.credential, valid);
    } finally {
      view.discard();
    }
  });
}
