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
import { ProviderFailure } from "../scheduler/contract.ts";
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
  NativePlatform: "native_platform",
  DisplayName: "display_name",
  ProjectId: "project_id",
  MissionId: "mission_id",
  Node: "node",
  Evidence: "evidence",
} as const;
type ReferenceKind = (typeof ReferenceKind)[keyof typeof ReferenceKind];

export const SeedStep = {
  ExecutionRefusal: "execution_refusal",
  JobWithoutTaker: "job_without_taker",
  Evidence: "evidence",
  EnvironmentFailed: "environment_failed",
  EnvironmentPending: "environment_pending",
} as const;

export const ApprovalAnswer = { Approve: "approve", Reject: "reject" } as const;

export const AutoMode = { On: "on", Off: "off" } as const;

export const TurnAuthor = { Owner: "owner", Guest: "guest" } as const;

const PLACEHOLDER = /\{\{([^{}]*)\}\}/g;
const REFERENCE =
  /^([\w-]+)\.(?:(project_id)|(mission_id)|node\.(.+)|evidence\.(.+?)(?:\.asset\.(\d+))?)$/;
const TEXT_MEDIA_PREFIX = "text/";
const NO_PROJECTS = 0;
const AGENT_NAME = /^[a-z][a-z0-9-]*@\d+$/;

const caseIdSchema = z.string().regex(/^[a-z][a-z0-9_-]*$/);
const NATIVE_KEY = "native";
const NATIVE_REFERENCE = "native.platform";
const DISPLAY_NAME_KEY = "display_name";
const DISPLAY_NAME_PLACEHOLDER = /\{\{display_name\}\}/g;
const fixtureKeySchema = z
  .string()
  .regex(/^[\w-]+$/)
  .refine((key) => key !== NATIVE_KEY, {
    message: `The fixture key ${NATIVE_KEY} is reserved.`,
  })
  .refine((key) => key !== DISPLAY_NAME_KEY, {
    message: `The fixture key ${DISPLAY_NAME_KEY} is reserved.`,
  });
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
    code: z.enum([ProviderFailure.Unauthorized, ProviderFailure.BadRequest]),
    credential: z.string().min(1),
    agent: z.string().min(1),
  }),
  z.strictObject({
    step: z.literal(SeedStep.JobWithoutTaker),
    node: referenceSchema,
    age_ms: z.int().nonnegative(),
  }),
  z.strictObject({
    step: z.literal(SeedStep.EnvironmentFailed),
    project: referenceSchema,
    binding: z.string().min(1),
  }),
  z.strictObject({
    step: z.literal(SeedStep.EnvironmentPending),
    project: referenceSchema,
    binding: z.string().min(1),
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

const humanTurnSchema = z.strictObject({
  human: z.string().min(1),
  author: z
    .enum([TurnAuthor.Owner, TurnAuthor.Guest])
    .default(TurnAuthor.Owner),
  approvals: z
    .record(z.string(), z.enum([ApprovalAnswer.Approve, ApprovalAnswer.Reject]))
    .default({}),
});

const forkTurnSchema = z.strictObject({
  fork: z.strictObject({ text: z.string().min(1) }),
});

const variantSchema = z.strictObject({
  agent_name: z.string().min(1),
  display_name: z.string().min(1),
  instruction: z.string().min(1),
});
export type CaseVariant = z.infer<typeof variantSchema>;

const turnSchema = z.union([humanTurnSchema, forkTurnSchema]);
export type Turn = z.infer<typeof turnSchema>;

export const caseSchema = z.strictObject({
  id: caseIdSchema,
  source: z.string().min(1).optional(),
  fixtures: z.record(fixtureKeySchema, fileNameSchema),
  agents: z.array(z.string().regex(AGENT_NAME)).default([]),
  variants: z.array(variantSchema).default([]),
  session_variant: z.string().min(1).optional(),
  setup: z.array(setupStepSchema).default([]),
  seed: z.array(seedStepSchema).default([]),
  auto_mode: z.enum([AutoMode.On, AutoMode.Off]).default(AutoMode.On),
  project_ids: z.array(fixtureKeySchema).default([]),
  grant: z.array(z.string().min(1)).default([]),
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
  mission_id: string;
  nodes: Record<string, string>;
  evidence: Record<string, EvidenceIds>;
}

export type PlaceholderIds = Record<string, FixtureIds>;

export interface NativePlaceholders {
  platform: string;
}

interface Reference {
  key: string;
  kind: ReferenceKind;
  filename: string;
  asset: number | undefined;
}

function parseReference(body: string): Reference {
  if (body === DISPLAY_NAME_KEY)
    return {
      key: DISPLAY_NAME_KEY,
      kind: ReferenceKind.DisplayName,
      filename: "",
      asset: undefined,
    };
  if (body === NATIVE_REFERENCE)
    return {
      key: NATIVE_KEY,
      kind: ReferenceKind.NativePlatform,
      filename: "",
      asset: undefined,
    };
  const match = REFERENCE.exec(body);
  if (!match)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnknown,
      "A placeholder has no valid form.",
    );
  const [, key, project, mission, node, evidence, asset] = match;
  const kind = project
    ? ReferenceKind.ProjectId
    : mission
      ? ReferenceKind.MissionId
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
  displayName: boolean,
): string {
  if (reference.kind === ReferenceKind.DisplayName && !displayName)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnknown,
      "The placeholder display_name applies to turns and checks only.",
    );
  if (
    reference.kind === ReferenceKind.NativePlatform ||
    reference.kind === ReferenceKind.DisplayName
  )
    return "";
  const fixture = entries[reference.key];
  const known =
    fixture !== undefined &&
    (reference.kind === ReferenceKind.ProjectId ||
      reference.kind === ReferenceKind.MissionId ||
      nodeFilenames(fixture).includes(reference.filename));
  if (!known)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnknown,
      `A placeholder names an unknown fixture key or filename: ${reference.key}.`,
    );
  return "";
}

