import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../../kernel/context.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { CheckEndState, type StorageBinding } from "../../mission/contract.ts";
import { objectSink, sinkStorage, scriptedCheck } from "./test-support.ts";

const KEY = "prefix/project/mission/node/1/asset";
const BYTES = "hello";
const SHA256 = "a".repeat(64);
const LIFETIME = 3600000;
const NO_OBJECTS = 0;
const TWO_CALLS = 2;
const binding: StorageBinding = {
  bindingId: "binding",
  projectId: "project",
  endpoint: "https://s3.example.com",
  bucket: "evidence",
  region: "eu-central-1",
  prefix: "prefix",
  credential: "store",
  available: true,
};
const call = {
  context: background,
  identity: testHumanIdentity("ulrich", "Ulrich", "token"),
};

test("Intake storage fixture transfers bytes, checks length and removes objects", async (t) => {
  const sink = await objectSink(t);
  const storage = sinkStorage(sink);
  const before = Date.now();
  const upload = await storage.put(call, binding, KEY, BYTES.length, null);
  assert.deepEqual(upload.headers, {});
  assert.ok(upload.expiresAt >= before + LIFETIME);
  assert.ok(upload.expiresAt <= Date.now() + LIFETIME);
  const checked = await storage.put(call, binding, KEY, BYTES.length, SHA256);
  assert.deepEqual(checked.headers, { "x-amz-checksum-sha256": SHA256 });
  await assert.rejects(
    storage.check(call, binding, KEY, BYTES.length, null),
    /object size mismatch/,
  );
  const response = await fetch(upload.putUrl, { method: "PUT", body: BYTES });
  assert.equal(response.status, HttpStatus.OK);
  await response.arrayBuffer();
  assert.deepEqual(
    await storage.check(call, binding, KEY, BYTES.length, null),
    { location: `s3://${binding.bucket}/${KEY}`, version: null },
  );
  for (const get of [storage.get, storage.executionGet]) {
    const result = await get(call, binding, KEY, null);
    const content = await fetch(result.getUrl);
    assert.equal(content.status, HttpStatus.OK);
    assert.equal(await content.text(), BYTES);
  }
  await storage.delete(call, binding, KEY, null);
  const missing = await fetch(upload.putUrl);
  assert.equal(missing.status, HttpStatus.NotFound);
  await missing.arrayBuffer();
  assert.equal(sink.objects.size, NO_OBJECTS);
});

test("scripted Intake check retains calls and isolates returned arrays", async () => {
  const fake = scriptedCheck({
    endState: CheckEndState.None,
    landedCommits: [],
  });
  const request = {
    frozenAction: {
      key: "repo.pull_request",
      bindingId: "binding",
      action: "pull_request",
      expectedEndState: "pull_request_merged",
      follows: null,
      configuration: { baseBranch: "main" },
    },
    address: {
      kind: "pull_request",
      resourceIdentity: "repository:github:owner/repo",
      number: 42,
    },
  } as const;
  const answer = await fake.check(background, request);
  answer.landedCommits.push(SHA256);
  assert.deepEqual(await fake.check(background, request), {
    endState: CheckEndState.None,
    landedCommits: [],
  });
  assert.equal(fake.calls.length, TWO_CALLS);
  assert.equal(fake.calls[0]?.[1], request);
});
