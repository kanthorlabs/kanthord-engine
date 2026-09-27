import assert from "node:assert/strict";
import { test } from "node:test";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { MissionBindingKind, MissionErrorCode, NodeKind } from "./contract.ts";
import {
  bindingKind,
  checkBindingRuleTable,
  validateFilename,
  validateNodeContent,
  validateText,
  type ResolvedBinding,
} from "./content.ts";

const DEFAULT_MAX = 32768;
const CONFIGURED_MAX = 8;
const ONE = 1;
const ZERO = 0;
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
        () =>
          validateNodeContent(
            NodeKind.Task,
            { ...base(), [field]: value },
            DEFAULT_MAX,
          ),
        field,
      );
    }
  }
  contentError(
    () => validateNodeContent(NodeKind.Task, null, DEFAULT_MAX),
    "name",
  );
  contentError(
    () => validateNodeContent(NodeKind.Task, [], DEFAULT_MAX),
    "name",
  );
});

test("verifications requires a nonempty list of nonblank strings", () => {
  for (const value of [undefined, []]) {
    expectError(
      () =>
        validateNodeContent(
          NodeKind.Task,
          { ...base(), verifications: value },
          DEFAULT_MAX,
        ),
      MissionErrorCode.VerificationsMissing,
    );
  }
  for (const value of [null, "true", [""], [" \t"], [42], [null]]) {
    contentError(
      () =>
        validateNodeContent(
          NodeKind.Task,
          { ...base(), verifications: value },
          DEFAULT_MAX,
        ),
      "verifications",
    );
  }
});

test("bindings must be a list of text names for every node kind", () => {
  for (const kind of Object.values(NodeKind)) {
    validateNodeContent(kind, base(), DEFAULT_MAX);
    for (const value of [undefined, null, "binding", [12], [null]]) {
      bindingsError(() =>
        validateNodeContent(kind, { ...base(), bindings: value }, DEFAULT_MAX),
      );
    }
  }
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
      assert.equal(Buffer.byteLength(tooLong, "utf8"), max + ONE);
      if (field === Field.Reason) {
        validateText(field, exact, max);
        contentError(() => validateText(field, tooLong, max), field);
      } else {
        const content = {
          ...base(),
          [field]: field === Field.Verifications ? [exact] : exact,
        };
        validateNodeContent(NodeKind.Objective, content, max);
        const invalid = {
          ...base(),
          [field]: field === Field.Verifications ? [tooLong] : tooLong,
        };
        contentError(
          () => validateNodeContent(NodeKind.Objective, invalid, max),
          field,
        );
      }
    }
  }
});

const resolved = (kind: string, index: number): ResolvedBinding => ({
  bindingId: `binding-${index}`,
  resourceIdentity: `${kind}:resource-${index}`,
});

const rules = [
  {
    kind: NodeKind.Initiative,
    binding: MissionBindingKind.Repository,
    allowed: [ZERO],
    forbidden: ONE,
  },
  {
    kind: NodeKind.Initiative,
    binding: MissionBindingKind.Worker,
    allowed: [ZERO],
    forbidden: ONE,
  },
  {
    kind: NodeKind.Initiative,
    binding: MissionBindingKind.Storage,
    allowed: [ZERO, ONE],
    forbidden: 2,
  },
  {
    kind: NodeKind.Objective,
    binding: MissionBindingKind.Repository,
    allowed: [ONE],
    forbidden: ZERO,
    extraForbidden: 2,
  },
  {
    kind: NodeKind.Objective,
    binding: MissionBindingKind.Worker,
    allowed: [ZERO],
    forbidden: ONE,
  },
  {
    kind: NodeKind.Objective,
    binding: MissionBindingKind.Storage,
    allowed: [ZERO, ONE],
    forbidden: 2,
  },
  {
    kind: NodeKind.Task,
    binding: MissionBindingKind.Repository,
    allowed: [ZERO],
    forbidden: ONE,
  },
  {
    kind: NodeKind.Task,
    binding: MissionBindingKind.Worker,
    allowed: [ZERO],
    forbidden: ONE,
  },
  {
    kind: NodeKind.Task,
    binding: MissionBindingKind.Storage,
    allowed: [ZERO],
    forbidden: ONE,
  },
] as const;

for (const rule of rules) {
  test(`${rule.kind} ${rule.binding} binding count`, () => {
    assert.equal(bindingKind(resolved(rule.binding, ZERO)), rule.binding);
    const make = (count: number) =>
      Array.from({ length: count }, (_, index) =>
        resolved(rule.binding, index),
      );
    const requiredRepository =
      rule.kind === NodeKind.Objective &&
      rule.binding !== MissionBindingKind.Repository
        ? [resolved(MissionBindingKind.Repository, ZERO)]
        : [];
    for (const count of rule.allowed) {
      checkBindingRuleTable(rule.kind, [...requiredRepository, ...make(count)]);
    }
    for (const count of [
      rule.forbidden,
      ...("extraForbidden" in rule ? [rule.extraForbidden] : []),
    ]) {
      bindingsError(
        () =>
          checkBindingRuleTable(rule.kind, [
            ...requiredRepository,
            ...make(count),
          ]),
        { kind: rule.kind, bindingKind: rule.binding, count },
      );
    }
  });
}

test("unknown resource kind is rejected", () => {
  bindingsError(() => bindingKind(resolved("other", ZERO)));
  bindingsError(() =>
    checkBindingRuleTable(NodeKind.Task, [resolved("other", ZERO)]),
  );
});
