import type { Credential } from "@earendil-works/pi-ai";
import { z } from "zod";
import { piCredentialSchema, SecretShape } from "../../custody/contract.ts";
import type { Diagnostic } from "../../kernel/errors.ts";
import { piProviderId } from "../../llm/platforms.ts";
import { PI_OAUTH_REFRESH_WINDOW_MS } from "../../llm/refresh-watch.ts";
import {
  tasksDiagnostic,
  TasksErrorCode,
  type TasksPlan,
} from "./tasks-seed.ts";

const ZERO_BYTE = 0;
const WORKING_AGENT = 0;
const CREDENTIAL_FIELD = "credential";
const PATH_SEPARATOR = ".";

const stdinCredentialSchema = z.strictObject({
  provider_id: z.string().min(1),
  credential: piCredentialSchema,
});

export interface LocalCredential {
  provider_id: string;
  credential: Credential;
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
  const { credential } = parsed.data;
  if (
    credential.type === SecretShape.OAuth &&
    credential.expires < wallDeadlineOfPlan(plan) + PI_OAUTH_REFRESH_WINDOW_MS
  )
    throw tasksDiagnostic(
      TasksErrorCode.CredentialExpiring,
      "worker tasks run: the oauth access token expires before the wall deadline of the run plus 5 minutes.",
    );
  return parsed.data;
}

export function credentialValues(credential: Credential): string[] {
  if (credential.type === SecretShape.OAuth)
    return [credential.access, credential.refresh];
  return credential.key === undefined ? [] : [credential.key];
}
