import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { background } from "../../kernel/context.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import { RefreshResult, refreshAtClaim } from "./base-refresh.ts";
import { runStepsImplement } from "./steps-implement.ts";
import { DONE_TRAILER, doneRecordOf } from "./done-record.ts";
import { nodeUnitOf } from "./release-gate.ts";
import {
  advanceBase,
  commitOnNode,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  recordDone,
  recordReleases,
  task,
  TEST_SSH_ACCESS,
} from "./test-support.ts";

const COMMIT_RULE =
  /^(feat|fix|docs|style|refactor|test|chore)(\([a-z0-9-]+\))?: \S.*$/;
const HEADER_MAX_LENGTH = 100;
const FETCH_DEADLINE_MS = 20000;
const RELEASED = { kind: "released", furtherWork: false };
const BASE_FILE = "other";
const LONG_NAME = `Rework ${"the long subject of the node ".repeat(5)}end.`;

type Harness = Awaited<ReturnType<typeof fixture>>;

const write = (path: string) =>
  fauxAssistantMessage(fauxToolCall("write", { path, content: path }), {
    stopReason: "toolUse",
  });

function assertHeader(header: string): void {
  assert.match(header, COMMIT_RULE);
  assert.ok(header.length <= HEADER_MAX_LENGTH, header);
}

function recordFinish(h: Harness): void {
  h.run.clients.mission = {
    ...h.run.clients.mission,
    "evidence.submit": async () => ({
      type: "completed",
      status: 200,
      data: { evidence: {} },
    }),
  } as unknown as MethodClients["mission"];
  recordReleases(h);
}

async function messages(directory: string, range: string): Promise<string[]> {
  const output = await simpleGit(directory).raw([
    "log",
    "--format=%B%x00",
    range,
  ]);
  return output
    .split("\0")
    .map((message) => message.trim())
    .filter(Boolean);
}

function parseTrailers(directory: string, message: string): string {
  return execFileSync("git", ["interpret-trailers", "--parse"], {
    cwd: directory,
    input: message,
    encoding: "utf8",
  }).trim();
}

async function releaseRun(h: Harness): Promise<void> {
  recordFinish(h);
  assert.deepEqual(
    await executionBoundary(h.run, () => runStepsImplement(h)),
    RELEASED,
  );
}

async function nodeMessages(h: Harness): Promise<string[]> {
  return messages(h.bare, `main..refs/heads/${h.nodeBranch}`);
}

test("a task commit and a merge commit take the commit rule, the unit id body and a parsed done trailer", async (t) => {
  const current = task("Add the login form.", "test -f login");
  const h = await fixture(
    t,
    [current],
    [write("login"), fauxAssistantMessage("done")],
  );
  await advanceBase(h, t, "base side", BASE_FILE);
  await releaseRun(h);
  const all = await nodeMessages(h);
  for (const message of all) assertHeader(message.split("\n")[0]!);
  const byHeader = new Map(
    all.map((message) => [message.split("\n")[0]!, message]),
  );
  assert.deepEqual([...byHeader.keys()].sort(), [
    "feat: add the login form",
    "feat: merge main",
  ]);
  const taskMessage = byHeader.get("feat: add the login form")!;
  const record = `${DONE_TRAILER}: ${doneRecordOf(current)}`;
  assert.equal(
    taskMessage,
    `feat: add the login form\n\n${current.id}\n\n${record}`,
  );
  assert.equal(parseTrailers(h.root, taskMessage), record);
  assert.equal(
    byHeader.get("feat: merge main"),
    `feat: merge main\n\n${h.input.claim.node_id}`,
  );
  const records = await simpleGit(h.bare).raw([
    "log",
    `--format=%(trailers:key=${DONE_TRAILER},valueonly)`,
    `main..refs/heads/${h.nodeBranch}`,
  ]);
  assert.deepEqual(records.split("\n").filter(Boolean), [
    doneRecordOf(current),
  ]);
});

test("a node unit commit takes the commit type of the node and a header cut to 100 characters", async (t) => {
  const h = await fixture(
    t,
    [],
    [write("change"), fauxAssistantMessage("done")],
  );
  Object.assign(h.revision.content, { name: LONG_NAME, commit_type: "fix" });
  await releaseRun(h);
  const [message] = await nodeMessages(h);
  const [header, , unitId] = message!.split("\n");
  assertHeader(header!);
  assert.equal(header!.length, HEADER_MAX_LENGTH);
  assert.ok(header!.startsWith("fix: rework the long subject"));
  assert.equal(unitId, h.input.claim.node_id);
});

test("a verdict commit takes the node name", async (t) => {
  const current = task("judged", "true");
  const h = await fixture(
    t,
    [current],
    [write("verdict"), fauxAssistantMessage("fixed")],
  );
  await recordDone(h, current);
  h.verdict = {
    text: "The edge case stays unhandled.",
    judged: h.checkouts.map((checkout) => ({
      binding_id: checkout.binding_id,
      commit: checkout.head,
    })),
  };
  await releaseRun(h);
  const [latest] = await nodeMessages(h);
  const unit = nodeUnitOf(h.input.claim.node_id, h.revision);
  assert.equal(
    latest,
    `feat: implement\n\n${unit.id}\n\n${DONE_TRAILER}: ${doneRecordOf(unit)}`,
  );
});

test("a conflict merge commit takes the commit rule", async (t) => {
  const h = await conflictFixture(t, [
    write("file"),
    fauxAssistantMessage("resolved"),
  ]);
  await h.input.transport.fetchBase(
    h.root,
    "main",
    background,
    FETCH_DEADLINE_MS,
    TEST_SSH_ACCESS,
  );
  assert.equal(await refreshAtClaim(h), RefreshResult.Merged);
  const [message] = await messages(h.root, "-1");
  assert.equal(message, `feat: merge main\n\n${h.input.claim.node_id}`);
});

test("a checkpoint commit takes the name of the current unit", async (t) => {
  const current = task("Write the guide", "false");
  const h = await fixture(
    t,
    [current],
    [write("guide"), fauxAssistantMessage("partial")],
  );
  const prompt = h.agent.prompt.bind(h.agent);
  h.agent.prompt = async (work) => {
    await prompt(work);
    h.agent.budget.exhausted = () => true;
  };
  recordFinish(h);
  await executionBoundary(h.run, () => runStepsImplement(h));
  const [message] = await nodeMessages(h);
  assert.equal(message, `feat: write the guide\n\n${current.id}`);
});

async function conflictFixture(
  t: TestContext,
  script: Parameters<typeof fixture>[2],
) {
  const h = await fixture(t, [], script);
  await commitOnNode(h.root, "node side");
  h.checkouts[0]!.head = (await simpleGit(h.root).revparse(["HEAD"])).trim();
  await advanceBase(h, t, "main side");
  return h;
}
