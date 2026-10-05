import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { isObject, isString } from "../kernel/values.ts";
import {
  MissionBindingKind,
  MissionErrorCode,
  NodeKind,
  planFileNameSchema,
} from "./contract.ts";

export const ContentField = {
  Filename: "filename",
  Name: "name",
  Requirement: "requirement",
  Criterion: "criterion",
  Verifications: "verifications",
  Bindings: "bindings",
} as const;
export const CONTENT_FIELDS = Object.values(ContentField);
export const TASKS_FIELD = "tasks";
const Field = ContentField;
const UTF8 = "utf8";
const RESOURCE_KIND_SEPARATOR = ":";
const NO_BINDINGS = 0;
const EMPTY_LENGTH = 0;
const LOOP_START = 0;
const RESOURCE_KIND_SEGMENT = 0;
const INITIAL_BINDING_COUNT = 0;
const SINGLE_BINDING = 1;
const LOOP_STEP = 1;
const BINDING_COUNT_STEP = 1;
const SPLIT_FIRST_PART_LIMIT = 1;
type BindingKind = (typeof MissionBindingKind)[keyof typeof MissionBindingKind];
type Range = { min: number; max: number };

const bindingRules: Record<NodeKind, Record<BindingKind, Range>> = {
  [NodeKind.Initiative]: {
    [MissionBindingKind.Repository]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Worker]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Storage]: { min: NO_BINDINGS, max: SINGLE_BINDING },
  },
  [NodeKind.Objective]: {
    [MissionBindingKind.Repository]: {
      min: SINGLE_BINDING,
      max: SINGLE_BINDING,
    },
    [MissionBindingKind.Worker]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Storage]: { min: NO_BINDINGS, max: SINGLE_BINDING },
  },
  [NodeKind.Task]: {
    [MissionBindingKind.Repository]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Worker]: { min: NO_BINDINGS, max: NO_BINDINGS },
    [MissionBindingKind.Storage]: { min: NO_BINDINGS, max: NO_BINDINGS },
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

export function validateNodeContent(
  kind: NodeKind,
  content: unknown,
  textMaxBytes: number,
): void {
  void kind;
  const input =
    isObject(content) && !Array.isArray(content)
      ? (content as Record<string, unknown>)
      : {};
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

export type ResolvedBinding = { bindingId: string; resourceIdentity: string };

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
  const prefix = resolved.resourceIdentity.split(
    RESOURCE_KIND_SEPARATOR,
    SPLIT_FIRST_PART_LIMIT,
  )[RESOURCE_KIND_SEGMENT];
  if (!Object.values(MissionBindingKind).some((value) => value === prefix))
    invalidBindings();
  return prefix as BindingKind;
}

export function checkBindingRuleTable(
  kind: NodeKind,
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
    const range = bindingRules[kind][binding];
    if (count < range.min || count > range.max)
      invalidBindings({ kind, bindingKind: binding, count });
  }
}
