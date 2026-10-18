import { isMap, isScalar, parseDocument } from "yaml";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import {
  MissionErrorCode,
  NODE_IDENTITY_PREFIX,
  TASK_IDENTITY_PREFIX,
  planFileIdSchema,
  planFileNameSchema,
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
const ALIAS_LIMIT = 100;
const FIELD = {
  Id: "id",
  Intent: "intent",
  Node: "node",
  DependsOn: "depends_on",
  Tags: "tags",
  Bindings: "bindings",
  Verifications: "verifications",
} as const;
const NODE_FILE_FIELDS: readonly string[] = [
  FIELD.Id,
  FIELD.Intent,
  FIELD.DependsOn,
  FIELD.Tags,
  FIELD.Bindings,
  FIELD.Verifications,
];
const TASK_FILE_FIELDS: readonly string[] = [
  FIELD.Id,
  FIELD.Node,
  FIELD.Bindings,
  FIELD.Verifications,
];
const SECTION = { Requirement: "Requirement", Criterion: "Criterion" } as const;
const REASON = {
  FrontMatterMissing: "front_matter_missing",
  FrontMatterUnterminated: "front_matter_unterminated",
  FrontMatterInvalid: "front_matter_invalid",
  UnknownKey: "unknown_key",
  FieldInvalid: "field_invalid",
  FormInvalid: "form_invalid",
  IdPrefixInvalid: "id_prefix_invalid",
  DependsOnForbidden: "depends_on_forbidden",
  TagsForbidden: "tags_forbidden",
  HeadingMissing: "heading_missing",
  HeadingRepeated: "heading_repeated",
  SectionMissing: "section_missing",
  SectionRepeated: "section_repeated",
  UnknownSection: "unknown_section",
  BodyInvalid: "body_invalid",
} as const;

interface ParsedPlanContent {
  filename: string;
  id?: string;
  bindings: string[];
  verifications: string[];
  name: string;
  requirement: string;
  criterion: string;
}

export interface ParsedNodeFile extends ParsedPlanContent {
  intent: unknown;
  tags: unknown;
  depends_on: string[];
}

export interface ParsedTaskFile extends ParsedPlanContent {
  node: string;
}

export type ParsedPlanFile = ParsedNodeFile | ParsedTaskFile;
type ParsedFields =
  | Omit<ParsedNodeFile, "name" | "requirement" | "criterion">
  | Omit<ParsedTaskFile, "name" | "requirement" | "criterion">;

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
  return value as Record<string, unknown>;
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
): ParsedFields {
  const isNode = Object.hasOwn(mapping, FIELD.Intent);
  if (isNode === Object.hasOwn(mapping, FIELD.Node))
    refuse(filename, REASON.FormInvalid);
  if (!isNode && Object.hasOwn(mapping, FIELD.DependsOn))
    refuse(filename, REASON.DependsOnForbidden);
  if (!isNode && Object.hasOwn(mapping, FIELD.Tags))
    refuse(filename, REASON.TagsForbidden);
  const permitted = isNode ? NODE_FILE_FIELDS : TASK_FILE_FIELDS;
  for (const key of Object.keys(mapping)) {
    if (!permitted.includes(key)) refuse(filename, REASON.UnknownKey);
  }
  const id = mapping[FIELD.Id];
  if (id !== undefined && !planFileIdSchema.safeParse(id).success)
    refuse(filename, REASON.FieldInvalid);
  const prefix = isNode ? NODE_IDENTITY_PREFIX : TASK_IDENTITY_PREFIX;
  if (id !== undefined && !identitySchema(prefix).safeParse(id).success)
    refuse(filename, REASON.IdPrefixInvalid);
  const shared = {
    filename,
    ...(id !== undefined ? { id: id as string } : {}),
    bindings: stringList(filename, mapping[FIELD.Bindings], false),
    verifications: stringList(filename, mapping[FIELD.Verifications], false),
  };
  if (!isNode) {
    const node = mapping[FIELD.Node];
    if (!planFileNameSchema.safeParse(node).success)
      refuse(filename, REASON.FieldInvalid);
    return { ...shared, node: node as string };
  }
  const tags = mapping[FIELD.Tags];
  return {
    ...shared,
    intent: mapping[FIELD.Intent],
    tags: tags === undefined ? [] : tags,
    depends_on: stringList(filename, mapping[FIELD.DependsOn], true),
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
