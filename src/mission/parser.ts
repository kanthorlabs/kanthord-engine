import { isMap, isScalar, parseDocument } from "yaml";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  MissionErrorCode,
  NodeKind,
  nodeKindSchema,
  planFileNameSchema,
  type NodeKind as NodeKindType,
} from "./contract.ts";

const DELIMITER = "---";
const BLANK_BODY_LINE = "";
const STRING_TYPE = "string";
const OBJECT_TYPE = "object";
const NO_PARSE_ISSUES = 0;
const FIRST_LINE_INDEX = 0;
const DELIMITER_NOT_FOUND = 0;
const LINE_STEP = 1;
const HEADING_CAPTURE_GROUP = 1;
const AFTER_OPENING_DELIMITER = 1;
const AFTER_CLOSING_DELIMITER_OFFSET = 1;
const NODE_PREFIX = "node";
const ALIAS_LIMIT = 100;
const FIELD = {
  Id: "id",
  Kind: "kind",
  Parent: "parent",
  DependsOn: "dependsOn",
  Bindings: "bindings",
  Verifications: "verifications",
} as const;
const SECTION = { Requirement: "Requirement", Criterion: "Criterion" } as const;
const REASON = {
  FrontMatterMissing: "front_matter_missing",
  FrontMatterUnterminated: "front_matter_unterminated",
  FrontMatterInvalid: "front_matter_invalid",
  UnknownKey: "unknown_key",
  FieldInvalid: "field_invalid",
  KindInvalid: "kind_invalid",
  ParentRequired: "parent_required",
  ParentForbidden: "parent_forbidden",
  DependsOnForbidden: "depends_on_forbidden",
  HeadingMissing: "heading_missing",
  HeadingRepeated: "heading_repeated",
  SectionMissing: "section_missing",
  SectionRepeated: "section_repeated",
  UnknownSection: "unknown_section",
  BodyInvalid: "body_invalid",
} as const;

export interface ParsedPlanFile {
  filename: string;
  id?: string;
  kind: NodeKindType;
  parent?: string;
  dependsOn: string[];
  bindings: string[];
  verifications: string[];
  name: string;
  requirement: string;
  criterion: string;
}

function refuse(filename: string, reason: string): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    MissionErrorCode.PlanInvalid,
    `Plan file ${filename}: ${reason}.`,
    { filename, reason },
  );
}

function frontMatter(
  filename: string,
  source: string,
): Record<string, unknown> {
  const document = parseDocument(source, {
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
  });
  if (
    document.errors.length > NO_PARSE_ISSUES ||
    document.warnings.length > NO_PARSE_ISSUES
  )
    refuse(filename, REASON.FrontMatterInvalid);
  if (!isMap(document.contents)) refuse(filename, REASON.FrontMatterInvalid);
  for (const pair of document.contents.items) {
    if (!isScalar(pair.key) || typeof pair.key.value !== STRING_TYPE)
      refuse(filename, REASON.FrontMatterInvalid);
  }
  let value: unknown;
  try {
    value = document.toJS({ maxAliasCount: ALIAS_LIMIT });
  } catch {
    refuse(filename, REASON.FrontMatterInvalid);
  }
  if (value === null || typeof value !== OBJECT_TYPE || Array.isArray(value))
    refuse(filename, REASON.FrontMatterInvalid);
  const mapping = value as Record<string, unknown>;
  const permitted = Object.values(FIELD) as string[];
  for (const key of Object.keys(mapping)) {
    if (!permitted.includes(key)) refuse(filename, REASON.UnknownKey);
  }
  return mapping;
}

function stringList(
  filename: string,
  value: unknown,
  names: boolean,
): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) refuse(filename, REASON.FieldInvalid);
  for (const item of value) {
    if (
      typeof item !== STRING_TYPE ||
      (names && !planFileNameSchema.safeParse(item).success)
    )
      refuse(filename, REASON.FieldInvalid);
  }
  return value as string[];
}

