import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  MissionBindingKind,
  MissionErrorCode,
  Intent,
  planFileNameSchema,
  tagsSchema,
  intentSchema,
  commitTypeSchema,
  type Content,
} from "./contract.ts";

export const ContentField = {
  Filename: "filename",
  Name: "name",
  Requirement: "requirement",
  Criterion: "criterion",
  Verifications: "verifications",
  Bindings: "bindings",
  Intent: "intent",
  Tags: "tags",
  CommitType: "commit_type",
} as const;
export const CONTENT_FIELDS = Object.values(ContentField);
export const TASK_CONTENT_FIELDS = [
  ContentField.Filename,
  ContentField.Name,
  ContentField.Requirement,
  ContentField.Criterion,
  ContentField.Verifications,
  ContentField.Bindings,
];
export const TASKS_FIELD = "tasks";
const Field = ContentField;
const UTF8 = "utf8";
const RESOURCE_KIND_SEPARATOR = ":";
const NO_BINDINGS = 0;
const NO_TASKS = 0;
const EMPTY_LENGTH = 0;
const LOOP_START = 0;
const RESOURCE_KIND_SEGMENT = 0;
const INITIAL_BINDING_COUNT = 0;
const SINGLE_BINDING = 1;
const UNBOUNDED_BINDINGS = Number.POSITIVE_INFINITY;
const LOOP_STEP = 1;
const BINDING_COUNT_STEP = 1;
const SPLIT_FIRST_PART_LIMIT = 1;
type BindingKind = (typeof MissionBindingKind)[keyof typeof MissionBindingKind];
type Range = { min: number; max: number };

const bindingRules: Record<Intent, Record<BindingKind, Range>> = {
  [Intent.Implement]: {
    [MissionBindingKind.Repository]: {
      min: SINGLE_BINDING,
      max: UNBOUNDED_BINDINGS,
    },
    [MissionBindingKind.Worker]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Storage]: {
      min: NO_BINDINGS,
      max: UNBOUNDED_BINDINGS,
    },
  },
  [Intent.Examine]: {
    [MissionBindingKind.Repository]: {
      min: NO_BINDINGS,
      max: UNBOUNDED_BINDINGS,
    },
    [MissionBindingKind.Worker]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Storage]: {
      min: NO_BINDINGS,
      max: UNBOUNDED_BINDINGS,
    },
  },
};

function invalidContent(field: string): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.ContentInvalid,
    `Invalid node content: ${field}.`,
    { field },
  );
}

function nonblankText(field: string, value: unknown): string {
  if (!isString(value) || value.trim().length === EMPTY_LENGTH)
    invalidContent(field);
  return value;
}

export function validateFilename(filename: string): void {
  if (!planFileNameSchema.safeParse(filename).success)
    invalidContent(Field.Filename);
}

export function validateText(
  field: string,
  value: string,
  textMaxBytes: number,
): void {
  nonblankText(field, value);
  if (Buffer.byteLength(value, UTF8) > textMaxBytes) invalidContent(field);
}

export function validateTaskCount(intent: Intent, taskCount: number): void {
  if (intent === Intent.Examine && taskCount > NO_TASKS)
    invalidContent(TASKS_FIELD);
}

function recordOf(content: unknown): Record<string, unknown> {
  return isObject(content) && !Array.isArray(content)
    ? (content as Record<string, unknown>)
    : {};
}

export function validateNodeContent(
  content: unknown,
  textMaxBytes: number,
): Intent {
  validatePlanContent(content, textMaxBytes);
  const input = recordOf(content);
  const intent = input[Field.Intent];
  if (!intentSchema.safeParse(intent).success) invalidContent(Field.Intent);
  const tags = input[Field.Tags];
  if (tags !== undefined && !tagsSchema.safeParse(tags).success)
    invalidContent(Field.Tags);
  const commitType = input[Field.CommitType];
  if (
    commitType !== undefined &&
    !commitTypeSchema.safeParse(commitType).success
  )
    invalidContent(Field.CommitType);
  return intent as Intent;
}

