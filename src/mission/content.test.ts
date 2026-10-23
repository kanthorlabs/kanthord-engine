import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { MissionBindingKind, MissionErrorCode, Intent } from "./contract.ts";
import {
  bindingKind,
  checkBindingRuleTable,
  resolveNodeBindings,
  validateFilename,
  validateNodeContent,
  validatePlanContent,
  validateTaskCount,
  validateText,
  type ResolvedBinding,
} from "./content.ts";

const DEFAULT_MAX = 32768;
const CONFIGURED_MAX = 8;
const SINGLE_BINDING = 1;
const NO_BINDINGS = 0;
const Field = {
  Name: "name",
  Requirement: "requirement",
  Criterion: "criterion",
  Verifications: "verifications",
  Reason: "reason",
} as const;
const base = () => ({
  name: "Name",
  requirement: "Need",
  criterion: "Check",
  verifications: ["true"],
  bindings: [],
  intent: Intent.Implement,
});

function expectError(
  fn: () => void,
  code: string,
  details: OperationError["details"] = null,
): void {
  assert.throws(fn, (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, HttpStatus.BadRequest);
    assert.equal(error.code, code);
    assert.deepEqual(error.details, details);
    return true;
  });
}

const contentError = (fn: () => void, field: string) =>
  expectError(fn, MissionErrorCode.ContentInvalid, { field });
const bindingsError = (
  fn: () => void,
  details: OperationError["details"] = null,
) => expectError(fn, MissionErrorCode.BindingsInvalid, details);

test("filename accepts only lower-case plan names", () => {
  validateFilename("valid_name-1.md");
  for (const filename of [
    "Upper.md",
    "missing",
    "dir/file.md",
    "dir\\file.md",
  ]) {
    contentError(() => validateFilename(filename), "filename");
  }
});

test("required content text rejects absent, blank, whitespace and nontext", () => {
  for (const field of ["name", "requirement", "criterion"] as const) {
    for (const value of [undefined, "", " \t\n", 123, null, []]) {
      contentError(
        () => validateNodeContent({ ...base(), [field]: value }, DEFAULT_MAX),
        field,
      );
    }
  }
  contentError(() => validateNodeContent(null, DEFAULT_MAX), "name");
  contentError(() => validateNodeContent([], DEFAULT_MAX), "name");
});

test("verifications requires a nonempty list of nonblank strings", () => {
  for (const value of [undefined, []]) {
    expectError(
      () =>
        validateNodeContent({ ...base(), verifications: value }, DEFAULT_MAX),
      MissionErrorCode.VerificationsMissing,
    );
  }
  for (const value of [null, "true", [""], [" \t"], [42], [null]]) {
    contentError(
      () =>
        validateNodeContent({ ...base(), verifications: value }, DEFAULT_MAX),
      "verifications",
    );
  }
});

test("bindings must be a list of text names for every intent", () => {
  for (const intent of Object.values(Intent)) {
    assert.equal(
      validateNodeContent({ ...base(), intent }, DEFAULT_MAX),
      intent,
    );
    for (const value of [undefined, null, "binding", [12], [null]]) {
      bindingsError(() =>
        validateNodeContent(
          { ...base(), intent, bindings: value },
          DEFAULT_MAX,
        ),
      );
    }
  }
});

test("an absent or unknown intent answers mission.node.content_invalid", () => {
  for (const intent of [undefined, "task", "", 1, null])
    contentError(
      () => validateNodeContent({ ...base(), intent }, DEFAULT_MAX),
      "intent",
    );
});

test("tags holds unique tags and reads [] when absent", () => {
  validateNodeContent(base(), DEFAULT_MAX);
  validateNodeContent(
    { ...base(), tags: ["platform.macos", "toolchain.xcode_16"] },
    DEFAULT_MAX,
  );
  for (const tags of [
    "platform.macos",
    null,
    [1],
    ["platform.macOS"],
    ["platform..macos"],
    ["platform.macos", "platform.macos"],
  ])
    contentError(
      () => validateNodeContent({ ...base(), tags }, DEFAULT_MAX),
      "tags",
    );
});

