import type { Credential } from "@earendil-works/pi-ai";
import { join } from "node:path";
import { z } from "zod";
import { childEnvironment } from "../../agent/environment.ts";
import { piCredentialSchema, SecretShape } from "../../custody/contract.ts";
import type { Diagnostic } from "../../kernel/errors.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import {
  LLM_PLATFORMS,
  piProviderId,
  type Platform,
} from "../../llm/platforms.ts";
import { KNOWN_VALUE_MIN_CHARACTERS } from "../../agent/sensitive-text.ts";
import { PI_OAUTH_REFRESH_WINDOW_MS } from "../../llm/refresh-watch.ts";
import {
  HOME_DIRECTORY,
  STATE_DIRECTORY,
  type TasksOutput,
} from "./tasks-output.ts";
import {
  AMBIENT_CREDENTIAL_NAMES,
  tasksDiagnostic,
  TasksErrorCode,
  type TasksPlan,
} from "./tasks-seed.ts";

const ZERO_BYTE = 0;
const WORKING_AGENT = 0;
const CREDENTIAL_FIELD = "credential";
const PATH_SEPARATOR = ".";

const METADATA_FIELD = "metadata";
const AWS_DIRECTORY = ".aws";
const AWS_CONFIG = "config";
const AWS_CREDENTIALS = "credentials";
const NO_METADATA = null;
const REPLAY_KEY = "replay";

const stdinCredentialSchema = z.strictObject({
  provider_id: z.string().min(1),
  credential: piCredentialSchema,
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export interface LocalCredential {
  provider_id: string;
  credential: Credential;
  metadata: Record<string, unknown> | null;
}

export function credentialInvalid(field: string): Diagnostic {
  return tasksDiagnostic(
    TasksErrorCode.CredentialInvalid,
    "worker tasks run: standard input holds no valid credential of the effective provider.",
    [["field", field]],
  );
}

function fieldOf(error: z.ZodError): string {
  const [issue] = error.issues;
  const path = issue?.path.join(PATH_SEPARATOR);
  return path ? path : CREDENTIAL_FIELD;
}

function parsedInput(input: Buffer): unknown {
  try {
    return JSON.parse(input.toString("utf8"));
  } catch {
    throw credentialInvalid(CREDENTIAL_FIELD);
  } finally {
    input.fill(ZERO_BYTE);
  }
}

export function wallDeadlineOfPlan(plan: TasksPlan): number {
  return Math.min(
    plan.claim.created_at + plan.setup.resource_budget.wall_time_ms,
    plan.claim.expired_at,
  );
}

export function credentialOf(input: Buffer, plan: TasksPlan): LocalCredential {
  const parsed = stdinCredentialSchema.safeParse(parsedInput(input));
  if (!parsed.success) throw credentialInvalid(fieldOf(parsed.error));
  const agent = plan.setup.agents[WORKING_AGENT]!;
  if (
    parsed.data.provider_id !==
    piProviderId(agent.effective_configuration.provider)
  )
    throw credentialInvalid("provider_id");
  const metadata = routingMetadataOf(
    parsed.data.metadata ?? NO_METADATA,
    agent,
  );
  const { credential } = parsed.data;
  if (
    credential.type === SecretShape.OAuth &&
    credential.expires < wallDeadlineOfPlan(plan) + PI_OAUTH_REFRESH_WINDOW_MS
  )
    throw tasksDiagnostic(
      TasksErrorCode.CredentialExpiring,
      "worker tasks run: the oauth access token expires before the wall deadline of the run plus 5 minutes.",
    );
  return {
    provider_id: parsed.data.provider_id,
    credential,
    metadata,
  };
}

export function replayCredential(plan: TasksPlan): LocalCredential {
  const agent = plan.setup.agents[WORKING_AGENT]!;
  return {
    provider_id: piProviderId(agent.effective_configuration.provider),
    credential: { type: SecretShape.ApiKey, key: REPLAY_KEY },
    metadata: agent.metadata,
  };
}

type WorkingAgent = TasksPlan["setup"]["agents"][number];

function routingMetadataOf(
  metadata: Record<string, unknown> | null,
  agent: WorkingAgent,
): Record<string, unknown> | null {
  const schema =
    LLM_PLATFORMS[agent.effective_configuration.provider as Platform]
      ?.metadata_schema ?? null;
  const routed =
    schema === null
      ? metadata === NO_METADATA
      : metadata !== NO_METADATA && schema.safeParse(metadata).success;
  if (!routed || canonicalJSON(agent.metadata) !== canonicalJSON(metadata))
    throw credentialInvalid(METADATA_FIELD);
  return metadata;
}

export function knownPassValues(values: readonly string[]): string[] {
  return values.filter((value) => value.length >= KNOWN_VALUE_MIN_CHARACTERS);
}

export function credentialValues(credential: Credential): string[] {
  if (credential.type === SecretShape.OAuth)
    return [credential.access, credential.refresh];
  return credential.key === undefined ? [] : [credential.key];
}

export function withoutAmbientCredentials(
  env: NodeJS.ProcessEnv,
  output: TasksOutput,
): void {
  const home = output.directory(STATE_DIRECTORY, HOME_DIRECTORY);
  const stripped = childEnvironment(env);
  for (const name of Object.keys(env))
    if (!(name in stripped) || AMBIENT_CREDENTIAL_NAMES.includes(name))
      delete env[name];
  Object.assign(env, {
    HOME: home,
    AWS_CONFIG_FILE: join(home, AWS_DIRECTORY, AWS_CONFIG),
    AWS_SHARED_CREDENTIALS_FILE: join(home, AWS_DIRECTORY, AWS_CREDENTIALS),
    AWS_EC2_METADATA_DISABLED: "true",
    METADATA_SERVER_DETECTION: "none",
  });
}
