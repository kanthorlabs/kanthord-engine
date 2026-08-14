import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  completenessFindings,
  type CompletenessChild,
  type CompletenessParent,
} from "./plan-completeness.ts";

const subjects = ["document", "record"] as const;

describe("src/domain/plan-completeness.test", () => {
  it("empty parents yield no findings under both subjects", () => {
    for (const subject of subjects) {
      assert.deepEqual(
        completenessFindings({ subject, parents: [], children: [] }),
        [],
      );
    }
  });

  it("empty children emit one finding per non-task parent under both subjects", () => {
    const parents: readonly CompletenessParent[] = [
      { kind: "initiative", key: "A", path: null, id: null },
      { kind: "objective", key: "B", path: null, id: null },
    ];
    const documentMessages = [
      "the initiative holds no objective document",
      "the objective holds no task document",
    ];
    const recordMessages = [
      "the initiative holds no objective",
      "the objective holds no task",
    ];
    for (const subject of subjects) {
      const findings = completenessFindings({
        subject,
        parents,
        children: [],
      });
      assert.deepEqual(
        findings.map((finding) => finding.code),
        ["initiative-without-objective", "objective-without-task"],
      );
      assert.deepEqual(
        findings.map((finding) => finding.message),
        subject === "document" ? documentMessages : recordMessages,
      );
      assert.deepEqual(
        findings.map((finding) => finding.path),
        [null, null],
      );
      assert.deepEqual(
        findings.map((finding) => finding.id),
        [null, null],
      );
    }
  });

  it("a satisfied parent yields no finding under both subjects", () => {
    const parents: readonly CompletenessParent[] = [
      {
        kind: "initiative",
        key: "A",
        path: "plan/i--01/initiative.md",
        id: null,
      },
      {
        kind: "objective",
        key: "B",
        path: "plan/i--01/o--02/objective.md",
        id: null,
      },
    ];
    const children: readonly CompletenessChild[] = [
      { kind: "objective", parentKey: "A" },
      { kind: "task", parentKey: "B" },
    ];
    for (const subject of subjects) {
      assert.deepEqual(
        completenessFindings({ subject, parents, children }),
        [],
      );
    }
  });

  it("a task parent emits nothing under both subjects", () => {
    const parents: readonly CompletenessParent[] = [
      { kind: "task", key: "C", path: null, id: "task_C" },
    ];
    for (const subject of subjects) {
      assert.deepEqual(
        completenessFindings({ subject, parents, children: [] }),
        [],
      );
    }
  });

  it("the wrong child kind does not satisfy a parent", () => {
    const parents: readonly CompletenessParent[] = [
      { kind: "initiative", key: "A", path: null, id: null },
    ];
    const children: readonly CompletenessChild[] = [
      { kind: "task", parentKey: "A" },
    ];
    for (const subject of subjects) {
      const findings = completenessFindings({ subject, parents, children });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "initiative-without-objective");
    }
  });

  it("a child whose parent key is null satisfies no parent", () => {
    const parents: readonly CompletenessParent[] = [
      { kind: "initiative", key: "A", path: null, id: null },
    ];
    const children: readonly CompletenessChild[] = [
      { kind: "objective", parentKey: null },
    ];
    for (const subject of subjects) {
      const findings = completenessFindings({ subject, parents, children });
      assert.equal(findings.length, 1);
      assert.equal(findings[0]?.code, "initiative-without-objective");
    }
  });

  it("path and id are copied from the parent", () => {
    const parents: readonly CompletenessParent[] = [
      {
        kind: "initiative",
        key: "A",
        path: "plan/i--01/initiative.md",
        id: null,
      },
      { kind: "objective", key: "B", path: null, id: "objective_X" },
    ];
    for (const subject of subjects) {
      const findings = completenessFindings({
        subject,
        parents,
        children: [],
      });
      assert.equal(findings.length, 2);
      assert.equal(findings[0]?.path, "plan/i--01/initiative.md");
      assert.equal(findings[0]?.id, null);
      assert.equal(findings[1]?.path, null);
      assert.equal(findings[1]?.id, "objective_X");
    }
  });

  it("output order equals the parents order", () => {
    const parents: readonly CompletenessParent[] = [
      { kind: "initiative", key: "z", path: null, id: "initiative_z" },
      { kind: "objective", key: "a", path: null, id: "objective_a" },
      { kind: "initiative", key: "m", path: null, id: "initiative_m" },
    ];
    const findings = completenessFindings({
      subject: "record",
      parents,
      children: [],
    });
    assert.deepEqual(
      findings.map((finding) => finding.id),
      ["initiative_z", "objective_a", "initiative_m"],
    );
    assert.deepEqual(
      findings.map((finding) => finding.code),
      [
        "initiative-without-objective",
        "objective-without-task",
        "initiative-without-objective",
      ],
    );
  });
});
