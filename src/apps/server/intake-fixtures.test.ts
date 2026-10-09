import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../../kernel/context.ts";
import { testHumanIdentity } from "../../kernel/test-identity.ts";
import { HttpStatus } from "../../kernel/http.ts";
import { CheckEndState } from "../../mission/contract.ts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { simpleGit } from "simple-git";
import { temporary } from "../../kernel/test-support.ts";
import { GitHubPlatform, GitHubTargetKind } from "../../repository/github.ts";
import {
  fakeGitHub,
  fakeS3,
  FakePullState,
  gatewayFixture,
  bareRepository,
  mappedTransport,
  remoteHead,
} from "./test-support.ts";
import { ResultClass } from "../../worker/contract.ts";
import { S3Platform } from "../../storage/s3.ts";
import { createHash } from "node:crypto";

const KEY = "prefix#tag?query%2F space/é/project/mission/node/1/asset";
const BYTES = "hello";
const LIFETIME = 3600000;
const NO_OBJECTS = 0;
const ONE_CALL = 1;
const TWO_CALLS = 2;
const LAST_CALLS = 3;
const call = {
  context: background,
  identity: testHumanIdentity("ulrich", "Ulrich", "token"),
};

const GITHUB_TOKEN = "test-secret";
const VALIDATION_FAILED_STATUS = 422;
const NO_PULLS = 0;
const NOT_MODIFIED_STATUS = 304;
const CREATED_STATUS = 201;
const EVENTS_PATH = "/repos/owner/repo/events?per_page=100";
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
    if_none_match: null,
    status: CREATED_STATUS,
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

const eventsQuery = (etag: string | null) => ({
  owner: "owner",
  repo: "repo",
  etag,
});
const gitHubEvent = (id: string) => ({ id, type: "PushEvent", payload: {} });

test("fake GitHub changes the ETag with the list and answers 304 for a match", async (t) => {
  const gitHub = await fakeGitHub(t);
  const platform = new GitHubPlatform({ baseUrl: gitHub.endpoint });
  gitHub.events("owner", "repo", [gitHubEvent("101")]);
  const first = await platform.listEvents(gitHubCall(), eventsQuery(null));
  assert.ok(first.ok && !first.value.notModified);
  assert.deepEqual(
    first.value.events.map((event) => event.id),
    ["101"],
  );
  assert.ok(first.value.etag);
  const again = await platform.listEvents(
    gitHubCall(),
    eventsQuery(first.value.etag),
  );
  assert.deepEqual(again, { ok: true, value: { notModified: true } });
  gitHub.events("owner", "repo", [gitHubEvent("102"), gitHubEvent("101")]);
  const changed = await platform.listEvents(
    gitHubCall(),
    eventsQuery(first.value.etag),
  );
  assert.ok(changed.ok && !changed.value.notModified);
  assert.notEqual(changed.value.etag, first.value.etag);
  assert.deepEqual(
    gitHub.calls.map((item) => [item.if_none_match, item.status]),
    [
      [null, HttpStatus.OK],
      [first.value.etag, NOT_MODIFIED_STATUS],
      [first.value.etag, HttpStatus.OK],
    ],
  );
  assert.equal(gitHub.calls[0]?.path, EVENTS_PATH);
});

