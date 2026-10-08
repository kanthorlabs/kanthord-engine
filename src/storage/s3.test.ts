import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { PRESIGN_LIFETIME_S, ResultClass } from "../intake/contract.ts";
import { HttpStatus } from "../kernel/http.ts";
import { storageImplementations } from "./index.ts";
import {
  CHECKSUM_SHA256_HEADER,
  CONTENT_LENGTH_HEADER,
  S3Platform,
  S3_RESULT_CODE_PREFIX,
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
const SHORT_DEADLINE_MS = 600;
const MS_PER_S = 1000;
const ONE_REQUEST = 1;
const SIGNED_HEADERS = "X-Amz-SignedHeaders";
const EXPIRES = "X-Amz-Expires";
const VERSION_ID = "versionId";
const HEAD = "HEAD";
const DELETE = "DELETE";
const CRC32_PARAMETER = "x-amz-checksum-crc32";
const CHECKSUM_MODE_HEADER = "x-amz-checksum-mode";
const CHECKSUM_MODE_ENABLED = "ENABLED";
const UNKNOWN_OUTCOME_CODE = "storage.platform.s3.unknown_outcome";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

interface Store {
  endpoint: string;
  requests: IncomingMessage[];
}

async function store(t: TestContext, handler: Handler): Promise<Store> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    request.resume();
    request.once("end", () => handler(request, response));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { endpoint: `http://127.0.0.1:${port}`, requests };
}

function status(code: number, headers: Record<string, string> = {}): Handler {
  return (_request, response) => {
    response.writeHead(code, headers);
    response.end();
  };
}

const lose: Handler = (request) => {
  request.socket.destroy();
};

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

test("headObject answers the size, the hexadecimal SHA-256 and the version", async (t) => {
  const s3 = await store(
    t,
    status(HttpStatus.OK, {
      [CONTENT_LENGTH_HEADER]: String(SIZE),
      [CHECKSUM_SHA256_HEADER]: SHA256_BASE64,
      "x-amz-checksum-type": "FULL_OBJECT",
      "x-amz-version-id": VERSION,
    }),
  );
  const answer = await new S3Platform().headObject(call(), {
    ...location(s3.endpoint),
    key: KEY,
    version: VERSION,
  });
  assert.deepEqual(answer, {
    ok: true,
    value: { size: SIZE, sha256: SHA256, version: VERSION },
  });
  assert.equal(s3.requests.length, ONE_REQUEST);
  const request = s3.requests[0];
  assert.ok(request);
  assert.equal(request.method, HEAD);
  const url = new URL(request.url ?? "", s3.endpoint);
  assert.equal(url.searchParams.get(VERSION_ID), VERSION);
  assert.equal(request.headers[CHECKSUM_MODE_HEADER], CHECKSUM_MODE_ENABLED);
});

test("headObject maps 404 to null and 403 to final_refusal", async (t) => {
  const missing = await store(t, status(HttpStatus.NotFound));
  const target = { key: KEY, version: VERSION };
  const absent = await new S3Platform().headObject(call(), {
    ...location(missing.endpoint),
    ...target,
  });
  assert.deepEqual(absent, { ok: true, value: null });
  const forbidden = await store(t, status(HttpStatus.Forbidden));
  const refused = await new S3Platform().headObject(call(), {
    ...location(forbidden.endpoint),
    ...target,
  });
  assert.ok(!refused.ok);
  assert.equal(refused.class, ResultClass.FinalRefusal);
  assert.equal(refused.code, S3_RESULT_CODE_PREFIX + ResultClass.FinalRefusal);
  assert.equal(refused.status, HttpStatus.Forbidden);
  assert.equal(forbidden.requests.length, ONE_REQUEST);
  assertNoSecret(refused);
});

test("headObject retries a lost answer until the deadline and answers retryable_refusal", async (t) => {
  const s3 = await store(t, lose);
  const answer = await new S3Platform().headObject(call(SHORT_DEADLINE_MS), {
    ...location(s3.endpoint),
    key: KEY,
    version: null,
  });
  assert.ok(!answer.ok);
  assert.equal(answer.class, ResultClass.RetryableRefusal);
  assert.equal(answer.status, null);
  assert.ok(s3.requests.length > ONE_REQUEST);
});

test("deleteObject sends the version and answers the deleted version", async (t) => {
  const s3 = await store(
    t,
    status(HttpStatus.NoContent, { "x-amz-version-id": VERSION }),
  );
  const answer = await new S3Platform().deleteObject(call(), {
    ...location(s3.endpoint),
    key: KEY,
    version: VERSION,
  });
  assert.deepEqual(answer, { ok: true, value: { version: VERSION } });
  assert.equal(s3.requests.length, ONE_REQUEST);
  const request = s3.requests[0];
  assert.ok(request);
  assert.equal(request.method, DELETE);
  const url = new URL(request.url ?? "", s3.endpoint);
  assert.equal(url.pathname, `/${BUCKET}/${KEY}`);
  assert.equal(url.searchParams.get(VERSION_ID), VERSION);
});

test("deleteObject sends one request for a 503 and answers unknown_outcome with the status", async (t) => {
  const s3 = await store(t, status(HttpStatus.ServiceUnavailable));
  const answer = await new S3Platform().deleteObject(call(), {
    ...location(s3.endpoint),
    key: KEY,
    version: VERSION,
  });
  assert.ok(!answer.ok);
  assert.equal(answer.class, ResultClass.UnknownOutcome);
  assert.equal(answer.code, UNKNOWN_OUTCOME_CODE);
  assert.equal(answer.status, HttpStatus.ServiceUnavailable);
  assert.equal(s3.requests.length, ONE_REQUEST);
  assertNoSecret(answer);
});

test("deleteObject answers unknown_outcome with a null status for a lost answer", async (t) => {
  const s3 = await store(t, lose);
  const answer = await new S3Platform().deleteObject(call(), {
    ...location(s3.endpoint),
    key: KEY,
    version: VERSION,
  });
  assert.ok(!answer.ok);
  assert.equal(answer.class, ResultClass.UnknownOutcome);
  assert.equal(answer.status, null);
  assert.equal(s3.requests.length, ONE_REQUEST);
  assertNoSecret(answer);
});

test("deleteObject answers retryable_refusal for a 429 and a SlowDown", async (t) => {
  const limited = await store(t, status(HttpStatus.TooManyRequests));
  const slow = await store(t, (_request, response) => {
    response.writeHead(HttpStatus.ServiceUnavailable, {
      "content-type": "application/xml",
    });
    response.end("<Error><Code>SlowDown</Code><Message>slow</Message></Error>");
  });
  for (const s3 of [limited, slow]) {
    const answer = await new S3Platform().deleteObject(call(), {
      ...location(s3.endpoint),
      key: KEY,
      version: null,
    });
    assert.ok(!answer.ok);
    assert.equal(answer.class, ResultClass.RetryableRefusal);
    assert.equal(s3.requests.length, ONE_REQUEST);
  }
});

test("deleteObject answers confirmed_failure when the connection fails before dispatch", async () => {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  const answer = await new S3Platform().deleteObject(call(), {
    ...location(`http://127.0.0.1:${port}`),
    key: KEY,
    version: VERSION,
  });
  assert.ok(!answer.ok);
  assert.equal(answer.class, ResultClass.ConfirmedFailure);
  assert.equal(answer.status, null);
  assertNoSecret(answer);
});
