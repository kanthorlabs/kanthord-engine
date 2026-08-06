import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { choiceVerdict } from "./plan-choice.ts";
import type { Choice, ChoiceFacts, ChoiceVerdict } from "./plan-choice.ts";
import { nodeStates } from "./state.ts";
import type { NodeState } from "./state.ts";

function verdict(facts: ChoiceFacts): ChoiceVerdict {
  return choiceVerdict(facts);
}

describe("src/domain/plan-choice.test", () => {
  it("no difference suggests database as equivalent", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "pending",
        fields: [],
        containmentMovable: false,
      }),
      {
        suggested: "database",
        submitted: { legal: true, reason: "equivalent" },
        database: { legal: true, reason: null },
      },
    );
  });

  it("a document-only node suggests submitted", () => {
    assert.deepEqual(
      verdict({
        presence: "document-only",
        state: null,
        fields: [],
        containmentMovable: false,
      }),
      {
        suggested: "submitted",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: "do not create it" },
      },
    );
  });

  it("a database-only node suggests database and refuses submitted", () => {
    assert.deepEqual(
      verdict({
        presence: "database-only",
        state: "pending",
        fields: [],
        containmentMovable: false,
      }),
      {
        suggested: "database",
        submitted: { legal: false, reason: "a deletion is node.discard" },
        database: { legal: true, reason: null },
      },
    );
  });

  it("pending accepts any change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "pending",
        fields: ["depends_on"],
        containmentMovable: false,
      }),
      {
        suggested: "submitted",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: null },
      },
    );
  });

  it("blocked accepts any change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "blocked",
        fields: ["worker"],
        containmentMovable: false,
      }),
      {
        suggested: "submitted",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: null },
      },
    );
  });

  it("ready accepts a prose change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "ready",
        fields: ["title"],
        containmentMovable: false,
      }),
      {
        suggested: "submitted",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: null },
      },
    );
  });

  it("ready refuses a structural change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "ready",
        fields: ["parent"],
        containmentMovable: true,
      }),
      {
        suggested: "database",
        submitted: {
          legal: false,
          reason: "a structural edit needs pending or blocked",
        },
        database: { legal: true, reason: null },
      },
    );
  });

  it("running accepts a prose change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "running",
        fields: ["body"],
        containmentMovable: false,
      }),
      {
        suggested: "database",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: null },
      },
    );
  });

  it("running refuses a structural change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "running",
        fields: ["parent"],
        containmentMovable: true,
      }),
      {
        suggested: "database",
        submitted: {
          legal: false,
          reason: "a structural edit needs pending or blocked",
        },
        database: { legal: true, reason: null },
      },
    );
  });

  it("done accepts a prose change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "done",
        fields: ["title"],
        containmentMovable: false,
      }),
      {
        suggested: "database",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: null },
      },
    );
  });

  it("done refuses a structural change", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "done",
        fields: ["worker"],
        containmentMovable: false,
      }),
      {
        suggested: "database",
        submitted: {
          legal: false,
          reason: "a structural edit needs pending or blocked",
        },
        database: { legal: true, reason: null },
      },
    );
  });

  it("each of the eight states is exercised for a prose and a structural change", () => {
    const prose: Readonly<
      Record<NodeState, { suggested: Choice; legal: boolean }>
    > = {
      pending: { suggested: "submitted", legal: true },
      blocked: { suggested: "submitted", legal: true },
      ready: { suggested: "submitted", legal: true },
      running: { suggested: "database", legal: true },
      awaiting_approval: { suggested: "database", legal: true },
      done: { suggested: "database", legal: true },
      partial: { suggested: "database", legal: true },
      discarded: { suggested: "database", legal: true },
    };
    const structural: Readonly<
      Record<NodeState, { suggested: Choice; legal: boolean }>
    > = {
      pending: { suggested: "submitted", legal: true },
      blocked: { suggested: "submitted", legal: true },
      ready: { suggested: "database", legal: false },
      running: { suggested: "database", legal: false },
      awaiting_approval: { suggested: "database", legal: false },
      done: { suggested: "database", legal: false },
      partial: { suggested: "database", legal: false },
      discarded: { suggested: "database", legal: false },
    };
    for (const state of nodeStates) {
      const proseVerdict = verdict({
        presence: "both",
        state,
        fields: ["title"],
        containmentMovable: true,
      });
      assert.equal(
        proseVerdict.suggested,
        prose[state].suggested,
        `prose suggested at ${state}`,
      );
      assert.equal(
        proseVerdict.submitted.legal,
        prose[state].legal,
        `prose legality at ${state}`,
      );
      const structuralVerdict = verdict({
        presence: "both",
        state,
        fields: ["worker"],
        containmentMovable: true,
      });
      assert.equal(
        structuralVerdict.suggested,
        structural[state].suggested,
        `structural suggested at ${state}`,
      );
      assert.equal(
        structuralVerdict.submitted.legal,
        structural[state].legal,
        `structural legality at ${state}`,
      );
    }
  });

  it("pending and blocked refuse a parent or repo move while a node or descendant is contained", () => {
    for (const state of ["pending", "blocked"] as const) {
      assert.deepEqual(
        verdict({
          presence: "both",
          state,
          fields: ["parent"],
          containmentMovable: false,
        }),
        {
          suggested: "database",
          submitted: {
            legal: false,
            reason:
              "the node or a descendant holds a lease, a workspace or a commit",
          },
          database: { legal: true, reason: null },
        },
        `parent move at ${state}`,
      );
      assert.deepEqual(
        verdict({
          presence: "both",
          state,
          fields: ["repo"],
          containmentMovable: false,
        }).submitted,
        {
          legal: false,
          reason:
            "the node or a descendant holds a lease, a workspace or a commit",
        },
        `repo move at ${state}`,
      );
      assert.deepEqual(
        verdict({
          presence: "both",
          state,
          fields: ["parent"],
          containmentMovable: true,
        }).submitted,
        { legal: true, reason: null },
        `free parent move at ${state}`,
      );
    }
  });

  it("a depends_on change is legal even when the node is contained", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "pending",
        fields: ["depends_on"],
        containmentMovable: false,
      }).submitted,
      { legal: true, reason: null },
    );
  });

  it("a node carrying both a prose and an illegal structural change falls whole to database", () => {
    const facts: ChoiceFacts = {
      presence: "both",
      state: "running",
      fields: ["body", "parent"],
      containmentMovable: true,
    };
    const result = verdict(facts);
    assert.equal(result.suggested, "database");
    assert.equal(result.submitted.legal, false);
    assert.deepEqual(facts.fields, ["body", "parent"]);
  });

  it("database is legal in every case of the case table", () => {
    const cases: readonly ChoiceFacts[] = [
      {
        presence: "database-only",
        state: "pending",
        fields: [],
        containmentMovable: false,
      },
      {
        presence: "document-only",
        state: null,
        fields: [],
        containmentMovable: false,
      },
      {
        presence: "both",
        state: "pending",
        fields: [],
        containmentMovable: false,
      },
      {
        presence: "both",
        state: "blocked",
        fields: ["body"],
        containmentMovable: false,
      },
      {
        presence: "both",
        state: "ready",
        fields: ["title"],
        containmentMovable: false,
      },
      {
        presence: "both",
        state: "running",
        fields: ["parent"],
        containmentMovable: true,
      },
      {
        presence: "both",
        state: "done",
        fields: ["worker"],
        containmentMovable: true,
      },
      {
        presence: "both",
        state: "discarded",
        fields: ["repo"],
        containmentMovable: true,
      },
      {
        presence: "both",
        state: "partial",
        fields: ["depends_on", "body"],
        containmentMovable: false,
      },
      {
        presence: "both",
        state: "awaiting_approval",
        fields: ["title", "parent"],
        containmentMovable: false,
      },
    ];
    for (const facts of cases) {
      assert.equal(verdict(facts).database.legal, true, JSON.stringify(facts));
    }
  });

  it("the verdict is invariant under field order and duplicates", () => {
    const clean = verdict({
      presence: "both",
      state: "pending",
      fields: ["parent", "title"],
      containmentMovable: true,
    });
    const messy = verdict({
      presence: "both",
      state: "pending",
      fields: ["parent", "title", "parent"],
      containmentMovable: true,
    });
    assert.deepEqual(messy, clean);

    const prose = verdict({
      presence: "both",
      state: "ready",
      fields: ["title", "title"],
      containmentMovable: false,
    });
    assert.equal(prose.suggested, "submitted");
    assert.equal(prose.submitted.legal, true);
  });

  it("a discarded node accepts a prose change but keeps the database suggestion", () => {
    assert.deepEqual(
      verdict({
        presence: "both",
        state: "discarded",
        fields: ["title"],
        containmentMovable: false,
      }),
      {
        suggested: "database",
        submitted: { legal: true, reason: null },
        database: { legal: true, reason: null },
      },
    );
  });
});