function sessionScope(value: Case): unknown[] {
  return [value.turns, value.checks];
}

function preparationScope(value: Case): unknown[] {
  return [value.setup, value.seed];
}

function resolved(value: string | undefined, reference: Reference): string {
  if (value === undefined)
    throw new CodedError(
      CaseErrorCode.PlaceholderUnresolved,
      `A placeholder names no known value: ${reference.key}.`,
    );
  return value;
}

function lookup(
  ids: PlaceholderIds,
  native: NativePlaceholders,
  reference: Reference,
): string {
  if (reference.kind === ReferenceKind.NativePlatform) return native.platform;
  if (reference.kind === ReferenceKind.DisplayName)
    return `{{${DISPLAY_NAME_KEY}}}`;
  const fixture = ids[reference.key];
  if (reference.kind === ReferenceKind.ProjectId)
    return resolved(fixture?.project_id, reference);
  if (reference.kind === ReferenceKind.MissionId)
    return resolved(fixture?.mission_id, reference);
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

export function resolvePlaceholders<T>(
  value: T,
  ids: PlaceholderIds,
  native: NativePlaceholders,
): T {
  return mapStrings(value, (text) =>
    replacePlaceholders(text, (reference) => lookup(ids, native, reference)),
  ) as T;
}

export function resolveDisplayName<T>(value: T, displayName: string): T {
  return mapStrings(value, (text) =>
    text.replace(DISPLAY_NAME_PLACEHOLDER, () => displayName),
  ) as T;
}

function assetFiles(value: Case): string[] {
  return value.seed.flatMap((step) =>
    step.step === SeedStep.Evidence
      ? step.assets.map((asset) => asset.file)
      : [],
  );
}

function textAssetFiles(value: Case): string[] {
  return value.seed.flatMap((step) =>
    step.step === SeedStep.Evidence
      ? step.assets
          .filter((asset) => asset.media_type.startsWith(TEXT_MEDIA_PREFIX))
          .map((asset) => asset.file)
      : [],
  );
}

function digestOf(raw: unknown, files: readonly Buffer[]): string {
  const hash = createHash("sha256").update(canonicalJSON(raw), "utf8");
  for (const bytes of files) hash.update(bytes);
  return hash.digest("hex");
}

function assertProjectScope(value: Case): void {
  const unknown = value.project_ids.find(
    (key) => !Object.hasOwn(value.fixtures, key),
  );
  if (unknown !== undefined)
    throw new CodedError(
      CaseErrorCode.Invalid,
      `The project_ids names an unknown fixture key: ${unknown}.`,
    );
  const guestTurn = value.turns.some(
    (turn) => "author" in turn && turn.author === TurnAuthor.Guest,
  );
  if (guestTurn && value.project_ids.length === NO_PROJECTS)
    throw new CodedError(
      CaseErrorCode.Invalid,
      "A case with a guest turn names at least one project in project_ids.",
    );
}

function assertSessionVariant(value: Case): void {
  if (value.session_variant === undefined) return;
  if (
    !value.variants.some(
      (variant) => variant.display_name === value.session_variant,
    )
  )
    throw new CodedError(
      CaseErrorCode.Invalid,
      `The session_variant names no item of variants: ${value.session_variant}.`,
    );
}

export function parseCase(
  source: CaseSource,
  schema: z.ZodType<Case> = caseSchema,
): LoadedCase {
  const raw: unknown = parse(source.text);
  const value = schema.parse(raw);
  assertProjectScope(value);
  assertSessionVariant(value);
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
  const assetBytes = assetFiles(value).map((file) => source.readFile(file));
  const assetTexts = textAssetFiles(value).map((file) =>
    source.readFile(file).toString("utf8"),
  );
  const scopes = [
    ...sessionScope(value).map((scope) => ({ scope, displayName: true })),
    ...[...preparationScope(value), ...assetTexts].map((scope) => ({
      scope,
      displayName: false,
    })),
  ];
  for (const { scope, displayName } of scopes)
    mapStrings(scope, (text) =>
      replacePlaceholders(text, (reference) =>
        checkReference(reference, fixture_entries, displayName),
      ),
    );
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
