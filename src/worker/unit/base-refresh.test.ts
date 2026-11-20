import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { renderTemplate } from "../../agent/prompt-templates.ts";
import { PromptTemplate } from "../../agent/contract.ts";
import { dirname, join } from "node:path";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { temporary } from "../../kernel/test-support.ts";
import type { Revision } from "../../mission/contract.ts";
import {
  BASE_CHANGES_CUT,
  BASE_CHANGES_MAX_BYTES,
  refreshAtClaim,
  refreshAtRelease,
  RefreshResult,
} from "./base-refresh.ts";
import { ReleaseGateKind } from "./release-gate.ts";
import { ConflictAttribute, ConflictEnd } from "./method-telemetry.ts";
import { ExecutionStop } from "./execution-stop.ts";
import { MERGE_MARKERS_LEFT } from "./stop-codes.ts";
import type { StepsState } from "./steps-implement.ts";
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
const TWO_FILES = 2;
const BASE_ADDITION = "base addition of the second file";
const PROVIDER_FAILURE_TURNS = 2;

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
  assert.deepEqual(conflictFacts(records), [
    { files: ONE_FILE, turns: PROVIDER_FAILURE_TURNS, end: ConflictEnd.Stop },
  ]);
  assertNoConflictText(records);
});

function ownerFacts(records: Parameters<typeof spanEnds>[0]) {
  return spanEnds(records, SpanOperation.ReleaseGate).map((record) => ({
    failed: record.attributes?.[ConflictAttribute.OwnerFailed],
  }));
}

const FAILED_NODE_COMMAND = {
  content: { ...NODE_CONTENT, verifications: ["false"] },
  tasks: [],
} as unknown as Revision;

test("the first release gate after a conflict flags a failed command whose owner unit touched a conflicted file, and the next release gate holds no flag", async (t) => {
  const { h, records } = await conflictOnWeb(t, [
    writeResolved(),
    fauxAssistantMessage("resolved"),
  ]);
  h.revision = FAILED_NODE_COMMAND;
  assert.equal((await releaseGate(h)).kind, ReleaseGateKind.Routed);
  assert.equal((await releaseGate(h)).kind, ReleaseGateKind.Routed);
  assert.deepEqual(ownerFacts(records), [
    { failed: true },
    { failed: undefined },
  ]);
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
  assert.deepEqual(ownerFacts(records), [{ failed: false }]);
  assertNoConflictText(records);
});

const SECOND_FILE = "second-conflicted.txt";
const BASE_ONLY_FILE = "base-only-change.txt";
const MERGE_INTRO = "The merge of origin/";
const LONG_DIFF_LINES = 2000;
const USER_ROLE = "user";
const OWNER_LOG = "log --no-merges";
const BASE_LOG = "log --format=%h %s";
const BASE_DIFF = "diff --no-color";
const BASE_MERGE_BASE = /^merge-base HEAD [0-9a-f]{40}/;
const ONE_OWNER_LOG = 1;
const MULTIBYTE_LINE = "é".repeat(100);
const PATHSPEC_FILES = [":!x.txt", "a*b.txt"];
const GLOB_MATCH = "aXb.txt";
const OTHER_BASE_FILE = "other.txt";
const NON_ASCII_FILE = "café.txt";
const STRING_TYPE = "string";
const CUT_LINE = /^\+line \d+ of the long base change$/;

const NO_BASE_CHANGES_CONFLICT =
  "The merge of origin/{{base_branch}} into {{binding}} in `{{directory}}` conflicts: {{files}}.";

function withoutBaseChanges(h: Awaited<ReturnType<typeof fixture>>["h"]) {
  h.input.setup.templates = {
    ...h.input.setup.templates,
    [PromptTemplate.Conflict]: NO_BASE_CHANGES_CONFLICT,
  };
}

