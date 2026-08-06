import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { listProjects } from "./list-project.ts";
import { projectView } from "../../http/contract/project.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

function insertProject(
  storage: Parameters<typeof seedRegistry>[0],
  id: string,
  name: string,
  updatedAt: number,
): void {
  storage.run(
    "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, NULL, NULL, ?)",
    [id, name, updatedAt],
  );
}

describe("src/queries/project/list-project.test", () => {
  it("returns projects in ascending id order with names in reverse alphabetical order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertProject(transaction, "project_c", "alpha-project", 3);
      insertProject(transaction, "project_b", "beta-project", 2);
    });

    const views = listProjects({ storage: temporary.storage }, {});

    assert.deepEqual(
      views.map((view) => view.id),
      [fixtureIds.project, "project_b", "project_c"],
    );
    assert.deepEqual(
      views.map((view) => view.name),
      ["kanthord-verify", "beta-project", "alpha-project"],
    );
    assert.deepEqual(
      views.map((view) => view.updatedAt),
      [1, 2, 3],
    );
  });

  it("carries each project's bindings in the row order", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertProject(transaction, "project_b", "beta-project", 2);
      transaction.run(
        "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'git', ?, ?)",
        ["project_b", "repo_a", 2],
      );
    });

    const views = listProjects({ storage: temporary.storage }, {});

    assert.deepEqual(
      views.map((view) => view.repositories),
      [[fixtureIds.repository], [fixtureIds.repository]],
    );
  });

  it("an empty table returns an empty list", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());

    const views = listProjects({ storage: temporary.storage }, {});

    assert.deepEqual(views, []);
  });

  it("every returned view satisfies the projectView schema", (t) => {
    const temporary = createMigratedStorage();
    t.after(() => temporary.dispose());
    temporary.storage.transact((transaction) => {
      seedRegistry(transaction);
      insertProject(transaction, "project_b", "beta-project", 2);
    });

    const views = listProjects({ storage: temporary.storage }, {});

    for (const view of views) {
      assert.equal(
        projectView.safeParse(view).success,
        true,
        JSON.stringify(view),
      );
    }
  });

  it("the statements name their columns", () => {
    const source = readFileSync(
      new URL("./list-project.ts", import.meta.url),
      "utf8",
    );
    assert.equal(source.includes("SELECT *"), false);
    assert.equal(source.includes("select *"), false);
  });
});
