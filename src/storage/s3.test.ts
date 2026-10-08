import assert from "node:assert/strict";
import { test } from "node:test";
import { PRESIGN_LIFETIME_S } from "../intake/contract.ts";
import { storageImplementations } from "./index.ts";
import {
  CHECKSUM_SHA256_HEADER,
  CONTENT_LENGTH_HEADER,
  S3Platform,
  type S3Call,
  type S3Location,
} from "./s3.ts";

const ACCESS_KEY_ID = "test_private-s3-access-id";
const SECRET = "test_private-s3-secret-access-key";
const BUCKET = "evidence";
const REGION = "us-east-1";
const KEY = "project/node/asset";
const VERSION = "version-1";
const SIZE = 12;
const SHA256 = "ab".repeat(32);
const SHA256_BASE64 = Buffer.from(SHA256, "hex").toString("base64");
const CALL_DEADLINE_MS = 5000;
const MS_PER_S = 1000;
const SIGNED_HEADERS = "X-Amz-SignedHeaders";
const EXPIRES = "X-Amz-Expires";
const VERSION_ID = "versionId";
const CRC32_PARAMETER = "x-amz-checksum-crc32";

function call(deadlineMs = CALL_DEADLINE_MS): S3Call {
  return {
    accessKeyId: ACCESS_KEY_ID,
    secretAccessKey: SECRET,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + deadlineMs,
  };
}

function location(endpoint: string): S3Location {
  return { endpoint, bucket: BUCKET, region: REGION };
}

function assertNoSecret(value: unknown): void {
  assert.ok(!JSON.stringify(value).includes(SECRET));
}

test("the registry holds the S3 implementation under its platform value", () => {
  assert.equal(storageImplementations.s3, S3Platform);
});

test("the PUT URL expires after the presign lifetime and binds the content length", async () => {
  const platform = new S3Platform();
  const before = Date.now();
  const answer = await platform.presignPut(call(), {
    ...location("http://127.0.0.1:9"),
    key: KEY,
    size: SIZE,
    sha256: null,
  });
  const url = new URL(answer.put_url);
  assert.equal(url.pathname, `/${BUCKET}/${KEY}`);
  assert.equal(url.searchParams.get(EXPIRES), String(PRESIGN_LIFETIME_S));
  const signed = url.searchParams.get(SIGNED_HEADERS)?.split(";") ?? [];
  assert.ok(signed.includes(CONTENT_LENGTH_HEADER));
  assert.ok(!signed.includes(CHECKSUM_SHA256_HEADER));
  assert.deepEqual(answer.headers, { [CONTENT_LENGTH_HEADER]: String(SIZE) });
  assert.equal(url.searchParams.get(CRC32_PARAMETER), null);
  assert.ok(answer.expires_at >= before + PRESIGN_LIFETIME_S * MS_PER_S);
  assert.ok(answer.expires_at <= Date.now() + PRESIGN_LIFETIME_S * MS_PER_S);
  assertNoSecret(answer);
});

test("the PUT URL binds the checksum header only with a SHA-256", async () => {
  const platform = new S3Platform();
  const answer = await platform.presignPut(call(), {
    ...location("http://127.0.0.1:9"),
    key: KEY,
    size: SIZE,
    sha256: SHA256,
  });
  const url = new URL(answer.put_url);
  const signed = url.searchParams.get(SIGNED_HEADERS)?.split(";") ?? [];
  assert.ok(signed.includes(CHECKSUM_SHA256_HEADER));
  assert.ok(signed.includes(CONTENT_LENGTH_HEADER));
  assert.deepEqual(answer.headers, {
    [CONTENT_LENGTH_HEADER]: String(SIZE),
    [CHECKSUM_SHA256_HEADER]: SHA256_BASE64,
  });
  assertNoSecret(answer);
});

test("the GET URL names the recorded version and expires after the presign lifetime", async () => {
  const platform = new S3Platform();
  const target = { ...location("http://127.0.0.1:9"), key: KEY };
  const versioned = await platform.presignGet(call(), {
    ...target,
    version: VERSION,
  });
  const url = new URL(versioned.get_url);
  assert.equal(url.searchParams.get(VERSION_ID), VERSION);
  assert.equal(url.searchParams.get(EXPIRES), String(PRESIGN_LIFETIME_S));
  const latest = await platform.presignGet(call(), {
    ...target,
    version: null,
  });
  assert.equal(new URL(latest.get_url).searchParams.get(VERSION_ID), null);
  assertNoSecret([versioned, latest]);
});
