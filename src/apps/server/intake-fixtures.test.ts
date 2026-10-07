import assert from "node:assert/strict";
import { test } from "node:test";
import { background } from "../../kernel/context.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { CheckEndState, type StorageBinding } from "../../mission/contract.ts";
import {
  objectSink,
  sinkStorage,
  scriptedCheck,
  scriptedActions,
} from "./test-support.ts";
import { ResultClass } from "../../worker/contract.ts";

const KEY = "prefix#tag?query%2F space/é/project/mission/node/1/asset";
const BYTES = "hello";
const SHA256 = "a".repeat(64);
const LIFETIME = 3600000;
const NO_OBJECTS = 0;
const TWO_CALLS = 2;
const ONE_CALL = 1;
const binding: StorageBinding = {
  binding_id: "binding",
  project_id: "project",
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
  assert.ok(upload.expires_at >= before + LIFETIME);
  assert.ok(upload.expires_at <= Date.now() + LIFETIME);
  const checked = await storage.put(call, binding, KEY, BYTES.length, SHA256);
  assert.deepEqual(checked.headers, { "x-amz-checksum-sha256": SHA256 });
  await assert.rejects(
    storage.check(call, binding, KEY, BYTES.length, null),
    /object size mismatch/,
  );
  const response = await fetch(upload.put_url, { method: "PUT", body: BYTES });
  assert.equal(response.status, HttpStatus.OK);
  await response.arrayBuffer();
  assert.ok(sink.objects.has(KEY));
  assert.deepEqual(
    await storage.check(call, binding, KEY, BYTES.length, null),
    { location: `s3://${binding.bucket}/${KEY}`, version: null },
  );
  for (const get of [storage.get, storage.executionGet]) {
    const result = await get(call, binding, KEY, null);
    const content = await fetch(result.get_url);
    assert.equal(content.status, HttpStatus.OK);
    assert.equal(await content.text(), BYTES);
  }
  await storage.delete(call, binding, KEY, null, "asset-delete");
  const missing = await fetch(upload.put_url);
  assert.equal(missing.status, HttpStatus.NotFound);
  await missing.arrayBuffer();
  assert.equal(sink.objects.size, NO_OBJECTS);
});

test("the Intake action fake reads failed keys back and never redispatches a retained request", async () => {
  const fake = scriptedActions();
  const action = {
    key: "repo.pull_request",
    binding_id: "binding",
    action: "pull_request",
    expected_end_state: "pull_request_merged",
    follows: null,
    configuration: { base_branch: "main" },
  } as const;
  const operands = {
    nodeBranch: "kanthord/node",
    baseBranch: "main",
    commit: "a".repeat(40),
    reusedAddress: null,
  };
  const requestKey = "node/1/repo.pull_request";
  const failure = {
    class: ResultClass.UnknownOutcome,
    code: "timeout",
    message: "timeout",
  };
  const address = {
    kind: "pull_request",
    resource_identity: "repository:github:owner/repo",
    number: 42,
  } as const;
  fake.performAnswers.push(failure);
  const perform = () =>
    fake.seam.perform(
      { ...call, executionId: "execution" },
      action,
      operands,
      requestKey,
    );
  assert.deepEqual(await perform(), failure);
  assert.deepEqual(await perform(), failure);
  assert.equal(fake.performCalls.length, ONE_CALL);
  assert.deepEqual(fake.readBackCalls, [requestKey]);
  fake.readBackAnswers.push(address);
  assert.deepEqual(await perform(), address);
  assert.deepEqual(await perform(), address);
  assert.equal(fake.performCalls.length, ONE_CALL);
  assert.equal(fake.readBackCalls.length, TWO_CALLS);
});

test("scripted Intake check retains calls and isolates returned arrays", async () => {
  const fake = scriptedCheck({
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  const request = {
    frozen_action: {
      key: "repo.pull_request",
      binding_id: "binding",
      action: "pull_request",
      expected_end_state: "pull_request_merged",
      follows: null,
      configuration: { base_branch: "main" },
    },
    address: {
      kind: "pull_request",
      resource_identity: "repository:github:owner/repo",
      number: 42,
    },
  } as const;
  const answer = await fake.check(background, request);
  answer.landed_commits.push(SHA256);
  assert.deepEqual(await fake.check(background, request), {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  assert.equal(fake.calls.length, TWO_CALLS);
  assert.equal(fake.calls[0]?.[1], request);
});
