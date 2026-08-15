import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  nodeWriteLegality,
  nodeWriteRefusals,
  proseFields,
  structuralFields,
  differingFields,
} from "./node-write-legality.ts";
import type {
  NodeWriteFacts,
  NodeWriteLegality,
} from "./node-write-legality.ts";
import { nodeStates } from "./state.ts";

function verdict(facts: NodeWriteFacts): NodeWriteLegality {
  return nodeWriteLegality(facts);
}

const legalStates = ["pending", "ready", "blocked"] as const;
const illegalStates = [
  "running",
  "awaiting_approval",
  "done",
  "partial",
  "discarded",
] as const;

describe("src/domain/node-write-legality.test", () => {
  it("nodeWriteRefusals deep-equals the two refusals in order", () => {
    assert.deepEqual(nodeWriteRefusals, ["state", "containment"]);
    assert.equal(nodeWriteRefusals.length, 2);
  });

  it("proseFields and structuralFields keep their exact members", () => {
    assert.deepEqual(proseFields, ["body", "title"]);
    assert.deepEqual(structuralFields, [
      "depends_on",
      "parent",
      "repo",
      "worker",
    ]);
    assert.deepEqual(differingFields, [
      "body",
      "depends_on",
      "parent",
      "repo",
      "title",
      "worker",
    ]);
  });

  it("a prose-only edit is legal at all eight states", () => {
    for (const state of nodeStates) {
      for (const field of ["title", "body"] as const) {
        assert.deepEqual(
          verdict({ state, fields: [field], containmentMovable: false }),
          { legal: true },
          `${field} edit at ${state}`,
        );
      }
    }
  });

  it("a structural edit is legal at exactly pending, ready and blocked", () => {
    for (const state of legalStates) {
      assert.deepEqual(
        verdict({
          state,
          fields: ["depends_on"],
          containmentMovable: true,
        }),
        { legal: true },
        `depends_on edit at ${state}`,
      );
    }
    for (const state of illegalStates) {
      assert.deepEqual(
        verdict({
          state,
          fields: ["depends_on"],
          containmentMovable: true,
        }),
        { legal: false, refusal: "state" },
        `depends_on edit at ${state}`,
      );
    }
  });

  it("an immovable containment refuses a parent edit and a repo edit at the three legal states", () => {
    for (const state of legalStates) {
      for (const field of ["parent", "repo"] as const) {
        assert.deepEqual(
          verdict({ state, fields: [field], containmentMovable: false }),
          { legal: false, refusal: "containment" },
          `${field} edit at ${state}`,
        );
      }
    }
  });

  it("an immovable containment does not refuse a depends_on or worker edit", () => {
    for (const state of legalStates) {
      for (const field of ["depends_on", "worker"] as const) {
        assert.deepEqual(
          verdict({ state, fields: [field], containmentMovable: false }),
          { legal: true },
          `${field} edit at ${state}`,
        );
      }
    }
  });

  it("state precedes containment in the refusal order", () => {
    assert.deepEqual(
      verdict({
        state: "running",
        fields: ["parent"],
        containmentMovable: false,
      }),
      { legal: false, refusal: "state" },
    );
  });

  it("an empty field set is legal at all eight states", () => {
    for (const state of nodeStates) {
      assert.deepEqual(
        verdict({ state, fields: [], containmentMovable: false }),
        { legal: true },
        `empty fields at ${state}`,
      );
    }
  });

  it("a mixed prose and structural edit is structural", () => {
    assert.deepEqual(
      verdict({
        state: "running",
        fields: ["title", "parent"],
        containmentMovable: true,
      }),
      { legal: false, refusal: "state" },
    );
  });

  it("plan-choice.ts re-exports the field tuples from node-write-legality.ts", async () => {
    const choiceSource = readFileSync(
      resolve(import.meta.dirname, "./plan-choice.ts"),
      "utf-8",
    );
    assert.ok(
      choiceSource.includes('from "./node-write-legality.ts"'),
      "plan-choice.ts does not import node-write-legality.ts",
    );
    const {
      proseFields: reexportedProse,
      structuralFields: reexportedStructural,
    } = await import("./plan-choice.ts");
    assert.deepEqual(reexportedProse, proseFields);
    assert.deepEqual(reexportedStructural, structuralFields);
  });

  it("the dependency runs one way: node-write-legality.ts imports nothing from plan-choice.ts", () => {
    const source = readFileSync(
      resolve(import.meta.dirname, "./node-write-legality.ts"),
      "utf-8",
    );
    assert.ok(
      !source.includes('from "./plan-choice.ts"') &&
        !source.includes('from "./plan-choice'),
      "node-write-legality.ts imports plan-choice.ts",
    );
  });
});
