import assert from "node:assert/strict";
import { test } from "node:test";
import { HttpStatus } from "../../kernel/http.ts";
import { S3Platform } from "../../storage/s3.ts";
import { fakeS3 } from "./test-support.ts";

const KEY = "prefix#tag?query%2F space/é/project/mission/node/1/asset";
const BYTES = "hello";
const LIFETIME = 3600000;
const NO_OBJECTS = 0;
const S3_DEADLINE_MS = 5000;
const S3_REGION = "eu-central-1";
const FIRST_VERSION = "v1";
const s3Call = () => ({
  accessKeyId: "access",
  secretAccessKey: "secret",
  signal: new AbortController().signal,
  deadlineAt: Date.now() + S3_DEADLINE_MS,
});

test("fake S3 transfers, reads and removes a key with reserved characters", async (t) => {
  const s3 = await fakeS3(t);
  const platform = new S3Platform();
  const location = {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: S3_REGION,
  };
  const before = Date.now();
  const upload = await platform.presignPut(s3Call(), {
    ...location,
    key: KEY,
    size: BYTES.length,
    sha256: null,
  });
  assert.ok(upload.expires_at >= before + LIFETIME);
  assert.ok(upload.expires_at <= Date.now() + LIFETIME);
  const stored = await fetch(upload.put_url, {
    method: "PUT",
    headers: upload.headers,
    body: BYTES,
  });
  assert.equal(stored.status, HttpStatus.OK);
  await stored.arrayBuffer();
  assert.deepEqual(
    s3.objects(KEY).map((item) => item.version),
    [FIRST_VERSION],
  );
  const head = await platform.headObject(s3Call(), {
    ...location,
    key: KEY,
    version: FIRST_VERSION,
  });
  assert.ok(head.ok);
  assert.deepEqual(head.value, {
    size: BYTES.length,
    sha256: null,
    version: FIRST_VERSION,
  });
  const read = await platform.presignGet(s3Call(), {
    ...location,
    key: KEY,
    version: FIRST_VERSION,
  });
  const content = await fetch(read.get_url);
  assert.equal(content.status, HttpStatus.OK);
  assert.equal(await content.text(), BYTES);
  const deleted = await platform.deleteObject(s3Call(), {
    ...location,
    key: KEY,
    version: FIRST_VERSION,
  });
  assert.ok(deleted.ok);
  assert.equal(s3.objects(KEY).length, NO_OBJECTS);
  assert.ok(s3.calls.every((item) => item.key === KEY));
});
