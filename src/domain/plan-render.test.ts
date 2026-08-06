import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { NodeKind } from "./state.ts";
import type { CanonicalNode } from "./plan-canonical-path.ts";
import {
  quoteScalar,
  renderDocument,
  renderDocumentSet,
  type RenderInput,
} from "./plan-render.ts";

const uI = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const uO1 = "01BQZ3NDEKTSV4RRFFQ69G5FAV";
const uO2 = "01CRZ3NDEKTSV4RRFFQ69G5FAV";
const uT1 = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const uT2 = "01ERZ3NDEKTSV4RRFFQ69G5FAV";
const uT3 = "01FRZ3NDEKTSV4RRFFQ69G5FAV";

function node(
  identity: string,
  kind: NodeKind,
  title: string,
  parentIdentity: string | null,
  dependencies: readonly string[] = [],
): CanonicalNode {
  return { identity, kind, title, parentIdentity, dependencies };
}

const fullTask: RenderInput = {
  identity: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
  kind: "task",
  title: "Render JSON",
  dependencies: ["task_01ARZ3NDEKTSV4RRFFQ69G5FAW"],
  worker: "tdd@1",
  repo: null,
  instruction: "Do the thing.\n",
  acceptance: "## Acceptance criteria\n- it works\n",
};

const fullTaskOutput = [
  "---",
  'id: "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"',
  'kind: "task"',
  'title: "Render JSON"',
  "depends_on:",
  '  - "task_01ARZ3NDEKTSV4RRFFQ69G5FAW"',
  'worker: "tdd@1"',
  "---",
  "Do the thing.",
  "## Acceptance criteria",
  "- it works",
  "",
].join("\n");

