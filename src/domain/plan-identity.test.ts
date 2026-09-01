import { describe, it } from "node:test";
import assert from "node:assert/strict";

import type { NodeKind } from "./state.ts";
import type { ParsedDocument } from "./plan-document.ts";
import {
  resolveIdentities,
  type ResolveIdentitiesResult,
} from "./plan-identity.ts";
import { createMockIdGenerator } from "../../test/helpers/ids.ts";
import { IdGeneratorError } from "../services/ids/index.ts";

const u1 = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const u2 = "01BQZ3NDEKTSV4RRFFQ69G5FAV";
const u3 = "01CRZ3NDEKTSV4RRFFQ69G5FAV";
const u4 = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const u5 = "01ERZ3NDEKTSV4RRFFQ69G5FAV";
const u6 = "01FRZ3NDEKTSV4RRFFQ69G5FAV";

function document(
  path: string,
  fields: Readonly<Partial<Omit<ParsedDocument, "path">>> = {},
): ParsedDocument {
  return {
    path,
    kind: "task",
    id: null,
    title: "title",
    dependsOn: [],
    worker: null,
    repo: null,
    derivedParentPath: null,
    instruction: "instruction",
    acceptance: "acceptance criteria",
    deliverable: null,
    verify: null,
    ...fields,
  } as ParsedDocument;
}

function makeMint(ulids: readonly string[]) {
  const generator = createMockIdGenerator({ ulids });
  let calls = 0;
  return {
    mint(kind: NodeKind): string {
      calls += 1;
      return generator.mint(kind);
    },
    count(): number {
      return calls;
    },
  };
}

function run(
  documents: readonly ParsedDocument[],
  options: Readonly<{
    ulids?: readonly string[];
    databaseIdentities?: readonly string[];
    databasePaths?: ReadonlyMap<string, string>;
  }> = {},
): ResolveIdentitiesResult {
  const mint = makeMint(options.ulids ?? []);
  return resolveIdentities(
    { mint: mint.mint },
    {
      documents,
      databaseIdentities: options.databaseIdentities ?? [],
      databasePaths: options.databasePaths ?? new Map<string, string>(),
    },
  );
}

