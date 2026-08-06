import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { assertChoiceSet, ChoiceSetError } from "./plan-choice-set.ts";

type Take = "submitted" | "database";

function choice(
  id: string,
  take: Take = "submitted",
): Readonly<{ id: string; take: Take }> {
  return { id, take };
}

function thrown(work: () => ReadonlyMap<string, Take>): {
  code: string;
  ids: readonly string[];
} {
  let caught: unknown;
  try {
    work();
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof ChoiceSetError,
    `expected ChoiceSetError, got ${caught}`,
  );
  return { code: caught.code, ids: caught.ids };
}

describe("src/domain/plan-choice-set.test", () => {
  it("a complete set returns a map of the right size and the right take per id", () => {
    const map = assertChoiceSet({
      choices: [choice("b"), choice("a", "database")],
      required: ["a", "b"],
    });
    assert.equal(map.size, 2);
    assert.equal(map.get("a"), "database");
    assert.equal(map.get("b"), "submitted");
  });

  it("one missing id throws choice-missing with ids holding that id", () => {
    const failure = thrown(() =>
      assertChoiceSet({
        choices: [choice("a")],
        required: ["a", "b"],
      }),
    );
    assert.equal(failure.code, "choice-missing");
    assert.deepEqual(failure.ids, ["b"]);
  });

  it("two missing ids throw with both ids bytewise ascending", () => {
    const failure = thrown(() =>
      assertChoiceSet({
        choices: [choice("a")],
        required: ["b", "B", "a"],
      }),
    );
    assert.equal(failure.code, "choice-missing");
    assert.deepEqual(failure.ids, ["B", "b"]);
  });

  it("one extra id throws choice-extra with ids holding that id", () => {
    const failure = thrown(() =>
      assertChoiceSet({
        choices: [choice("a"), choice("x")],
        required: ["a"],
      }),
    );
    assert.equal(failure.code, "choice-extra");
    assert.deepEqual(failure.ids, ["x"]);
  });

  it("one duplicate id throws choice-duplicate with ids holding that id", () => {
    const failure = thrown(() =>
      assertChoiceSet({
        choices: [choice("a"), choice("a", "database")],
        required: ["a"],
      }),
    );
    assert.equal(failure.code, "choice-duplicate");
    assert.deepEqual(failure.ids, ["a"]);
  });

  it("the check order is pinned: duplicate first, then missing, then extra", () => {
    const duplicate = thrown(() =>
      assertChoiceSet({
        choices: [choice("a"), choice("a"), choice("x")],
        required: ["a", "b"],
      }),
    );
    assert.equal(duplicate.code, "choice-duplicate");
    assert.deepEqual(duplicate.ids, ["a"]);

    const missing = thrown(() =>
      assertChoiceSet({
        choices: [choice("a"), choice("x")],
        required: ["a", "b"],
      }),
    );
    assert.equal(missing.code, "choice-missing");
    assert.deepEqual(missing.ids, ["b"]);

    const extra = thrown(() =>
      assertChoiceSet({
        choices: [choice("a"), choice("x")],
        required: ["a"],
      }),
    );
    assert.equal(extra.code, "choice-extra");
    assert.deepEqual(extra.ids, ["x"]);
  });

  it("an empty required with an empty choices returns an empty map", () => {
    const map = assertChoiceSet({ choices: [], required: [] });
    assert.equal(map.size, 0);
  });

  it("an empty required with one choice throws choice-extra", () => {
    const failure = thrown(() =>
      assertChoiceSet({
        choices: [choice("a")],
        required: [],
      }),
    );
    assert.equal(failure.code, "choice-extra");
    assert.deepEqual(failure.ids, ["a"]);
  });
});
