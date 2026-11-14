import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { z } from "zod";
import { CodedError } from "../kernel/errors.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { isObject, isString } from "../kernel/values.ts";
import { importEntrySchema } from "../mission/contract.ts";
import { checksSchema } from "./score.ts";

export const EVAL_DIRECTORY = fileURLToPath(
  new URL("../../eval/", import.meta.url),
);
const FIXTURES_DIRECTORY = "fixtures";
const CASE_EXTENSION = ".yaml";

const CaseErrorCode = {
  Invalid: "eval.case.invalid",
  PlaceholderUnknown: "eval.case.placeholder_unknown",
  PlaceholderUnresolved: "eval.case.placeholder_unresolved",
  UnknownId: "eval.case.unknown_id",
} as const;

export const ReferenceKind = {
  ProjectId: "project_id",
  Node: "node",
  Evidence: "evidence",
} as const;
type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

export const SeedStep = {
  ExecutionRefusal: "execution_refusal",
  JobWithoutTaker: "job_without_taker",
  Evidence: "evidence",
} as const;

export const ApprovalAnswer = { Approve: "approve", Reject: "reject" } as const;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const REFERENCE =
  /^([\w-]+)\.(?:(project_id)|node\.(.+)|evidence\.(.+?)(?:\.asset\.(\d+))?)$/;
const AGENT_NAME = /^[a-z][a-z0-9-]*@\d+$/;

const caseIdSchema = z.string().regex(/^[a-z][a-z0-9-]*$/);
const fixtureKeySchema = z.string().regex(/^[\w-]+$/);
const fileNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const referenceSchema = z.string().min(1);

const setupStepSchema = z.strictObject({
  operation_id: z.string().min(1),
  input: z.strictObject({
    params: z.record(z.string(), z.unknown()),
    query: z.record(z.string(), z.unknown()),
    body: z.json(),
  }),
});

const seedStepSchema = z.discriminatedUnion("step", [
  z.strictObject({
    step: z.literal(SeedStep.ExecutionRefusal),
    node: referenceSchema,
    code: z.enum(["unauthorized", "bad_request"]),
    credential: z.string().min(1),
    agent: z.string().min(1),
  }),
  z.strictObject({
    step: z.literal(SeedStep.JobWithoutTaker),
    node: referenceSchema,
    age_ms: z.int().nonnegative(),
  }),
  z.strictObject({
    step: z.literal(SeedStep.Evidence),
    node: referenceSchema,
    attempt: z.int().positive(),
    assets: z.array(
      z.strictObject({ media_type: z.string().min(1), file: fileNameSchema }),
    ),
  }),
]);
export type SeedStepValue = z.infer<typeof seedStepSchema>;

const turnSchema = z.strictObject({
  human: z.string().min(1),
  approvals: z
    .record(z.string(), z.enum([ApprovalAnswer.Approve, ApprovalAnswer.Reject]))
    .default({}),
});

export const caseSchema = z.strictObject({
  id: caseIdSchema,
  source: z.string().min(1).optional(),
  fixtures: z.record(fixtureKeySchema, fileNameSchema),
  setup: z.array(setupStepSchema).default([]),
  seed: z.array(seedStepSchema).default([]),
  turns: z.array(turnSchema).min(1),
  checks: checksSchema,
});
export type Case = z.infer<typeof caseSchema>;

const fixtureFileSchema = z
  .strictObject({ entries: z.array(importEntrySchema) })
  .refine((file) => file.entries.every((entry) => entry.id === undefined), {
    message: "A fixture entry holds no id.",
  });
export type FixtureEntry = z.infer<typeof importEntrySchema>;

export interface CaseSource {
  id: string;
  text: string;
  readFile(name: string): Buffer;
}

export interface LoadedCase extends Case {
  case_digest: string;
  fixture_entries: Record<string, FixtureEntry[]>;
}

export interface EvidenceIds {
  id: string;
  assets: string[];
}

export interface FixtureIds {
  project_id: string;
  nodes: Record<string, string>;
  evidence: Record<string, EvidenceIds>;
}

export type PlaceholderIds = Record<string, FixtureIds>;

interface Reference {
  key: string;
  kind: ReferenceKind;
  filename: string;
  asset: number | undefined;
}

function parseReference(body: string): Reference {
  const match = REFERENCE.exec(body);
  if (!match)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnknown,
      "A placeholder has no valid form.",
    );
  const [, key, project, node, evidence, asset] = match;
  const kind = project
    ? ReferenceKind.ProjectId
    : node
      ? ReferenceKind.Node
      : ReferenceKind.Evidence;
  return {
    key: key!,
    kind,
    filename: node ?? evidence ?? "",
    asset: asset === undefined ? undefined : Number(asset),
  };
}