function conflictPromptOf(provider: { calls: { messages: unknown[] }[] }) {
  const texts = JSON.stringify(provider.calls[0]!.messages);
  const parsed = JSON.parse(texts) as {
    role: string;
    content: string | { type: string; text?: string }[];
  }[];
  const found = parsed
    .filter((message) => message.role === USER_ROLE)
    .flatMap((message) =>
      typeof message.content === STRING_TYPE
        ? [message.content as string]
        : (message.content as { text?: string }[]).flatMap((part) =>
            part.text ? [part.text] : [],
          ),
    )
    .find((text) => text.startsWith(MERGE_INTRO));
  assert.ok(found);
  return found;
}

async function baseAdvance(
  bare: string,
  t: TestContext,
  files: Readonly<Record<string, string>>,
) {
  const clone = temporary(t);
  const git = simpleGit(clone);
  await git.clone(bare, clone, ["--branch", "main"]);
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(clone, path), content);
  await git.raw(["--literal-pathspecs", "add", "--", ...Object.keys(files)]);
  await git.raw([...TEST_IDENTITY, "commit", "-m", "base change of the files"]);
  await git.push("origin", "main");
}

test("the shipped Conflict template holds the base-side log and diff of each conflicted file and of no other file", async (t) => {
  const { h, web, webBare } = await fixture(t, [fauxAssistantMessage("done")]);
  for (const file of [CONFLICT_FILE, SECOND_FILE])
    writeFileSync(join(web.directory, file), NODE_SIDE);
  const git = simpleGit(web.directory);
  await git.add([CONFLICT_FILE, SECOND_FILE]);
  await git.commit("feat: node side");
  web.head = await headOf(web.directory);
  await baseAdvance(webBare, t, {
    [CONFLICT_FILE]: BASE_SIDE,
    [SECOND_FILE]: BASE_SIDE,
    [BASE_ONLY_FILE]: BASE_SIDE,
  });
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  const prompt = conflictPromptOf(h.provider);
  for (const file of [CONFLICT_FILE, SECOND_FILE]) {
    assert.ok(prompt.includes(`## ${file}`));
    assert.ok(prompt.includes(`+++ b/${file}`));
  }
  assert.ok(prompt.includes("base change of the files"));
  assert.ok(prompt.includes(`+${BASE_SIDE}`));
  assert.equal(prompt.includes(BASE_ONLY_FILE), false);
});

test("the base-side changes of the shipped template stop on a line edge at the byte limit and state the cut", async (t) => {
  const { h, web, webBare } = await fixture(t, [fauxAssistantMessage("done")]);
  writeFileSync(join(web.directory, CONFLICT_FILE), NODE_SIDE);
  const git = simpleGit(web.directory);
  await git.add(CONFLICT_FILE);
  await git.commit("feat: node side");
  web.head = await headOf(web.directory);
  const long = Array.from(
    { length: LONG_DIFF_LINES },
    (_, index) => `line ${index} of the long base change`,
  ).join("\n");
  await baseAdvance(webBare, t, { [CONFLICT_FILE]: long });
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  const prompt = conflictPromptOf(h.provider);
  const changes = prompt.slice(prompt.indexOf(`## ${CONFLICT_FILE}`));
  assert.ok(Buffer.byteLength(changes) <= BASE_CHANGES_MAX_BYTES);
  assert.ok(changes.endsWith(`\n${BASE_CHANGES_CUT}`));
  const lines = changes.split("\n");
  assert.match(lines.at(-2)!, CUT_LINE);
});

