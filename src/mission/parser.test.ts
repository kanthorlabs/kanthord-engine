import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { MissionErrorCode, Work } from "./contract.ts";
import { parsePlanFile, type ParsedNodeFile } from "./parser.ts";

const FILENAME = "add-password-reset.md";
const FOUNDATION_NAME = "Establish the Express API foundation";
const FOUNDATION_RUNTIME_NAME = "Provide a reproducible Node 24 runtime";
const TODO_API_NAME = "Deliver a secure, maintainable TODO REST API";
const FOUNDATION_FILENAME = "foundation.md";
const UNKNOWN_WORK = "task";
const CRITERION =
  "A valid token permits one reset and an expired token permits none.";
const EXAMPLE = `---
id: node_01ARZ3NDEKTSV4RRFFQ69G5FAV
work: implement
depends_on: []
requires: []
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
const FOUNDATION = `---
work: implement
depends_on: []
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run test:foundation
  - npm run lint && npm run format:check
---

# Establish the Express API foundation

## Requirement

Create a JavaScript ESM application on Node.js 24.x using Express 5.x. Separate the side-effect-free app factory from the process entrypoint. Organize \`src/config\`, \`src/http\` and \`src/db\`. Create a directory only when it holds code, and add no \`.gitkeep\` placeholder. Later nodes create \`src/modules/auth\`, \`src/modules/todos\` and \`src/modules/admin\` with their code. Routes delegate to services and services to repositories. Inject database, clock and logger dependencies rather than relying on mutable global state.

Use npm with a committed lockfile, ESLint, Prettier, Node's test runner and Supertest. Provide \`test:foundation\`, \`lint\` and \`format:check\` scripts, with substantive tests in the three task-named files. Later nodes add their suites. Do not pre-create passing placeholder suites.

Establish HTTP conventions now: JSON responses, snake_case property names shared by domain objects and HTTP payloads, and errors shaped \`{ error: { code, message, request_id, details } }\`. \`details\` is a safe list, empty when not applicable. The error middleware is last; no error response leaks stack traces or SQL. Expose public \`GET /health/live\` with 200 and \`{ status: "ok" }\`.

## Criterion

- A clean Node 24 checkout installs with \`npm ci\`; other Node major versions fail the documented runtime check.
- Importing the app factory neither opens a listener nor creates a database. The entrypoint alone owns process startup.
- Configuration validates \`NODE_ENV\`, \`HOST\`, \`PORT\`, \`DATABASE_PATH\`, \`CORS_ORIGINS\`, \`TRUST_PROXY\`, \`LOG_LEVEL\` and \`SESSION_TTL_SECONDS\` at startup. Defaults include port 3000, no trusted proxy, no cross-origin access and session TTL 86400 seconds. Unsafe or invalid production configuration fails startup.
- \`express.json\` accepts only JSON object request bodies where a route expects JSON, with a 32 KiB limit. Malformed JSON returns 400, oversized bodies 413, and unsupported request media types 415 on JSON write routes.
- Unknown routes return JSON 404; asynchronous route failures reach the central error handler. Application errors distinguish safe client messages from internal diagnostics.
- Tests, lint and formatting are real checks with nonzero failure status. Source, configuration examples and tests contain no credentials.
`;
const FOUNDATION_RUNTIME = `---
node: foundation.md
bindings: []
verifications:
  - node --test test/foundation-runtime.test.js
  - npm ci && npm run test:foundation
  - npm run lint && npm run format:check
---

# Provide a reproducible Node 24 runtime

## Requirement

Keep an ESM package on Node.js 24.x with Express 5.x, a Node 24 version declaration, a committed npm lockfile, a documented runtime guard and a side-effect-free Express app factory. The process entrypoint alone owns process startup. Provide development and start commands.

Use ESLint, Prettier, Node's test runner and Supertest. Provide the \`lint\`, \`format:check\` and \`test:foundation\` scripts. Put substantive tests in the three foundation task-named test files. Do not pre-create passing placeholder suites for later nodes.

Organize \`src/config\`, \`src/http\` and \`src/db\`. Create a directory only when it holds code, and add no \`.gitkeep\` placeholder. Later nodes create \`src/modules/auth\`, \`src/modules/todos\` and \`src/modules/admin\` with their code. Routes delegate to services and services to repositories. Inject database, clock and logger dependencies rather than relying on mutable global state. Keep source modules small.

## Criterion

- A clean Node 24 checkout installs with \`npm ci\`; other Node major versions fail the documented runtime check.
- Tests prove constructing and importing the app factory does not listen on a port and does not open or create a database. The entrypoint alone owns process startup.
- The runtime check accepts major 24 and rejects another major using a testable version input.
- The source tree contains \`src/config\`, \`src/http\` and \`src/db\`, each with code. It contains no empty directory and no \`.gitkeep\` file.
- The app factory receives database, clock and logger as injected dependencies, not mutable global state.
- The package lock matches the manifest. Tests, lint and formatting are real checks that return nonzero status on failure. A clean install and static checks succeed without disabling lint rules to hide defects.
- Later nodes add their own suites; no placeholder suite passes without real assertions.
- Source, configuration examples and tests contain no credentials.
- \`test/foundation-runtime.test.js\` contains behavioral assertions and closes every resource it opens.
`;
const TODO_API = `---
work: examine
depends_on:
  - foundation.md
  - persistence.md
  - authentication.md
  - todos.md
  - operations.md
  - acceptance.md
  - contributing.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run verify
---

# Deliver a secure, maintainable TODO REST API

## Requirement

Deliver a Node.js 24 and SQLite TODO API using Express 5 and ecosystem middleware. Account holders authenticate, manage only their own TODOs and receive predictable JSON errors. Operators can diagnose failures without exposing secrets and can run the service from a clean checkout.

This examine node integrates the outcomes of its direct dependencies and does not repeat their implementation. Check out the base-branch head of its \`todoapp-repo\` binding. Judge the final repository snapshot and the current outcome of each direct dependency; publish an addressed integration report as produced evidence.

## Criterion

- Every direct dependency is \`Completed\` with a successful current outcome. A discarded dependency satisfies nothing, so this examine node stays \`Pending\` until a human removes that dependency.
- A clean Node 24 checkout installs from its lockfile and passes every node suite, the integrated end-to-end suite, lint and formatting through \`npm run verify\`.
- Two users can register, log in and persist private TODOs across a process restart. Neither user can read or mutate the other's TODOs. Logout and expiry revoke access.
- Public health and authentication routes work without a token; private and admin-only routes enforce their documented policies. Invalid inputs, unavailable storage and unexpected exceptions produce safe, correlated errors.
- OpenAPI and the runbook match the running API. Production secrets and user content never enter logs. SQLite's single-host, single-writer limits are explicit.
- The integration report identifies the tested commit, verification results and the outcome of each direct dependency. A passing command alone does not replace review of test adequacy or security behavior.
`;

