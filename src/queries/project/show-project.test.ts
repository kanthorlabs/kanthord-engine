import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { showProject } from "./show-project.ts";
import { projectView } from "../../http/contract/project.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

describe("src/queries/project/show-project.test", () => {
  it("returns the seeded project with its bound repository", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    const view = showProject(
      { storage: temporary.storage },
      { id: fixtureIds.project },
    );

    assert.deepEqual(view, {
      id: fixtureIds.project,
      name: "kanthord-verify",
      repositories: [fixtureIds.repository],
      updatedAt: 1,
    });
  });

  it("an unknown project id returns null", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    const view = showProject(
      { storage: temporary.storage },
      { id: "project_missing" },
    );

    assert.equal(view, null);
  });

  it("returns bindings in bytewise ascending target order, not insertion order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'git', ?, ?)",
        [fixtureIds.project, "repo_c", 2],
      );
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'git', ?, ?)",
        [fixtureIds.project, "repo_b", 3],
      );
    });

    const view = showProject(
      { storage: temporary.storage },
      { id: fixtureIds.project },
    );

    assert.deepEqual(view?.repositories, [
      fixtureIds.repository,
      "repo_b",
      "repo_c",
    ]);
  });

  it("every returned view satisfies the projectView schema", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact(seedRegistry);

    const view = showProject(
      { storage: temporary.storage },
      { id: fixtureIds.project },
    );

    assert.equal(
      view !== null && projectView.safeParse(view).success,
      true,
      JSON.stringify(view),
    );
  });

  it("the statement names its columns", () => {
    const source = readFileSync(
      new URL("./show-project.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("SELECT *"), false);
    assert.equal(source.includes("select *"), false);
  });
});
