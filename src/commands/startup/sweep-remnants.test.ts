import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { eventRow } from "../../domain/event.ts";
import type { Git } from "../../services/git/index.ts";
import type {
  SweepHomeInput,
  SweepHomeReport,
} from "../../services/git/sweep.ts";
import { createRecoveryFixture } from "../../../test/helpers/recovery.ts";
import type { RecoveryFixture } from "../../../test/helpers/recovery.ts";
import { sweepRemnants } from "./sweep-remnants.ts";

const REPOSITORY_ID = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const ACTOR = "daemon-startup";
const KEY_DIRECTORY = "/run/kanthord/keys";

type MockConfig = Readonly<{
  report: SweepHomeReport;
  onSweep?: (input: SweepHomeInput) => void;
}>;

type Mock = Readonly<{
  git: Git;
  sweepCalls: readonly SweepHomeInput[];
}>;

function gitMock(config: MockConfig): Mock {
  const sweepCalls: SweepHomeInput[] = [];
  const git = {
    remoteUrlVerdict(): never {
      throw new Error("unexpected remoteUrlVerdict call");
    },
    scanHostKeys(): Promise<never> {
      throw new Error("unexpected scanHostKeys call");
    },
    confirmHostKey(): Promise<never> {
      throw new Error("unexpected confirmHostKey call");
    },
    trustHostKey(): Promise<never> {
      throw new Error("unexpected trustHostKey call");
    },
    seedHome(): Promise<never> {
      throw new Error("unexpected seedHome call");
    },
    remoteInfo(): Promise<never> {
      throw new Error("unexpected remoteInfo call");
    },
    canPush(): Promise<never> {
      throw new Error("unexpected canPush call");
    },
    probePush(): Promise<never> {
      throw new Error("unexpected probePush call");
    },
    fetch(): Promise<never> {
      throw new Error("unexpected fetch call");
    },
    resolveRef(): Promise<never> {
      throw new Error("unexpected resolveRef call");
    },
    refUpdate(): Promise<never> {
      throw new Error("unexpected refUpdate call");
    },
    checkOutsideWriter(): Promise<never> {
      throw new Error("unexpected checkOutsideWriter call");
    },
    clone(): Promise<never> {
      throw new Error("unexpected clone call");
    },
    inspectChild(): Promise<never> {
      throw new Error("unexpected inspectChild call");
    },
    stopChild(): Promise<never> {
      throw new Error("unexpected stopChild call");
    },
    listPidFiles(): Promise<never> {
      throw new Error("unexpected listPidFiles call");
    },
    removePidFile(): Promise<never> {
      throw new Error("unexpected removePidFile call");
    },
    async sweepHome(input: SweepHomeInput): Promise<SweepHomeReport> {
      sweepCalls.push(input);
      config.onSweep?.(input);
      return config.report;
    },
    worktreeClean(): Promise<never> {
      throw new Error("unexpected worktreeClean call");
    },
  } as Git;
  return { git, sweepCalls };
}

function emptyReport(): SweepHomeReport {
  return { removed: [], refused: [] };
}

function parseEvent(fixture: RecoveryFixture): void {
  for (const event of fixture.listEvents()) {
    assert.doesNotThrow(() =>
      eventRow.parse({
        id: event.id,
        subjectKind: event.subjectKind,
        subjectId: event.subjectId,
        type: event.type,
        actorKind: event.actorKind,
        actorId: event.actorId,
        payloadJson: JSON.stringify(event.payload),
      }),
    );
  }
}

async function runSweep(
  fixture: RecoveryFixture,
  mock: Mock,
): Promise<ReturnType<typeof sweepRemnants>> {
  return sweepRemnants(
    {
      storage: fixture.storage,
      git: mock.git,
      events: fixture.events,
      keyDirectory: KEY_DIRECTORY,
    },
    { actor: ACTOR, reap: { children: [], findings: [] } },
  );
}

