import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Git, RemoteUrlVerdict } from "../../services/git/index.ts";
import { showRepository } from "./show-repository.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

const HOME_PATH = "repos/r.git";
const LANDING_REF = "refs/heads/main";
const TRACKING_REF = "refs/remotes/origin/main";

const SORTED_MEMBERS = [
  "branch",
  "credential",
  "divergedLandingOid",
  "divergedUpstreamOid",
  "fetchedUpstreamOid",
  "id",
  "landingOid",
  "landingRef",
  "name",
  "publishOnApproval",
  "publishRef",
  "remoteUrl",
  "state",
  "trackingOid",
  "trackingRef",
  "updatedAt",
] as const;

function key(gitDir: string, ref: string): string {
  return `${gitDir}\u0000${ref}`;
}

function gitMock(pairs: Readonly<Record<string, string | null>>): Readonly<{
  git: Git;
  refCalls: readonly { gitDir: string; ref: string }[];
}> {
  const refCalls: { gitDir: string; ref: string }[] = [];
  const git: Git = {
    remoteUrlVerdict(): RemoteUrlVerdict {
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
    fetch(): Promise<never> {
      throw new Error("unexpected fetch call");
    },
    async resolveRef(
      input: Readonly<{ gitDir: string; ref: string }>,
    ): Promise<string | null> {
      refCalls.push(input);
      const value = pairs[key(input.gitDir, input.ref)];
      if (value === undefined) {
        throw new Error(
          `unexpected resolveRef for ${input.gitDir} ${input.ref}`,
        );
      }
      return value;
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
    sweepHome(): Promise<never> {
      throw new Error("unexpected sweepHome call");
    },
    worktreeClean(): Promise<never> {
      throw new Error("unexpected worktreeClean call");
    },
  };
  return { git, refCalls };
}

const landingPair = {
  [key(HOME_PATH, LANDING_REF)]: "1".repeat(40),
  [key(HOME_PATH, TRACKING_REF)]: "2".repeat(40),
};

describe("src/queries/repository/show-repository.test", () => {
  it("returns a view whose every field is asserted and whose keys are the sixteen members", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock(landingPair);

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.id, fixtureIds.repository);
    assert.equal(view.name, "kanthord-verify");
    assert.equal(view.remoteUrl, "https://example.invalid/r.git");
    assert.deepEqual(view.credential, {
      id: fixtureIds.provider,
      name: "work-anthropic",
    });
    assert.equal(view.branch, "main");
    assert.equal(view.landingRef, LANDING_REF);
    assert.equal(view.trackingRef, TRACKING_REF);
    assert.equal(view.publishRef, "refs/heads/main");
    assert.equal(view.publishOnApproval, true);
    assert.equal(view.state, "ready");
    assert.equal(view.landingOid, "1".repeat(40));
    assert.equal(view.trackingOid, "2".repeat(40));
    assert.equal(view.fetchedUpstreamOid, null);
    assert.equal(view.divergedLandingOid, null);
    assert.equal(view.divergedUpstreamOid, null);
    assert.equal(view.updatedAt, 1);
    assert.deepEqual(
      [...Object.keys(view)].sort((a, b) =>
        Buffer.compare(Buffer.from(a), Buffer.from(b)),
      ),
      [...SORTED_MEMBERS],
    );
  });

  it("renders landingRef and trackingRef for a kanthord/main branch as a concatenation", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run("UPDATE repository SET branch = ? WHERE id = ?", [
        "kanthord/main",
        fixtureIds.repository,
      ]);
    });
    const mock = gitMock({
      [key(HOME_PATH, "refs/heads/kanthord/main")]: "3".repeat(40),
      [key(HOME_PATH, "refs/remotes/origin/kanthord/main")]: "4".repeat(40),
    });

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.landingRef, "refs/heads/kanthord/main");
    assert.equal(view.trackingRef, "refs/remotes/origin/kanthord/main");
    assert.equal(view.landingOid, "3".repeat(40));
    assert.equal(view.trackingOid, "4".repeat(40));
  });

  it("a branch of kanthord/landing reports all three derived refs by exact string", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run("UPDATE repository SET branch = ? WHERE id = ?", [
        "kanthord/landing",
        fixtureIds.repository,
      ]);
    });
    const mock = gitMock({
      [key(HOME_PATH, "refs/heads/kanthord/landing")]: "5".repeat(40),
      [key(HOME_PATH, "refs/remotes/origin/kanthord/landing")]: "6".repeat(40),
    });

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.landingRef, "refs/heads/kanthord/landing");
    assert.equal(view.trackingRef, "refs/remotes/origin/kanthord/landing");
    assert.equal(view.publishRef, "refs/heads/kanthord/landing");
  });

  it("reads the provider name through the join, not a copy", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run("UPDATE provider SET name = ? WHERE id = ?", [
        "renamed-bot",
        fixtureIds.provider,
      ]);
    });
    const mock = gitMock(landingPair);

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.deepEqual(view.credential, {
      id: fixtureIds.provider,
      name: "renamed-bot",
    });
  });

  it("reports publishOnApproval true for a stored 1 and false for a stored 0", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock(landingPair);

    const first = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );
    assert.equal(first?.publishOnApproval, true);

    temporary.storage.transact((transaction) => {
      transaction.run(
        "UPDATE repository SET publish_on_approval = ? WHERE id = ?",
        [0, fixtureIds.repository],
      );
    });
    const second = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );
    assert.equal(second?.publishOnApproval, false);
  });

  it("reads the landing tip first and then the tracking tip, exactly twice", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock(landingPair);

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.landingOid, "1".repeat(40));
    assert.equal(view.trackingOid, "2".repeat(40));
    assert.deepEqual(mock.refCalls, [
      { gitDir: HOME_PATH, ref: LANDING_REF },
      { gitDir: HOME_PATH, ref: TRACKING_REF },
    ]);
  });

  it("reports a missing ref as null, not an error", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock({
      [key(HOME_PATH, LANDING_REF)]: "1".repeat(40),
      [key(HOME_PATH, TRACKING_REF)]: null,
    });

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.landingOid, "1".repeat(40));
    assert.equal(view.trackingOid, null);
  });

  it("reports an unreadable home as null tips, not an error", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock({
      [key(HOME_PATH, LANDING_REF)]: null,
      [key(HOME_PATH, TRACKING_REF)]: null,
    });

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.landingOid, null);
    assert.equal(view.trackingOid, null);
  });

  it("returns the diverged tips and the state of a needs-reconcile row", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "UPDATE repository SET state = ?, diverged_landing_oid = ?, diverged_upstream_oid = ? WHERE id = ?",
        [
          "needs-reconcile",
          "a".repeat(40),
          "b".repeat(40),
          fixtureIds.repository,
        ],
      );
    });
    const mock = gitMock(landingPair);

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    assert.equal(view.state, "needs-reconcile");
    assert.equal(view.divergedLandingOid, "a".repeat(40));
    assert.equal(view.divergedUpstreamOid, "b".repeat(40));
  });

  it("returns null for an unknown but well-formed id", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock({});

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: "repo_unknown" },
    );

    assert.equal(view, null);
    assert.deepEqual(mock.refCalls, []);
  });

  it("carries no path and no ciphertext", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
    });
    const mock = gitMock(landingPair);

    const view = await showRepository(
      { storage: temporary.storage, git: mock.git },
      { id: fixtureIds.repository },
    );

    assert.ok(view !== null);
    const text = JSON.stringify(view);
    assert.equal(text.includes(HOME_PATH), false, text);
    assert.equal(text.includes("payload"), false, text);
    assert.equal(Object.hasOwn(view, "homePath"), false);
  });

  it("the statement names its columns", () => {
    const source = readFileSync(
      new URL("./show-repository.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("SELECT *"), false);
    assert.equal(source.includes("select *"), false);
  });
});
