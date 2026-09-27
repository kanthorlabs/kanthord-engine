import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { MissionErrorCode, NodeKind } from "./contract.ts";
import { parsePlanFile } from "./parser.ts";

const FILENAME = "add-password-reset.md";
const CRITERION =
  "A valid token permits one reset and an expired token permits none.";
const EXAMPLE = `---
id: node_01ARZ3NDEKTSV4RRFFQ69G5FAV
kind: objective
parent: account-recovery.md
dependsOn: []
bindings:
  - api-repo
verifications:
  - npm run e2e
  - npm run test:reset
---
# Add password reset

## Requirement

Let account holders reset a forgotten password.

## Criterion

A valid token permits one reset and an expired token permits none.
`;

function rejected(content: string, reason: string): void {
  assert.throws(
    () => parsePlanFile(FILENAME, content),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, MissionErrorCode.PlanInvalid);
      assert.deepEqual(error.details, { filename: FILENAME, reason });
      assert.match(error.message, /add-password-reset\.md/);
      return true;
    },
  );
}

test("parses the canonical plan file and preserves every field", () => {
  assert.deepEqual(parsePlanFile(FILENAME, EXAMPLE), {
    filename: FILENAME,
    id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    kind: NodeKind.Objective,
    parent: "account-recovery.md",
    dependsOn: [],
    bindings: ["api-repo"],
    verifications: ["npm run e2e", "npm run test:reset"],
    name: "Add password reset",
    requirement: "Let account holders reset a forgotten password.",
    criterion: CRITERION,
  });
});

test("new initiative defaults lists and omits identity and parent", () => {
  const result = parsePlanFile(
    FILENAME,
    EXAMPLE.replace(/id:.*\n/, "")
      .replace(
        "kind: objective\nparent: account-recovery.md\n",
        "kind: initiative\n",
      )
      .replace(/dependsOn: \[\]\n/, "")
      .replace(/bindings:\n  - api-repo\n/, "")
      .replace(/verifications:\n  - npm run e2e\n  - npm run test:reset\n/, ""),
  );
  assert.equal(result.kind, NodeKind.Initiative);
  assert.equal(result.id, undefined);
  assert.equal(result.parent, undefined);
  assert.deepEqual(
    [result.dependsOn, result.bindings, result.verifications],
    [[], [], []],
  );
});

for (const key of ["name", "requirement", "criterion", "extra"]) {
  test(`refuses unknown front matter key ${key}`, () => {
    rejected(
      EXAMPLE.replace("kind: objective", `${key}: unexpected\nkind: objective`),
      "unknown_key",
    );
  });
}

for (const [label, content, reason] of [
  [
    "unknown section",
    EXAMPLE.replace("## Criterion", "## Other\n\ntext\n\n## Criterion"),
    "unknown_section",
  ],
  [
    "missing H1",
    EXAMPLE.replace("# Add password reset\n", ""),
    "heading_missing",
  ],
  [
    "repeated H1",
    EXAMPLE.replace("# Add password reset", "# Add password reset\n# Again"),
    "heading_repeated",
  ],
  [
    "missing Requirement",
    EXAMPLE.replace(
      /## Requirement\n\nLet account holders reset a forgotten password.\n\n/,
      "",
    ),
    "section_missing",
  ],
  [
    "repeated Requirement",
    EXAMPLE.replace("## Criterion", "## Requirement\n\nagain\n\n## Criterion"),
    "section_repeated",
  ],
  [
    "missing Criterion",
    EXAMPLE.replace(/## Criterion[\s\S]*/, ""),
    "section_missing",
  ],
  ["repeated Criterion", `${EXAMPLE}\n## Criterion\nagain`, "section_repeated"],
  [
    "missing opening delimiter",
    EXAMPLE.replace(/^---\n/, ""),
    "front_matter_missing",
  ],
  [
    "missing closing delimiter",
    EXAMPLE.replace(/---\n#/, "#"),
    "front_matter_unterminated",
  ],
  [
    "objective without parent",
    EXAMPLE.replace("parent: account-recovery.md\n", ""),
    "parent_required",
  ],
  [
    "task without parent",
    EXAMPLE.replace(
      "kind: objective\nparent: account-recovery.md\n",
      "kind: task\n",
    ),
    "parent_required",
  ],
  [
    "initiative with parent",
    EXAMPLE.replace("kind: objective", "kind: initiative"),
    "parent_forbidden",
  ],
  [
    "task with dependsOn",
    EXAMPLE.replace("kind: objective", "kind: task"),
    "depends_on_forbidden",
  ],
  [
    "invalid kind",
    EXAMPLE.replace("kind: objective", "kind: project"),
    "kind_invalid",
  ],
  [
    "text before H1",
    EXAMPLE.replace("# Add password reset", "unexpected\n# Add password reset"),
    "body_invalid",
  ],
  [
    "text before sections",
    EXAMPLE.replace("## Requirement", "unexpected\n## Requirement"),
    "body_invalid",
  ],
  [
    "duplicate YAML key",
    EXAMPLE.replace("kind: objective", "kind: objective\nkind: objective"),
    "front_matter_invalid",
  ],
  [
    "non-string YAML key",
    EXAMPLE.replace("kind: objective", "7: value\nkind: objective"),
    "unknown_key",
  ],
  [
    "invalid parent filename",
    EXAMPLE.replace("account-recovery.md", "../other.md"),
    "field_invalid",
  ],
  [
    "invalid dependency filename",
    EXAMPLE.replace("dependsOn: []", "dependsOn: [../other.md]"),
    "field_invalid",
  ],
  [
    "invalid id",
    EXAMPLE.replace("node_01ARZ3NDEKTSV4RRFFQ69G5FAV", "node_invalid"),
    "field_invalid",
  ],
  [
    "invalid bindings list",
    EXAMPLE.replace("  - api-repo", "  - 7"),
    "field_invalid",
  ],
  [
    "invalid verifications list",
    EXAMPLE.replace("  - npm run e2e", "  - 7"),
    "field_invalid",
  ],
] as const) {
  test(`refuses ${label}`, () => rejected(content, reason));
}

test("headings inside fenced code blocks remain section text", () => {
  const result = parsePlanFile(
    FILENAME,
    EXAMPLE.replace(
      "Let account holders reset a forgotten password.",
      "Let account holders reset a forgotten password.\n\n```markdown\n## Other\n# Other\n```",
    ),
  );
  assert.match(result.requirement, /## Other\n# Other/);
  assert.equal(result.criterion, CRITERION);
});
