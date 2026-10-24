import assert from "node:assert/strict";
import { test } from "node:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import { temporary } from "../../kernel/test-support.ts";
import type { TaskContent } from "../../mission/contract.ts";
import { EndReason } from "./execution-run.ts";
import { executionBoundary } from "./native-method.ts";
import type { MethodClients } from "./method-clients.ts";
import {
  prepareStepsWorkspace,
  runStepsImplement,
  taskWork,
} from "./steps-implement.ts";
import { releaseGate, ReleaseGateKind } from "./release-gate.ts";
import { NoProgressRule, noProgressDetail } from "./progress-rule.ts";
import { RELEASE_DIRECTORY, WorkspaceKind } from "./workspace.ts";
import {
  advanceBase,
  fauxAssistantMessage,
  fauxToolCall,
  implementFixture as fixture,
  recordReleases,
  task,
} from "./test-support.ts";

type Fixture = Awaited<ReturnType<typeof fixture>>;

const NOTHING = fauxAssistantMessage("nothing");
const NO_PROGRESS_LIMIT = 2;
const RELEASE_COMMANDS_RAN = 2;
const FAILED_EXIT_CODE = 1;
const REVISION_TEXT = "Revise the task work";
const REVISED_CONTENT = "base two";
const SECRET = "secret";
const MARKER = "release-directory";
const TAG = "x";
const CONFIG_KEY = "a.b";
const BASE_CHANGE = "base change";
const LEFTOVER = "leftover";
const RUN_ONCE =
  "if [ -e .ran ] && [ ! -e fixed ]; then exit 1; fi; touch .ran";

function write(path: string, content: string) {
  return fauxAssistantMessage(fauxToolCall("write", { path, content }), {
    stopReason: "toolUse",
  });
}

function recordRevisions(h: Fixture): string[] {
  const digests: string[] = [];
  const instruct = h.agent.instruct.bind(h.agent);
  h.agent.instruct = async (work, text) => {
    if (text.startsWith(REVISION_TEXT)) digests.push(work.digest);
    await instruct(work, text);
  };
  return digests;
}

function acceptEvidence(h: Fixture): void {
  h.run.clients.mission = {
    "evidence.submit": async () => ({
      type: "completed",
      status: 200,
      data: { evidence: {} },
    }),
  } as unknown as MethodClients["mission"];
}

function digestOf(h: Fixture, unit: TaskContent): string {
  return taskWork(h, unit).digest;
}

test("a task that breaks the verification of an earlier task routes a revision to that task before the release", async (t) => {
  const first = task("first", "grep -q base file");
  const second = task("second", "grep -q two file");
  const h = await fixture(
    t,
    [first, second],
    [
      NOTHING,
      write("file", "two"),
      fauxAssistantMessage("done"),
      write("file", REVISED_CONTENT),
      fauxAssistantMessage("fixed"),
    ],
  );
  const revisions = recordRevisions(h);
  const bodies = recordReleases(h);
  acceptEvidence(h);
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(revisions, [digestOf(h, first)]);
  assert.deepEqual(bodies, [{ further_work: false, stop: null }]);
  assert.equal(
    await simpleGit(h.bare).raw(["show", `refs/heads/${h.nodeBranch}:file`]),
    REVISED_CONTENT,
  );
});

test("a release failure that no revision changes stops with no_progress and never releases further work false", async (t) => {
  const current = task("ignored", `test -e ${SECRET}`);
  const h = await fixture(
    t,
    [current],
    [
      NOTHING,
      fauxAssistantMessage("nothing again"),
      fauxAssistantMessage("still nothing"),
    ],
  );
  appendFileSync(join(h.root, ".git", "info", "exclude"), `${SECRET}\n`);
  writeFileSync(join(h.root, SECRET), SECRET);
  const revisions = recordRevisions(h);
  const bodies = recordReleases(h);
  acceptEvidence(h);
  const end = await executionBoundary(h.run, () => runStepsImplement(h));
  assert.deepEqual(revisions, [digestOf(h, current), digestOf(h, current)]);
  assert.deepEqual(end, {
    kind: "released",
    furtherWork: true,
    stop: {
      reason: EndReason.NoProgress,
      code: null,
      detail: noProgressDetail({
        rule: NoProgressRule.UnchangedRevision,
        count: NO_PROGRESS_LIMIT,
        limit: NO_PROGRESS_LIMIT,
        verification: {
          passed: false,
          ran: RELEASE_COMMANDS_RAN,
          exit_code: FAILED_EXIT_CODE,
        },
      }),
    },
  });
  assert.deepEqual(bodies, [
    {
      further_work: true,
      stop: {
        reason: EndReason.NoProgress,
        code: null,
        detail: noProgressDetail({
          rule: NoProgressRule.UnchangedRevision,
          count: NO_PROGRESS_LIMIT,
          limit: NO_PROGRESS_LIMIT,
          verification: {
            passed: false,
            ran: RELEASE_COMMANDS_RAN,
            exit_code: FAILED_EXIT_CODE,
          },
        }),
      },
    },
  ]);
});

