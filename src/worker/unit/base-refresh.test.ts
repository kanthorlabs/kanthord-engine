import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import type { Revision } from "../../mission/contract.ts";
import {
  refreshAtClaim,
  refreshAtRelease,
  RefreshResult,
} from "./base-refresh.ts";
import { ReleaseGateKind } from "./release-gate.ts";
import { ConflictAttribute, ConflictEnd } from "./method-telemetry.ts";
import { ExecutionStop } from "./execution-stop.ts";
import { MERGE_MARKERS_LEFT } from "./stop-codes.ts";
import { SpanOperation } from "./telemetry.ts";
import { RecordKind } from "../../tracking/contract.ts";
import { releaseGate } from "./steps-implement-host.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture,
  recordSpans,
  spanEnds,
} from "./test-support.ts";
import { sshAccessOf } from "./workspace.ts";
import { RELEASE_DIRECTORY } from "./workspace-layout.ts";
import { PoolClass, repoKeyOf } from "./tree-pool.ts";
import type { SshAccess } from "../../repository/contract.ts";
import { workerPorts } from "./worker-ports.ts";

const BINDINGS = ["api", "web"];
const DEADLINE_MS = 20000;
const BASE_CHANGE = "base change";
const RESOLVED = "resolved";
const UPSTREAM = "up";
const BASE_BRANCH = "main";
const UPSTREAM_CHANGE = "upstream change";
const TWO_MERGES = "2";
const TWO_PARENTS = 2;
const NO_OUTPUT = "";
const ONE_TREE = 1;
const TEST_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const NODE_CONTENT = {
  name: "node",
  requirement: "node",
  criterion: "node",
  verifications: ["true"],
  bindings: [],
};

async function fixture(
  t: TestContext,
  script: Parameters<typeof implementFixture>[2] = [],
  turns?: number,
) {
  const h = await implementFixture(t, [], script, turns, BINDINGS);
  h.revision = { content: NODE_CONTENT, tasks: [] } as unknown as Revision;
  const [api, web] = h.checkouts;
  assert.ok(api && web);
  const [apiBare, webBare] = h.bares;
  assert.ok(apiBare && webBare);
  return { h, api, web, apiBare, webBare };
}

const headOf = async (directory: string) =>
  (await simpleGit(directory).revparse(["HEAD"])).trim();

