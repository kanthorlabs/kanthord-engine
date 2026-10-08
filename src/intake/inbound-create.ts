import assert from "node:assert/strict";
import type { z } from "zod";
import {
  apiKeySecretSchema,
  GrantKind,
  InboundOperation,
  type Material,
} from "../custody/contract.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { abortSignal } from "../kernel/context.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  OperationResultType,
  type CallerContext,
  type ServiceClient,
} from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import type { projectOperations } from "../project/contract.ts";
import {
  GitHubTargetKind,
  repositoryOf,
  type GitHubAnswer,
  type GitHubEventsAnswer,
  type GitHubFailure,
  type GitHubPlatform,
} from "../repository/github.ts";
import type { IntakeCustody } from "./action-check.ts";
import {
  configurationSchemaOf,
  type GitHubConfiguration,
} from "./configuration.ts";
import {
  InboundKind,
  IntakeErrorCode,
  PLATFORM_CALL_DEADLINE_MS,
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
const PLATFORM_REFUSED_STATUS = 422;
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

export type InboundSuitability = Pick<IntakeCustody, "custodySuitability">;

export interface InboundCreateDependencies {
  store: Store;
  identity: ServiceIdentity;
  custody: Pick<
    IntakeCustody,
    "custodySuitability" | "authorizeOperation" | "release"
  >;
  github: Pick<GitHubPlatform, "listEvents">;
  projects: InboundProjects;
}

interface Hold {
  material: Material | null;
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

function admitInbound(input: InboundCreate): GitHubConfiguration {
  const credentialRequired = input.kind === InboundKind.Poll;
  if (credentialRequired !== (input.credential !== undefined))
    throw validationFailed([
      { path: [BODY_PATH, "credential"], code: "custom" },
    ]);
  const parsed = configurationSchemaOf(input.kind, input.platform).safeParse(
    input.configuration,
  );
  if (!parsed.success) throw configurationIssues(parsed.error);
  return parsed.data;
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
  custody: InboundSuitability,
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
  custody: InboundSuitability,
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

function releasePoll(
  dependencies: InboundCreateDependencies,
  tx: Transaction,
  inbound: { id: string; input: InboundCreate; resource: string },
  hold: Hold,
): void {
  assert.equal(hold.material, null, "A poll create releases once.");
  const { id, input, resource } = inbound;
  assert.ok(input.credential !== undefined, "A poll names a credential.");
  const now = Date.now();
  const grant = dependencies.custody.authorizeOperation(
    tx,
    {
      kind: GrantKind.Inbound,
      identity: dependencies.identity,
      inbound: {
        inboundId: id,
        projectId: input.project_id,
        credential: input.credential,
        platform: input.platform,
        resource,
      },
      operation: InboundOperation.Poll,
    },
    now,
  );
  assert.equal(grant.execution, null, "A poll release pins nothing.");
  hold.material = dependencies.custody.release(tx, grant, now);
}

async function firstRequest(
  github: InboundCreateDependencies["github"],
  caller: CallerContext,
  material: Material,
  resource: string,
): Promise<GitHubAnswer<GitHubEventsAnswer>> {
  assert.ok(caller.identity, "A human operation holds an identity.");
  const token = apiKeySecretSchema.parse(material.value()).key;
  const { owner, repo } = repositoryOf({
    kind: GitHubTargetKind.Inbound,
    resource,
  });
  const { signal, dispose } = abortSignal(caller.context);
  try {
    return await github.listEvents(
      {
        token,
        requester: caller.identity,
        signal,
        deadlineAt: Date.now() + PLATFORM_CALL_DEADLINE_MS,
      },
      { owner, repo, etag: null },
    );
  } finally {
    dispose();
  }
}

function platformRefused(failure: GitHubFailure): OperationError {
  assert.equal(failure.ok, false);
  assert.ok(failure.message.length > NO_LENGTH, "A failure names a reason.");
  return new OperationError(
    PLATFORM_REFUSED_STATUS,
    IntakeErrorCode.InboundPlatformRefused,
    failure.message,
    { status: failure.status },
  );
}

async function validatePoll(
  dependencies: InboundCreateDependencies,
  caller: CallerContext,
  inbound: { id: string; input: InboundCreate; resource: string },
): Promise<void> {
  assert.equal(inbound.input.kind, InboundKind.Poll);
  const hold: Hold = { material: null };
  try {
    try {
      dependencies.store.transaction((tx) =>
        releasePoll(dependencies, tx, inbound, hold),
      );
    } catch (error) {
      throw credentialRefusal(error);
    }
    assert.ok(hold.material, "A committed release holds the material.");
    const answer = await firstRequest(
      dependencies.github,
      caller,
      hold.material,
      inbound.resource,
    );
    if (!answer.ok) throw platformRefused(answer);
  } finally {
    hold.material?.drop();
  }
}

export async function createInbound(
  dependencies: InboundCreateDependencies,
  caller: CallerContext,
  input: InboundCreate,
): Promise<Inbound> {
  const configuration = admitInbound(input);
  await requireProject(dependencies.projects, caller, input.project_id);
  const id = allocateInboundId();
  if (input.kind === InboundKind.Poll)
    await validatePoll(dependencies, caller, {
      id,
      input,
      resource: configuration.resource,
    });
  const inbound = caller.commit((tx) =>
    commitInbound(dependencies.custody, tx, id, input, null),
  );
  assert.equal(inbound.id, id, "The answer names the allocated identity.");
  return inbound;
}
