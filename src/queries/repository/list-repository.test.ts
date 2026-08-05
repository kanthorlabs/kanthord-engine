import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { Git, RemoteUrlVerdict } from "../../services/git/index.ts";
import { listRepositories } from "./list-repository.ts";
import type { RepositoryView } from "./show-repository.ts";
import { repositoryView } from "../../http/contract/repository.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

const HOME_PATH = "repos/r.git";
const OTHER_HOME = "repos/other.git";

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
  };
  return { git, refCalls };
}

function insertRepository(
  transaction: Parameters<typeof seedRegistry>[0],
  id: string,
  name: string,
  state: "ready" | "needs-reconcile",
): void {
  transaction.run(
    "INSERT INTO repository (id, name, remote_url, credential_id, home_path, upstream_branch, landing_branch, publish_ref, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    [
      id,
      name,
      "https://example.invalid/other.git",
      fixtureIds.provider,
      OTHER_HOME,
      "main",
      "main",
      "refs/heads/main",
      1,
      state,
      state === "needs-reconcile" ? "a".repeat(40) : null,
      state === "needs-reconcile" ? "b".repeat(40) : null,
      null,
      1,
    ],
  );
}

describe("src/queries/repository/list-repository.test", () => {
  it("returns three repositories in ascending id order, not insertion or name order", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertRepository(transaction, "repo_c", "aaa-repository", "ready");
      insertRepository(transaction, "repo_b", "zzz-repository", "ready");
    });
    const pairs = {
      [key(HOME_PATH, "refs/heads/main")]: "1".repeat(40),
      [key(HOME_PATH, "refs/remotes/origin/main")]: "2".repeat(40),
      [key(OTHER_HOME, "refs/heads/main")]: "3".repeat(40),
      [key(OTHER_HOME, "refs/remotes/origin/main")]: "4".repeat(40),
    };
    const mock = gitMock(pairs);

    const views: readonly RepositoryView[] = await listRepositories(
      { storage: temporary.storage, git: mock.git },
      {},
    );

    assert.deepEqual(
      views.map((view) => view.id),
      ["repo_a", "repo_b", "repo_c"],
    );
    assert.deepEqual(
      views.map((view) => view.name),
      ["kanthord-verify", "zzz-repository", "aaa-repository"],
    );
    assert.equal(views[0]?.landingOid, "1".repeat(40));
    assert.equal(views[1]?.landingOid, "3".repeat(40));
    assert.equal(views[2]?.landingOid, "3".repeat(40));
  });

  it("a state filter returns only the matching rows in the same order", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertRepository(transaction, "repo_b", "zzz-repository", "ready");
      insertRepository(
        transaction,
        "repo_c",
        "aaa-repository",
        "needs-reconcile",
      );
    });
    const pairs = {
      [key(OTHER_HOME, "refs/heads/main")]: "3".repeat(40),
      [key(OTHER_HOME, "refs/remotes/origin/main")]: "4".repeat(40),
    };
    const mock = gitMock(pairs);

    const views: readonly RepositoryView[] = await listRepositories(
      { storage: temporary.storage, git: mock.git },
      { state: "needs-reconcile" },
    );

    assert.deepEqual(
      views.map((view) => view.id),
      ["repo_c"],
    );
    assert.equal(views[0]?.state, "needs-reconcile");
    assert.equal(views[0]?.divergedLandingOid, "a".repeat(40));
    assert.equal(views[0]?.divergedUpstreamOid, "b".repeat(40));
  });

  it("an empty table returns an empty list", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    const mock = gitMock({});

    const views = await listRepositories(
      { storage: temporary.storage, git: mock.git },
      {},
    );

    assert.deepEqual(views, []);
  });

  it("reads the tips in the returned order: landing then tracking, per repository", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertRepository(transaction, "repo_b", "zzz-repository", "ready");
      insertRepository(transaction, "repo_c", "aaa-repository", "ready");
    });
    const pairs = {
      [key(HOME_PATH, "refs/heads/main")]: "1".repeat(40),
      [key(HOME_PATH, "refs/remotes/origin/main")]: "2".repeat(40),
      [key(OTHER_HOME, "refs/heads/main")]: "3".repeat(40),
      [key(OTHER_HOME, "refs/remotes/origin/main")]: "4".repeat(40),
    };
    const mock = gitMock(pairs);

    await listRepositories({ storage: temporary.storage, git: mock.git }, {});

    assert.deepEqual(mock.refCalls, [
      { gitDir: HOME_PATH, ref: "refs/heads/main" },
      { gitDir: HOME_PATH, ref: "refs/remotes/origin/main" },
      { gitDir: OTHER_HOME, ref: "refs/heads/main" },
      { gitDir: OTHER_HOME, ref: "refs/remotes/origin/main" },
      { gitDir: OTHER_HOME, ref: "refs/heads/main" },
      { gitDir: OTHER_HOME, ref: "refs/remotes/origin/main" },
    ]);
  });

  it("every returned view satisfies the repositoryView schema", async (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertRepository(transaction, "repo_b", "zzz-repository", "ready");
      insertRepository(
        transaction,
        "repo_c",
        "aaa-repository",
        "needs-reconcile",
      );
    });
    const pairs = {
      [key(HOME_PATH, "refs/heads/main")]: "1".repeat(40),
      [key(HOME_PATH, "refs/remotes/origin/main")]: "2".repeat(40),
      [key(OTHER_HOME, "refs/heads/main")]: "3".repeat(40),
      [key(OTHER_HOME, "refs/remotes/origin/main")]: "4".repeat(40),
    };
    const mock = gitMock(pairs);

    const views: readonly RepositoryView[] = await listRepositories(
      { storage: temporary.storage, git: mock.git },
      {},
    );

    for (const view of views) {
      assert.equal(
        repositoryView.safeParse(view).success,
        true,
        JSON.stringify(view),
      );
    }
  });

  it("the statement names its columns", () => {
    const source = readFileSync(
      new URL("./list-repository.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("SELECT *"), false);
    assert.equal(source.includes("select *"), false);
  });
});
