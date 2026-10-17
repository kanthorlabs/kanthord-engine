import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { MissionBindingKind, MissionErrorCode, Work } from "./contract.ts";
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
  work: Work.Implement,
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

test("bindings must be a list of text names for every work", () => {
  for (const work of Object.values(Work)) {
    assert.equal(validateNodeContent({ ...base(), work }, DEFAULT_MAX), work);
    for (const value of [undefined, null, "binding", [12], [null]]) {
      bindingsError(() =>
        validateNodeContent({ ...base(), work, bindings: value }, DEFAULT_MAX),
      );
    }
  }
});

test("an absent or unknown work answers mission.node.content_invalid", () => {
  for (const work of [undefined, "task", "", 1, null])
    contentError(
      () => validateNodeContent({ ...base(), work }, DEFAULT_MAX),
      "work",
    );
});

test("requires holds unique trait keys and reads [] when absent", () => {
  validateNodeContent(base(), DEFAULT_MAX);
  validateNodeContent(
    { ...base(), requires: ["platform.macos", "toolchain.xcode_16"] },
    DEFAULT_MAX,
  );
  for (const requires of [
    "platform.macos",
    null,
    [1],
    ["platform.macOS"],
    ["platform..macos"],
    ["platform.macos", "platform.macos"],
  ])
    contentError(
      () => validateNodeContent({ ...base(), requires }, DEFAULT_MAX),
      "requires",
    );
});

test("a task body holds the five plan content fields alone", () => {
  const { work, ...task } = base();
  assert.equal(work, Work.Implement);
  validatePlanContent(task, DEFAULT_MAX);
});

test("an examine node with a task answers mission.node.content_invalid", () => {
  validateTaskCount(Work.Implement, 0);
  validateTaskCount(Work.Implement, 2);
  validateTaskCount(Work.Examine, 0);
  contentError(() => validateTaskCount(Work.Examine, 1), "tasks");
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
    work: Work.Implement,
    binding: MissionBindingKind.Repository,
    allowed: [SINGLE_BINDING],
    forbidden: [NO_BINDINGS, TWO_BINDINGS],
  },
  {
    work: Work.Implement,
    binding: MissionBindingKind.Worker,
    allowed: [NO_BINDINGS],
    forbidden: [SINGLE_BINDING],
  },
  {
    work: Work.Implement,
    binding: MissionBindingKind.Storage,
    allowed: [NO_BINDINGS, SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [],
  },
  {
    work: Work.Examine,
    binding: MissionBindingKind.Repository,
    allowed: [NO_BINDINGS, SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [],
  },
  {
    work: Work.Examine,
    binding: MissionBindingKind.Worker,
    allowed: [NO_BINDINGS],
    forbidden: [SINGLE_BINDING],
  },
  {
    work: Work.Examine,
    binding: MissionBindingKind.Storage,
    allowed: [NO_BINDINGS, SINGLE_BINDING, TWO_BINDINGS],
    forbidden: [],
  },
] as const;

for (const rule of rules) {
  test(`${rule.work} ${rule.binding} binding count`, () => {
    assert.equal(
      bindingKind(resolved(rule.binding, NO_BINDINGS)),
      rule.binding,
    );
    const requiredRepository =
      rule.work === Work.Implement &&
      rule.binding !== MissionBindingKind.Repository
        ? [resolved(MissionBindingKind.Repository, NO_BINDINGS)]
        : [];
    for (const count of rule.allowed)
      checkBindingRuleTable(rule.work, [
        ...requiredRepository,
        ...make(rule.binding, count),
      ]);
    for (const count of rule.forbidden)
      bindingsError(
        () =>
          checkBindingRuleTable(rule.work, [
            ...requiredRepository,
            ...make(rule.binding, count),
          ]),
        { work: rule.work, binding_kind: rule.binding, count },
      );
  });
}

test("unknown resource kind is rejected", () => {
  bindingsError(() => bindingKind(resolved("other", NO_BINDINGS)));
  bindingsError(() =>
    checkBindingRuleTable(Work.Examine, [resolved("other", NO_BINDINGS)]),
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
const resolveNamed = (work: Work, named: unknown) =>
  resolveNodeBindings(tx, resolve, PROJECT_ID, work, named);

test("an implement node that names no repository binding answers mission.node.bindings_invalid", () => {
  bindingsError(() => resolveNamed(Work.Implement, []), {
    work: Work.Implement,
    binding_kind: MissionBindingKind.Repository,
    count: NO_BINDINGS,
  });
  bindingsError(() => resolveNamed(Work.Implement, ["archive"]), {
    work: Work.Implement,
    binding_kind: MissionBindingKind.Repository,
    count: NO_BINDINGS,
  });
});

test("an implement node with two repository bindings answers mission.node.bindings_invalid", () => {
  bindingsError(() => resolveNamed(Work.Implement, ["api-repo", "web-repo"]), {
    work: Work.Implement,
    binding_kind: MissionBindingKind.Repository,
    count: TWO_BINDINGS,
  });
});

test("an examine node accepts zero, one and two repository bindings", () => {
  for (const named of [[], ["api-repo"], ["api-repo", "web-repo"]])
    assert.deepEqual(
      resolveNamed(Work.Examine, named).map((binding) => binding.binding_id),
      named.map((name) => catalog.get(name)!.binding_id),
    );
});

test("two storage bindings keep their write order", () => {
  for (const named of [
    ["api-repo", "reports", "archive"],
    ["archive", "api-repo", "reports"],
  ])
    assert.deepEqual(
      resolveNamed(Work.Implement, named).map((binding) => binding.binding_id),
      named.map((name) => catalog.get(name)!.binding_id),
    );
});

test("a write takes no binding from the project", () => {
  lookups.length = 0;
  assert.deepEqual(resolveNamed(Work.Examine, []), []);
  assert.deepEqual(lookups, []);
  assert.deepEqual(
    resolveNamed(Work.Examine, ["archive"]).map(
      (binding) => binding.binding_id,
    ),
    [catalog.get("archive")!.binding_id],
  );
  assert.deepEqual(lookups, ["archive"]);
});

test("a repeated, unresolved or nonlist binding answers mission.node.bindings_invalid", () => {
  bindingsError(() => resolveNamed(Work.Examine, ["archive", "archive"]));
  bindingsError(() => resolveNamed(Work.Examine, ["missing"]), {
    binding: "missing",
  });
  bindingsError(() => resolveNamed(Work.Examine, undefined));
  bindingsError(() => resolveNamed(Work.Examine, [1]));
});