function mapStrings(value: unknown, map: (text: string) => string): unknown {
  if (isString(value)) return map(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, map));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, mapStrings(item, map)]),
    );
  return value;
}

function replacePlaceholders(
  text: string,
  resolve: (reference: Reference) => string,
): string {
  return text.replace(PLACEHOLDER, (_, body: string) =>
    resolve(parseReference(body)),
  );
}

function nodeFilenames(entries: readonly FixtureEntry[]): string[] {
  return entries
    .filter((entry) => !("node" in entry))
    .map((entry) => entry.filename);
}

function checkReference(
  reference: Reference,
  entries: Record<string, FixtureEntry[]>,
): string {
  const fixture = entries[reference.key];
  const known =
    fixture !== undefined &&
    (reference.kind === ReferenceKind.ProjectId ||
      nodeFilenames(fixture).includes(reference.filename));
  if (!known)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnknown,
      `A placeholder names an unknown fixture key or filename: ${reference.key}.`,
    );
  return "";
}

function placeholderScope(value: Case): unknown[] {
  return [value.setup, value.seed, value.turns, value.checks];
}

function resolved(value: string | undefined, reference: Reference): string {
  if (value === undefined)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnresolved,
      `A placeholder names no known value: ${reference.key}.`,
    );
  return value;
}

function lookup(ids: PlaceholderIds, reference: Reference): string {
  const fixture = ids[reference.key];
  if (reference.kind === ReferenceKind.ProjectId)
    return resolved(fixture?.project_id, reference);
  if (reference.kind === ReferenceKind.Node)
    return resolved(fixture?.nodes[reference.filename], reference);
  const evidence = fixture?.evidence[reference.filename];
  return resolved(
    reference.asset === undefined
      ? evidence?.id
      : evidence?.assets[reference.asset],
    reference,
  );
}

export function resolvePlaceholders<T>(value: T, ids: PlaceholderIds): T {
  return mapStrings(value, (text) =>
    replacePlaceholders(text, (reference) => lookup(ids, reference)),
  ) as T;
}

function assetFiles(value: Case): string[] {
  return value.seed.flatMap((step) =>
    step.step === SeedStep.Evidence
      ? step.assets.map((asset) => asset.file)
      : [],
  );
}

function digestOf(raw: unknown, files: readonly Buffer[]): string {
  const hash = createHash("sha256").update(canonicalJSON(raw), "utf8");
  for (const bytes of files) hash.update(bytes);
  return hash.digest("hex");
}

export function parseCase(
  source: CaseSource,
  schema: z.ZodType<Case> = caseSchema,
): LoadedCase {
  const raw: unknown = parse(source.text);
  const value = schema.parse(raw);
  if (value.id !== source.id)
    throw new CodedError(
      CaseErrorCode.Invalid,
      `The case id differs from the file name: ${source.id}.`,
    );
  const keys = Object.keys(value.fixtures).sort();
  const fixtureBytes = keys.map((key) => source.readFile(value.fixtures[key]!));
  const fixture_entries = Object.fromEntries(
    keys.map((key, index) => [
      key,
      fixtureFileSchema.parse(JSON.parse(fixtureBytes[index]!.toString("utf8")))
        .entries,
    ]),
  );
  for (const scope of placeholderScope(value))
    mapStrings(scope, (text) =>
      replacePlaceholders(text, (reference) =>
        checkReference(reference, fixture_entries),
      ),
    );
  const assetBytes = assetFiles(value).map((file) => source.readFile(file));
  return {
    ...value,
    case_digest: digestOf(raw, [...fixtureBytes, ...assetBytes]),
    fixture_entries,
  };
}

export function loadSuite(
  agent: string,
  ids: readonly string[],
  root = EVAL_DIRECTORY,
): LoadedCase[] {
  if (!AGENT_NAME.test(agent))
    throw new CodedError(
      CaseErrorCode.Invalid,
      `The agent name has no valid form: ${agent}.`,
    );
  const directory = join(root, agent);
  const files = readdirSync(directory)
    .filter((name) => extname(name) === CASE_EXTENSION)
    .sort();
  const known = files.map((name) => basename(name, CASE_EXTENSION));
  const unknown = ids.filter((id) => !known.includes(id));
  if (unknown.length)
    throw new CodedError(
      CaseErrorCode.UnknownId,
      `The suite of ${agent} holds no case: ${unknown.join(", ")}.`,
    );
  return files
    .filter(
      (name) => !ids.length || ids.includes(basename(name, CASE_EXTENSION)),
    )
    .map((name) =>
      parseCase({
        id: basename(name, CASE_EXTENSION),
        text: readFileSync(join(directory, name), "utf8"),
        readFile: (file) =>
          readFileSync(join(directory, FIXTURES_DIRECTORY, file)),
      }),
    );
}
