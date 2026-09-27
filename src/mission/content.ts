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
const ZERO = 0;
const ONE = 1;
type BindingKind = (typeof MissionBindingKind)[keyof typeof MissionBindingKind];
type Range = { min: number; max: number };

const bindingRules: Record<NodeKind, Record<BindingKind, Range>> = {
  [NodeKind.Initiative]: {
    [MissionBindingKind.Repository]: { min: ZERO, max: ZERO },
    [MissionBindingKind.Worker]: { min: ZERO, max: ZERO },
    [MissionBindingKind.Storage]: { min: ZERO, max: ONE },
  },
  [NodeKind.Objective]: {
    [MissionBindingKind.Repository]: { min: ONE, max: ONE },
    [MissionBindingKind.Worker]: { min: ZERO, max: ZERO },
    [MissionBindingKind.Storage]: { min: ZERO, max: ONE },
  },
  [NodeKind.Task]: {
    [MissionBindingKind.Repository]: { min: ZERO, max: ZERO },
    [MissionBindingKind.Worker]: { min: ZERO, max: ZERO },
    [MissionBindingKind.Storage]: { min: ZERO, max: ZERO },
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
  if (!isString(value) || value.trim().length === ZERO) invalidContent(field);
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
    (Array.isArray(verifications) && verifications.length === ZERO)
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      MissionErrorCode.VerificationsMissing,
      "Node verifications are required.",
    );
  if (!Array.isArray(verifications)) invalidContent(Field.Verifications);
  for (
    let index = ZERO, count = verifications.length;
    index < count;
    index += ONE
  ) {
    const value = nonblankText(Field.Verifications, verifications[index]);
    validateText(Field.Verifications, value, textMaxBytes);
  }
  const bindings = input[Field.Bindings];
  if (!Array.isArray(bindings)) invalidBindings();
  for (let index = ZERO, count = bindings.length; index < count; index += ONE) {
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
  const prefix = resolved.resourceIdentity.split(RESOURCE_KIND_SEPARATOR, ONE)[
    ZERO
  ];
  if (!Object.values(MissionBindingKind).some((value) => value === prefix))
    invalidBindings();
  return prefix as BindingKind;
}

export function checkBindingRuleTable(
  kind: NodeKind,
  resolved: ResolvedBinding[],
): void {
  const counts: Record<BindingKind, number> = {
    [MissionBindingKind.Repository]: ZERO,
    [MissionBindingKind.Worker]: ZERO,
    [MissionBindingKind.Storage]: ZERO,
  };
  for (let index = ZERO, count = resolved.length; index < count; index += ONE) {
    const binding = resolved[index];
    if (!binding) invalidBindings();
    counts[bindingKind(binding)] += ONE;
  }
  for (const binding of Object.values(MissionBindingKind)) {
    const count = counts[binding];
    const range = bindingRules[kind][binding];
    if (count < range.min || count > range.max)
      invalidBindings({ kind, bindingKind: binding, count });
  }
}