test("a wall deadline during a task verification releases further work", async (t) => {
  const h = await fixture(
    t,
    [task("timed", "touch transient; sleep 30")],
    [NOTHING],
  );
  let deadline = Date.now() + 60000;
  h.agent.budget.wallDeadline = () => {
    deadline = Date.now() + 30;
    return deadline;
  };
  h.agent.budget.exhausted = () => Date.now() >= deadline;
  const bodies = recordReleases(h);
  acceptEvidence(h);
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: true,
    stop: { reason: "budget_end", code: "wall_time" },
  });
  assert.deepEqual(bodies, [
    { further_work: true, stop: { reason: "budget_end", code: "wall_time" } },
  ]);
});

test("a release failure goes to the owner of the first failed index when the node and a task share one command", async (t) => {
  const current = task("shared", RUN_ONCE);
  const h = await fixture(
    t,
    [current],
    [NOTHING, write("fixed", "fixed"), fauxAssistantMessage("fixed")],
  );
  h.revision = {
    ...h.revision,
    content: { ...h.revision.content, verifications: [RUN_ONCE] },
  };
  const revisions = recordRevisions(h);
  acceptEvidence(h);
  recordReleases(h);
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  assert.deepEqual(revisions, [digestOf(h, current)]);
});

test("a release verification that writes git state leaves the live checkout unchanged", async (t) => {
  const marker = join(temporary(t), MARKER);
  const h = await fixture(t, [task("plain", "true")], [NOTHING]);
  h.revision = {
    ...h.revision,
    content: {
      ...h.revision.content,
      verifications: [
        `git tag ${TAG} && git config ${CONFIG_KEY} c && pwd > ${marker}`,
      ],
    },
  };
  acceptEvidence(h);
  recordReleases(h);
  assert.deepEqual(await runStepsImplement(h), {
    kind: "released",
    furtherWork: false,
  });
  const directory = readFileSync(marker, "utf8").trim();
  assert.notEqual(directory, h.root);
  assert.equal(existsSync(directory), false);
  assert.equal((await simpleGit(h.root).tags()).all.includes(TAG), false);
  assert.equal(
    (await simpleGit(h.root).getConfig(CONFIG_KEY, "local")).value,
    null,
  );
});

test("a release clone holds the remote of the reviewer clone and the fetched base", async (t) => {
  const markers = temporary(t);
  const base = join(markers, "base");
  const url = join(markers, "url");
  const h = await fixture(t, [], []);
  h.revision = {
    ...h.revision,
    content: {
      ...h.revision.content,
      verifications: [
        `git rev-parse origin/main > ${base} && git remote get-url origin > ${url}`,
      ],
    },
  };
  await advanceBase(h, t, BASE_CHANGE, "other");
  assert.deepEqual(await releaseGate(h), { kind: ReleaseGateKind.Passed });
  const fetched = (await simpleGit(h.bare).revparse(["main"])).trim();
  assert.equal(readFileSync(base, "utf8").trim(), fetched);
  assert.equal(
    readFileSync(url, "utf8").trim(),
    h.input.setup.repositories[0]!.address,
  );
});

test("the next prepare removes release clones that a crash left", async (t) => {
  const h = await fixture(t, [], []);
  const key = h.input.workspaces.nodeKey(h.input.claim.node_id);
  const leftover = join(key, RELEASE_DIRECTORY, LEFTOVER);
  mkdirSync(leftover, { recursive: true });
  h.input.workspaces.release(key, WorkspaceKind.Node);
  await prepareStepsWorkspace(h.input, h.run);
  assert.equal(existsSync(join(key, RELEASE_DIRECTORY)), false);
});
