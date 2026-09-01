import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  proposalStatements,
  readRouteMatrix,
} from "../../../test/helpers/proposal.ts";

const docs = resolve(import.meta.dirname, "../../../docs/proposal");

function read(relative: string): string {
  return readFileSync(resolve(docs, relative), "utf8");
}

function squash(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

const graph = squash(read("api/graph.md"));
const readme = squash(read("api/README.md"));
const stateMachine = squash(read("phase-1/state-machine.md"));
const planFormat = squash(read("phase-1/plan-format.md"));
const migration = read("database/migration.md");

describe("src/http/contract/proposal-amendment.test", () => {
  it("the routes table holds the three node operations", () => {
    const rows = readRouteMatrix();
    const expected = [
      {
        operationId: "node.create",
        method: "POST",
        path: "/v1/project/:id/node",
        introducedIn: "phase-1",
        status: "routed",
      },
      {
        operationId: "node.update",
        method: "POST",
        path: "/v1/node/:id/update",
        introducedIn: "phase-1",
        status: "routed",
      },
      {
        operationId: "node.delete",
        method: "POST",
        path: "/v1/node/:id/delete",
        introducedIn: "phase-1",
        status: "routed",
      },
    ];
    for (const row of expected) {
      const found = rows.find((entry) => entry.operationId === row.operationId);
      assert.ok(found, `missing route row for ${row.operationId}`);
      assert.equal(found.method, row.method);
      assert.equal(found.path, row.path);
      assert.equal(found.introducedIn, row.introducedIn);
      assert.equal(found.status, row.status);
      assert.ok(
        found.source.includes("013-external-drive-overview.md"),
        `${row.operationId} row cites 013-external-drive-overview.md:23`,
      );
    }
  });

  it("graph.md gains one section per node route", () => {
    for (const operation of ["node.create", "node.update", "node.delete"]) {
      assert.ok(
        graph.includes(`## \`${operation}\``),
        `missing section for ${operation}`,
      );
    }
  });

  it("the paragraph states the two concurrency classes and the refusal sets", () => {
    const paragraph = squash(
      "Two concurrency classes exist. A field-only update carries the node revision. A create, a topology change and a delete carry the project revision. A mismatch is `409 stale-revision`, and `details.guard` names the class. A structural finding refuses the write with `422 plan-invalid`. It refuses at `plan.import` and at every per-node write. A completeness finding refuses nothing. It travels in the success body under `completeness`. The two completeness codes are `initiative-without-objective` and `objective-without-task`.",
    );
    assert.ok(
      graph.includes(paragraph),
      "the paragraph after the three sections states the three facts",
    );
  });

  it("state-machine.md line 47 carries the amended completeness sentence", () => {
    assert.ok(
      stateMachine.includes(
        "An objective with no tasks, or an initiative with no objectives, is incomplete. Every write reports the finding and commits. A claim under an incomplete node is refused.",
      ),
    );
  });

  it("plan-format.md line 135 names the structurally valid baseline", () => {
    assert.ok(
      planFormat.includes(
        "The database baseline is always structurally valid, so the procedure terminates.",
      ),
    );
    assert.ok(
      !planFormat.includes(
        "The database baseline is always valid, so the procedure terminates",
      ),
      "the old always-valid wording is gone",
    );
  });

  it("plan-format.md records both frontmatter shapes and the dual-read window", () => {
    assert.match(
      planFormat,
      /Frontmatter fields:.*worker.*deliverable.*verify/,
    );
    assert.ok(
      planFormat.includes(
        "The two shapes are exclusive per document. A document carries either `worker` (legacy) or `deliverable` + `verify` (new), never both.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "A document carrying both raises `frontmatter-invalid` on the issue path `deliverable`.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "A document carrying neither field is legal through the dual-read window. `worker` is nullable in the `node.create` request, so the daemon creates such a node itself. EPIC 057 closes the window and makes `deliverable` mandatory.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "A document carrying `deliverable` and no `verify` raises `frontmatter-invalid` on the issue path `verify`.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "`verify` is required in the new shape and may be `{ paths: [], commands: [] }`.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "The dual-read window closes at EPIC 057, which removes the `worker` field.",
      ),
    );
  });

  it("plan-format.md records the two key orders and verify block grammar", () => {
    assert.ok(
      planFormat.includes(
        "Legacy shape (worker): `id`, `kind`, `title`, `depends_on`, `worker`, `repo`. An absent field is omitted.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "New shape (deliverable): `id`, `kind`, `title`, `deliverable`, `repo`, `depends_on`, `verify`. An absent field is omitted. `depends_on` moves after `repo` in the new shape.",
      ),
    );
    assert.ok(planFormat.includes("### verify block"));
    assert.ok(
      planFormat.includes(
        "The `verify` block is a nested YAML structure with exactly two keys: `paths` (list of absolute paths, anchored at the repository root) and `commands` (list of shell strings).",
      ),
    );
    assert.ok(
      planFormat.includes("An empty list renders as ` paths: []` on one line."),
    );
    assert.ok(
      planFormat.includes(
        "A non-empty `paths` list renders as one ` - <quoted-path>` line per entry.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "A non-empty `commands` list renders as one ` - <quoted-command>` line per entry.",
      ),
    );
    assert.ok(
      planFormat.includes(
        "Paths are sorted bytewise; commands preserve author order.",
      ),
    );
  });

  it("the precondition table carries fromRevision for the three node operations", () => {
    const rows = read("api/README.md")
      .split("\n")
      .filter((line) => line.startsWith("|"));
    for (const operation of ["node.create", "node.update", "node.delete"]) {
      const row = rows.find(
        (line) => line.split("|")[1]?.trim() === `\`${operation}\``,
      );
      assert.ok(row, `missing precondition row for ${operation}`);
      assert.equal(row.split("|")[2]?.trim(), "`fromRevision`");
    }
  });

  it("binding-in-use widens to removals, containment moves and deletes", () => {
    assert.ok(
      readme.includes(
        "a removal, a containment move or a delete is refused, and `details.blockers` lists what blocks it",
      ),
    );
    assert.ok(
      !readme.includes("a removal is refused"),
      "the old narrow wording is gone",
    );
  });

  it("plan_revision.md normalizes to the revision-origin DDL", () => {
    const expected = squash(`
      CREATE TABLE plan_revision (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL REFERENCES project(id),
        parent_id TEXT REFERENCES plan_revision(id),
        origin TEXT NOT NULL CHECK (origin IN ('import', 'node-write')),
        import_id TEXT,
        submitted_blob TEXT REFERENCES blob(hash),
        choices_blob TEXT REFERENCES blob(hash),
        accepted_blob TEXT NOT NULL REFERENCES blob(hash),
        UNIQUE (project_id, import_id),
        CHECK ((origin = 'import') = (import_id IS NOT NULL)),
        CHECK ((origin = 'import') = (submitted_blob IS NOT NULL)),
        CHECK ((origin = 'import') = (choices_blob IS NOT NULL))
      ) STRICT
    `);
    assert.deepEqual(proposalStatements("plan_revision"), [expected]);
  });

  it("migration.md lists eight migrations including 0007-external-execution and 0008-graph-indexes", () => {
    const fences = migration.split("```");
    const fence = fences[fences.length - 2] ?? "";
    for (let version = 1; version <= 8; version++) {
      assert.ok(
        new RegExp(
          `^${version}\\s+000${version}-[a-z-]+\\s+\\d+\\s*$`,
          "m",
        ).test(fence),
        `missing row for version ${version}`,
      );
    }
    assert.equal(
      (migration.match(/0007-external-execution/g) ?? []).length,
      1,
      "the migration list names 0007-external-execution exactly once",
    );
    assert.equal(
      (migration.match(/0008-graph-indexes/g) ?? []).length,
      1,
      "the migration list names 0008-graph-indexes exactly once",
    );
    assert.ok(migration.includes("Eight rows appear"));
    assert.ok(migration.includes("prints these eight versions"));
    assert.ok(
      !migration.includes("Six rows appear"),
      "the old six-row prose is gone",
    );
    assert.ok(
      !migration.includes("these six versions"),
      "the old six-row prose is gone",
    );
  });
});