function rejectedAs(filename: string, content: string, reason: string): void {
  assert.throws(
    () => parsePlanFile(filename, content),
    (error: unknown) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, MissionErrorCode.PlanInvalid);
      assert.deepEqual(error.details, { filename, reason });
      assert.ok(error.message.includes(filename));
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
    work: Work.Implement,
    requires: [],
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

test("parses the todoapp implement node foundation.md", () => {
  const result = parsePlanFile("foundation.md", FOUNDATION) as ParsedNodeFile;
  assert.equal(result.id, undefined);
  assert.equal(result.work, Work.Implement);
  assert.deepEqual(result.requires, []);
  assert.deepEqual(result.depends_on, []);
  assert.deepEqual(result.bindings, ["todoapp-repo"]);
  assert.deepEqual(result.verifications, [
    "npm ci && npm run test:foundation",
    "npm run lint && npm run format:check",
  ]);
  assert.equal(result.name, FOUNDATION_NAME);
  assert.match(result.requirement, /^Create a JavaScript ESM application/);
  assert.match(result.criterion, /contain no credentials\.$/);
});

test("parses the todoapp task foundation-runtime.md", () => {
  const result = parsePlanFile("foundation-runtime.md", FOUNDATION_RUNTIME);
  assert.ok("node" in result);
  assert.equal(result.node, FOUNDATION_FILENAME);
  assert.equal(result.id, undefined);
  assert.deepEqual(result.bindings, []);
  assert.deepEqual(result.verifications, [
    "node --test test/foundation-runtime.test.js",
    "npm ci && npm run test:foundation",
    "npm run lint && npm run format:check",
  ]);
  assert.equal(result.name, FOUNDATION_RUNTIME_NAME);
  assert.equal("work" in result, false);
  assert.equal("depends_on" in result, false);
  assert.equal("requires" in result, false);
});

test("parses the todoapp examine node todo-api.md", () => {
  const result = parsePlanFile("todo-api.md", TODO_API) as ParsedNodeFile;
  assert.equal(result.work, Work.Examine);
  assert.deepEqual(result.requires, []);
  assert.deepEqual(result.depends_on, [
    "foundation.md",
    "persistence.md",
    "authentication.md",
    "todos.md",
    "operations.md",
    "acceptance.md",
    "contributing.md",
  ]);
  assert.deepEqual(result.bindings, ["todoapp-repo"]);
  assert.deepEqual(result.verifications, ["npm ci && npm run verify"]);
  assert.equal(result.name, TODO_API_NAME);
});

test("a new node file defaults lists and omits identity", () => {
  const result = parsePlanFile(
    FILENAME,
    EXAMPLE.replace(/id:.*\n/, "")
      .replace("work: implement", "work: examine")
      .replace(/depends_on: \[\]\n/, "")
      .replace(/requires: \[\]\n/, "")
      .replace(/bindings:\n  - api-repo\n/, "")
      .replace(/verifications:\n  - npm run e2e\n  - npm run test:reset\n/, ""),
  ) as ParsedNodeFile;
  assert.equal(result.work, Work.Examine);
  assert.equal(result.id, undefined);
  assert.deepEqual(
    [result.requires, result.depends_on, result.bindings, result.verifications],
    [[], [], [], []],
  );
});

test("a node file keeps its requires list in order", () => {
  const result = parsePlanFile(
    FILENAME,
    EXAMPLE.replace(
      "requires: []",
      "requires:\n  - toolchain.xcode_16\n  - platform.macos",
    ),
  ) as ParsedNodeFile;
  assert.deepEqual(result.requires, ["toolchain.xcode_16", "platform.macos"]);
});

test("the parser passes an unknown work value to the content rules", () => {
  const result = parsePlanFile(
    FILENAME,
    EXAMPLE.replace("work: implement", `work: ${UNKNOWN_WORK}`),
  ) as ParsedNodeFile;
  assert.equal(result.work, UNKNOWN_WORK);
});

test("the parser passes a nontext work and a nonlist or nontext requires as read", () => {
  for (const [from, to, field, value] of [
    ["work: implement", "work: [implement]", "work", ["implement"]],
    ["requires: []", "requires: platform.macos", "requires", "platform.macos"],
    ["requires: []", "requires: [7]", "requires", [7]],
  ] as const) {
    const result = parsePlanFile(
      FILENAME,
      EXAMPLE.replace(from, to),
    ) as ParsedNodeFile;
    assert.deepEqual(result[field], value);
  }
});

for (const key of ["name", "requirement", "criterion", "extra", "kind"]) {
  test(`refuses unknown front matter key ${key}`, () => {
    rejected(
      EXAMPLE.replace("work: implement", `${key}: unexpected\nwork: implement`),
      "unknown_key",
    );
  });
}

for (const key of ["extra", "kind"]) {
  test(`refuses unknown task file key ${key}`, () => {
    rejectedTask(
      TASK_EXAMPLE.replace("bindings: []", `${key}: task\nbindings: []`),
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
    "a file with neither work nor node",
    EXAMPLE.replace("work: implement\n", ""),
    "form_invalid",
  ],
  [
    "a file with both work and node",
    EXAMPLE.replace(
      "work: implement",
      "work: implement\nnode: account-recovery.md",
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
    EXAMPLE.replace("work: implement", "work: implement\nwork: implement"),
    "front_matter_invalid",
  ],
  [
    "non-string YAML key",
    EXAMPLE.replace("work: implement", "7: value\nwork: implement"),
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
    "a task file with requires",
    TASK_EXAMPLE.replace("bindings: []", "requires: []\nbindings: []"),
    "requires_forbidden",
  ],
  [
    "a task file with work",
    TASK_EXAMPLE.replace("bindings: []", "work: implement\nbindings: []"),
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