test("a claim merges the base branch of each binding", async (t) => {
  const { h, api, web, apiBare, webBare } = await fixture(t);
  await advanceBase({ bare: apiBare }, t, BASE_CHANGE, "api-base");
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "web-base");
  for (const checkout of h.checkouts)
    await h.input.transport.fetchBase(
      checkout.directory,
      "main",
      background,
      DEADLINE_MS,
      sshAccessOf(h.input.sshAccess, checkout.binding_id),
    );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(
    readFileSync(join(api.directory, "api-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(
    readFileSync(join(web.directory, "web-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(api.head, await headOf(api.directory));
  assert.equal(web.head, await headOf(web.directory));
});

test("a conflict at the release goes through the conflict turn and concludes the merge", async (t) => {
  const { h, web, webBare } = await fixture(t, [
    fauxAssistantMessage(
      fauxToolCall("write", { path: "web/file", content: RESOLVED }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("resolved"),
  ]);
  await commitOnNode(web.directory, "node side");
  web.head = await headOf(web.directory);
  const before = web.head;
  await advanceBase({ bare: webBare }, t, "main side");
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.Merged,
  );
  assert.equal(readFileSync(join(web.directory, "file"), "utf8"), RESOLVED);
  assert.equal(web.head, await headOf(web.directory));
  assert.equal(
    (await simpleGit(web.directory).raw(["rev-parse", `${web.head}^1`])).trim(),
    before,
  );
  assert.equal((await simpleGit(web.directory).status()).isClean(), true);
});

test("a failed release verification keeps the merged heads and routes a revision", async (t) => {
  const { h, api, web, apiBare, webBare } = await fixture(t);
  h.revision = {
    content: { ...NODE_CONTENT, verifications: ["false"] },
    tasks: [],
  } as unknown as Revision;
  const before = [api.head, web.head];
  await advanceBase({ bare: apiBare }, t, BASE_CHANGE, "other");
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "other");
  const gate = await releaseGate(h);
  assert.equal(gate.kind, ReleaseGateKind.Routed);
  assert.notDeepEqual([api.head, web.head], before);
  for (const checkout of h.checkouts) {
    assert.equal(await headOf(checkout.directory), checkout.head);
    assert.equal(
      readFileSync(join(checkout.directory, "other"), "utf8"),
      BASE_CHANGE,
    );
  }
  assert.equal(
    existsSync(
      join(
        h.input.workspaces.nodeKey(h.input.claim.node_id),
        RELEASE_DIRECTORY,
      ),
    ),
    false,
  );
  const pool = h.input.workspaces.pool;
  for (const repository of h.input.setup.repositories)
    assert.equal(
      pool
        .trees()
        .filter(
          (tree) =>
            dirname(tree.path) ===
            join(pool.root, repoKeyOf(repository.address), PoolClass.Command),
        ).length,
      ONE_TREE,
    );
});

test("the refresh fetches the base of each checkout with the SSH identity of its binding", async (t) => {
  const { h } = await fixture(t);
  const fetched: { directory: string; ssh: SshAccess }[] = [];
  const fetchBase = h.input.transport.fetchBase;
  h.input.transport = {
    ...h.input.transport,
    fetchBase: (directory, base, context, deadlineMs, ssh) => {
      fetched.push({ directory, ssh });
      return fetchBase(directory, base, context, deadlineMs, ssh);
    },
  };
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.Current,
  );
  assert.deepEqual(
    fetched,
    h.checkouts.map((checkout) => ({
      directory: checkout.directory,
      ssh: h.input.sshAccess.get(checkout.binding_id),
    })),
  );
});

async function advanceUpstream(
  bare: string,
  t: TestContext,
  content: string,
  path = "file",
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(bare, clone, ["--branch", "main"]);
  const published = (
    await git.raw(["ls-remote", "--heads", "origin", UPSTREAM])
  ).trim();
  await git.raw([
    "checkout",
    "-B",
    UPSTREAM,
    published === NO_OUTPUT ? BASE_BRANCH : `origin/${UPSTREAM}`,
  ]);
  writeFileSync(join(clone, path), content);
  await git.add(path);
  await git.raw([
    ...TEST_IDENTITY,
    "commit",
    "-m",
    `upstream change of ${path}`,
  ]);
  await git.push("origin", UPSTREAM);
}

function followUpstream(h: Awaited<ReturnType<typeof fixture>>["h"]) {
  h.input.setup.repositories[1]!.strategy.upstream_branch = UPSTREAM;
}

const parentsOf = async (directory: string, commit: string) =>
  (await simpleGit(directory).raw(["rev-list", "--parents", "-n", "1", commit]))
    .trim()
    .split(" ")
    .slice(1);

test("a claim with upstream_branch merges the base, then the upstream, and the head has two merge commits", async (t) => {
  const { h, web, webBare } = await fixture(t);
  followUpstream(h);
  const before = web.head;
  await advanceBase({ bare: webBare }, t, BASE_CHANGE, "web-base");
  await advanceUpstream(webBare, t, UPSTREAM_CHANGE, "web-upstream");
  for (const branch of ["main", UPSTREAM])
    await h.input.transport.fetchBase(
      web.directory,
      branch,
      background,
      DEADLINE_MS,
      sshAccessOf(h.input.sshAccess, web.binding_id),
    );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  assert.equal(
    readFileSync(join(web.directory, "web-base"), "utf8"),
    BASE_CHANGE,
  );
  assert.equal(
    readFileSync(join(web.directory, "web-upstream"), "utf8"),
    UPSTREAM_CHANGE,
  );
  const git = simpleGit(web.directory);
  assert.equal(
    (
      await git.raw(["rev-list", "--merges", "--count", `${before}..HEAD`])
    ).trim(),
    TWO_MERGES,
  );
  const subjects = (
    await git.raw(["log", "--merges", "--format=%s", `${before}..HEAD`])
  )
    .trim()
    .split("\n");
  assert.ok(subjects[0]?.endsWith(UPSTREAM));
  assert.ok(subjects[1]?.endsWith("main"));
  assert.equal(web.head, await headOf(web.directory));
});

test("an upstream conflict runs the conflict turn and the result keeps two parents", async (t) => {
  const { h, web, webBare } = await fixture(t, [
    fauxAssistantMessage(
      fauxToolCall("write", { path: "web/file", content: RESOLVED }),
      { stopReason: "toolUse" },
    ),
    fauxAssistantMessage("resolved"),
  ]);
  followUpstream(h);
  await commitOnNode(web.directory, "node side");
  web.head = await headOf(web.directory);
  const before = web.head;
  await advanceUpstream(webBare, t, "upstream side");
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.Merged,
  );
  assert.ok(
    JSON.stringify(h.provider.calls[0]).includes(
      `The merge of origin/${UPSTREAM} into the node branch of repository web`,
    ),
  );
  assert.equal(readFileSync(join(web.directory, "file"), "utf8"), RESOLVED);
  assert.equal(web.head, await headOf(web.directory));
  assert.equal((await parentsOf(web.directory, web.head)).length, TWO_PARENTS);
  assert.equal((await parentsOf(web.directory, web.head))[0], before);
  assert.equal((await simpleGit(web.directory).status()).isClean(), true);
});

const CONFLICT_FILE = "conflicted-secret-name.txt";
const NODE_SIDE = "node side text of the conflict";
const BASE_SIDE = "base side text of the conflict";
const ONE_FILE = 1;
const TWO_MODEL_TURNS = 2;
const ONE_MODEL_TURN = 1;
const ONE_TURN_BUDGET = 1;
const NO_FAILURES = 0;

async function conflictOnWeb(
  t: TestContext,
  script: Parameters<typeof implementFixture>[2],
  turns?: number,
) {
  const opened = await fixture(t, script, turns);
  const { web, webBare } = opened;
  writeFileSync(join(web.directory, CONFLICT_FILE), NODE_SIDE);
  const git = simpleGit(web.directory);
  await git.add(CONFLICT_FILE);
  await git.commit(["feat: node side", opened.h.input.claim.node_id]);
  web.head = await headOf(web.directory);
  await advanceBase({ bare: webBare }, t, BASE_SIDE, CONFLICT_FILE);
  return { ...opened, records: recordSpans(opened.h) };
}

function conflictRecords(records: Parameters<typeof spanEnds>[0]) {
  return records.filter(
    (record) =>
      record.kind === RecordKind.Span &&
      record.operation === SpanOperation.Conflict,
  );
}

function conflictFacts(records: Parameters<typeof spanEnds>[0]) {
  return spanEnds(records, SpanOperation.Conflict).map((record) => ({
    files: record.attributes?.[ConflictAttribute.FileCount],
    turns: record.attributes?.[ConflictAttribute.ModelTurns],
    end: record.attributes?.[ConflictAttribute.End],
  }));
}

function assertNoConflictText(records: Parameters<typeof spanEnds>[0]) {
  const text = JSON.stringify([
    ...conflictRecords(records),
    ...spanEnds(records, SpanOperation.ReleaseGate),
  ]);
  for (const secret of [CONFLICT_FILE, NODE_SIDE, BASE_SIDE])
    assert.equal(text.includes(secret), false);
}

const writeResolved = () =>
  fauxAssistantMessage(
    fauxToolCall("write", {
      path: `web/${CONFLICT_FILE}`,
      content: RESOLVED,
    }),
    { stopReason: "toolUse" },
  );

test("a resolved conflict turn records the file count, the model turns and the end resolved", async (t) => {
  const { h, records } = await conflictOnWeb(t, [
    writeResolved(),
    fauxAssistantMessage("resolved"),
  ]);
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.Merged,
  );
  assert.deepEqual(conflictFacts(records), [
    { files: ONE_FILE, turns: TWO_MODEL_TURNS, end: ConflictEnd.Resolved },
  ]);
  assertNoConflictText(records);
});

test("a conflict turn that leaves a marker records the end markers_left", async (t) => {
  const { h, records } = await conflictOnWeb(t, [fauxAssistantMessage("done")]);
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    (error) =>
      error instanceof ExecutionStop && error.code === MERGE_MARKERS_LEFT,
  );
  assert.deepEqual(conflictFacts(records), [
    { files: ONE_FILE, turns: ONE_MODEL_TURN, end: ConflictEnd.MarkersLeft },
  ]);
  assertNoConflictText(records);
});

