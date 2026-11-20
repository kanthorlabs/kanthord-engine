import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import {
  agentProviderKindSchema,
  PromptOrigin,
  promptTemplatesSchema,
  reasoningEffortSchema,
} from "../../agent/contract.ts";
import {
  resolveTemplateSet,
  type TemplateSet,
} from "../../agent/prompt-templates.ts";
import { childEnvironment } from "../../agent/environment.ts";
import { background } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { identitySchema } from "../../kernel/identity.ts";
import { digest } from "../../kernel/json.ts";
import { findingSchema, revisionSchema } from "../../mission/contract.ts";
import {
  agentSetupSchema,
  type ExecutionSetup,
  executionSetupSchema,
  linkUpdateReadSchema,
  withoutEnvironmentMaps,
} from "../contract.ts";
import type { MethodClaim } from "./execution-stop.ts";
import { RELEASE_GATE_LOOP } from "./foundry-implement.ts";
import { VerdictSource } from "./node-verdict.ts";

export const TasksErrorCode = {
  SeedInvalid: "cli.worker.tasks.seed_invalid",
  TreeInvalid: "cli.worker.tasks.tree_invalid",
  ModeInvalid: "cli.worker.tasks.mode_invalid",
  OptionInvalid: "cli.worker.tasks.option_invalid",
  CredentialInvalid: "cli.worker.tasks.credential_invalid",
  CredentialExpiring: "cli.worker.tasks.credential_expiring",
  UnitUnknown: "cli.worker.tasks.unit_unknown",
  OutputExists: "cli.worker.tasks.output_exists",
  ReplayInvalid: "cli.worker.tasks.replay_invalid",
  ReplayDiverged: "cli.worker.tasks.replay_diverged",
  SeedMismatch: "cli.worker.tasks.seed_mismatch",
  InternalError: "cli.worker.tasks.internal_error",
} as const;
export type TasksErrorCode =
  (typeof TasksErrorCode)[keyof typeof TasksErrorCode];

export const SEED_FILE = "seed.json";
const OUTPUT_PREFIX = "tasks-run-";
const MODEL_SEPARATOR = "/";
const DURATION_PATTERN = /^([1-9][0-9]*)(s|m|h)$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DURATION_UNIT_MS: Readonly<Record<string, number>> = {
  s: 1000,
  m: 60000,
  h: 3600000,
};
const FIXED_ENV_NAMES: readonly string[] = ["PATH", "LANG", "TMPDIR", "HOME"];
const WORKING_AGENT = 0;
const NO_ELAPSED_MS = 0;
const PROBE_VALUE = "probe";
const NOT_FOUND = -1;
const SHA256 = "sha256";
const HEX = "hex";

const commitSchema = z.string().regex(/^[a-f0-9]{40,64}$/);
const claimSchema = z
  .strictObject({
    execution_id: identitySchema("execution"),
    node_id: identitySchema("node"),
    attempt: z.number().int().positive(),
    pinned_revision: z.number().int().positive(),
    node_branch: z.string().min(1),
    created_at: z.number().int(),
    expired_at: z.number().int(),
    trace_id: z.string().min(1),
    root_span_id: z.string().min(1),
  })
  .refine((claim) => claim.expired_at > claim.created_at, {
    path: ["expired_at"],
  });
const seedAgentSchema = agentSetupSchema.extend({
  prompt: z.strictObject({
    final: z.string().optional(),
    sources: agentSetupSchema.shape.prompt.shape.sources,
  }),
});
const seedSetupSchema = executionSetupSchema.extend({
  agents: z.array(seedAgentSchema).min(1),
  templates: promptTemplatesSchema.optional(),
  unit_records: executionSetupSchema.shape.unit_records.optional(),
});
const seedPlanSchema = z.strictObject({
  pending: z.array(
    z.strictObject({
      unit_id: z.string().min(1),
      instruction: z.string().nullable(),
    }),
  ),
  node: z
    .strictObject({
      text: z.string().min(1),
      round: z.number().int().positive().nullable(),
    })
    .nullable(),
});
const priorSchema = z.strictObject({
  verdict: z
    .strictObject({
      source: z.enum(VerdictSource),
      text: z.string(),
      judged: z.array(
        z.strictObject({
          binding_id: identitySchema("binding"),
          commit: commitSchema,
        }),
      ),
      findings: z.array(findingSchema),
      round: z.number().int().positive().nullable(),
      linkUpdates: z.number().int().nonnegative().optional(),
    })
    .nullable(),
  cleared: z.string().nullable(),
});
export const seedSchema = z.strictObject({
  claim: claimSchema,
  setup: seedSetupSchema,
  revision: revisionSchema,
  heads: z.record(identitySchema("binding"), commitSchema),
  plan: seedPlanSchema.optional(),
  affectedTests: z
    .array(
      z.strictObject({
        name: z.string().min(1),
        command: z.string().min(1),
        gate_files: z.array(z.string().min(1)),
      }),
    )
    .optional(),
  prior: priorSchema.optional(),
  link_updates: linkUpdateReadSchema.shape.items.optional(),
  elapsed_ms: z.number().int().nonnegative().optional(),
});
export type Seed = z.infer<typeof seedSchema>;
export type SeedPlan = z.infer<typeof seedPlanSchema>;