test("fake GitHub scripts the events failures and holds the later events calls", async (t) => {
  const gitHub = await fakeGitHub(t);
  const platform = new GitHubPlatform({ baseUrl: gitHub.endpoint });
  gitHub.events("owner", "repo", [gitHubEvent("101")]);
  gitHub.respondNext(HttpStatus.Unauthorized, { message: "Bad credentials" });
  const refused = await platform.listEvents(gitHubCall(), eventsQuery(null));
  assert.ok(!refused.ok);
  assert.equal(refused.status, HttpStatus.Unauthorized);
  gitHub.failEvents(HttpStatus.InternalServerError);
  const release = gitHub.holdEvents({ pass: ONE_CALL });
  const passed = await platform.listEvents(gitHubCall(), eventsQuery(null));
  assert.ok(!passed.ok);
  assert.equal(passed.status, HttpStatus.InternalServerError);
  let settled = false;
  const held = platform
    .listEvents(gitHubCall(), eventsQuery(null))
    .finally(() => {
      settled = true;
    });
  for (
    let poll = 0;
    poll < HOLD_POLL_LIMIT && gitHub.calls.length < LAST_CALLS;
    poll++
  )
    await delay(HOLD_POLL_MS);
  assert.equal(gitHub.calls.length, LAST_CALLS);
  await delay(HOLD_POLL_MS);
  assert.equal(settled, false);
  assert.equal(gitHub.calls[TWO_CALLS]?.status, null);
  gitHub.failEvents(null);
  release();
  const released = await held;
  assert.ok(released.ok && !released.value.notModified);
  assert.deepEqual(
    gitHub.calls.map((item) => item.status),
    [HttpStatus.Unauthorized, HttpStatus.InternalServerError, HttpStatus.OK],
  );
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

const S3_DEADLINE_MS = 5000;
const S3_REGION = "eu-central-1";
const S3_KEY = "project/mission/node/1/asset";
const FIRST_VERSION = "v1";
const SECOND_VERSION = "v2";
const SECOND_BYTES = "second";
const SCRIPTED_STATUS = 503;
const s3Call = () => ({
  accessKeyId: "access",
  secretAccessKey: "secret",
  signal: new AbortController().signal,
  deadlineAt: Date.now() + S3_DEADLINE_MS,
});
const sha256Of = (value: string) =>
  createHash("sha256").update(value).digest("hex");

test("fake S3 stores a PUT with and without a SHA-256", async (t) => {
  const s3 = await fakeS3(t);
  const platform = new S3Platform();
  const location = {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: S3_REGION,
  };
  const plain = await platform.presignPut(s3Call(), {
    ...location,
    key: S3_KEY,
    size: BYTES.length,
    sha256: null,
  });
  const stored = await fetch(plain.put_url, {
    method: "PUT",
    headers: plain.headers,
    body: BYTES,
  });
  assert.equal(stored.status, HttpStatus.OK);
  assert.equal(stored.headers.get("x-amz-version-id"), FIRST_VERSION);
  const head = await platform.headObject(s3Call(), {
    ...location,
    key: S3_KEY,
    version: null,
  });
  assert.ok(head.ok);
  assert.deepEqual(head.value, {
    size: BYTES.length,
    sha256: null,
    version: FIRST_VERSION,
  });
  const bound = await platform.presignPut(s3Call(), {
    ...location,
    key: S3_KEY,
    size: BYTES.length,
    sha256: sha256Of(BYTES),
  });
  const mismatch = await fetch(bound.put_url, {
    method: "PUT",
    headers: {
      ...bound.headers,
      "x-amz-checksum-sha256": Buffer.from(
        sha256Of(SECOND_BYTES),
        "hex",
      ).toString("base64"),
    },
    body: BYTES,
  });
  assert.equal(mismatch.status, HttpStatus.BadRequest);
  assert.equal(s3.objects(S3_KEY).length, ONE_CALL);
  const accepted = await fetch(bound.put_url, {
    method: "PUT",
    headers: bound.headers,
    body: BYTES,
  });
  assert.equal(accepted.status, HttpStatus.OK);
  const checked = await platform.headObject(s3Call(), {
    ...location,
    key: S3_KEY,
    version: SECOND_VERSION,
  });
  assert.ok(checked.ok);
  assert.deepEqual(checked.value, {
    size: BYTES.length,
    sha256: sha256Of(BYTES),
    version: SECOND_VERSION,
  });
  const unsigned = await fetch(`${s3.endpoint}/${s3.bucket}/${S3_KEY}`, {
    method: "PUT",
    body: BYTES,
  });
  assert.equal(unsigned.status, HttpStatus.Forbidden);
});

test("fake S3 keeps the first version addressable after a second PUT", async (t) => {
  const s3 = await fakeS3(t);
  const platform = new S3Platform();
  const location = {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: S3_REGION,
  };
  for (const body of [BYTES, SECOND_BYTES]) {
    const put = await platform.presignPut(s3Call(), {
      ...location,
      key: S3_KEY,
      size: body.length,
      sha256: null,
    });
    const stored = await fetch(put.put_url, {
      method: "PUT",
      headers: put.headers,
      body,
    });
    assert.equal(stored.status, HttpStatus.OK);
  }
  assert.deepEqual(
    s3.objects(S3_KEY).map((item) => item.version),
    [FIRST_VERSION, SECOND_VERSION],
  );
  const first = await platform.presignGet(s3Call(), {
    ...location,
    key: S3_KEY,
    version: FIRST_VERSION,
  });
  assert.equal(await (await fetch(first.get_url)).text(), BYTES);
  const newest = await platform.presignGet(s3Call(), {
    ...location,
    key: S3_KEY,
    version: null,
  });
  assert.equal(await (await fetch(newest.get_url)).text(), SECOND_BYTES);
  const deleted = await platform.deleteObject(s3Call(), {
    ...location,
    key: S3_KEY,
    version: FIRST_VERSION,
  });
  assert.ok(deleted.ok);
  assert.deepEqual(deleted.value, { version: FIRST_VERSION });
  assert.deepEqual(
    s3.objects(S3_KEY).map((item) => item.version),
    [SECOND_VERSION],
  );
  const gone = await platform.headObject(s3Call(), {
    ...location,
    key: S3_KEY,
    version: FIRST_VERSION,
  });
  assert.ok(gone.ok);
  assert.equal(gone.value, null);
  assert.deepEqual(
    s3.calls.slice(-LAST_CALLS).map((item) => [item.method, item.version]),
    [
      ["GET", null],
      ["DELETE", FIRST_VERSION],
      ["HEAD", FIRST_VERSION],
    ],
  );
  assert.ok(s3.calls.every((item) => item.key === S3_KEY));
});

test("fake S3 scripts one failure status", async (t) => {
  const s3 = await fakeS3(t);
  const platform = new S3Platform();
  const target = {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: S3_REGION,
    key: S3_KEY,
    version: null,
  };
  s3.failNext(SCRIPTED_STATUS);
  const failed = await platform.deleteObject(s3Call(), target);
  assert.ok(!failed.ok);
  assert.equal(failed.class, ResultClass.UnknownOutcome);
  assert.equal(failed.status, SCRIPTED_STATUS);
  const answered = await platform.deleteObject(s3Call(), target);
  assert.ok(answered.ok);
  assert.equal(s3.calls.length, TWO_CALLS);
});

test("fake S3 loses the next answers and then answers again", async (t) => {
  const s3 = await fakeS3(t);
  const platform = new S3Platform();
  const target = {
    endpoint: s3.endpoint,
    bucket: s3.bucket,
    region: S3_REGION,
    key: S3_KEY,
    version: null,
  };
  s3.loseNext();
  const lost = await platform.deleteObject(s3Call(), target);
  assert.ok(!lost.ok);
  assert.equal(lost.class, ResultClass.UnknownOutcome);
  assert.equal(lost.status, null);
  const answered = await platform.deleteObject(s3Call(), target);
  assert.ok(answered.ok);
  assert.equal(s3.calls.length, TWO_CALLS);
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