describe("src/domain/plan-identity.test", () => {
  it("mints by canonical path order, independent of the input order", () => {
    const documents = [
      document("plan/i--01/initiative.md", { kind: "initiative" }),
      document("plan/i--01/o--02/objective.md", { kind: "objective" }),
      document("plan/i--01/o--01/01-a--03.md", {}),
    ];
    const expectTable = (order: readonly ParsedDocument[]) => {
      const result = run(order, { ulids: [u1, u2, u3] });
      assert.deepEqual(result.findings, []);
      const byPath = new Map(result.resolved.map((r) => [r.path, r.identity]));
      assert.equal(byPath.get("plan/i--01/initiative.md"), `initiative_${u1}`);
      assert.equal(byPath.get("plan/i--01/o--01/01-a--03.md"), `task_${u2}`);
      assert.equal(
        byPath.get("plan/i--01/o--02/objective.md"),
        `objective_${u3}`,
      );
      for (const resolved of result.resolved) {
        assert.equal(resolved.minted, true);
      }
    };
    expectTable(documents);
    expectTable([...documents].reverse());
  });

  it("keeps an authored id with minted false and consumes no mint", () => {
    const mint = makeMint([]);
    const result = resolveIdentities(
      { mint: mint.mint },
      {
        documents: [
          document("plan/i--01/o--02/01-a--03.md", { id: `task_${u1}` }),
        ],
        databaseIdentities: [],
        databasePaths: new Map<string, string>(),
      },
    );
    assert.deepEqual(result.findings, []);
    assert.equal(result.resolved.length, 1);
    assert.equal(result.resolved[0]!.identity, `task_${u1}`);
    assert.equal(result.resolved[0]!.minted, false);
    assert.equal(mint.count(), 0);
  });

  it("consumes exactly one mint per document without an id", () => {
    const documents = [
      document("plan/i--01/initiative.md", {
        kind: "initiative",
        id: `initiative_${u1}`,
      }),
      document("plan/i--01/o--01/01-a--03.md", { id: `task_${u2}` }),
      document("plan/i--01/o--01/02-b--04.md", { id: `task_${u3}` }),
      document("plan/i--01/o--01/objective.md", {
        kind: "objective",
        id: `objective_${u4}`,
      }),
      document("plan/i--01/o--02/03-c--05.md", {}),
      document("plan/i--01/o--02/04-d--06.md", {}),
    ];
    const mint = makeMint([u5, u6]);
    const result = resolveIdentities(
      { mint: mint.mint },
      { documents, databaseIdentities: [], databasePaths: new Map() },
    );
    assert.equal(mint.count(), 2);
    assert.deepEqual(result.findings, []);
    const byPath = new Map(result.resolved.map((r) => [r.path, r.identity]));
    assert.equal(byPath.get("plan/i--01/o--02/03-c--05.md"), `task_${u5}`);
    assert.equal(byPath.get("plan/i--01/o--02/04-d--06.md"), `task_${u6}`);
  });

  it("propagates ids-exhausted as a thrown IdGeneratorError, not a finding", () => {
    const mint = makeMint([u1]);
    const documents = [
      document("plan/i--01/o--02/01-a--03.md", {}),
      document("plan/i--01/o--02/02-b--04.md", {}),
    ];
    assert.throws(
      () =>
        resolveIdentities(
          { mint: mint.mint },
          { documents, databaseIdentities: [], databasePaths: new Map() },
        ),
      IdGeneratorError,
    );
  });

  it("reports identity-invalid for three unparseable ids and excludes the documents", () => {
    const documents = [
      document("plan/i--01/o--01/01-a--03.md", { id: "task_nope" }),
      document("plan/i--01/o--01/02-b--04.md", { id: u1 }),
      document("plan/i--01/o--01/03-c--05.md", { id: `widget_${u1}` }),
    ];
    const result = run(documents);
    assert.equal(result.resolved.length, 0);
    const invalid = result.findings.filter(
      (f) => f.code === "identity-invalid",
    );
    assert.equal(invalid.length, 3);
    assert.deepEqual(invalid.map((f) => f.path).sort(), [
      "plan/i--01/o--01/01-a--03.md",
      "plan/i--01/o--01/02-b--04.md",
      "plan/i--01/o--01/03-c--05.md",
    ]);
  });

  it("reports identity-kind-mismatch for an id whose kind differs from the document kind", () => {
    const result = run([
      document("plan/i--01/o--02/01-a--03.md", { id: `objective_${u1}` }),
    ]);
    assert.equal(result.resolved.length, 0);
    assert.deepEqual(
      result.findings.map((f) => f.code),
      ["identity-kind-mismatch"],
    );
    assert.equal(result.findings[0]!.path, "plan/i--01/o--02/01-a--03.md");
  });

  it("reports identity-kind-mismatch for both documents sharing one ULID payload under two prefixes", () => {
    const documents = [
      document("plan/i--01/o--02/01-a--03.md", { id: `task_${u1}` }),
      document("plan/i--01/o--02/objective.md", {
        kind: "objective",
        id: `objective_${u1}`,
      }),
    ];
    const result = run(documents);
    assert.equal(result.resolved.length, 0);
    const mismatch = result.findings.filter(
      (f) => f.code === "identity-kind-mismatch",
    );
    assert.equal(mismatch.length, 2);
    assert.deepEqual(mismatch.map((f) => f.path).sort(), [
      "plan/i--01/o--02/01-a--03.md",
      "plan/i--01/o--02/objective.md",
    ]);
  });

  it("reports identity-duplicate once per extra occurrence", () => {
    const two = run([
      document("plan/i--01/o--02/01-a--03.md", { id: `task_${u1}` }),
      document("plan/i--01/o--02/02-b--04.md", { id: `task_${u1}` }),
    ]);
    assert.equal(two.resolved.length, 1);
    assert.equal(two.resolved[0]!.identity, `task_${u1}`);
    assert.deepEqual(
      two.findings.map((f) => f.code),
      ["identity-duplicate"],
    );
    assert.equal(two.findings[0]!.path, "plan/i--01/o--02/02-b--04.md");

    const three = run([
      document("plan/i--01/o--02/01-a--03.md", { id: `task_${u1}` }),
      document("plan/i--01/o--02/02-b--04.md", { id: `task_${u1}` }),
      document("plan/i--01/o--02/03-c--05.md", { id: `task_${u1}` }),
    ]);
    assert.equal(three.resolved.length, 1);
    assert.equal(
      three.findings.filter((f) => f.code === "identity-duplicate").length,
      2,
    );
  });

  it("resolves an identity entry first and never as a path", () => {
    const target = document("plan/i--01/o--02/01-a--03.md", {
      id: `task_${u1}`,
    });
    const declaring = document("plan/i--01/o--02/01-b--04.md", {
      dependsOn: [`task_${u1}`],
    });

    const resolved = run([declaring, target], { ulids: [u2] });
    assert.deepEqual(resolved.findings, []);
    const self = resolved.resolved.find((r) => r.path === declaring.path)!;
    assert.deepEqual(self.dependencies, [`task_${u1}`]);

    const unresolved = run(
      [document("plan/i--01/o--02/01-b--04.md", { dependsOn: [`task_${u1}`] })],
      { ulids: [u2] },
    );
    assert.deepEqual(
      unresolved.findings.map((f) => f.code),
      ["reference-unresolved"],
    );

    const fromDatabase = run(
      [document("plan/i--01/o--02/01-b--04.md", { dependsOn: [`task_${u1}`] })],
      { ulids: [u2], databaseIdentities: [`task_${u1}`] },
    );
    assert.deepEqual(fromDatabase.findings, []);
    const fromDb = fromDatabase.resolved.find(
      (r) => r.path === declaring.path,
    )!;
    assert.deepEqual(fromDb.dependencies, [`task_${u1}`]);

    const pathSpelledLikeAnIdentity = run(
      [
        document("plan/i--01/o--02/task_01ARZ3NDEKTSV4RRFFQ69G5FAV.md", {
          id: `task_${u2}`,
        }),
        document("plan/i--01/o--02/01-b--04.md", { dependsOn: [`task_${u1}`] }),
      ],
      { ulids: [u3] },
    );
    assert.equal(
      pathSpelledLikeAnIdentity.findings.filter(
        (f) => f.code === "reference-unresolved",
      ).length,
      1,
    );
  });

  it("resolves a sibling basename from the declaring directory", () => {
    const target = document(
      "plan/i--01/o--02/01-a--01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
      { id: `task_${u1}` },
    );
    const declaring = document("plan/i--01/o--02/01-b--04.md", {
      dependsOn: ["01-a--01ARZ3NDEKTSV4RRFFQ69G5FAV.md"],
    });
    const result = run([declaring, target], { ulids: [u2] });
    assert.deepEqual(result.findings, []);
    const resolved = result.resolved.find((r) => r.path === declaring.path)!;
    assert.deepEqual(resolved.dependencies, [`task_${u1}`]);
  });

  it("resolves a plan-relative path from a different objective", () => {
    const target = document("plan/i--01/o--02/01-a--03.md", {
      id: `task_${u1}`,
    });
    const declaring = document("plan/i--01/o--01/01-b--04.md", {
      dependsOn: ["plan/i--01/o--02/01-a--03.md"],
    });
    const result = run([declaring, target], { ulids: [u2] });
    assert.deepEqual(result.findings, []);
    const resolved = result.resolved.find((r) => r.path === declaring.path)!;
    assert.deepEqual(resolved.dependencies, [`task_${u1}`]);
  });

  it("reports reference-ambiguous naming both resolved paths", () => {
    const declaring = document("plan/i--01/o--02/objective.md", {
      kind: "objective",
      dependsOn: ["plan/x--05.md"],
    });
    const result = run(
      [
        document("plan/x--05.md", { id: `task_${u1}` }),
        document("plan/i--01/o--02/plan/x--05.md", { id: `task_${u2}` }),
        declaring,
      ],
      { ulids: [u3] },
    );
    const ambiguous = result.findings.filter(
      (f) => f.code === "reference-ambiguous",
    );
    assert.equal(ambiguous.length, 1);
    const finding = ambiguous[0]!;
    assert.equal(finding.path, declaring.path);
    assert.ok(finding.message.includes("plan/i--01/o--02/plan/x--05.md"));
    assert.ok(finding.message.includes("plan/x--05.md"));
  });

  it("resolves a value naming the same path under both bases with one dependency and no finding", () => {
    const target = document("plan/y--06.md", { id: `task_${u2}` });
    const declaring = document("plan/x--05.md", { dependsOn: ["y--06.md"] });
    const result = run([declaring, target], { ulids: [u1] });
    assert.deepEqual(result.findings, []);
    const resolved = result.resolved.find((r) => r.path === declaring.path)!;
    assert.deepEqual(resolved.dependencies, [`task_${u2}`]);
  });

  it("reports reference-unresolved when a parent pop escapes and the plan root finds nothing", () => {
    const declaring = document("plan/i--01/initiative.md", {
      kind: "initiative",
      dependsOn: ["../nope.md"],
    });
    const result = run([declaring], { ulids: [u1] });
    assert.deepEqual(
      result.findings.map((f) => f.code),
      ["reference-unresolved"],
    );
  });

  it("de-duplicates and bytewise-sorts dependencies", () => {
    const siblings = [
      document("plan/i--01/o--02/01-a--01ARZ3NDEKTSV4RRFFQ69G5FAV.md", {
        id: `task_${u1}`,
      }),
      document("plan/i--01/o--02/02-b--01BQZ3NDEKTSV4RRFFQ69G5FAV.md", {
        id: `task_${u2}`,
      }),
      document("plan/i--01/o--02/03-c--01CRZ3NDEKTSV4RRFFQ69G5FAV.md", {
        id: `task_${u3}`,
      }),
    ];
    const declaring = document("plan/i--01/o--02/04-d--05.md", {
      dependsOn: [
        `task_${u3}`,
        "01-a--01ARZ3NDEKTSV4RRFFQ69G5FAV.md",
        `task_${u1}`,
      ],
    });
    const result = run([...siblings, declaring], { ulids: [u4] });
    assert.deepEqual(result.findings, []);
    const resolved = result.resolved.find((r) => r.path === declaring.path)!;
    assert.deepEqual(resolved.dependencies, [`task_${u1}`, `task_${u3}`]);
  });

  it("sets parentIdentity from the submitted document at the derived parent path", () => {
    const documents = [
      document("plan/i--01/initiative.md", {
        kind: "initiative",
        derivedParentPath: null,
      }),
      document("plan/i--01/o--02/objective.md", {
        kind: "objective",
        derivedParentPath: "plan/i--01/initiative.md",
      }),
      document("plan/i--01/o--02/01-c--03.md", {
        derivedParentPath: "plan/i--01/o--02/objective.md",
      }),
    ];
    const result = run(documents, { ulids: [u1, u2, u3] });
    assert.deepEqual(result.findings, []);
    const byPath = new Map(result.resolved.map((r) => [r.path, r]));
    assert.equal(
      byPath.get("plan/i--01/o--02/01-c--03.md")!.parentIdentity,
      `objective_${u3}`,
    );
    assert.equal(
      byPath.get("plan/i--01/o--02/objective.md")!.parentIdentity,
      `initiative_${u1}`,
    );
    assert.equal(byPath.get("plan/i--01/initiative.md")!.parentIdentity, null);
  });

  it("is deterministic across two runs with a fresh mock", () => {
    const documents = [
      document("plan/i--01/initiative.md", {
        kind: "initiative",
        derivedParentPath: null,
      }),
      document("plan/i--01/o--01/01-a--03.md", {
        id: `task_${u1}`,
        derivedParentPath: "plan/i--01/o--01/objective.md",
      }),
      document("plan/i--01/o--01/objective.md", {
        kind: "objective",
        id: `objective_${u2}`,
        derivedParentPath: "plan/i--01/initiative.md",
      }),
      document("plan/i--01/o--02/02-b--04.md", {
        dependsOn: ["plan/i--01/o--01/objective.md", `task_${u1}`],
        derivedParentPath: "plan/i--01/o--02/objective.md",
      }),
      document("plan/i--01/o--02/objective.md", {
        kind: "objective",
        derivedParentPath: "plan/i--01/initiative.md",
      }),
    ];
    const first = run(documents, { ulids: [u3, u4, u5] });
    const second = run(documents, { ulids: [u3, u4, u5] });
    assert.deepEqual(second, first);
  });
});
