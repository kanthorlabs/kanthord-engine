import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BodySplitError, normalizeBody, splitBody } from "./plan-body.ts";

const splitCases: readonly (readonly [
  input: string,
  instruction: string,
  acceptance: string | null,
])[] = [
  [
    "intro\n## Acceptance criteria\n- one\n",
    "intro\n",
    "## Acceptance criteria\n- one\n",
  ],
  ["## Acceptance criteria\n- one\n", "", "## Acceptance criteria\n- one\n"],
  ["intro\nmore\n", "intro\nmore\n", null],
  ["  ## Acceptance criteria\n", "  ## Acceptance criteria\n", null],
  ["## Acceptance criteria extra\n", "## Acceptance criteria extra\n", null],
  ["## acceptance criteria\n", "## acceptance criteria\n", null],
  ["intro\n## Acceptance criteria", "intro\n", "## Acceptance criteria"],
];

describe("src/domain/plan-body.test", () => {
  it("normalizeBody converts CRLF and lone CR to LF and appends exactly one LF", () => {
    assert.equal(normalizeBody("a\r\nb"), "a\nb\n");
    assert.equal(normalizeBody("a\rb"), "a\nb\n");
    assert.equal(normalizeBody("a\n\n\n"), "a\n");
    assert.equal(normalizeBody(""), "\n");
    assert.equal(normalizeBody("a"), "a\n");
  });

  it("normalizeBody preserves trailing spaces on a line", () => {
    assert.equal(normalizeBody("a  \nb\n"), "a  \nb\n");
  });

  it("normalizeBody is idempotent", () => {
    for (const input of ["a\r\nb", "a\rb", "a\n\n\n", "", "a", "a  \nb\n"]) {
      assert.equal(normalizeBody(normalizeBody(input)), normalizeBody(input));
    }
  });

  it("splitBody splits at the first acceptance heading", () => {
    const split = splitBody("intro\n## Acceptance criteria\n- one\n");
    assert.equal(split.instruction, "intro\n");
    assert.equal(split.acceptance, "## Acceptance criteria\n- one\n");
  });

  it("the concatenation identity holds for every case", () => {
    for (const [input, instruction, acceptance] of splitCases) {
      assert.equal(
        instruction + (acceptance ?? ""),
        input,
        `identity failed for ${JSON.stringify(input)}`,
      );
    }
  });

  it("a body with no heading returns null acceptance and the input as instruction", () => {
    for (const [input, instruction, acceptance] of splitCases) {
      if (acceptance !== null) continue;
      const split = splitBody(input);
      assert.equal(split.acceptance, null);
      assert.equal(split.instruction, instruction);
      assert.equal(split.instruction, input);
    }
  });

  it("a heading as the very first line returns an empty instruction", () => {
    const split = splitBody("## Acceptance criteria\n- one\n");
    assert.equal(split.instruction, "");
    assert.equal(split.acceptance, "## Acceptance criteria\n- one\n");
  });

  it("a heading with no trailing newline keeps the concatenation identity", () => {
    const split = splitBody("intro\n## Acceptance criteria");
    assert.equal(split.instruction, "intro\n");
    assert.equal(split.acceptance, "## Acceptance criteria");
  });

  it("a second heading throws acceptance-heading-duplicated", () => {
    assert.throws(
      () =>
        splitBody(
          "intro\n## Acceptance criteria\nmore\n## Acceptance criteria\n",
        ),
      (err) =>
        err instanceof BodySplitError &&
        err.code === "acceptance-heading-duplicated",
    );
  });

  it("a heading followed by trailing spaces throws acceptance-heading-not-at-line-start", () => {
    assert.throws(
      () => splitBody("## Acceptance criteria  \n"),
      (err) =>
        err instanceof BodySplitError &&
        err.code === "acceptance-heading-not-at-line-start",
    );
  });
});