function fields(
  filename: string,
  mapping: Record<string, unknown>,
): Omit<ParsedPlanFile, "name" | "requirement" | "criterion"> {
  const kind = mapping[FIELD.Kind];
  if (!nodeKindSchema.safeParse(kind).success)
    refuse(filename, REASON.KindInvalid);
  const typedKind = kind as NodeKindType;
  const id = mapping[FIELD.Id];
  if (id !== undefined && !identitySchema(NODE_PREFIX).safeParse(id).success)
    refuse(filename, REASON.FieldInvalid);
  const parent = mapping[FIELD.Parent];
  if (parent !== undefined && !planFileNameSchema.safeParse(parent).success)
    refuse(filename, REASON.FieldInvalid);
  if (typedKind === NodeKind.Initiative && parent !== undefined)
    refuse(filename, REASON.ParentForbidden);
  if (typedKind !== NodeKind.Initiative && parent === undefined)
    refuse(filename, REASON.ParentRequired);
  if (typedKind === NodeKind.Task && Object.hasOwn(mapping, FIELD.DependsOn))
    refuse(filename, REASON.DependsOnForbidden);
  const dependsOn = stringList(filename, mapping[FIELD.DependsOn], true);
  const bindings = stringList(filename, mapping[FIELD.Bindings], false);
  const verifications = stringList(
    filename,
    mapping[FIELD.Verifications],
    false,
  );
  return {
    filename,
    ...(id !== undefined ? { id: id as string } : {}),
    kind: typedKind,
    ...(parent !== undefined ? { parent: parent as string } : {}),
    dependsOn,
    bindings,
    verifications,
  };
}

function body(
  filename: string,
  lines: string[],
): Pick<ParsedPlanFile, "name" | "requirement" | "criterion"> {
  let name: string | undefined;
  let section: string | undefined;
  const sections = new Map<string, string[]>();
  let fenced = false;
  for (let index = FIRST_LINE_INDEX; index < lines.length; index += LINE_STEP) {
    const line = lines[index]!;
    if (/^\s*```/.test(line)) fenced = !fenced;
    if (!fenced && /^#(?:\s|$)/.test(line) && !/^##/.test(line)) {
      if (name !== undefined) refuse(filename, REASON.HeadingRepeated);
      if (section !== undefined) refuse(filename, REASON.BodyInvalid);
      name = /^# (.+)$/.exec(line)?.[HEADING_CAPTURE_GROUP]?.trim();
      if (!name) refuse(filename, REASON.HeadingMissing);
      continue;
    }
    if (!fenced && /^##(?:\s|$)/.test(line)) {
      const title = /^## (.+)$/.exec(line)?.[HEADING_CAPTURE_GROUP];
      if (title !== SECTION.Requirement && title !== SECTION.Criterion)
        refuse(filename, REASON.UnknownSection);
      if (name === undefined) refuse(filename, REASON.HeadingMissing);
      if (sections.has(title)) refuse(filename, REASON.SectionRepeated);
      section = title;
      sections.set(title, []);
      continue;
    }
    if (section !== undefined) sections.get(section)!.push(line);
    else if (line.trim() !== BLANK_BODY_LINE)
      refuse(filename, REASON.BodyInvalid);
  }
  if (name === undefined) refuse(filename, REASON.HeadingMissing);
  if (!sections.has(SECTION.Requirement) || !sections.has(SECTION.Criterion))
    refuse(filename, REASON.SectionMissing);
  return {
    name,
    requirement: sections.get(SECTION.Requirement)!.join("\n").trim(),
    criterion: sections.get(SECTION.Criterion)!.join("\n").trim(),
  };
}

export function parsePlanFile(
  filename: string,
  content: string,
): ParsedPlanFile {
  const lines = content.split(/\r?\n/);
  if (lines[FIRST_LINE_INDEX] !== DELIMITER)
    refuse(filename, REASON.FrontMatterMissing);
  const end = lines.indexOf(DELIMITER, AFTER_OPENING_DELIMITER);
  if (end < DELIMITER_NOT_FOUND)
    refuse(filename, REASON.FrontMatterUnterminated);
  const mapping = frontMatter(
    filename,
    lines.slice(AFTER_OPENING_DELIMITER, end).join("\n"),
  );
  return {
    ...fields(filename, mapping),
    ...body(filename, lines.slice(end + AFTER_CLOSING_DELIMITER_OFFSET)),
  };
}