export function commitTypeField(
  commitType: unknown,
): Pick<Content, "commit_type"> {
  return commitType === undefined || commitType === null
    ? {}
    : { commit_type: commitType as Content["commit_type"] };
}

export function validatePlanContent(
  content: unknown,
  textMaxBytes: number,
): void {
  const input = recordOf(content);
  for (const field of [Field.Name, Field.Requirement, Field.Criterion]) {
    const value = nonblankText(field, input[field]);
    validateText(field, value, textMaxBytes);
  }
  const verifications = input[Field.Verifications];
  if (
    verifications === undefined ||
    (Array.isArray(verifications) && verifications.length === EMPTY_LENGTH)
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.VerificationsMissing,
      "Node verifications are required.",
    );
  if (!Array.isArray(verifications)) invalidContent(Field.Verifications);
  for (
    let index = LOOP_START, count = verifications.length;
    index < count;
    index += LOOP_STEP
  ) {
    const value = nonblankText(Field.Verifications, verifications[index]);
    validateText(Field.Verifications, value, textMaxBytes);
  }
  const bindings = input[Field.Bindings];
  if (!Array.isArray(bindings)) invalidBindings();
  for (
    let index = LOOP_START, count = bindings.length;
    index < count;
    index += LOOP_STEP
  ) {
    if (!isString(bindings[index])) invalidBindings();
  }
}

export type ResolvedBinding = { binding_id: string; resource_identity: string };

function invalidBindings(
  details: Record<string, string | number> | null = null,
): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.BindingsInvalid,
    "Invalid node bindings.",
    details,
  );
}

export function bindingKind(resolved: ResolvedBinding): BindingKind {
  const prefix = resolved.resource_identity.split(
    RESOURCE_KIND_SEPARATOR,
    SPLIT_FIRST_PART_LIMIT,
  )[RESOURCE_KIND_SEGMENT];
  if (!Object.values(MissionBindingKind).some((value) => value === prefix))
    invalidBindings();
  return prefix as BindingKind;
}

export type BindingResolver = (
  tx: Transaction,
  projectId: string,
  named: string,
) => ResolvedBinding | null;

export function resolveNodeBindings(
  tx: Transaction,
  resolve: BindingResolver,
  projectId: string,
  intent: Intent,
  named: unknown,
): ResolvedBinding[] {
  if (!Array.isArray(named)) invalidBindings();
  const resolved = named.map((value: unknown) => {
    if (!isString(value)) invalidBindings();
    const binding = resolve(tx, projectId, value);
    if (binding === null) invalidBindings({ binding: value });
    return binding;
  });
  const ids = resolved.map((binding) => binding.binding_id);
  if (new Set(ids).size !== ids.length) invalidBindings();
  checkBindingRuleTable(intent, resolved);
  return resolved;
}

export function checkBindingRuleTable(
  intent: Intent,
  resolved: ResolvedBinding[],
): void {
  const counts: Record<BindingKind, number> = {
    [MissionBindingKind.Repository]: INITIAL_BINDING_COUNT,
    [MissionBindingKind.Worker]: INITIAL_BINDING_COUNT,
    [MissionBindingKind.Storage]: INITIAL_BINDING_COUNT,
  };
  for (
    let index = LOOP_START, count = resolved.length;
    index < count;
    index += LOOP_STEP
  ) {
    const binding = resolved[index];
    if (!binding) invalidBindings();
    counts[bindingKind(binding)] += BINDING_COUNT_STEP;
  }
  for (const binding of Object.values(MissionBindingKind)) {
    const count = counts[binding];
    const range = bindingRules[intent][binding];
    if (count < range.min || count > range.max)
      invalidBindings({ intent, binding_kind: binding, count });
  }
}
