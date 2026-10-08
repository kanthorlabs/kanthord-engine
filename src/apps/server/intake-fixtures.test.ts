import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../../kernel/context.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { CheckEndState, type StorageBinding } from "../../mission/contract.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { temporary } from "../../kernel/test-support.ts";
import { GitHubPlatform, GitHubTargetKind } from "../../repository/github.ts";
import {
  objectSink,
  sinkStorage,
  fakeGitHub,
  FakePullState,
  gatewayFixture,
  bareRepository,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import { ResultClass } from "../../worker/contract.ts";

const KEY = "prefix#tag?query%2F space/é/project/mission/node/1/asset";
const BYTES = "hello";
const SHA256 = "a".repeat(64);
const LIFETIME = 3600000;
const NO_OBJECTS = 0;
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

const GITHUB_TOKEN = "test-secret";
const VALIDATION_FAILED_STATUS = 422;
const NO_PULLS = 0;
const ONE_PULL = 1;
const NO_CALLS = 0;
const GITHUB_DEADLINE_MS = 5000;
const GIT_DEADLINE_MS = 20000;
const HOLD_POLL_MS = 10;
const HOLD_POLL_LIMIT = 500;
const MERGE_SHA = "e".repeat(40);
const ADDRESS = "git@github.com:owner/repo.git";
const NODE_BRANCH = "kanthord/node";
const MAIN_REF = "refs/heads/main";
const target = { kind: GitHubTargetKind.Binding, address: ADDRESS } as const;
const gitHubCall = () => ({
  token: GITHUB_TOKEN,
  requester: call.identity,
  signal: new AbortController().signal,
  deadlineAt: Date.now() + GITHUB_DEADLINE_MS,
});
const branches = { head: NODE_BRANCH, base: "main" };

test("fake GitHub serves the pull-request routes and records each call", async (t) => {
  const gitHub = await fakeGitHub(t);
  const platform = new GitHubPlatform({ baseUrl: gitHub.endpoint });
  const created = await platform.createPullRequest(gitHubCall(), target, {
    ...branches,
    title: "kanthord node",
  });
  assert.deepEqual(created, { ok: true, value: { number: 1 } });
  assert.deepEqual(
    await platform.openPullRequests(gitHubCall(), target, branches),
    {
      ok: true,
      value: [1],
    },
  );
  const other = {
    kind: GitHubTargetKind.Inbound,
    resource: "owner/other",
  } as const;
  assert.deepEqual(
    await platform.openPullRequests(gitHubCall(), other, branches),
    {
      ok: true,
      value: [],
    },
  );
  const comments = await platform.listReviewComments(gitHubCall(), target, {
    number: 1,
  });
  assert.deepEqual(comments, {
    ok: true,
    value: { body: [], next_cursor: null },
  });
  gitHub.merge(1, MERGE_SHA);
  const merged = await platform.getPullRequest(gitHubCall(), target, {
    number: 1,
  });
  assert.ok(merged.ok);
  assert.deepEqual(
    platform.foldPullRequest(merged.value, "pull_request_merged"),
    {
      end_state: CheckEndState.Expected,
      landed_commits: [MERGE_SHA],
    },
  );
  assert.deepEqual(
    await platform.openPullRequests(gitHubCall(), target, branches),
    {
      ok: true,
      value: [],
    },
  );
  const missing = await platform.getPullRequest(gitHubCall(), target, {
    number: 9,
  });
  assert.equal(missing.ok, false);
  assert.equal(gitHub.pulls[0]?.state, FakePullState.Closed);
  assert.deepEqual(gitHub.calls[0], {
    method: "POST",
    path: "/repos/owner/repo/pulls",
    body: { ...branches, title: "kanthord node" },
    token: GITHUB_TOKEN,
  });
  assert.ok(gitHub.calls.every((item) => item.token === GITHUB_TOKEN));
});

test("fake GitHub closes a pull request and scripts the failures", async (t) => {
  const gitHub = await fakeGitHub(t);
  const platform = new GitHubPlatform({ baseUrl: gitHub.endpoint });
  const create = () =>
    platform.createPullRequest(gitHubCall(), target, {
      ...branches,
      title: "t",
    });
  gitHub.respondNext(VALIDATION_FAILED_STATUS, {
    message: "Validation Failed",
  });
  const refused = await create();
  assert.ok(!refused.ok);
  assert.equal(refused.class, ResultClass.FinalRefusal);
  assert.equal(refused.status, VALIDATION_FAILED_STATUS);
  assert.equal(gitHub.pulls.length, NO_PULLS);
  gitHub.dropNextAfterApply();
  const lost = await create();
  assert.ok(!lost.ok);
  assert.equal(lost.class, ResultClass.UnknownOutcome);
  assert.equal(lost.status, null);
  assert.equal(gitHub.pulls.length, ONE_PULL);
  gitHub.close(1);
  const closed = await platform.getPullRequest(gitHubCall(), target, {
    number: 1,
  });
  assert.ok(closed.ok);
  assert.equal(
    platform.foldPullRequest(closed.value, "pull_request_merged").end_state,
    CheckEndState.Other,
  );
  gitHub.failPulls(HttpStatus.ServiceUnavailable);
  const failed = await platform.getPullRequest(gitHubCall(), target, {
    number: 1,
  });
  assert.ok(!failed.ok);
  assert.equal(failed.class, ResultClass.RetryableRefusal);
  assert.equal(failed.status, HttpStatus.ServiceUnavailable);
  gitHub.failPulls(null);
  assert.ok(
    (await platform.getPullRequest(gitHubCall(), target, { number: 1 })).ok,
  );
});

test("fake GitHub opens a pull request without a recorded call", async (t) => {
  const gitHub = await fakeGitHub(t);
  const platform = new GitHubPlatform({ baseUrl: gitHub.endpoint });
  const number = gitHub.open({ owner: "owner", repo: "repo", ...branches });
  assert.equal(number, ONE_PULL);
  assert.equal(gitHub.calls.length, NO_CALLS);
  const opened = await platform.getPullRequest(gitHubCall(), target, {
    number,
  });
  assert.ok(opened.ok);
  assert.equal(
    platform.foldPullRequest(opened.value, "pull_request_merged").end_state,
    CheckEndState.None,
  );
  assert.equal(gitHub.calls.length, ONE_CALL);
});

test("fake GitHub holds every answer until the release", async (t) => {
  const gitHub = await fakeGitHub(t);
  const platform = new GitHubPlatform({ baseUrl: gitHub.endpoint });
  const release = gitHub.hold();
  let settled = false;
  const pending = platform
    .createPullRequest(gitHubCall(), target, { ...branches, title: "t" })
    .finally(() => {
      settled = true;
    });
  for (
    let poll = 0;
    poll < HOLD_POLL_LIMIT && gitHub.calls.length === NO_CALLS;
    poll++
  )
    await delay(HOLD_POLL_MS);
  assert.equal(gitHub.calls.length, ONE_CALL);
  await delay(HOLD_POLL_MS);
  assert.equal(settled, false);
  release();
  assert.deepEqual(await pending, { ok: true, value: { number: 1 } });
});

test("gatewayFixture passes the GitHub base URL and the repository transport", async (t) => {
  const gitHub = await fakeGitHub(t);
  const transport = mappedTransport({});
  const fixture = await gatewayFixture(t, {
    github: { baseUrl: gitHub.endpoint },
    repositoryTransport: transport,
  });
  assert.equal(fixture.gitWriter, transport);
  const created = await fixture.github.createPullRequest(gitHubCall(), target, {
    ...branches,
    title: "t",
  });
  assert.deepEqual(created, { ok: true, value: { number: 1 } });
  assert.equal(gitHub.calls.length, ONE_CALL);
});

async function pushNodeCommit(t: TestContext, bare: string): Promise<string> {
  const seed = join(temporary(t), "node");
  await simpleGit().clone(bare, seed);
  const git = simpleGit(seed);
  await git.addConfig("user.name", "Test Fixture");
  await git.addConfig("user.email", "test_fixture@example.invalid");
  writeFileSync(join(seed, "node.txt"), "node work\n");
  await git.add("node.txt");
  await git.commit("node work");
  const commit = (await git.revparse(["HEAD"])).trim();
  await git.push("origin", `HEAD:refs/heads/${NODE_BRANCH}`);
  assert.equal(await remoteHead(bare, `refs/heads/${NODE_BRANCH}`), commit);
  return commit;
}

test("mapped transport maps the address of the fresh git writes and the landing read", async (t) => {
  const repo = await bareRepository(t, "test_merge");
  const transport = mappedTransport({ [ADDRESS]: repo.bare });
  const commit = await pushNodeCommit(t, repo.bare);
  const deadline = () => Date.now() + GIT_DEADLINE_MS;
  const before = { address: ADDRESS, branch: "main", commit };
  assert.deepEqual(await transport.landedOn(before, background, deadline()), {
    landed: false,
    first_parent: null,
  });
  const merged = await transport.mergePushFresh(
    { address: ADDRESS, base_branch: "main", commit },
    background,
    deadline(),
  );
  assert.equal(await remoteHead(repo.bare, MAIN_REF), merged.commit);
  const parents = await simpleGit(repo.bare).raw([
    "rev-list",
    "--parents",
    "-n",
    "1",
    merged.commit,
  ]);
  assert.deepEqual(parents.trim().split(" ").slice(1), [repo.head, commit]);
  assert.deepEqual(await transport.landedOn(before, background, deadline()), {
    landed: true,
    first_parent: merged.commit,
  });
  await transport.pushSnapshotFresh(
    { address: ADDRESS, branch: "snapshot", commit },
    background,
    deadline(),
  );
  assert.equal(await remoteHead(repo.bare, "refs/heads/snapshot"), commit);
  assert.throws(
    () =>
      transport.landedOn(
        { ...before, address: "git@github.com:owner/unmapped.git" },
        background,
        deadline(),
      ),
    assert.AssertionError,
  );
});
