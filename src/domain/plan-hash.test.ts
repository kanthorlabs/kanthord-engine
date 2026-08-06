import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { canonicalChoicesJson, canonicalDocumentsJson } from "./plan-hash.ts";
import type { Choice } from "./plan-choice.ts";
import type { RenderedDocument } from "./plan-render.ts";

type ChoiceEntry = Readonly<{ id: string; take: Choice }>;

const documents: readonly RenderedDocument[] = [
  { path: "plan/a.md", content: "one" },
  { path: "plan/b.md", content: "two" },
  { path: "plan/c.md", content: "three" },
];

const choices: readonly ChoiceEntry[] = [
  { id: "task_b", take: "database" },
  { id: "task_a", take: "submitted" },
];

describe("src/domain/plan-hash.test", () => {
  it("canonicalDocumentsJson ignores the submission order", () => {
    assert.equal(
      canonicalDocumentsJson([...documents].reverse()),
      canonicalDocumentsJson(documents),
    );
  });

  it("canonicalDocumentsJson emits path before content regardless of the input key order", () => {
    const result = canonicalDocumentsJson([
      { content: "one", path: "plan/a.md" },
    ]);
    assert.equal(result, '[{"path":"plan/a.md","content":"one"}]');
  });

  it("canonicalDocumentsJson changes when one content byte differs", () => {
    assert.notEqual(
      canonicalDocumentsJson([{ path: "plan/a.md", content: "one" }]),
      canonicalDocumentsJson([{ path: "plan/a.md", content: "onf" }]),
    );
  });

  it("canonicalChoicesJson sorts by id and is stable across two calls", () => {
    const sorted = canonicalChoicesJson(choices);
    assert.equal(canonicalChoicesJson([...choices].reverse()), sorted);
    assert.equal(canonicalChoicesJson(choices), sorted);
  });

  it("canonicalChoicesJson emits id before take regardless of the input key order", () => {
    assert.equal(
      canonicalChoicesJson([
        { take: "database", id: "task_b" },
        { take: "submitted", id: "task_a" },
      ]),
      '[{"id":"task_a","take":"submitted"},{"id":"task_b","take":"database"}]',
    );
  });

  it("canonicalChoicesJson carries neither revision field", () => {
    const json = canonicalChoicesJson([{ id: "task_a", take: "submitted" }]);
    assert.equal(json.includes("fromRevision"), false);
    assert.equal(json.includes("validatedRevision"), false);
  });

  it("canonicalChoicesJson changes when one take differs", () => {
    assert.notEqual(
      canonicalChoicesJson([
        { id: "task_a", take: "submitted" },
        { id: "task_b", take: "database" },
      ]),
      canonicalChoicesJson([
        { id: "task_a", take: "submitted" },
        { id: "task_b", take: "submitted" },
      ]),
    );
  });

  it("both functions leave their inputs untouched", () => {
    const documentsBefore = JSON.stringify(documents);
    canonicalDocumentsJson(documents);
    assert.equal(JSON.stringify(documents), documentsBefore);

    const choicesBefore = JSON.stringify(choices);
    canonicalChoicesJson(choices);
    assert.equal(JSON.stringify(choices), choicesBefore);
  });
});
