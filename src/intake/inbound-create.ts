import assert from "node:assert/strict";
import type { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  OperationResultType,
  type CallerContext,
  type ServiceClient,
} from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import type { projectOperations } from "../project/contract.ts";
import type { IntakeCustody } from "./action-check.ts";
import { configurationSchemaOf } from "./configuration.ts";
import {
  InboundKind,
  IntakeErrorCode,
  type Inbound,
  type InboundCreate,
} from "./contract.ts";
import {
  allocateInboundId,
  inboundRecord,
  insertInbound,
  readInbound,
} from "./inbound-store.ts";

const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const OPERATION_UNKNOWN_CODE = "system.operation.unknown";
const CREDENTIAL_INVALID_STATUS = 422;
const BODY_PATH = "body";
const NO_LENGTH = 0;
const CREDENTIAL_REFUSAL_CODES: ReadonlySet<string> = new Set([
  "credential.credential.not_found",
  "credential.platform.mismatch",
]);

export type InboundProjects = Pick<
  ServiceClient<typeof projectOperations>,
  "get"
>;

export interface InboundCreateDependencies {
  custody: Pick<IntakeCustody, "custodySuitability">;
  projects: InboundProjects;
}

function validationFailed(
  issues: { path: string[]; code: string }[],
): OperationError {
  assert.ok(issues.length > NO_LENGTH, "A validation failure names an issue.");
  return new OperationError(
    HttpStatus.BadRequest,
    VALIDATION_FAILED_CODE,
    "Request validation failed.",
    issues,
  );
}

function configurationIssues(error: z.ZodError): OperationError {
  return validationFailed(
    error.issues.map((issue) => ({
      path: [BODY_PATH, "configuration", ...issue.path.map(String)],
      code: issue.code,
    })),
  );
}

function admitWebhook(input: InboundCreate): void {
  if (input.kind !== InboundKind.Webhook)
    throw validationFailed([{ path: [BODY_PATH, "kind"], code: "custom" }]);
  if (input.credential !== undefined)
    throw validationFailed([
      { path: [BODY_PATH, "credential"], code: "custom" },
    ]);
  const parsed = configurationSchemaOf(input.kind, input.platform).safeParse(
    input.configuration,
  );
  if (!parsed.success) throw configurationIssues(parsed.error);
}

async function requireProject(
  projects: InboundProjects,
  caller: CallerContext,
  projectId: string,
): Promise<void> {
  assert.ok(caller.identity, "A human operation holds an identity.");
  const result = await projects.get(
    { params: { project_id: projectId }, query: {}, body: null },
    { identity: caller.identity, context: caller.context },
  );
  if (result.type === OperationResultType.Completed) return;
  if (result.type === OperationResultType.Indeterminate)
    throw new OperationError(
      HttpStatus.InternalServerError,
      OPERATION_UNKNOWN_CODE,
      "Operation failed.",
    );
  if (result.status === HttpStatus.NotFound)
    throw new OperationError(
      HttpStatus.NotFound,
      IntakeErrorCode.InboundProjectNotFound,
      "The project of the inbound does not exist.",
    );
  throw new OperationError(
    result.status,
    result.error.error.code,
    result.error.error.message,
    result.error.error.details,
  );
}

export function credentialRefusal(error: unknown): unknown {
  if (!(error instanceof OperationError)) return error;
  if (!CREDENTIAL_REFUSAL_CODES.has(error.code)) return error;
  return new OperationError(
    CREDENTIAL_INVALID_STATUS,
    IntakeErrorCode.InboundCredentialInvalid,
    "The credential does not exist, or its platform does not suit the inbound.",
  );
}

function checkCredential(
  custody: InboundCreateDependencies["custody"],
  tx: Transaction,
  input: InboundCreate,
): void {
  if (input.credential === undefined) return;
  try {
    custody.custodySuitability(tx, {
      credential: input.credential,
      platform: input.platform,
    });
  } catch (error) {
    throw credentialRefusal(error);
  }
}

export function commitInbound(
  custody: InboundCreateDependencies["custody"],
  tx: Transaction,
  id: string,
  input: InboundCreate,
  checkpoint: unknown,
): Inbound {
  assert.ok(id.length > NO_LENGTH, "An inbound identity is required.");
  assert.equal(readInbound(tx, id), null, "An inbound identity is fresh.");
  checkCredential(custody, tx, input);
  insertInbound(tx, id, {
    project_id: input.project_id,
    kind: input.kind,
    platform: input.platform,
    consumer: input.consumer,
    credential: input.credential ?? null,
    configuration: input.configuration,
    checkpoint,
    created_at: Date.now(),
  });
  const row = readInbound(tx, id);
  assert.ok(row !== null, "An inserted inbound is readable.");
  return inboundRecord(row);
}

export async function createInbound(
  dependencies: InboundCreateDependencies,
  caller: CallerContext,
  input: InboundCreate,
): Promise<Inbound> {
  admitWebhook(input);
  await requireProject(dependencies.projects, caller, input.project_id);
  const id = allocateInboundId();
  const inbound = caller.commit((tx) =>
    commitInbound(dependencies.custody, tx, id, input, null),
  );
  assert.equal(inbound.id, id, "The answer names the allocated identity.");
  return inbound;
}
