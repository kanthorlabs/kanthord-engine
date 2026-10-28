import assert from "node:assert/strict";
import { test } from "node:test";
import { digest } from "../kernel/json.ts";
import {
  handoverPayloadSchema,
  piCredentialSchema,
  refreshReportSchema,
  SecretShape,
} from "./contract.ts";
import {
  credentialOfSecret,
  dropExtraOAuthFields,
  normalizeCredential,
  secretOfCredential,
} from "./payload.ts";

const ID = "credential_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const BINDING_ID = "binding_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const SSH_KEY_TEXT =
  "-----BEGIN OPENSSH PRIVATE KEY-----\nZmFrZQ==\n-----END OPENSSH PRIVATE KEY-----\n";
const KEY = { type: SecretShape.ApiKey, key: "material" };
const OAUTH = {
  type: SecretShape.OAuth,
  refresh: "refresh",
  access: "access",
  expires: 1,
};

test("credential shapes round trip and normalization drops provider extensions", () => {
  for (const credential of [KEY, OAUTH]) {
    assert.deepEqual(
      credentialOfSecret(credential.type, secretOfCredential(credential)),
      credential,
    );
  }
  const extra = { ...OAUTH, account: "extra" };
  assert.deepEqual(normalizeCredential(extra), OAUTH);
  assert.equal(digest(normalizeCredential(extra)), digest(OAUTH));
  assert.throws(() => credentialOfSecret(SecretShape.S3AccessKey, {}));
  assert.throws(() =>
    normalizeCredential({ type: SecretShape.ApiKey, key: " " }),
  );
});

test("handover and report contracts refuse extra keys, wrong identities and digests", () => {
  const item = { credential_id: ID, provider_id: "anthropic", credential: KEY };
  const report = { credential_id: ID, digest: digest(KEY), credential: KEY };
  const ssh = {
    binding_id: BINDING_ID,
    credential_id: ID,
    private_key: SSH_KEY_TEXT,
  };
  const payload = { items: [item], ssh_identities: [ssh] };
  assert.deepEqual(handoverPayloadSchema.parse(payload), payload);
  assert.deepEqual(refreshReportSchema.parse(report), report);
  assert.throws(() => piCredentialSchema.parse({ ...OAUTH, extra: true }));
  assert.throws(() => handoverPayloadSchema.parse({ items: [item] }));
  assert.throws(() => handoverPayloadSchema.parse({ ...payload, extra: true }));
  assert.throws(() =>
    handoverPayloadSchema.parse({
      ...payload,
      items: [{ ...item, extra: true }],
    }),
  );
  assert.throws(() =>
    handoverPayloadSchema.parse({
      ...payload,
      items: [
        { ...item, credential_id: ID.replace("credential", "execution") },
      ],
    }),
  );
  for (const entry of [
    { ...ssh, extra: true },
    { ...ssh, binding_id: ID },
    { ...ssh, private_key: "key" },
  ])
    assert.throws(() =>
      handoverPayloadSchema.parse({ ...payload, ssh_identities: [entry] }),
    );
  assert.throws(() => refreshReportSchema.parse({ ...report, extra: true }));
  assert.throws(() =>
    refreshReportSchema.parse({ ...report, digest: "invalid" }),
  );
});

test("a refresh report with extra OAuth fields normalizes before validation", () => {
  const report = {
    credential_id: ID,
    digest: digest(OAUTH),
    credential: { ...OAUTH, accountId: "account" },
  };
  assert.throws(() => refreshReportSchema.parse(report));
  assert.deepEqual(refreshReportSchema.parse(dropExtraOAuthFields(report)), {
    credential_id: ID,
    digest: digest(OAUTH),
    credential: OAUTH,
  });
  assert.equal(dropExtraOAuthFields(null), null);
  const apiReport = { credential_id: ID, digest: "x", credential: KEY };
  assert.equal(dropExtraOAuthFields(apiReport), apiReport);
});