export interface TasksOptions {
  cwd: string;
  seedFolder: string;
  trees: readonly string[];
  passEnv: readonly string[];
  model?: string;
  reasoning?: string;
  systemPrompt?: string;
  templates?: string;
  units: readonly string[];
  budgetTurns?: string;
  budgetWall?: string;
  skipReleaseGate: boolean;
  output?: string;
  force: boolean;
  verify: boolean;
}

export interface TasksPlan {
  seed: Seed;
  digest: string;
  claim: MethodClaim;
  setup: ExecutionSetup;
  trees: ReadonlyMap<string, string>;
  passEnv: readonly string[];
  units: readonly string[];
  until: string | null;
  output: string;
  force: boolean;
  verify: boolean;
  overrides: Record<string, unknown>;
}

export function tasksDiagnostic(
  code: TasksErrorCode,
  message: string,
  fields: [string, string][] = [],
): Diagnostic {
  return new Diagnostic(code, message, { fields });
}

function issuePaths(error: z.ZodError): string {
  return [...new Set(error.issues.map((issue) => issue.path.join(".")))].join(
    ", ",
  );
}

function readSeed(folder: string): { seed: Seed; digest: string } {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(join(folder, SEED_FILE), "utf8"));
  } catch {
    throw tasksDiagnostic(
      TasksErrorCode.SeedInvalid,
      "worker tasks run: seed.json is absent or holds no JSON.",
    );
  }
  const parsed = seedSchema.safeParse(value);
  if (!parsed.success)
    throw tasksDiagnostic(
      TasksErrorCode.SeedInvalid,
      "worker tasks run: seed.json fails its schema.",
      [["paths", issuePaths(parsed.error)]],
    );
  return {
    seed: {
      ...parsed.data,
      setup: withoutEnvironmentMaps(parsed.data.setup),
    },
    digest: digest(value),
  };
}

function optionInvalid(option: string): Diagnostic {
  return tasksDiagnostic(
    TasksErrorCode.OptionInvalid,
    "worker tasks run: an option value is invalid.",
    [["option", option]],
  );
}

function parsedDuration(value: string): number {
  const match = DURATION_PATTERN.exec(value);
  if (!match) throw optionInvalid("--budget-wall");
  return Number(match[1]) * DURATION_UNIT_MS[match[2]!]!;
}

function parsedTurns(value: string): number {
  const turns = z.coerce.number().int().positive().safeParse(value);
  if (!turns.success) throw optionInvalid("--budget-turns");
  return turns.data;
}

function readOption(path: string, option: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    throw optionInvalid(option);
  }
}

type SeedAgent = Seed["setup"]["agents"][number];

function withModel(agent: SeedAgent, options: TasksOptions): SeedAgent {
  const configuration = { ...agent.effective_configuration };
  if (options.model !== undefined) {
    const at = options.model.indexOf(MODEL_SEPARATOR);
    const provider = agentProviderKindSchema.safeParse(
      options.model.slice(0, at),
    );
    const model = options.model.slice(at + MODEL_SEPARATOR.length);
    if (at === NOT_FOUND || !provider.success || !model)
      throw optionInvalid("--model");
    configuration.provider = provider.data;
    configuration.model_identifier = model;
  }
  if (options.reasoning !== undefined) {
    const level = reasoningEffortSchema.safeParse(options.reasoning);
    if (!level.success) throw optionInvalid("--reasoning");
    configuration.reasoning_effort = level.data;
  }
  return { ...agent, effective_configuration: configuration };
}