describe("src/domain/plan-render.test", () => {
  it("renders a full task to the exact bytes", () => {
    assert.equal(renderDocument(fullTask), fullTaskOutput);
  });

  it("renders repo after worker on an objective and neither on an initiative", () => {
    const objectiveOut = renderDocument({
      identity: `objective_${uO1}`,
      kind: "objective",
      title: "Objective One",
      dependencies: [],
      worker: "tdd@1",
      repo: `repo_${uI}`,
      instruction: "Do the objective.\n",
      acceptance: null,
    });
    assert.ok(objectiveOut.includes('worker: "tdd@1"'));
    assert.ok(objectiveOut.includes(`repo: "repo_${uI}"`));
    assert.ok(
      objectiveOut.indexOf('worker: "tdd@1"') <
        objectiveOut.indexOf(`repo: "repo_${uI}"`),
    );

    const initiativeOut = renderDocument({
      identity: `initiative_${uI}`,
      kind: "initiative",
      title: "Initiative",
      dependencies: [],
      worker: null,
      repo: null,
      instruction: "Do the initiative.\n",
      acceptance: null,
    });
    assert.ok(initiativeOut.includes('kind: "initiative"'));
    assert.ok(!initiativeOut.includes("worker:"));
    assert.ok(!initiativeOut.includes("repo:"));
  });

  it("omits the depends_on key entirely for an empty dependency list", () => {
    const out = renderDocument({
      ...fullTask,
      title: "No Deps",
      dependencies: [],
    });
    assert.ok(!out.includes("depends_on:"));
    assert.ok(out.includes('title: "No Deps"'));
  });

  it("renders two dependencies as sorted block entries from a descending input", () => {
    const out = renderDocument({
      ...fullTask,
      title: "Two Deps",
      dependencies: [
        "task_01ARZ3NDEKTSV4RRFFQ69G5FAW",
        "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      ],
    });
    const favLine = out.indexOf('  - "task_01ARZ3NDEKTSV4RRFFQ69G5FAV"');
    const fawLine = out.indexOf('  - "task_01ARZ3NDEKTSV4RRFFQ69G5FAW"');
    assert.ok(favLine !== -1);
    assert.ok(fawLine !== -1);
    assert.ok(favLine < fawLine);
  });

  it("renders the instruction alone when acceptance is null", () => {
    const out = renderDocument({
      ...fullTask,
      title: "No Acceptance",
      dependencies: [],
      acceptance: null,
    });
    assert.ok(out.endsWith("---\nDo the thing.\n"));
  });

  it("guards only a missing trailing LF: one stays, none gains one, three survive", () => {
    const renderBody = (instruction: string): string =>
      renderDocument({
        ...fullTask,
        title: "Body",
        dependencies: [],
        acceptance: null,
        instruction,
      });
    assert.ok(renderBody("a\n").endsWith("---\na\n"));
    assert.ok(renderBody("a").endsWith("---\na\n"));
    assert.ok(renderBody("a\n\n\n").endsWith("---\na\n\n\n"));
  });

  it("quotes scalars, one case per rule", () => {
    assert.equal(quoteScalar('a"b'), '"a\\"b"');
    assert.equal(quoteScalar("a\\b"), '"a\\\\b"');
    assert.equal(quoteScalar("a\nb"), '"a\\nb"');
    assert.equal(quoteScalar("a\rb"), '"a\\rb"');
    assert.equal(quoteScalar("a\tb"), '"a\\tb"');
    assert.equal(quoteScalar("a\u0000b"), '"a\\x00b"');
    assert.equal(quoteScalar("a\u001fb"), '"a\\x1fb"');
    assert.equal(quoteScalar("a\u007fb"), '"a\\x7fb"');
    assert.equal(quoteScalar("héllo ☕"), '"héllo ☕"');
    assert.equal(quoteScalar("'quoted'"), "\"'quoted'\"");
  });

  it("keeps a title with --- inside one quoted scalar", () => {
    const out = renderDocument({
      ...fullTask,
      title: "a---b",
      dependencies: [],
    });
    assert.equal(out.split("\n---\n").length, 2);
    assert.ok(out.includes('title: "a---b"'));
  });

  it("emits no CR in any output and exactly one trailing LF on normalized bodies", () => {
    const outputs: readonly string[] = [
      fullTaskOutput,
      renderDocument({
        identity: `objective_${uO1}`,
        kind: "objective",
        title: "Objective One",
        dependencies: [],
        worker: "tdd@1",
        repo: `repo_${uI}`,
        instruction: "Do the objective.\n",
        acceptance: null,
      }),
      renderDocument({
        identity: `initiative_${uI}`,
        kind: "initiative",
        title: "Initiative",
        dependencies: [],
        worker: null,
        repo: null,
        instruction: "Do the initiative.\n",
        acceptance: null,
      }),
      renderDocument({ ...fullTask, title: "No Deps", dependencies: [] }),
      renderDocument({
        ...fullTask,
        title: "Two Deps",
        dependencies: [
          "task_01ARZ3NDEKTSV4RRFFQ69G5FAW",
          "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        ],
      }),
      renderDocument({
        ...fullTask,
        title: "No Acceptance",
        dependencies: [],
        acceptance: null,
      }),
      renderDocument({
        ...fullTask,
        title: "Body",
        dependencies: [],
        acceptance: null,
        instruction: "a\n",
      }),
      renderDocument({
        ...fullTask,
        title: "Body",
        dependencies: [],
        acceptance: null,
        instruction: "a",
      }),
      renderDocument({ ...fullTask, title: "a---b", dependencies: [] }),
    ];
    for (const output of outputs) {
      assert.ok(!output.includes("\r"));
      assert.ok(output.endsWith("\n"));
      assert.ok(!output.endsWith("\n\n"));
    }
  });

  it("orders a six-document set by comparePaths on the canonical path", () => {
    const nodes: readonly CanonicalNode[] = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(
        `objective_${uO1}`,
        "objective",
        "Objective One",
        `initiative_${uI}`,
      ),
      node(`task_${uT1}`, "task", "Task A", `objective_${uO1}`),
      node(`task_${uT2}`, "task", "Task B", `objective_${uO1}`),
      node(
        `objective_${uO2}`,
        "objective",
        "Objective Two",
        `initiative_${uI}`,
      ),
      node(`task_${uT3}`, "task", "Task C", `objective_${uO2}`),
    ];
    const bodies = new Map(
      nodes.map((n) => [
        n.identity,
        {
          instruction: `${n.title} instruction.\n`,
          acceptance: null,
          worker: n.kind === "task" ? "tdd@1" : null,
          repo: null,
        },
      ]),
    );
    const docs = renderDocumentSet(nodes, bodies);
    assert.deepEqual(
      docs.map((d) => d.path),
      [
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/initiative.md",
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/01-task-a--01drz3ndektsv4rrffq69g5fav.md",
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/02-task-b--01erz3ndektsv4rrffq69g5fav.md",
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-one--01bqz3ndektsv4rrffq69g5fav/objective.md",
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-two--01crz3ndektsv4rrffq69g5fav/01-task-c--01frz3ndektsv4rrffq69g5fav.md",
        "plan/initiative--01arz3ndektsv4rrffq69g5fav/objective-two--01crz3ndektsv4rrffq69g5fav/objective.md",
      ],
    );
    assert.equal(
      docs[1]!.content,
      renderDocument({
        identity: `task_${uT1}`,
        kind: "task",
        title: "Task A",
        dependencies: [],
        worker: "tdd@1",
        repo: null,
        instruction: "Task A instruction.\n",
        acceptance: null,
      }),
    );
  });

  it("throws when a node is absent from the bodies map", () => {
    const nodes: readonly CanonicalNode[] = [
      node(`initiative_${uI}`, "initiative", "Initiative", null),
      node(`task_${uT1}`, "task", "Task A", `initiative_${uI}`),
    ];
    const bodies = new Map<
      string,
      {
        instruction: string;
        acceptance: string | null;
        worker: string | null;
        repo: string | null;
      }
    >();
    bodies.set(`initiative_${uI}`, {
      instruction: "initiative\n",
      acceptance: null,
      worker: null,
      repo: null,
    });
    assert.throws(() => renderDocumentSet(nodes, bodies));
  });

  it("the three render modules never sort by localeCompare, Intl or a bare sort", () => {
    for (const name of [
      "plan-slug.ts",
      "plan-canonical-path.ts",
      "plan-render.ts",
    ]) {
      const source = readFileSync(resolve(import.meta.dirname, name), "utf8");
      assert.ok(
        !source.includes("localeCompare"),
        `${name} uses localeCompare`,
      );
      assert.ok(!source.includes("Intl"), `${name} uses Intl`);
      assert.ok(!source.includes(".sort()"), `${name} uses a bare .sort()`);
    }
  });
});