test("a conflict turn that ends the budget records the end budget_end", async (t) => {
  const { h, records } = await conflictOnWeb(
    t,
    [writeResolved(), fauxAssistantMessage("resolved")],
    ONE_TURN_BUDGET,
  );
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.BudgetEnd,
  );
  assert.deepEqual(conflictFacts(records), [
    { files: ONE_FILE, turns: ONE_MODEL_TURN, end: ConflictEnd.BudgetEnd },
  ]);
  assertNoConflictText(records);
});

test("a conflict turn that stops on a provider failure records the end stop", async (t) => {
  const { h, records } = await conflictOnWeb(t, [
    fauxAssistantMessage("", {
      stopReason: "error",
      errorMessage: "terminated",
    }),
  ]);
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  assert.deepEqual(
    conflictFacts(records).map(({ files, end }) => ({ files, end })),
    [{ files: ONE_FILE, end: ConflictEnd.Stop }],
  );
  assertNoConflictText(records);
});

function ownerFacts(records: Parameters<typeof spanEnds>[0]) {
  return spanEnds(records, SpanOperation.ReleaseGate).map((record) => ({
    failed: record.attributes?.[ConflictAttribute.OwnerFailed],
    count: record.attributes?.[ConflictAttribute.OwnerFailedCount],
  }));
}