function withPrompt(agent: SeedAgent, options: TasksOptions): SeedAgent {
  if (options.systemPrompt === undefined) return agent;
  return {
    ...agent,
    prompt: {
      ...agent.prompt,
      final: readOption(
        resolve(options.cwd, options.systemPrompt),
        "--system-prompt",
      ),
    },
  };
}

async function templateSetOf(
  options: TasksOptions,
): Promise<TemplateSet | null> {
  if (options.templates === undefined) return null;
  try {
    return await resolveTemplateSet(
      resolve(options.cwd, options.templates),
      background,
    );
  } catch {
    throw optionInvalid("--templates");
  }
}

function contentDigest(text: string): string {
  return createHash(SHA256).update(text, "utf8").digest(HEX);
}

function templateDigests(set: TemplateSet): Record<string, string> {
  return Object.fromEntries(
    Object.entries(set.origins)
      .filter(([, origin]) => origin === PromptOrigin.File)
      .map(([name]) => [
        name,
        contentDigest(set.templates[name as keyof TemplateSet["templates"]]),
      ]),
  );
}

function budgetOf(
  seed: Seed,
  options: TasksOptions,
): ExecutionSetup["resource_budget"] {
  const budget = { ...seed.setup.resource_budget };
  if (options.budgetTurns !== undefined)
    budget.turns = parsedTurns(options.budgetTurns);
  if (options.budgetWall !== undefined)
    budget.wall_time_ms = parsedDuration(options.budgetWall);
  return budget;
}

function seedMissing(field: string): Diagnostic {
  return tasksDiagnostic(
    TasksErrorCode.SeedInvalid,
    "worker tasks run: the seed lacks a field and its option is absent.",
    [["paths", field]],
  );
}

async function setupOf(
  seed: Seed,
  options: TasksOptions,
  set: TemplateSet | null,
): Promise<ExecutionSetup> {
  const agents = seed.setup.agents.map((agent, index) =>
    index === WORKING_AGENT
      ? withPrompt(withModel(agent, options), options)
      : agent,
  );
  const templates = set === null ? seed.setup.templates : set.templates;
  if (templates === undefined) throw seedMissing("setup.templates");
  return {
    ...seed.setup,
    templates,
    unit_records: seed.setup.unit_records ?? [],
    resource_budget: budgetOf(seed, options),
    agents: agents.map((agent, index) => {
      if (agent.prompt.final === undefined)
        throw seedMissing(`setup.agents.${index}.prompt.final`);
      return {
        ...agent,
        prompt: { ...agent.prompt, final: agent.prompt.final },
      };
    }),
  };
}

function treesOf(
  setup: ExecutionSetup,
  options: TasksOptions,
): Map<string, string> {
  const trees = new Map<string, string>();
  for (const entry of options.trees) {
    const at = entry.indexOf("=");
    const binding = entry.slice(0, at);
    const path = entry.slice(at + 1);
    const known = setup.repositories.some(
      (repository) => repository.binding_id === binding,
    );
    if (at === NOT_FOUND || !path || !known || trees.has(binding))
      throw tasksDiagnostic(
        TasksErrorCode.TreeInvalid,
        "worker tasks run: a --tree value names no binding of the seed or repeats one.",
        [["binding", binding]],
      );
    trees.set(binding, resolve(options.cwd, path));
  }
  for (const repository of setup.repositories)
    if (!trees.has(repository.binding_id))
      throw tasksDiagnostic(
        TasksErrorCode.SeedInvalid,
        "worker tasks run: a binding has no tree source.",
        [["binding", repository.binding_id]],
      );
  return trees;
}