test("commit_type takes one value of the closed set and is optional", () => {
  validateNodeContent(base(), DEFAULT_MAX);
  for (const commit_type of [
    "feat",
    "fix",
    "docs",
    "style",
    "refactor",
    "test",
    "chore",
  ])
    validateNodeContent({ ...base(), commit_type }, DEFAULT_MAX);
  for (const commit_type of ["build", "Feat", "", null, ["feat"], 1])
    contentError(
      () => validateNodeContent({ ...base(), commit_type }, DEFAULT_MAX),
      "commit_type",
    );
});

test("a task body holds the five plan content fields alone", () => {
  const { intent, ...task } = base();
  assert.equal(intent, Intent.Implement);
  validatePlanContent(task, DEFAULT_MAX);
});

test("an examine node with a task answers mission.node.content_invalid", () => {
  validateTaskCount(Intent.Implement, 0);
  validateTaskCount(Intent.Implement, 2);
  validateTaskCount(Intent.Examine, 0);
  contentError(() => validateTaskCount(Intent.Examine, 1), "tasks");
});

test("each Text field uses its configured UTF-8 byte limit", () => {
  for (const max of [DEFAULT_MAX, CONFIGURED_MAX]) {
    for (const field of [
      Field.Name,
      Field.Requirement,
      Field.Criterion,
      Field.Verifications,
      Field.Reason,
    ] as const) {
      const exact = `${"a".repeat(max - 2)}é`;
      const tooLong = `${exact}a`;
      assert.equal(Buffer.byteLength(exact, "utf8"), max);
      assert.equal(Buffer.byteLength(tooLong, "utf8"), max + SINGLE_BINDING);
      if (field === Field.Reason) {
        validateText(field, exact, max);
        contentError(() => validateText(field, tooLong, max), field);
      } else {
        const content = {
          ...base(),
          [field]: field === Field.Verifications ? [exact] : exact,
        };
        validateNodeContent(content, max);
        const invalid = {
          ...base(),
          [field]: field === Field.Verifications ? [tooLong] : tooLong,
        };
        contentError(() => validateNodeContent(invalid, max), field);
      }
    }
  }
});

const resolved = (kind: string, index: number): ResolvedBinding => ({
  binding_id: `binding-${index}`,
  resource_identity: `${kind}:resource-${index}`,
});
const make = (kind: string, count: number) =>
  Array.from({ length: count }, (_, index) => resolved(kind, index));
const TWO_BINDINGS = 2;