const FAILED_NODE_COMMAND = {
  content: { ...NODE_CONTENT, verifications: ["false"] },
  tasks: [],
} as unknown as Revision;

test("the release gate after a conflict counts a failed command whose owner unit touched a conflicted file", async (t) => {
  const { h, records } = await conflictOnWeb(t, [
    writeResolved(),
    fauxAssistantMessage("resolved"),
  ]);
  h.revision = FAILED_NODE_COMMAND;
  assert.equal((await releaseGate(h)).kind, ReleaseGateKind.Routed);
  assert.deepEqual(ownerFacts(records), [{ failed: true, count: ONE_FILE }]);
  assertNoConflictText(records);
});

test("the release gate after a conflict counts no failed command when no owner unit touched a conflicted file", async (t) => {
  const { h, web, records } = await conflictOnWeb(t, [
    writeResolved(),
    fauxAssistantMessage("resolved"),
  ]);
  await simpleGit(web.directory).raw([
    "commit",
    "--amend",
    "-q",
    "-m",
    "feat: node side",
    "-m",
    "other_unit",
  ]);
  web.head = await headOf(web.directory);
  h.revision = FAILED_NODE_COMMAND;
  assert.equal((await releaseGate(h)).kind, ReleaseGateKind.Routed);
  assert.deepEqual(ownerFacts(records), [
    { failed: false, count: NO_FAILURES },
  ]);
});