function wrapGit(
  t: TestContext,
  h: Awaited<ReturnType<typeof fixture>>["h"],
  failOn: string | null = null,
): () => string[] {
  const log = join(temporary(t), "git.log");
  const bin = temporary(t);
  const git = execFileSync("sh", ["-c", "command -v git"], {
    env: h.input.env,
    encoding: "utf8",
  }).trim();
  const fail =
    failOn === null ? "" : `case "$*" in *'${failOn}'*) exit 128;; esac\n`;
  writeFileSync(
    join(bin, "git"),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n${fail}exec '${git}' "$@"\n`,
  );
  chmodSync(join(bin, "git"), 0o755);
  h.input.env = { ...h.input.env, PATH: `${bin}:${h.input.env.PATH}` };
  return () => readFileSync(log, "utf8").split("\n");
}

test("a Conflict template without base_changes runs no base-side git process, one owner log, and renders the prompt of its variables", async (t) => {
  const { h, web } = await conflictOnWeb(t, [fauxAssistantMessage("done")]);
  withoutBaseChanges(h);
  const gitCalls = wrapGit(t, h);
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  const calls = gitCalls();
  assert.ok(calls.some((call) => call.startsWith("merge --no-edit")));
  assert.equal(
    calls.filter((call) => call.includes(OWNER_LOG)).length,
    ONE_OWNER_LOG,
  );
  assert.equal(
    calls.some(
      (call) =>
        call.includes(BASE_LOG) ||
        call.includes(BASE_DIFF) ||
        BASE_MERGE_BASE.test(call),
    ),
    false,
  );
  assert.equal(
    conflictPromptOf(h.provider),
    renderTemplate(h.input.setup.templates, PromptTemplate.Conflict, {
      binding: web.name,
      directory: "web",
      base_branch: BASE_BRANCH,
      files: CONFLICT_FILE,
    }),
  );
});

async function nodeCommit(
  directory: string,
  files: Readonly<Record<string, string>>,
  body: string,
) {
  for (const [path, content] of Object.entries(files))
    writeFileSync(join(directory, path), content);
  const git = simpleGit(directory);
  await git.raw(["--literal-pathspecs", "add", "--", ...Object.keys(files)]);
  await git.commit(["feat: node side", body]);
}

function withTasks(
  h: Awaited<ReturnType<typeof fixture>>["h"],
  ids: readonly string[],
) {
  h.revision = {
    content: NODE_CONTENT,
    tasks: ids.map((id) => ({
      id,
      filename: `${id}.md`,
      content: NODE_CONTENT,
    })),
  } as unknown as Revision;
}

test("a failed owner log leaves the release flag unknown and the merge still resolves with the shipped template", async (t) => {
  const { h, records } = await conflictOnWeb(t, [
    writeResolved(),
    fauxAssistantMessage("resolved"),
  ]);
  wrapGit(t, h, OWNER_LOG);
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.Merged,
  );
  assert.equal((h as StepsState).conflictOwners, null);
  assert.deepEqual(conflictFacts(records), [
    { files: ONE_FILE, turns: TWO_MODEL_TURNS, end: ConflictEnd.Resolved },
  ]);
  h.revision = FAILED_NODE_COMMAND;
  assert.equal((await releaseGate(h)).kind, ReleaseGateKind.Routed);
  assert.deepEqual(ownerFacts(records), [{ failed: undefined }]);
});

test("pathspec magic in a conflicted file name selects only that file for the base-side changes and the owner log", async (t) => {
  const { h, web, webBare } = await fixture(t, [fauxAssistantMessage("done")]);
  withTasks(h, ["task_conflicted", "task_glob"]);
  await nodeCommit(
    web.directory,
    Object.fromEntries(PATHSPEC_FILES.map((file) => [file, NODE_SIDE])),
    "task_conflicted",
  );
  await nodeCommit(web.directory, { [GLOB_MATCH]: NODE_SIDE }, "task_glob");
  web.head = await headOf(web.directory);
  await baseAdvance(webBare, t, {
    ...Object.fromEntries(PATHSPEC_FILES.map((file) => [file, BASE_SIDE])),
    [OTHER_BASE_FILE]: BASE_SIDE,
  });
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  assert.deepEqual((h as StepsState).conflictOwners, ["task_conflicted"]);
  const prompt = conflictPromptOf(h.provider);
  for (const file of PATHSPEC_FILES) assert.ok(prompt.includes(`## ${file}`));
  assert.equal(prompt.includes(OTHER_BASE_FILE), false);
  assert.equal(prompt.includes(GLOB_MATCH), false);
});