describe("src/commands/startup/sweep-remnants.test", () => {
  it("two repository rows and one workspace row produce the boundary array in id then workspace order", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const repoA = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const repoB = "repo_01BRZ3NDEKTSV4RRFFQ69G5FAV";
    const homeA = "/homes/repos/a.git";
    const homeB = "/homes/repos/b.git";
    const workspacePath = "/homes/workspaces/objective_a";
    fixture.seedRepository({ id: repoB, name: "repo-b", homePath: homeB });
    fixture.seedRepository({ id: repoA, name: "repo-a", homePath: homeA });
    fixture.seedWorkspace({
      id: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId: repoA,
      path: workspacePath,
    });
    const mock = gitMock({ report: emptyReport() });
    const result = await runSweep(fixture, mock);
    assert.equal(mock.sweepCalls.length, 1);
    assert.deepEqual(mock.sweepCalls[0], {
      boundaries: [
        { kind: "bare-home", root: homeA, repositoryId: repoA },
        { kind: "bare-home", root: homeB, repositoryId: repoB },
        { kind: "workspace", root: workspacePath, repositoryId: repoA },
      ],
      keyDirectory: KEY_DIRECTORY,
    });
    assert.equal(result.removed, 0);
    assert.deepEqual(result.findings, []);
    assert.equal(fixture.listEvents().length, 0);
  });

  it("one removal with a repositoryId appends exactly one recovery.remnantRemoved event", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/homes/repos/fixture.git",
    });
    const mock = gitMock({
      report: {
        removed: [
          {
            path: "/homes/repos/fixture.git/HEAD.lock",
            class: "lock",
            repositoryId: REPOSITORY_ID,
          },
        ],
        refused: [],
      },
    });
    const result = await runSweep(fixture, mock);
    assert.equal(result.removed, 1);
    assert.deepEqual(result.findings, []);
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "recovery.remnantRemoved");
    assert.equal(event.subjectKind, "repository");
    assert.equal(event.subjectId, REPOSITORY_ID);
    assert.equal(event.actorKind, "daemon");
    assert.equal(event.actorId, ACTOR);
    assert.deepEqual(event.payload, {
      path: "/homes/repos/fixture.git/HEAD.lock",
      class: "lock",
    });
    parseEvent(fixture);
  });

  it("one refusal appends exactly one recovery.remnantRefused event and one finding", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    fixture.seedRepository({
      id: REPOSITORY_ID,
      name: "fixture",
      homePath: "/homes/repos/fixture.git",
    });
    const path = "/homes/repos/fixture.git/refs/heads/main.lock";
    const mock = gitMock({
      report: {
        removed: [],
        refused: [
          {
            path,
            class: "lock",
            repositoryId: REPOSITORY_ID,
            reason: "symlink-on-path",
          },
        ],
      },
    });
    const result = await runSweep(fixture, mock);
    assert.equal(result.removed, 0);
    assert.equal(result.findings.length, 1);
    assert.deepEqual(result.findings[0], {
      step: "sweep",
      code: "symlink-on-path",
      repositoryId: REPOSITORY_ID,
      detail: `lock ${path}`,
    });
    const events = fixture.listEvents();
    assert.equal(events.length, 1);
    const event = events[0]!;
    assert.equal(event.type, "recovery.remnantRefused");
    assert.equal(event.subjectKind, "repository");
    assert.equal(event.subjectId, REPOSITORY_ID);
    assert.equal(event.actorKind, "daemon");
    assert.equal(event.actorId, ACTOR);
    assert.deepEqual(event.payload, {
      path,
      class: "lock",
      reason: "symlink-on-path",
    });
    parseEvent(fixture);
  });

  it("a key-material removal with no repository appends no event and still counts", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const mock = gitMock({
      report: {
        removed: [
          {
            path: "/run/kanthord/keys/key-abc",
            class: "key-material",
            repositoryId: null,
          },
        ],
        refused: [],
      },
    });
    const result = await runSweep(fixture, mock);
    assert.equal(result.removed, 1);
    assert.deepEqual(result.findings, []);
    assert.equal(fixture.listEvents().length, 0);
  });

  it("the command reaches git.sweepHome exactly once whatever the number of boundaries", async (t) => {
    const fixture = createRecoveryFixture();
    t.after(() => fixture.dispose());
    const repoA = "repo_01ARZ3NDEKTSV4RRFFQ69G5FAV";
    const repoB = "repo_01BRZ3NDEKTSV4RRFFQ69G5FAV";
    const repoC = "repo_01CRZ3NDEKTSV4RRFFQ69G5FAV";
    const repoD = "repo_01DRZ3NDEKTSV4RRFFQ69G5FAV";
    for (const [id, name] of [
      [repoD, "repo-d"],
      [repoA, "repo-a"],
      [repoC, "repo-c"],
      [repoB, "repo-b"],
    ] as const) {
      fixture.seedRepository({
        id,
        name,
        homePath: `/homes/repos/${name}.git`,
      });
    }
    fixture.seedWorkspace({
      id: "workspace_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      repositoryId: repoA,
      path: "/homes/workspaces/objective_a",
    });
    const mock = gitMock({ report: emptyReport() });
    await runSweep(fixture, mock);
    assert.equal(mock.sweepCalls.length, 1);
    assert.equal(mock.sweepCalls[0]!.boundaries.length, 5);
    assert.equal(fixture.listEvents().length, 0);
  });
});
