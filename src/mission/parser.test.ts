import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { ImportFormat, Intent, MissionErrorCode } from "./contract.ts";
import { normalizeImportSnapshot } from "./import.ts";
import { type ParsedNodeFile, parsePlanFile } from "./parser.ts";

const FILENAME = "add-password-reset.md";
const MISSION_ID = "mission_00000000000000000000000000";
const TEXT_MAX_BYTES = 32768;
const CRITERION =
  "A valid token permits one reset and an expired token permits none.";
const EXAMPLE = `---
id: node_01ARZ3NDEKTSV4RRFFQ69G5FAV
intent: implement
depends_on: []
tags: []
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
const TASK_EXAMPLE = `---
id: task_01ARZ3NDEKTSV4RRFFQ69G5FB0
node: add-password-reset.md
bindings: []
verifications:
  - npm run e2e
  - npm run test:reset
---

# Add the reset request

## Requirement

Accept a reset request for an account and send one reset token.

## Criterion

A valid token permits one reset.
`;
const LINKED_BINDINGS = `bindings:
  - engine
  - acme-issues
external_links:
  - kind: github_issue
    resource_identity: conversation:github:acme/app
    number: 117
`;

function rejectedAs(filename: string, content: string, reason: string): void {
  assert.throws(
    () => parsePlanFile(filename, content),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, MissionErrorCode.PlanInvalid);
      assert.deepEqual(error.details, { filename, reason });
      return true;
    },
  );
}

function rejected(content: string, reason: string): void {
  rejectedAs(FILENAME, content, reason);
}

function rejectedTask(content: string, reason: string): void {
  rejectedAs("add-reset-request.md", content, reason);
}

test("parses the canonical node file and preserves every field", () => {
  assert.deepEqual(parsePlanFile(FILENAME, EXAMPLE), {
    filename: FILENAME,
    id: "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    intent: Intent.Implement,
    tags: [],
    external_links: [],
    depends_on: [],
    bindings: ["api-repo"],
    verifications: ["npm run e2e", "npm run test:reset"],
    name: "Add password reset",
    requirement: "Let account holders reset a forgotten password.",
    criterion: CRITERION,
  });
});

test("parses the canonical task file and preserves every field", () => {
  assert.deepEqual(parsePlanFile("add-reset-request.md", TASK_EXAMPLE), {
    filename: "add-reset-request.md",
    id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB0",
    node: FILENAME,
    bindings: [],
    verifications: ["npm run e2e", "npm run test:reset"],
    name: "Add the reset request",
    requirement:
      "Accept a reset request for an account and send one reset token.",
    criterion: "A valid token permits one reset.",
  });
});

test("a new node file defaults lists and omits identity", () => {
  const result = parsePlanFile(
    FILENAME,
    EXAMPLE.replace(/id:.*\n/, "")
      .replace("intent: implement", "intent: examine")
      .replace(/depends_on: \[\]\n/, "")
      .replace(/tags: \[\]\n/, "")
      .replace(/bindings:\n {2}- api-repo\n/, "")
      .replace(
        /verifications:\n {2}- npm run e2e\n {2}- npm run test:reset\n/,
        "",
      ),
  ) as ParsedNodeFile;
  assert.equal(result.intent, Intent.Examine);
  assert.equal(result.id, undefined);
  assert.deepEqual(
    [result.tags, result.depends_on, result.bindings, result.verifications],
    [[], [], [], []],
  );
});

const LINKED_EXAMPLE = EXAMPLE.replace(
  "bindings:\n  - api-repo\n",
  LINKED_BINDINGS,
);

test("a node file with external links parses and holds the link", () => {
  const result = parsePlanFile(FILENAME, LINKED_EXAMPLE) as ParsedNodeFile;
  assert.deepEqual(result.bindings, ["engine", "acme-issues"]);
  assert.deepEqual(result.external_links, [
    {
      kind: "github_issue",
      resource_identity: "conversation:github:acme/app",
      number: 117,
    },
  ]);
});

for (const [label, links] of [
  ["a link that is no object", "external_links:\n  - 117\n"],
  [
    "a link with an unknown field",
    "external_links:\n  - kind: github_issue\n    resource_identity: conversation:github:acme/app\n    number: 117\n    title: Reset\n",
  ],
  ["a value that is no list", "external_links: 7\n"],
] as const) {
  test(`an import of a node file with ${label} lists mission.node.content_invalid`, () => {
    const result = normalizeImportSnapshot(
      {
        format: ImportFormat.Markdown,
        mission_id: MISSION_ID,
        mission_version: 1,
        reason: "Import plan",
        files: [
          {
            filename: FILENAME,
            content: EXAMPLE.replace("bindings:\n", `${links}bindings:\n`),
          },
        ],
      },
      MISSION_ID,
      TEXT_MAX_BYTES,
    );
    assert.deepEqual(
      result.violations.map(({ code, filename, details }) => ({
        code,
        filename,
        details,
      })),
      [
        {
          code: MissionErrorCode.ContentInvalid,
          filename: FILENAME,
          details: { field: "external_links" },
        },
      ],
    );
  });
}

test("refuses a task file with external_links", () => {
  rejectedTask(
    TASK_EXAMPLE.replace("bindings: []", "external_links: []\nbindings: []"),
    "unknown_key",
  );
});

for (const key of ["name", "requirement", "criterion", "extra", "kind"]) {
  test(`refuses unknown front matter key ${key}`, () => {
    rejected(
      EXAMPLE.replace(
        "intent: implement",
        `${key}: unexpected\nintent: implement`,
      ),
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
    EXAMPLE.replace(/---\n\n#/, "\n#"),
    "front_matter_unterminated",
  ],
  [
    "a file with neither intent nor node",
    EXAMPLE.replace("intent: implement\n", ""),
    "form_invalid",
  ],
  [
    "a file with both intent and node",
    EXAMPLE.replace(
      "intent: implement",
      "intent: implement\nnode: account-recovery.md",
    ),
    "form_invalid",
  ],
  [
    "a node file id with the task prefix",
    EXAMPLE.replace(
      "node_01ARZ3NDEKTSV4RRFFQ69G5FAV",
      "task_01ARZ3NDEKTSV4RRFFQ69G5FAV",
    ),
    "id_prefix_invalid",
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
    EXAMPLE.replace(
      "intent: implement",
      "intent: implement\nintent: implement",
    ),
    "front_matter_invalid",
  ],
  [
    "non-string YAML key",
    EXAMPLE.replace("intent: implement", "7: value\nintent: implement"),
    "unknown_key",
  ],
  [
    "invalid dependency filename",
    EXAMPLE.replace("depends_on: []", "depends_on: [../other.md]"),
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

for (const [label, content, reason] of [
  [
    "a task file with depends_on",
    TASK_EXAMPLE.replace("bindings: []", "depends_on: []\nbindings: []"),
    "depends_on_forbidden",
  ],
  [
    "a task file with tags",
    TASK_EXAMPLE.replace("bindings: []", "tags: []\nbindings: []"),
    "tags_forbidden",
  ],
  [
    "a task file with intent",
    TASK_EXAMPLE.replace("bindings: []", "intent: implement\nbindings: []"),
    "form_invalid",
  ],
  [
    "a task file id with the node prefix",
    TASK_EXAMPLE.replace(
      "task_01ARZ3NDEKTSV4RRFFQ69G5FB0",
      "node_01ARZ3NDEKTSV4RRFFQ69G5FB0",
    ),
    "id_prefix_invalid",
  ],
  [
    "an invalid node filename",
    TASK_EXAMPLE.replace("node: add-password-reset.md", "node: ../other.md"),
    "field_invalid",
  ],
] as const) {
  test(`refuses ${label}`, () => rejectedTask(content, reason));
}