test("a non-ASCII conflicted file name reaches the conflict list, the marker check, the base-side changes and the owner log as the real name", async (t) => {
  const { h, web, webBare } = await fixture(
    t,
    [
      fauxAssistantMessage(
        fauxToolCall("write", {
          path: `web/${NON_ASCII_FILE}`,
          content: RESOLVED,
        }),
        { stopReason: "toolUse" },
      ),
    ],
    ONE_TURN_BUDGET,
  );
  await nodeCommit(
    web.directory,
    { [NON_ASCII_FILE]: NODE_SIDE },
    h.input.claim.node_id,
  );
  web.head = await headOf(web.directory);
  await baseAdvance(webBare, t, { [NON_ASCII_FILE]: BASE_SIDE });
  assert.equal(
    await refreshAtRelease(h, workerPorts(h.input, h.run)),
    RefreshResult.BudgetEnd,
  );
  assert.deepEqual((h as StepsState).openMerge?.files, [NON_ASCII_FILE]);
  assert.equal((h as StepsState).openMerge?.resolved, true);
  assert.deepEqual((h as StepsState).conflictOwners, [h.input.claim.node_id]);
  const prompt = conflictPromptOf(h.provider);
  assert.ok(prompt.includes(`: ${NON_ASCII_FILE}.`));
  assert.ok(prompt.includes(`## ${NON_ASCII_FILE}`));
  assert.ok(prompt.includes(`+++ b/${NON_ASCII_FILE}`));
});

test("the base-side cut counts bytes, not UTF-16 units, for multibyte lines", async (t) => {
  const { h, web, webBare } = await fixture(t, [fauxAssistantMessage("done")]);
  await nodeCommit(web.directory, { [CONFLICT_FILE]: NODE_SIDE }, "body");
  web.head = await headOf(web.directory);
  const long = Array.from(
    { length: LONG_DIFF_LINES },
    (_, index) => `${index} ${MULTIBYTE_LINE}`,
  ).join("\n");
  await baseAdvance(webBare, t, { [CONFLICT_FILE]: long });
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  const prompt = conflictPromptOf(h.provider);
  const changes = prompt.slice(prompt.indexOf(`## ${CONFLICT_FILE}`));
  assert.ok(Buffer.byteLength(changes) <= BASE_CHANGES_MAX_BYTES);
  assert.ok(changes.length < Buffer.byteLength(changes));
  assert.ok(changes.endsWith(`\n${BASE_CHANGES_CUT}`));
  assert.ok(changes.split("\n").at(-2)!.endsWith(MULTIBYTE_LINE));
});

test("a modify/delete and an add/add conflict give the base-side deletion and addition to the shipped template", async (t) => {
  const { h, web, webBare } = await fixture(t, [fauxAssistantMessage("done")]);
  await baseAdvance(webBare, t, { [CONFLICT_FILE]: BASE_SIDE });
  await h.input.transport.fetchBase(
    web.directory,
    BASE_BRANCH,
    background,
    DEADLINE_MS,
    sshAccessOf(h.input.sshAccess, web.binding_id),
  );
  const git = simpleGit(web.directory);
  await git.raw(["merge", "-q", "--no-edit", `origin/${BASE_BRANCH}`]);
  await nodeCommit(
    web.directory,
    { [CONFLICT_FILE]: NODE_SIDE, [SECOND_FILE]: NODE_SIDE },
    h.input.claim.node_id,
  );
  web.head = await headOf(web.directory);
  const clone = temporary(t);
  const base = simpleGit(clone);
  await base.clone(webBare, clone, ["--branch", "main"]);
  await base.raw(["rm", "-q", CONFLICT_FILE]);
  writeFileSync(join(clone, SECOND_FILE), BASE_ADDITION);
  await base.add(SECOND_FILE);
  await base.raw([...TEST_IDENTITY, "commit", "-m", "delete and add"]);
  await base.push("origin", "main");
  const records = recordSpans(h);
  await assert.rejects(
    refreshAtRelease(h, workerPorts(h.input, h.run)),
    ExecutionStop,
  );
  assert.deepEqual(
    conflictFacts(records).map(({ files }) => files),
    [TWO_FILES],
  );
  assert.deepEqual((h as StepsState).conflictOwners, [h.input.claim.node_id]);
  const prompt = conflictPromptOf(h.provider);
  assert.ok(prompt.includes("deleted file mode"));
  assert.ok(prompt.includes("new file mode"));
  assert.ok(prompt.includes(`## ${SECOND_FILE}`));
});