const rules = [
  {
    intent: Intent.Implement,
    binding: MissionBindingKind.Repository,
    allowed: [SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [NO_BINDINGS],
  },
  {
    intent: Intent.Implement,
    binding: MissionBindingKind.Worker,
    allowed: [NO_BINDINGS],
    forbidden: [SINGLE_BINDING],
  },
  {
    intent: Intent.Implement,
    binding: MissionBindingKind.Storage,
    allowed: [NO_BINDINGS, SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [],
  },
  {
    intent: Intent.Examine,
    binding: MissionBindingKind.Repository,
    allowed: [NO_BINDINGS, SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [],
  },
  {
    intent: Intent.Examine,
    binding: MissionBindingKind.Worker,
    allowed: [NO_BINDINGS],
    forbidden: [SINGLE_BINDING],
  },
  {
    intent: Intent.Examine,
    binding: MissionBindingKind.Storage,
    allowed: [NO_BINDINGS, SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [],
  },
] as const;

for (const rule of rules) {
  test(`${rule.intent} ${rule.binding} binding count`, () => {
    assert.equal(
      bindingKind(resolved(rule.binding, NO_BINDINGS)),
      rule.binding,
    );
    const requiredRepository =
      rule.intent === Intent.Implement &&
      rule.binding !== MissionBindingKind.Repository
        ? [resolved(MissionBindingKind.Repository, NO_BINDINGS)]
        : [];
    for (const count of rule.allowed)
      checkBindingRuleTable(rule.intent, [
        ...requiredRepository,
        ...make(rule.binding, count),
      ]);
    for (const count of rule.forbidden)
      bindingsError(
        () =>
          checkBindingRuleTable(rule.intent, [
            ...requiredRepository,
            ...make(rule.binding, count),
          ]),
        { intent: rule.intent, binding_kind: rule.binding, count },
      );
  });
}

test("unknown resource kind is rejected", () => {
  bindingsError(() => bindingKind(resolved("other", NO_BINDINGS)));
  bindingsError(() =>
    checkBindingRuleTable(Intent.Examine, [resolved("other", NO_BINDINGS)]),
  );
});

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const tx = {} as Transaction;
const catalog = new Map<string, ResolvedBinding>([
  ["api-repo", resolved(MissionBindingKind.Repository, 1)],
  ["web-repo", resolved(MissionBindingKind.Repository, 2)],
  ["archive", resolved(MissionBindingKind.Storage, 3)],
  ["reports", resolved(MissionBindingKind.Storage, 4)],
]);
const lookups: string[] = [];
const resolve = (_tx: Transaction, projectId: string, named: string) => {
  assert.equal(projectId, PROJECT_ID);
  lookups.push(named);
  return catalog.get(named) ?? null;
};
const resolveNamed = (intent: Intent, named: unknown) =>
  resolveNodeBindings(tx, resolve, PROJECT_ID, intent, named);

test("an implement node that names no repository binding answers mission.node.bindings_invalid", () => {
  bindingsError(() => resolveNamed(Intent.Implement, []), {
    intent: Intent.Implement,
    binding_kind: MissionBindingKind.Repository,
    count: NO_BINDINGS,
  });
  bindingsError(() => resolveNamed(Intent.Implement, ["archive"]), {
    intent: Intent.Implement,
    binding_kind: MissionBindingKind.Repository,
    count: NO_BINDINGS,
  });
});

test("an implement node accepts two repository bindings in binding order", () => {
  for (const named of [
    ["api-repo", "web-repo"],
    ["web-repo", "api-repo"],
  ])
    assert.deepEqual(
      resolveNamed(Intent.Implement, named).map(
        (binding) => binding.binding_id,
      ),
      named.map((name) => catalog.get(name)!.binding_id),
    );
});

test("an examine node accepts zero, one and two repository bindings", () => {
  for (const named of [[], ["api-repo"], ["api-repo", "web-repo"]])
    assert.deepEqual(
      resolveNamed(Intent.Examine, named).map((binding) => binding.binding_id),
      named.map((name) => catalog.get(name)!.binding_id),
    );
});

test("two storage bindings keep their write order", () => {
  for (const named of [
    ["api-repo", "reports", "archive"],
    ["archive", "api-repo", "reports"],
  ])
    assert.deepEqual(
      resolveNamed(Intent.Implement, named).map(
        (binding) => binding.binding_id,
      ),
      named.map((name) => catalog.get(name)!.binding_id),
    );
});

test("a write takes no binding from the project", () => {
  lookups.length = 0;
  assert.deepEqual(resolveNamed(Intent.Examine, []), []);
  assert.deepEqual(lookups, []);
  assert.deepEqual(
    resolveNamed(Intent.Examine, ["archive"]).map(
      (binding) => binding.binding_id,
    ),
    [catalog.get("archive")!.binding_id],
  );
  assert.deepEqual(lookups, ["archive"]);
});

test("a repeated, unresolved or nonlist binding answers mission.node.bindings_invalid", () => {
  bindingsError(() => resolveNamed(Intent.Examine, ["archive", "archive"]));
  bindingsError(() => resolveNamed(Intent.Examine, ["missing"]), {
    binding: "missing",
  });
  bindingsError(() => resolveNamed(Intent.Examine, undefined));
  bindingsError(() => resolveNamed(Intent.Examine, [1]));
});