export const AMBIENT_CREDENTIAL_NAMES: readonly string[] = [
  "AWS_PROFILE",
  "AWS_DEFAULT_PROFILE",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AWS_BEARER_TOKEN_BEDROCK",
  "AWS_ROLE_ARN",
  "AWS_ROLE_SESSION_NAME",
  "AWS_WEB_IDENTITY_TOKEN_FILE",
  "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
  "AWS_CONTAINER_CREDENTIALS_FULL_URI",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN",
  "AWS_CONTAINER_AUTHORIZATION_TOKEN_FILE",
  "AWS_SDK_LOAD_CONFIG",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "GOOGLE_API_KEY",
  "GOOGLE_CLOUD_PROJECT",
  "GCLOUD_PROJECT",
  "CLOUDSDK_CONFIG",
  "AZURE_CLIENT_ID",
  "AZURE_CLIENT_SECRET",
  "AZURE_TENANT_ID",
  "AZURE_CLIENT_CERTIFICATE_PATH",
  "AZURE_CLIENT_CERTIFICATE_PASSWORD",
  "AZURE_FEDERATED_TOKEN_FILE",
  "AZURE_USERNAME",
  "AZURE_PASSWORD",
  "AZURE_OPENAI_API_KEY",
  "XDG_CONFIG_HOME",
  "AWS_REGION",
  "AWS_DEFAULT_REGION",
  "AWS_ENDPOINT_URL",
  "AWS_ENDPOINT_URL_BEDROCK",
  "AWS_ENDPOINT_URL_BEDROCK_RUNTIME",
  "AWS_BEDROCK_SKIP_AUTH",
  "AZURE_OPENAI_BASE_URL",
  "AZURE_OPENAI_RESOURCE_NAME",
  "AZURE_OPENAI_API_VERSION",
  "AZURE_OPENAI_DEPLOYMENT_NAME_MAP",
  "GOOGLE_CLOUD_LOCATION",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_GATEWAY_ID",
  "ANTHROPIC_FEDERATION_RULE_ID",
  "ANTHROPIC_ORGANIZATION_ID",
  "ANTHROPIC_SERVICE_ACCOUNT_ID",
  "ANTHROPIC_IDENTITY_TOKEN_FILE",
  "ANTHROPIC_WORKSPACE_ID",
];

function passEnvRefused(name: string): boolean {
  return (
    !ENV_NAME_PATTERN.test(name) ||
    FIXED_ENV_NAMES.includes(name) ||
    AMBIENT_CREDENTIAL_NAMES.includes(name) ||
    childEnvironment({ [name]: PROBE_VALUE })[name] === undefined
  );
}

function passEnvOf(options: TasksOptions): string[] {
  const names = [...new Set(options.passEnv)];
  for (const name of names)
    if (passEnvRefused(name)) throw optionInvalid("--pass-env");
  return names;
}

function claimOf(seed: Seed, startedAt: number): MethodClaim {
  const created = startedAt - (seed.elapsed_ms ?? NO_ELAPSED_MS);
  return {
    ...seed.claim,
    created_at: created,
    expired_at: created + seed.claim.expired_at - seed.claim.created_at,
  };
}

interface OverrideFiles {
  setup: ExecutionSetup;
  set: TemplateSet | null;
}

function overridesOf(
  options: TasksOptions,
  files: OverrideFiles,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries({
      model: options.model,
      reasoning: options.reasoning,
      system_prompt:
        options.systemPrompt === undefined
          ? undefined
          : contentDigest(files.setup.agents[WORKING_AGENT]!.prompt.final),
      templates: files.set === null ? undefined : templateDigests(files.set),
      units: options.units.length ? [...options.units] : undefined,
      budget_turns: options.budgetTurns,
      budget_wall: options.budgetWall,
      skip_release_gate: options.skipReleaseGate || undefined,
    }).filter((entry) => entry[1] !== undefined),
  );
}

export async function tasksPlanOf(
  options: TasksOptions,
  startedAt: number,
): Promise<TasksPlan> {
  const { seed, digest: seedDigest } = readSeed(
    resolve(options.cwd, options.seedFolder),
  );
  const set = await templateSetOf(options);
  const setup = await setupOf(seed, options, set);
  return {
    seed,
    digest: seedDigest,
    claim: claimOf(seed, startedAt),
    setup,
    trees: treesOf(setup, options),
    passEnv: passEnvOf(options),
    units: [...new Set(options.units)],
    until: options.skipReleaseGate ? RELEASE_GATE_LOOP : null,
    output: resolve(
      options.cwd,
      options.output ?? `${OUTPUT_PREFIX}${seed.claim.execution_id}`,
    ),
    force: options.force,
    verify: options.verify,
    overrides: overridesOf(options, { setup, set }),
  };
}
