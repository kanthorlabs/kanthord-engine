import assert from "node:assert/strict";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { temporary } from "../../../kernel/test-support.ts";
import { parsePlanFile } from "../../../mission/parser.ts";
import { CouncilErrorCode, type CouncilRecord, type Plan } from "./contract.ts";
import {
  RECORD_FILENAME,
  renderPlanFiles,
  renderRecord,
  requireEmptyOutput,
  writeOutput,
} from "./output.ts";

const INITIATIVE = {
  filename: "login.md",
  kind: "initiative" as const,
  depends_on: [],
  bindings: [] as [],
  verifications: ["pnpm test"],
  name: "Login",
  requirement: "A user signs in.",
  criterion: "A signed-in user sees the home page.",
};
const TASK = {
  filename: "login-form.md",
  kind: "task" as const,
  parent: "login-objective.md",
  bindings: [] as [],
  verifications: ["grep -q 'a: b' src/login.tsx"],
  name: "Login form",
  requirement: "\n  The form takes an email and a password.\n\n",
  criterion: "The form submits.",
};
const OBJECTIVE = {
  filename: "login-objective.md",
  kind: "objective" as const,
  parent: "login.md",
  depends_on: [],
  bindings: [] as [],
  verifications: ["pnpm test"],
  name: "Email login",
  requirement: "A user signs in with an email.",
  criterion: "The login test passes.",
};
const TRIMMED_REQUIREMENT = "The form takes an email and a password.";
const PLAN: Plan = {
  entries: [INITIATIVE, OBJECTIVE, TASK],
  reasons: { "login.md": "Every role asks for it." },
};

test("renderPlanFiles writes files that the Mission parser reads back", () => {
  const files = renderPlanFiles(PLAN);
  assert.deepEqual(
    files.map((file) => file.filename),
    ["login.md", "login-objective.md", "login-form.md"],
  );
  const task = parsePlanFile("login-form.md", files[2]!.content);
  assert.equal(task.requirement, TRIMMED_REQUIREMENT);
  assert.deepEqual(task.verifications, ["grep -q 'a: b' src/login.tsx"]);
  assert.equal(task.id, undefined);
});

test("renderPlanFiles refuses a repeated filename", () => {
  assert.throws(
    () => renderPlanFiles({ ...PLAN, entries: [INITIATIVE, INITIATIVE] }),
    {
      code: CouncilErrorCode.PlanFileInvalid,
    },
  );
});

test("renderPlanFiles refuses a parent outside the set", () => {
  assert.throws(
    () => renderPlanFiles({ ...PLAN, entries: [INITIATIVE, TASK] }),
    {
      code: CouncilErrorCode.PlanFileInvalid,
    },
  );
});

test("renderPlanFiles refuses a task with depends_on", () => {
  const entries = [
    INITIATIVE,
    OBJECTIVE,
    { ...TASK, depends_on: ["login.md"] },
  ];
  assert.throws(() => renderPlanFiles({ ...PLAN, entries }), {
    code: CouncilErrorCode.PlanFileInvalid,
  });
});

test("renderPlanFiles refuses a filename the Mission Service does not accept", () => {
  assert.throws(
    () =>
      renderPlanFiles({
        ...PLAN,
        entries: [{ ...INITIATIVE, filename: "Login.md" }],
      }),
    {
      code: CouncilErrorCode.PlanFileInvalid,
    },
  );
});

test("requireEmptyOutput accepts an absent or empty directory", (t) => {
  const root = temporary(t);
  requireEmptyOutput(join(root, "absent"));
  mkdirSync(join(root, "empty"));
  requireEmptyOutput(join(root, "empty"));
});

test("requireEmptyOutput refuses a directory with a file and a regular file", (t) => {
  const root = temporary(t);
  mkdirSync(join(root, "full"));
  writeFileSync(join(root, "full", "x.md"), "x");
  writeFileSync(join(root, "file"), "x");
  for (const path of [join(root, "full"), join(root, "file")])
    assert.throws(() => requireEmptyOutput(path), {
      code: CouncilErrorCode.OutputDirectoryNotEmpty,
    });
});

test("writeOutput writes the plan files and the record", (t) => {
  const dir = join(temporary(t), "out");
  const record: CouncilRecord = {
    idea: "Add login",
    triage: { complexity: "S", reasons: ["One flow."] },
    rounds: [
      {
        questions: ["Who signs in?"],
        answers: {
          "po@1": {
            answers: [
              {
                question: "Who signs in?",
                answer: "Customers.",
                confidence: "high",
                assumptions: [],
              },
            ],
          },
        },
      },
    ],
    synthesis: {
      agreements: ["Email login."],
      conflicts: [],
      direction: "Ship email login.",
    },
    plan: PLAN,
  };
  writeOutput(dir, renderPlanFiles(PLAN), renderRecord(record));
  assert.deepEqual(readdirSync(dir).sort(), [
    RECORD_FILENAME,
    "login-form.md",
    "login-objective.md",
    "login.md",
  ]);
  const text = readFileSync(join(dir, RECORD_FILENAME), "utf8");
  for (const part of [
    "Add login",
    "Complexity S",
    "Who signs in?",
    "Customers.",
    "Ship email login.",
    "Every role asks for it.",
  ])
    assert.ok(text.includes(part), part);
});
