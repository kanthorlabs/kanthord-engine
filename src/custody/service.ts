import { addAbortListener } from "node:events";
import { z } from "zod";
import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { Credential, CredentialStore } from "@earendil-works/pi-ai";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import {
  isHumanIdentity,
  isMachineIdentity,
  isServiceIdentity,
  type MachineIdentity,
} from "../kernel/caller.ts";
import {
  entryFailureReason,
  HealthScope,
  observeDeadline,
  ResourceFailureReason,
  ResourceStatus,
  type HealthRegistry,
  type ResourceCheck,
  type ResourceEntry,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { sealJSON, sealedObjectSchema } from "../kernel/hpke.ts";
import { canonicalJSON, digest } from "../kernel/json.ts";
import { piProviderId } from "../kernel/pi-provider.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  CREDENTIAL_CHECK_TIMEOUT_MS,
  LIST_LIMIT_DEFAULT,
  RevisionChange,
  secretSchemas,
  SecretShape,
  type CheckMaterial,
  type CredentialAnswer,
  type CredentialCheckAnswer,
  type CredentialCheckBody,
  type CredentialCreate,
  type CredentialCopy,
  type CredentialEntry,
  type CredentialListAnswer,
  type CredentialListQuery,
  type CredentialMetadata,
  type CredentialPlatform,
  type CredentialPlatforms,
  type CredentialPlatformSet,
  type CredentialHoldItem,
  type CredentialHolds,
  type CredentialRecords,
  type CredentialRotateBody,
  type SealedCopy,
  type SealedRotateBody,
  type HeldCopy,
  type SealedCopyAnswer,
  type InstanceKey,
  type InstanceKeys,
  type BindingsListingInstanceFn,
  SERVER_HOLDER,
  CREDENTIAL_SEAL_INFO,
  SEALED_CIPHERTEXT_MAX_BYTES,
  SEALED_PLAINTEXT_MAX_BYTES,
  credentialSealAad,
  credentialSealedToSchema,
  type SealedHandoverItem,
  type CredentialUpdateMetadataBody,
  type GeneratedCreate,
  type GeneratedRevision,
  type GeneratedRotate,
  SshIdentitySubjectKind,
  type HandoverSshIdentity,
  type SshAccessOf,
  type SshIdentityAuthorization,
  type SshSignatureOf,
  sshPublicKeyMetadataSchema,
  type AgentProviderDependent,
  type BindingRevision,
  type AgentProvidersDependentOnFn,
  type BindingsNamingFn,
  type InboundDependent,
  type InboundsNamingFn,
  type CustodyExecutions,
  type CustodyAuthorization,
  type CustodyExecution,
  type Grant,
  GrantKind,
  type GrantOf,
  type GrantRequest,
  HandoverPlacement,
  HolderRefusal,
  InboundOperation,
  type MissionAuthorization,
  type Material,
  piCredentialSchema,
  type ServerAgentCredentialsInput,
  type WorkbenchCredentialsInput,
  type WorkbenchGrant,
} from "./contract.ts";
import type { ExecutionClaim } from "../kernel/operation.ts";
import {
  consumeGrant,
  consumeWorkbenchGrant,
  FacilityError,
  grantFacts,
  mintGrant,
  mintWorkbenchGrant,
  MaterialBuffer,
} from "./facility.ts";
import { credentialOfSecret } from "./payload.ts";
import { ExecutionStoreError } from "./execution-store.ts";
import { workbenchCredentialStore } from "./workbench-store.ts";
import {
  sealMaterial,
  plainItem,
  openReport,
  openSignRequest,
  sealSignAnswer,
  applyReport,
  CUSTODY_HOLDER_REFUSED,
  SSH_SIGN_PLACEMENT_REFUSED,
  REVISION_REVOKED,
} from "./handover.ts";
import type { HandoverEnvelope } from "../kernel/handover.ts";
import { encrypt } from "./envelope.ts";
import { heldByInstance, openSecret, storedSealed } from "./secret.ts";
import { isReservedName, validateNameForm } from "./names.ts";
import { ENVIRONMENT_SECRET_PLATFORM } from "../project/contract.ts";

export interface Dependencies {
  executions: CustodyExecutions;
  authorization: CustodyAuthorization;
  missionAuthorization: MissionAuthorization;
  clientSecret: (clientId: string) => string;
  store: Store;
  platforms: CredentialPlatforms;
  envelopeKey: Buffer;
  logger: Logger;
  health?: HealthRegistry;
  agentProvidersDependentOn: AgentProvidersDependentOnFn;
  bindingsNaming: BindingsNamingFn;
  inboundsNaming: InboundsNamingFn;
  intakeServiceName: string;
  projectServiceName: string;
  sshIdentityAuthorization?: SshIdentityAuthorization;
  sshAccessOf?: SshAccessOf;
  sshSignatureOf?: SshSignatureOf;
  instanceKeys?: InstanceKeys;
  bindingsListingInstance?: BindingsListingInstanceFn;
  instanceCopyRefreshed?: (holder: string) => void;
}

const CustodyErrorCode = {
  Stopped: "custody.lifecycle.stopped",
  Invalid: "credential.input.invalid",
  UnsupportedPlatform: "credential.platform.unsupported",
  UnsupportedEntry: "credential.entry.unsupported",
  Conflict: "credential.name.conflict",
  PlatformConflict: "credential.name.platform_conflict",
  SealedInvalid: "credential.sealed.invalid",
  NotFound: "credential.credential.not_found",
  PlatformMismatch: "credential.platform.mismatch",
  RevisionConflict: "credential.revision.conflict",
  CheckUnsupported: "credential.check.unsupported",
  InUse: "credential.credential.in_use",
  Archived: "credential.credential.archived",
  RevisionNotFound: "credential.revision.not_found",
  RevisionEnded: "credential.revision.ended",
  RevisionRevoked: REVISION_REVOKED,
  NewestLive: "credential.revision.newest_live",
  InvalidCursor: "system.pagination.cursor_invalid",
} as const;
const FIRST_REVISION = 1;
const NO_ROWS = 0;
const QUERY_TRUE = "true";
const INCLUDE = 1;
const EXCLUDE = 0;
const EXTRA_ROW = 1;
const CREDENTIAL_PREFIX = "credential";
const CUSTODY_HEALTH_NAME = "custody";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;
const TARGET_KIND_CREDENTIAL = "credential";
const BASE64URL = "base64url";
const UTF8 = "utf8";
const ROW_COLUMNS =
  "id, name, platform, holder, sealed_to, revision, metadata, created_at, ended_at";
const NO_INSTANCE_KEYS: InstanceKeys = {
  keyOf: () => null,
  nameOf: () => null,
};

type CredentialRow = {
  id: string;
  name: string;
  platform: string;
  holder: string;
  sealed_to: string | null;
  revision: number;
  metadata: string | null;
  created_at: number;
  ended_at: number | null;
};

type LiveRow = CredentialRow & { nonce: Buffer; ciphertext: Buffer };

function capturedResourceCheck(
  row: LiveRow,
  key: Buffer,
  entry: CredentialPlatform,
  refreshStore: CredentialStore | null,
): ResourceCheck {
  const { id, platform, holder } = row;
  const { probe } = entry;
  const nonce = Buffer.from(row.nonce);
  const ciphertext = Buffer.from(row.ciphertext);
  const metadata: unknown =
    row.metadata === null ? null : JSON.parse(row.metadata);
  return async (context, observe) => {
    if (context.signal.aborted) return ResourceStatus.Unknown;
    try {
      if (probe === null) return ResourceStatus.Unknown;
      const secret = openSecret(key, {
        id,
        platform,
        holder,
        nonce,
        ciphertext,
      });
      return await probe(
        secret,
        metadata,
        context,
        observe,
        refreshStore ?? undefined,
      );
    } catch {
      observe?.(
        "probe failed before the remote call",
        ResourceFailureReason.Unclassified,
      );
      return ResourceStatus.Unknown;
    }
  };
}

function heldByInstanceCheck(): ResourceCheck {
  return async (_context, observe) => {
    observe?.(
      "a worker instance holds the credential copy",
      ResourceFailureReason.HeldByInstance,
    );
    return ResourceStatus.Unknown;
  };
}

function newestLive(
  tx: Transaction,
  name: string,
  holder: string,
): LiveRow | undefined {
  return tx.database
    .prepare(
      `SELECT ${ROW_COLUMNS}, nonce, ciphertext FROM credential WHERE name = ? AND holder = ? AND ended_at IS NULL ORDER BY revision DESC LIMIT 1`,
    )
    .get(name, holder) as LiveRow | undefined;
}

function liveHoldersOf(tx: Transaction, name: string): string[] {
  return (
    tx.database
      .prepare(
        "SELECT DISTINCT holder FROM credential WHERE name = ? AND ended_at IS NULL ORDER BY holder <> ?, holder",
      )
      .all(name, SERVER_HOLDER) as { holder: string }[]
  ).map(({ holder }) => holder);
}

function holderOfRow(tx: Transaction, id: string): string | null {
  const row = tx.database
    .prepare("SELECT holder FROM credential WHERE id = ?")
    .get(id) as { holder: string } | undefined;
  return row?.holder ?? null;
}

function serverLive(tx: Transaction, name: string): LiveRow | undefined {
  const row = newestLive(tx, name, SERVER_HOLDER);
  if (row) return row;
  if (liveHoldersOf(tx, name).length !== NO_ROWS) throw heldByInstance();
  return undefined;
}

function firstRowOfName(
  tx: Transaction,
  name: string,
): CredentialRow | undefined {
  return tx.database
    .prepare(`SELECT ${ROW_COLUMNS} FROM credential WHERE name = ? LIMIT 1`)
    .get(name) as CredentialRow | undefined;
}

function sealedInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CustodyErrorCode.SealedInvalid,
    "The sealed credential copy is invalid.",
  );
}

function refuseArchived(tx: Transaction, name: string, holder: string): void {
  const rows = rowsForName(tx, name, holder);
  if (rows.length !== NO_ROWS && rows.every((row) => row.ended_at !== null))
    throw new OperationError(
      HttpStatus.Conflict,
      CustodyErrorCode.Archived,
      "Credential is archived.",
    );
}

function requireLive(
  tx: Transaction,
  name: string,
  holder: string,
  expected: number,
): LiveRow {
  refuseArchived(tx, name, holder);
  const row = newestLive(tx, name, holder);
  if (!row)
    throw new OperationError(
      HttpStatus.NotFound,
      CustodyErrorCode.NotFound,
      "Credential not found.",
    );
  if (row.revision !== expected)
    throw new OperationError(
      HttpStatus.Conflict,
      CustodyErrorCode.RevisionConflict,
      "Credential revision conflict.",
      { revision: row.revision },
    );
  return row;
}

function validatedMetadata(
  entry: CredentialPlatform,
  value: unknown,
): Record<string, unknown> | null {
  const schema = entry.metadata_schema;
  if (schema === null) {
    if (value !== null) throw invalidInput();
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput();
  return parsed.data as Record<string, unknown>;
}

function isGenerated(entry: CredentialPlatform): boolean {
  return entry.secret_shape === SecretShape.SshKey;
}

function unsupportedEntry(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CustodyErrorCode.UnsupportedEntry,
    "Unsupported credential entry.",
  );
}

function notFound(): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    CustodyErrorCode.NotFound,
    "Credential not found.",
  );
}

function ownedPlatform(
  set: CredentialPlatformSet,
  platform: string,
): CredentialPlatform | undefined {
  return Object.hasOwn(set.platforms, platform)
    ? set.platforms[platform]
    : undefined;
}

function refuseForeign(
  tx: Transaction,
  set: CredentialPlatformSet,
  name: string,
): void {
  const row = firstRowOfName(tx, name);
  if (row && !ownedPlatform(set, row.platform)) throw notFound();
}

function parsedMetadata(row: CredentialRow): Record<string, unknown> | null {
  return row.metadata === null ? null : JSON.parse(row.metadata);
}

function requireNameForm(name: string): void {
  if (!validateNameForm(name) || isReservedName(name)) throw invalidInput();
}

function invalidInput(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CustodyErrorCode.Invalid,
    "Invalid input.",
  );
}

function sshPublicKeyOfRow(row: CredentialRow): string | null {
  const metadata = sshPublicKeyMetadataSchema.safeParse(
    row.metadata === null ? null : JSON.parse(row.metadata),
  );
  return metadata.success ? metadata.data.public_key : null;
}

function rowsForName(
  tx: Transaction,
  name: string,
  holder: string,
): CredentialRow[] {
  return tx.database
    .prepare(
      `SELECT ${ROW_COLUMNS} FROM credential WHERE name = ? AND holder = ? ORDER BY revision DESC`,
    )
    .all(name, holder) as CredentialRow[];
}

function invalidCursor(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CustodyErrorCode.InvalidCursor,
    "Invalid cursor.",
  );
}

function encodeCursor(name: string, holder: string): string {
  return Buffer.from(JSON.stringify([name, holder]), UTF8).toString(BASE64URL);
}

const cursorSchema = z.tuple([z.string(), z.string()]);

function decodeCursor(cursor: string): { name: string; holder: string } {
  if (!CURSOR_PATTERN.test(cursor)) throw invalidCursor();
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(cursor, BASE64URL).toString(UTF8));
  } catch {
    throw invalidCursor();
  }
  const parsed = cursorSchema.safeParse(value);
  if (
    !parsed.success ||
    !validateNameForm(parsed.data[0]) ||
    !validateNameForm(parsed.data[1]) ||
    encodeCursor(...parsed.data) !== cursor
  )
    throw invalidCursor();
  const [name, holder] = parsed.data;
  return { name, holder };
}

const NO_STRIKES = 0;
const ONE_ROW = 1;

function credentialHolds(): CredentialHolds {
  return {
    holdOf: (tx, name, holder) => {
      const row = tx.database
        .prepare(
          "SELECT available_at, strikes FROM credential WHERE name = ? AND holder = ? AND revision = ?",
        )
        .get(name, holder, FIRST_REVISION) as
        { available_at: number | null; strikes: number } | undefined;
      return row === undefined || row.available_at === null
        ? null
        : { available_at: row.available_at, strikes: row.strikes };
    },
    hold: (tx, name, holder, availableAt, strikes) => {
      const { changes } = tx.database
        .prepare(
          "UPDATE credential SET available_at = ?, strikes = ? WHERE name = ? AND holder = ? AND revision = ?",
        )
        .run(availableAt, strikes, name, holder, FIRST_REVISION);
      assert.equal(changes, ONE_ROW);
    },
    release: (tx, name, holder) =>
      tx.database
        .prepare(
          "UPDATE credential SET available_at = NULL, strikes = ? WHERE name = ? AND holder = ? AND revision = ? AND strikes > ?",
        )
        .run(NO_STRIKES, name, holder, FIRST_REVISION, NO_STRIKES).changes >
      NO_ROWS,
    listHolds: (tx) =>
      tx.database
        .prepare(
          "SELECT name AS credential, holder, strikes, available_at FROM credential WHERE revision = ? AND strikes > ? ORDER BY name, holder",
        )
        .all(FIRST_REVISION, NO_STRIKES)
        .map((row) => ({ ...row }) as CredentialHoldItem),
  };
}

function metadataOf(
  tx: Transaction,
  credentialName: string,
  holder: string,
): CredentialMetadata | null {
  const row = newestLive(tx, credentialName, holder);
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    metadata: row.metadata === null ? null : JSON.parse(row.metadata),
  };
}

function copiesMetadataOf(
  tx: Transaction,
  credentialName: string,
): CredentialMetadata[] {
  return liveHoldersOf(tx, credentialName).map((holder) => {
    const metadata = metadataOf(tx, credentialName, holder);
    assert(metadata);
    return metadata;
  });
}

export class CustodyComponent implements Service, CredentialRecords {
  readonly holds: CredentialHolds = credentialHolds();
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly store: Store;
  private readonly platforms: CredentialPlatforms;
  private readonly envelopeKey: Buffer;
  private readonly logger: Logger;
  private readonly agentProvidersDependentOn: AgentProvidersDependentOnFn;
  private readonly bindingsNaming: BindingsNamingFn;
  private readonly inboundsNaming: InboundsNamingFn;
  private readonly executions: CustodyExecutions;
  private readonly authorization: CustodyAuthorization;
  private readonly missionAuthorization: MissionAuthorization;
  private readonly clientSecret: (clientId: string) => string;
  private readonly intakeServiceName: string;
  private readonly projectServiceName: string;
  private readonly sshIdentityAuthorization:
    SshIdentityAuthorization | undefined;
  private readonly sshAccessOf: SshAccessOf | undefined;
  private readonly sshSignatureOf: SshSignatureOf | undefined;
  private readonly instanceKeys: InstanceKeys;
  private readonly bindingsListingInstance: BindingsListingInstanceFn;
  private readonly instanceCopyRefreshed: (holder: string) => void;

  constructor(dependencies: Dependencies) {
    this.executions = dependencies.executions;
    this.authorization = dependencies.authorization;
    this.missionAuthorization = dependencies.missionAuthorization;
    this.clientSecret = dependencies.clientSecret;
    this.store = dependencies.store;
    this.platforms = dependencies.platforms;
    this.envelopeKey = dependencies.envelopeKey;
    this.logger = dependencies.logger;
    this.agentProvidersDependentOn = dependencies.agentProvidersDependentOn;
    this.bindingsNaming = dependencies.bindingsNaming;
    this.inboundsNaming = dependencies.inboundsNaming;
    this.intakeServiceName = dependencies.intakeServiceName;
    this.projectServiceName = dependencies.projectServiceName;
    this.sshIdentityAuthorization = dependencies.sshIdentityAuthorization;
    this.sshAccessOf = dependencies.sshAccessOf;
    this.sshSignatureOf = dependencies.sshSignatureOf;
    this.instanceKeys = dependencies.instanceKeys ?? NO_INSTANCE_KEYS;
    this.bindingsListingInstance =
      dependencies.bindingsListingInstance ?? (() => []);
    this.instanceCopyRefreshed =
      dependencies.instanceCopyRefreshed ?? (() => {});
    dependencies.health?.register(CUSTODY_HEALTH_NAME, () =>
      this.healthcheck(),
    );
  }

  authorize(
    tx: Transaction,
    identity: MachineIdentity,
    execution: CustodyExecution,
  ): Grant[] {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    return this.authorization
      .authorizeModelInference(tx, identity, execution)
      .map(({ credential, platform, provider_id, agent_provider }) =>
        mintGrant({
          kind: GrantKind.ModelInference,
          credential,
          platform,
          project_id: execution.project_id,
          execution,
          facts: { provider_id, agent_provider },
        }),
      );
  }

  authorizeOperation<R extends GrantRequest>(
    tx: Transaction,
    request: R,
    now: number,
  ): GrantOf<R["kind"]>;
  authorizeOperation(
    tx: Transaction,
    request: GrantRequest,
    now: number,
  ): Grant {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    if (request.kind === GrantKind.Inbound)
      return this.inboundGrant(tx, request);
    if (request.kind === GrantKind.EnvironmentSecret)
      return this.environmentSecretGrant(tx, request);
    const execution =
      request.claim === null
        ? null
        : this.claimedExecution(tx, request.claim, now);
    if (request.kind === GrantKind.SshIdentity)
      return this.sshIdentityGrant(tx, request, execution);
    return this.missionGrant(tx, request, execution);
  }

  private sshIdentityGrant(
    tx: Transaction,
    request: Extract<GrantRequest, { kind: typeof GrantKind.SshIdentity }>,
    execution: CustodyExecution | null,
  ): GrantOf<typeof GrantKind.SshIdentity> {
    assert(tx.database.isTransaction);
    assert(execution === null || request.claim !== null);
    const { identity, subject, claim } = request;
    if (
      this.sshIdentityAuthorization === undefined ||
      isMachineIdentity(identity) !== (claim !== null) ||
      (subject.kind === SshIdentitySubjectKind.Draft &&
        !isHumanIdentity(identity))
    )
      throw new FacilityError();
    const authorized = this.sshIdentityAuthorization.sshIdentity(
      tx,
      identity,
      subject,
      claim,
    );
    const entry =
      authorized.credential === null
        ? undefined
        : Object.hasOwn(this.platforms, authorized.platform)
          ? this.platforms[authorized.platform]
          : undefined;
    if (entry === undefined || !isGenerated(entry)) throw new FacilityError();
    return mintGrant({ kind: request.kind, execution, ...authorized });
  }

  private inboundGrant(
    tx: Transaction,
    request: Extract<GrantRequest, { kind: typeof GrantKind.Inbound }>,
  ): GrantOf<typeof GrantKind.Inbound> {
    assert(tx.database.isTransaction);
    assert.equal(request.kind, GrantKind.Inbound);
    const { identity, inbound, operation } = request;
    if (
      !isServiceIdentity(identity) ||
      identity.service !== this.intakeServiceName ||
      operation !== InboundOperation.Poll
    )
      throw new FacilityError();
    const { credential, platform } = inbound;
    this.custodySuitability(tx, { credential, platform });
    return mintGrant({
      kind: request.kind,
      credential,
      platform,
      project_id: inbound.projectId,
      execution: null,
      facts: { inbound_id: inbound.inboundId, resource: inbound.resource },
    });
  }

  private environmentSecretGrant(
    tx: Transaction,
    request: Extract<
      GrantRequest,
      { kind: typeof GrantKind.EnvironmentSecret }
    >,
  ): GrantOf<typeof GrantKind.EnvironmentSecret> {
    assert(tx.database.isTransaction);
    assert.equal(request.kind, GrantKind.EnvironmentSecret);
    const { identity, projectId, bindingId, variable, credential } = request;
    if (
      !isServiceIdentity(identity) ||
      identity.service !== this.projectServiceName
    )
      throw new FacilityError();
    this.custodySuitability(tx, {
      credential,
      platform: ENVIRONMENT_SECRET_PLATFORM,
    });
    return mintGrant({
      kind: request.kind,
      credential,
      platform: ENVIRONMENT_SECRET_PLATFORM,
      project_id: projectId,
      execution: null,
      facts: { binding_id: bindingId, variable },
    });
  }

  private missionGrant(
    tx: Transaction,
    request: Exclude<
      GrantRequest,
      {
        kind:
          | typeof GrantKind.Inbound
          | typeof GrantKind.SshIdentity
          | typeof GrantKind.EnvironmentSecret;
      }
    >,
    execution: CustodyExecution | null,
  ): Grant {
    assert(tx.database.isTransaction);
    assert(execution === null || request.claim !== null);
    const mission = this.missionAuthorization;
    switch (request.kind) {
      case GrantKind.FrozenAction: {
        const { key, commit, reusedEvidenceId } = request;
        const mergeEvidenceId = request.mergeEvidenceId ?? null;
        const authorized = mission.frozenAction(
          tx,
          request.identity,
          request.claim,
          { key, commit, reusedEvidenceId, mergeEvidenceId },
        );
        return mintGrant({ kind: request.kind, execution, ...authorized });
      }
      case GrantKind.RequestEvidence: {
        const authorized = mission.requestEvidence(
          tx,
          request.identity,
          request.evidenceId,
          request.claim,
        );
        return mintGrant({ kind: request.kind, execution, ...authorized });
      }
      case GrantKind.EvidenceAsset: {
        const authorized = mission.evidenceAsset(
          tx,
          request.identity,
          request.assetId,
          request.claim,
          request.use,
        );
        return mintGrant({ kind: request.kind, execution, ...authorized });
      }
      case GrantKind.ObjectPut: {
        const { nodeId, assetId, storageBindingId, size, sha256 } = request;
        const authorized = mission.objectPut(
          tx,
          request.identity,
          request.claim,
          { nodeId, assetId, storageBindingId, size, sha256 },
        );
        return mintGrant({ kind: request.kind, execution, ...authorized });
      }
    }
  }

  private claimedExecution(
    tx: Transaction,
    claim: ExecutionClaim,
    now: number,
  ): CustodyExecution {
    const row = this.executions.requireRunning(
      tx,
      claim.executionId,
      claim.runtimeIdentity,
      now,
    );
    assert.equal(row.execution_id, claim.executionId);
    assert.equal(row.runtime_identity, claim.runtimeIdentity);
    if (
      row.project_id !== claim.projectId ||
      row.worker_binding_id !== claim.workerBindingId
    )
      throw new FacilityError();
    return row;
  }

  release(tx: Transaction, grant: Grant, now: number): Material {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    if (grant.credential === null) throw new FacilityError();
    consumeGrant(grant);
    const row = this.releasedRow(
      tx,
      grant.credential,
      SERVER_HOLDER,
      grant.execution,
    );
    this.drainRevisions(tx, row.name, row.holder, now);
    if (row.platform !== grant.platform)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.PlatformMismatch,
        "Credential platform mismatch.",
      );
    return new MaterialBuffer(
      row.id,
      row.platform,
      openSecret(this.envelopeKey, this.storedRowOf(tx, row)),
    );
  }

  private storedRowOf(tx: Transaction, row: CredentialRow) {
    const encrypted = tx.database
      .prepare("SELECT nonce, ciphertext FROM credential WHERE id = ?")
      .get(row.id) as { nonce: Buffer; ciphertext: Buffer } | undefined;
    assert(encrypted);
    return {
      id: row.id,
      platform: row.platform,
      holder: row.holder,
      nonce: encrypted.nonce,
      ciphertext: encrypted.ciphertext,
    };
  }

  private sealedItem(
    tx: Transaction,
    grant: Grant,
    holder: string | null,
    now: number,
  ): SealedHandoverItem {
    assert(tx.database.isTransaction);
    if (grant.credential === null) throw new FacilityError();
    consumeGrant(grant);
    const credential = grant.credential;
    const key = holder === null ? null : this.instanceKeys.keyOf(tx, holder);
    const rows =
      holder === null || key === null
        ? []
        : rowsForName(tx, credential, holder);
    const pinned = rows.find(({ id }) =>
      grant.execution?.credentials.includes(id),
    );
    if (pinned && pinned.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionRevoked,
        "The pinned credential revision is revoked.",
      );
    const row = pinned ?? rows.find(({ ended_at }) => ended_at === null);
    if (!row || row.sealed_to !== key?.fingerprint)
      throw new OperationError(
        HttpStatus.Forbidden,
        CUSTODY_HOLDER_REFUSED,
        "The worker placement receives only a copy sealed to the current key of its instance.",
        {
          reason:
            row === undefined &&
            newestLive(tx, credential, SERVER_HOLDER) !== undefined
              ? HolderRefusal.ServerHeld
              : HolderRefusal.HeldElsewhere,
        },
      );
    if (row.platform !== grant.platform)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.PlatformMismatch,
        "Credential platform mismatch.",
      );
    if (!pinned && grant.execution)
      this.executions.pinCredential(tx, grant.execution.execution_id, row.id);
    this.drainRevisions(tx, row.name, row.holder, now);
    return {
      credential_id: row.id,
      provider_id: piProviderId(row.platform),
      name: row.name,
      platform: row.platform,
      sealed: storedSealed(this.envelopeKey, this.storedRowOf(tx, row)),
    };
  }

  consume(grant: Grant): void {
    if (grant.credential !== null) throw new FacilityError();
    consumeGrant(grant);
  }

  private releasedRow(
    tx: Transaction,
    credential: string,
    holder: string,
    execution: Grant["execution"],
  ) {
    const row = this.revisionRow(tx, credential, holder, execution);
    if (execution && !execution.credentials.includes(row.id))
      this.executions.pinCredential(tx, execution.execution_id, row.id);
    return row;
  }

  private revisionRow(
    tx: Transaction,
    credential: string,
    holder: string,
    execution: Grant["execution"],
  ) {
    assert(credential.length);
    const rows = rowsForName(tx, credential, holder);
    const pinned = execution
      ? rows.find((candidate) => execution.credentials.includes(candidate.id))
      : undefined;
    if (pinned && pinned.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionRevoked,
        "The pinned credential revision is revoked.",
      );
    if (pinned) return pinned;
    const live = rows.find((candidate) => candidate.ended_at === null);
    if (!live) {
      if (liveHoldersOf(tx, credential).length !== NO_ROWS)
        throw heldByInstance();
      throw new OperationError(
        HttpStatus.NotFound,
        CustodyErrorCode.NotFound,
        "Credential not found.",
      );
    }
    assert.equal(live.name, credential);
    return live;
  }

  private workbenchRow(tx: Transaction, grant: WorkbenchGrant): LiveRow {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    consumeWorkbenchGrant(grant);
    const row = serverLive(tx, grant.credential);
    if (!row)
      throw new OperationError(
        HttpStatus.NotFound,
        CustodyErrorCode.NotFound,
        "Credential not found.",
      );
    if (row.platform !== grant.platform)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.PlatformMismatch,
        "Credential platform mismatch.",
      );
    return row;
  }

  releaseWorkbench(tx: Transaction, grant: WorkbenchGrant): Material {
    const row = this.workbenchRow(tx, grant);
    return new MaterialBuffer(
      row.id,
      row.platform,
      openSecret(this.envelopeKey, row),
    );
  }

  workbenchCredentials(input: WorkbenchCredentialsInput) {
    const grant = (tx: Transaction): WorkbenchGrant => {
      const requester = input.requester();
      if (!isHumanIdentity(requester)) throw new FacilityError();
      const { credential, platform } = input.authorize(
        tx,
        requester,
        input.session_id,
      );
      return this.grantOf(input, credential, platform);
    };
    return this.grantedCredentialStore(
      input.platform,
      grant,
      (tx, current, next) =>
        this.replaceServerCopy(
          tx,
          this.workbenchRow(tx, grant(tx)).id,
          current,
          next,
        ),
    );
  }

  private replaceServerCopy(
    tx: Transaction,
    credentialId: string,
    current: Credential,
    next: Credential,
  ): void {
    if (this.executions.liveExecutionsPinning(tx, credentialId).length)
      throw new ExecutionStoreError(
        "A live execution holds the credential revision.",
      );
    applyReport(
      tx,
      this.envelopeKey,
      {
        credential_id: credentialId,
        digest: digest(current),
        credential: piCredentialSchema.parse(next),
      },
      this.platforms,
      this.instanceKeys,
    );
  }

  private refreshStoreOf(
    tx: Transaction,
    row: LiveRow,
    entry: CredentialPlatform,
  ): CredentialStore | null {
    if (entry.secret_shape !== SecretShape.OAuth) return null;
    if (this.executions.liveExecutionsPinning(tx, row.id).length !== NO_ROWS)
      return null;
    return this.serverRefreshStore(row);
  }

  private serverRefreshStore(row: LiveRow): CredentialStore {
    return workbenchCredentialStore({
      providerId: piProviderId(row.platform),
      type: SecretShape.OAuth,
      release: () =>
        this.store.transaction((tx) =>
          credentialOfSecret(
            SecretShape.OAuth,
            openSecret(this.envelopeKey, this.storedRowOf(tx, row)),
          ),
        ),
      replace: (current, next) =>
        this.store.transaction((tx) =>
          this.replaceServerCopy(tx, row.id, current, next),
        ),
    });
  }

  serverAgentCredentials(input: ServerAgentCredentialsInput) {
    const grant = (tx: Transaction): WorkbenchGrant => {
      const requester = input.requester();
      if (!isServiceIdentity(requester)) throw new FacilityError();
      const { credential, platform } = input.authorize(
        tx,
        requester,
        input.session_id,
      );
      return this.grantOf(input, credential, platform);
    };
    return this.grantedCredentialStore(input.platform, grant, () => {
      throw new FacilityError();
    });
  }

  private grantOf(
    input: { platform: string; session_id: string },
    credential: string,
    platform: string,
  ): WorkbenchGrant {
    if (platform !== input.platform) throw new FacilityError();
    return mintWorkbenchGrant({
      credential,
      platform,
      session_id: input.session_id,
    });
  }

  private grantedCredentialStore(
    inputPlatform: string,
    grant: (tx: Transaction) => WorkbenchGrant,
    replace: (tx: Transaction, current: Credential, next: Credential) => void,
  ) {
    assert(Object.hasOwn(this.platforms, inputPlatform));
    const shape = this.platforms[inputPlatform]!.secret_shape;
    assert(shape === SecretShape.ApiKey || shape === SecretShape.OAuth);
    return workbenchCredentialStore({
      providerId: piProviderId(inputPlatform),
      type: shape,
      release: () =>
        this.store.transaction((tx) => {
          const material = this.releaseWorkbench(tx, grant(tx));
          try {
            return credentialOfSecret(shape, material.value());
          } finally {
            material.drop();
          }
        }),
      replace: (current, next) =>
        this.store.transaction((tx) => replace(tx, current, next)),
    });
  }

  handover(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    placement: HandoverPlacement | null,
    repositoryBindingIds: readonly string[],
    now: number,
  ): HandoverEnvelope {
    const row = this.executions.requireRunning(
      tx,
      claim.executionId,
      claim.runtimeIdentity,
      now,
    );
    const grants = this.authorize(tx, identity, row);
    if (placement === HandoverPlacement.Worker)
      return this.sealedHandover(tx, identity, row, grants, now);
    const materials: Material[] = [];
    try {
      for (const grant of grants) materials.push(this.release(tx, grant, now));
      const sshIdentities = repositoryBindingIds.map((bindingId) =>
        this.sshIdentityOf(tx, identity, claim, bindingId, now),
      );
      const envelope = sealMaterial(
        this.clientSecret(identity.clientId),
        row,
        materials.map((material) => plainItem(material, this.platforms)),
        sshIdentities,
      );
      for (const material of materials)
        this.logger.info(
          {
            execution_id: row.execution_id,
            worker_binding_id: row.worker_binding_id,
            credential_id: material.credential_id,
            client_id: identity.clientId,
            runtime_identity: row.runtime_identity,
          },
          "credential handover",
        );
      for (const { binding_id, credential_id } of sshIdentities)
        this.logger.info(
          {
            execution_id: row.execution_id,
            worker_binding_id: row.worker_binding_id,
            binding_id,
            credential_id,
            client_id: identity.clientId,
            runtime_identity: row.runtime_identity,
          },
          "ssh identity handover",
        );
      return envelope;
    } finally {
      for (const material of materials) material.drop();
    }
  }

  private sealedHandover(
    tx: Transaction,
    identity: MachineIdentity,
    row: CustodyExecution,
    grants: readonly Grant[],
    now: number,
  ): HandoverEnvelope {
    const holder =
      identity.instanceId === undefined
        ? null
        : this.instanceKeys.nameOf(tx, identity.instanceId);
    const items = grants.map((grant) =>
      this.sealedItem(tx, grant, holder, now),
    );
    const envelope = sealMaterial(
      this.clientSecret(identity.clientId),
      row,
      items,
      [],
    );
    for (const item of items)
      this.logger.info(
        {
          execution_id: row.execution_id,
          worker_binding_id: row.worker_binding_id,
          credential_id: item.credential_id,
          client_id: identity.clientId,
          instance_id: identity.instanceId ?? null,
          runtime_identity: row.runtime_identity,
        },
        "credential handover",
      );
    return envelope;
  }

  private sshIdentityOf(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    bindingId: string,
    now: number,
  ): HandoverSshIdentity {
    if (this.sshAccessOf === undefined) throw new FacilityError();
    const grant = this.authorizeOperation(
      tx,
      {
        kind: GrantKind.SshIdentity,
        identity,
        subject: {
          kind: SshIdentitySubjectKind.Binding,
          binding_id: bindingId,
        },
        claim,
      },
      now,
    );
    const granted = grantFacts(grant);
    assert.equal(granted.facts.binding_id, bindingId);
    const material = this.release(tx, grant, now);
    const credentialId = material.credential_id;
    const { private_key } = this.sshAccessOf(tx, granted, material);
    return {
      binding_id: bindingId,
      credential_id: credentialId,
      private_key,
    };
  }

  sshSign(
    tx: Transaction,
    identity: MachineIdentity,
    claim: ExecutionClaim,
    placement: HandoverPlacement | null,
    envelope: HandoverEnvelope,
    now: number,
  ): HandoverEnvelope {
    if (this.sshSignatureOf === undefined) throw new FacilityError();
    const row = this.executions.requireRunning(
      tx,
      claim.executionId,
      claim.runtimeIdentity,
      now,
    );
    if (placement !== HandoverPlacement.Worker)
      throw new OperationError(
        HttpStatus.Forbidden,
        SSH_SIGN_PLACEMENT_REFUSED,
        "The SSH signature relay serves only the worker placement.",
        { placement },
      );
    const secret = this.clientSecret(identity.clientId);
    const request = openSignRequest(secret, row, envelope);
    const grant = this.authorizeOperation(
      tx,
      {
        kind: GrantKind.SshIdentity,
        identity,
        subject: {
          kind: SshIdentitySubjectKind.Binding,
          binding_id: request.binding_id,
        },
        claim,
      },
      now,
    );
    const granted = grantFacts(grant);
    assert.equal(granted.facts.binding_id, request.binding_id);
    if (grant.credential === null) throw new FacilityError();
    const revision = this.revisionRow(
      tx,
      grant.credential,
      SERVER_HOLDER,
      grant.execution,
    );
    const signature = this.sshSignatureOf(
      tx,
      granted,
      sshPublicKeyOfRow(revision),
      Buffer.from(request.data, "base64"),
      () => this.release(tx, grant, now),
    );
    this.logger.info(
      {
        execution_id: row.execution_id,
        binding_id: request.binding_id,
        credential_id: revision.id,
        client_id: identity.clientId,
        instance_id: identity.instanceId ?? null,
        runtime_identity: row.runtime_identity,
      },
      "ssh signature relay",
    );
    return sealSignAnswer(secret, row, {
      signature: signature.toString("base64"),
    });
  }

  sshPublicKeyOf(
    tx: Transaction,
    execution: { executionId: string; runtimeIdentity: string },
    credentialName: string,
    now: number,
  ): string | null {
    const claim = this.executions.requireRunning(
      tx,
      execution.executionId,
      execution.runtimeIdentity,
      now,
    );
    const rows = rowsForName(tx, credentialName, SERVER_HOLDER);
    const pinned = rows.find(({ id }) => claim.credentials.includes(id));
    if (pinned && pinned.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionRevoked,
        "Pinned credential revision is revoked.",
      );
    const row = pinned ?? newestLive(tx, credentialName, SERVER_HOLDER);
    if (!row)
      throw new OperationError(
        HttpStatus.NotFound,
        CustodyErrorCode.NotFound,
        "Credential not found.",
      );
    return sshPublicKeyOfRow(row);
  }

  report(
    tx: Transaction,
    identity: MachineIdentity,
    execution: { executionId: string; runtimeIdentity: string },
    envelope: HandoverEnvelope,
    now: number,
  ): void {
    const row = this.executions.requireRunning(
      tx,
      execution.executionId,
      execution.runtimeIdentity,
      now,
    );
    const report = openReport(
      this.clientSecret(identity.clientId),
      row,
      envelope,
    );
    const written = applyReport(
      tx,
      this.envelopeKey,
      report,
      this.platforms,
      this.instanceKeys,
    );
    this.logger.info(
      {
        execution_id: row.execution_id,
        credential_id: report.credential_id,
        client_id: identity.clientId,
        runtime_identity: row.runtime_identity,
      },
      written ? "credential report" : "credential report stale",
    );
    const holder = written ? holderOfRow(tx, report.credential_id) : null;
    if (holder !== null && holder !== SERVER_HOLDER)
      this.instanceCopyRefreshed(holder);
  }

  custodySuitability(
    tx: Transaction,
    req: { credential: string; platform: string },
  ): void {
    const holder = liveHoldersOf(tx, req.credential)[0];
    const row =
      holder === undefined ? undefined : newestLive(tx, req.credential, holder);
    if (!row)
      throw new OperationError(
        HttpStatus.NotFound,
        CustodyErrorCode.NotFound,
        "Credential not found.",
      );
    if (row.platform !== req.platform)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.PlatformMismatch,
        "Credential platform mismatch.",
      );
  }

  pinnedCredentialMetadata(
    tx: Transaction,
    execution: { executionId: string; runtimeIdentity: string },
    credentialName: string,
    now: number,
  ): CredentialMetadata | null {
    const claim = this.executions.requireRunning(
      tx,
      execution.executionId,
      execution.runtimeIdentity,
      now,
    );
    const row = (
      tx.database
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM credential WHERE name = ? ORDER BY holder, revision DESC`,
        )
        .all(credentialName) as CredentialRow[]
    ).find(({ id }) => claim.credentials.includes(id));
    if (!row) return null;
    if (row.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionRevoked,
        "Pinned credential revision is revoked.",
      );
    this.drainRevisions(tx, credentialName, row.holder, now);
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
    };
  }

  credentialMetadata(
    tx: Transaction,
    credentialName: string,
    holder?: string,
  ): CredentialMetadata | null {
    if (holder === undefined)
      return copiesMetadataOf(tx, credentialName)[0] ?? null;
    return metadataOf(tx, credentialName, holder);
  }

  copiesMetadata(
    tx: Transaction,
    credentialName: string,
  ): CredentialMetadata[] {
    return copiesMetadataOf(tx, credentialName);
  }

  copyHeld(tx: Transaction, credentialName: string, holder: string): boolean {
    const row = newestLive(tx, credentialName, holder);
    return row !== undefined && this.sealedCurrent(tx, holder, row.sealed_to);
  }

  heldCopy(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
  ): HeldCopy | null {
    assert.notEqual(holder, SERVER_HOLDER);
    const row = newestLive(tx, credentialName, holder);
    if (!row || !ownedPlatform(set, row.platform)) return null;
    return {
      name: row.name,
      revision: row.revision,
      platform: row.platform,
      sealed_current: this.sealedCurrent(tx, holder, row.sealed_to),
    };
  }

  sealedCopy(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
  ): SealedCopyAnswer {
    assert.notEqual(holder, SERVER_HOLDER);
    const row = newestLive(tx, credentialName, holder);
    if (
      !row ||
      !ownedPlatform(set, row.platform) ||
      !this.sealedCurrent(tx, holder, row.sealed_to)
    )
      throw notFound();
    return {
      name: row.name,
      platform: row.platform,
      revision: row.revision,
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
      sealed: storedSealed(this.envelopeKey, row),
    };
  }

  heldCopies(tx: Transaction, holder: string): HeldCopy[] {
    assert.notEqual(holder, SERVER_HOLDER);
    return (
      tx.database
        .prepare(
          `SELECT ${ROW_COLUMNS} FROM credential AS current WHERE holder = ? AND ended_at IS NULL AND revision = (SELECT MAX(revision) FROM credential WHERE name = current.name AND holder = current.holder AND ended_at IS NULL) ORDER BY name`,
        )
        .all(holder) as CredentialRow[]
    ).map((row) => ({
      name: row.name,
      revision: row.revision,
      platform: row.platform,
      sealed_current: this.sealedCurrent(tx, holder, row.sealed_to),
    }));
  }

  archiveHeld(tx: Transaction, holder: string, now: number): number {
    assert(tx.database.isTransaction);
    assert.notEqual(holder, SERVER_HOLDER);
    return tx.database
      .prepare(
        "UPDATE credential SET ended_at = ? WHERE holder = ? AND ended_at IS NULL",
      )
      .run(now, holder).changes as number;
  }

  private sealedCurrent(
    tx: Transaction,
    holder: string,
    sealedTo: string | null,
  ): boolean {
    if (holder === SERVER_HOLDER) return true;
    return (
      sealedTo !== null &&
      this.instanceKeys.keyOf(tx, holder)?.fingerprint === sealedTo
    );
  }

  private answerOf(
    tx: Transaction,
    name: string,
    holder: string,
  ): CredentialAnswer | null {
    const rows = rowsForName(tx, name, holder);
    if (rows.length === NO_ROWS) return null;
    const live = rows.find(({ ended_at }) => ended_at === null);
    return {
      name,
      platform: rows[0]!.platform,
      holder,
      sealed_to: (live ?? rows[0]!).sealed_to,
      sealed_current:
        holder === SERVER_HOLDER ||
        (live !== undefined && this.sealedCurrent(tx, holder, live.sealed_to)),
      revisions: rows.map((row) => ({
        id: row.id,
        revision: row.revision,
        metadata: row.metadata === null ? null : JSON.parse(row.metadata),
        created_at: row.created_at,
        ended_at: row.ended_at,
      })),
    };
  }

  resourceInventory(
    tx: Transaction,
    set: CredentialPlatformSet,
  ): ResourceEntry[] {
    const rows = tx.database
      .prepare(
        `SELECT ${ROW_COLUMNS}, nonce, ciphertext FROM credential AS current WHERE holder = ? AND ended_at IS NULL AND revision = (SELECT MAX(revision) FROM credential WHERE name = current.name AND holder = current.holder AND ended_at IS NULL) AND platform IN (SELECT value FROM json_each(?)) ORDER BY name`,
      )
      .all(
        SERVER_HOLDER,
        JSON.stringify(Object.keys(set.platforms)),
      ) as LiveRow[];
    return rows.map((row) => {
      const entry = ownedPlatform(set, row.platform)!;
      return {
        scope: HealthScope.Global,
        project: null,
        name: encodeURIComponent(row.name),
        target: `${TARGET_KIND_CREDENTIAL}:${row.id}`,
        capability: entry.capability,
        check: capturedResourceCheck(
          row,
          this.envelopeKey,
          entry,
          this.refreshStoreOf(tx, row, entry),
        ),
      };
    });
  }

  resourceCheck(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): ResourceCheck {
    const row = newestLive(tx, credentialName, SERVER_HOLDER);
    const entry = row && ownedPlatform(set, row.platform);
    if (!row && liveHoldersOf(tx, credentialName).length !== NO_ROWS)
      return heldByInstanceCheck();
    if (!row || !entry) return async () => ResourceStatus.Unknown;
    return capturedResourceCheck(
      row,
      this.envelopeKey,
      entry,
      this.refreshStoreOf(tx, row, entry),
    );
  }

  checkMaterial(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CheckMaterial | null {
    const owner = firstRowOfName(tx, credentialName);
    const entry = owner && ownedPlatform(set, owner.platform);
    if (!entry) return null;
    const row = serverLive(tx, credentialName);
    if (!row) return null;
    const { id, platform, holder } = row;
    const key = this.envelopeKey;
    const nonce = Buffer.from(row.nonce);
    const ciphertext = Buffer.from(row.ciphertext);
    return {
      platform,
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
      secret: () =>
        openSecret(key, { id, platform, holder, nonce, ciphertext }),
      refreshStore: this.refreshStoreOf(tx, row, entry),
    };
  }

  async verify(
    set: CredentialPlatformSet,
    credentialName: string,
    context: Context,
  ): Promise<CredentialCheckAnswer> {
    const { row, entry, refreshStore } = this.store.transaction((tx) => {
      refuseForeign(tx, set, credentialName);
      refuseArchived(tx, credentialName, SERVER_HOLDER);
      const live = serverLive(tx, credentialName);
      if (!live) throw notFound();
      const owned = ownedPlatform(set, live.platform)!;
      if (owned.probe === null)
        throw new OperationError(
          HttpStatus.BadRequest,
          CustodyErrorCode.CheckUnsupported,
          "Unsupported credential check.",
        );
      return {
        row: live,
        entry: owned,
        refreshStore: this.refreshStoreOf(tx, live, owned),
      };
    });
    const deadline = new CancellationContext(
      context,
      Date.now() + CREDENTIAL_CHECK_TIMEOUT_MS,
    );
    let failureReason: ResourceFailureReason | null = null;
    const observe = (reason: string, observed: ResourceFailureReason) => {
      failureReason = observed;
      this.logger.info(
        {
          credential_name: credentialName,
          platform: row.platform,
          reason,
        },
        "credential verify failed",
      );
    };
    try {
      const checked = await Promise.race([
        capturedResourceCheck(
          row,
          this.envelopeKey,
          entry,
          refreshStore,
        )(deadline, observe),
        cancelled(deadline.signal).then(() => ResourceStatus.Unknown),
      ]);
      const status = deadline.signal.aborted ? ResourceStatus.Unknown : checked;
      observeDeadline(deadline, observe);
      return {
        status,
        capability: entry.capability,
        failure_reason: entryFailureReason(status, failureReason),
      };
    } finally {
      deadline.cancel();
    }
  }

  async check(
    set: CredentialPlatformSet,
    body: CredentialCheckBody,
    context: Context,
  ): Promise<CredentialCheckAnswer> {
    const { platform, secret, metadata } = body;
    const entry = ownedPlatform(set, platform);
    if (!entry)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.UnsupportedPlatform,
        "Unsupported platform.",
      );
    const { probe } = entry;
    if (
      probe === null ||
      entry.secret_shape === SecretShape.OAuth ||
      isGenerated(entry)
    )
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.CheckUnsupported,
        "Unsupported credential check.",
      );
    const parsedSecret = secretSchemas[entry.secret_shape].safeParse(secret);
    if (!parsedSecret.success) throw invalidInput();
    const parsedMetadata = validatedMetadata(entry, metadata);
    const deadline = new CancellationContext(
      context,
      Date.now() + CREDENTIAL_CHECK_TIMEOUT_MS,
    );
    let failureReason: ResourceFailureReason | null = null;
    const observe = (reason: string, observed: ResourceFailureReason) => {
      failureReason = observed;
      this.logger.info({ platform, reason }, "credential check failed");
    };
    try {
      const status = await probe(
        parsedSecret.data,
        parsedMetadata,
        deadline,
        observe,
      ).catch(() => {
        this.logger.info(
          { platform, reason: "check failed before the remote call" },
          "credential check failed",
        );
        return ResourceStatus.Unknown;
      });
      if (status === ResourceStatus.Unknown) observeDeadline(deadline, observe);
      return {
        status,
        capability: entry.capability,
        failure_reason: entryFailureReason(status, failureReason),
      };
    } finally {
      deadline.cancel();
    }
  }

  credentialDependents(
    tx: Transaction,
    credentialName: string,
  ): {
    agent_providers: AgentProviderDependent[];
    bindings: BindingRevision[];
    inbounds: InboundDependent[];
  } {
    return {
      agent_providers: this.agentProvidersDependentOn(tx, credentialName),
      bindings: this.bindingsNaming(tx, credentialName).map(
        ({ binding_id, project_id }) => ({ binding_id, project_id }),
      ),
      inbounds: this.inboundsNaming(tx, credentialName),
    };
  }

  create(
    tx: Transaction,
    set: CredentialPlatformSet,
    body: CredentialCreate,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    const { name, platform, secret, metadata } = body;
    const [answer] = this.createCopies(
      tx,
      set,
      { name, platform, metadata, copies: [{ holder: SERVER_HOLDER, secret }] },
      humanIdentity,
    );
    assert(answer);
    return answer;
  }

  createCopies(
    tx: Transaction,
    set: CredentialPlatformSet,
    entry: CredentialEntry,
    humanIdentity: string | undefined,
  ): CredentialAnswer[] {
    const { name, platform, metadata, copies } = entry;
    assert(copies.length > NO_ROWS);
    if (!validateNameForm(name) || isReservedName(name)) throw invalidInput();
    const platformEntry = this.entryForCreate(set, platform);
    const holders = copies.map(({ holder }) => holder);
    if (new Set(holders).size !== holders.length) throw invalidInput();
    for (const holder of holders) this.requireAvailableName(tx, name, holder);
    this.refusePlatformConflict(tx, name, platform);
    const next = validatedMetadata(platformEntry, metadata);
    const now = Date.now();
    for (const copy of copies) {
      set.check_metadata?.(tx, {
        name,
        platform,
        holder: copy.holder,
        change: RevisionChange.Create,
        current: null,
        next,
      });
      const stored = this.storedCopy(tx, set, platformEntry, copy);
      const id = createIdentity(CREDENTIAL_PREFIX);
      const { nonce, ciphertext } = encrypt(
        this.envelopeKey,
        id,
        platform,
        stored.value,
      );
      tx.database
        .prepare(
          "INSERT INTO credential (id, name, platform, holder, sealed_to, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)",
        )
        .run(
          id,
          name,
          platform,
          copy.holder,
          stored.sealed_to,
          FIRST_REVISION,
          nonce,
          ciphertext,
          next === null ? null : canonicalJSON(next),
          now,
        );
      this.logger.info(
        {
          credential_id: id,
          holder: copy.holder,
          human_identity: humanIdentity,
        },
        "credential created",
      );
    }
    return holders.map((holder) => this.answerOf(tx, name, holder)!);
  }

  async sealCopies(
    set: CredentialPlatformSet,
    input: {
      name: string;
      platform: string;
      secret: unknown;
      keys: readonly InstanceKey[];
    },
  ): Promise<SealedCopy[]> {
    const { name, platform, keys } = input;
    if (!set.instance_copies) throw sealedInvalid();
    const entry = this.entryForCreate(set, platform);
    const parsed = secretSchemas[entry.secret_shape].safeParse(input.secret);
    if (!parsed.success) throw invalidInput();
    if (
      Buffer.byteLength(canonicalJSON(parsed.data), UTF8) >
      SEALED_PLAINTEXT_MAX_BYTES
    )
      throw invalidInput();
    const copies: SealedCopy[] = [];
    for (const key of keys) {
      assert.notEqual(key.name, SERVER_HOLDER);
      const sealed = await sealJSON(
        Buffer.from(key.public_key, BASE64URL),
        CREDENTIAL_SEAL_INFO,
        credentialSealAad({
          name,
          platform,
          holder: key.name,
          sealed_to: key.fingerprint,
        }),
        parsed.data,
      );
      copies.push({ holder: key.name, sealed, sealed_to: key.fingerprint });
    }
    return copies;
  }

  private entryForCreate(
    set: CredentialPlatformSet,
    platform: string,
  ): CredentialPlatform {
    const entry = ownedPlatform(set, platform);
    if (!entry)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.UnsupportedPlatform,
        "Unsupported platform.",
      );
    if (entry.secret_shape === SecretShape.OAuth || isGenerated(entry))
      throw unsupportedEntry();
    return entry;
  }

  private storedCopy(
    tx: Transaction,
    set: CredentialPlatformSet,
    entry: CredentialPlatform,
    copy: CredentialCopy,
  ): { value: unknown; sealed_to: string | null } {
    if ("secret" in copy) {
      if (copy.holder !== SERVER_HOLDER) throw sealedInvalid();
      const parsed = secretSchemas[entry.secret_shape].safeParse(copy.secret);
      if (!parsed.success) throw invalidInput();
      return { value: parsed.data, sealed_to: null };
    }
    this.refuseSealedCopy(tx, set, copy);
    return { value: copy.sealed, sealed_to: copy.sealed_to };
  }

  private refuseSealedCopy(
    tx: Transaction,
    set: CredentialPlatformSet,
    copy: SealedCopy,
  ): void {
    if (!set.instance_copies || copy.holder === SERVER_HOLDER)
      throw sealedInvalid();
    const sealed = sealedObjectSchema.safeParse(copy.sealed);
    if (
      !sealed.success ||
      Buffer.from(sealed.data.ciphertext, BASE64URL).length >
        SEALED_CIPHERTEXT_MAX_BYTES ||
      !credentialSealedToSchema.safeParse(copy.sealed_to).success ||
      this.instanceKeys.keyOf(tx, copy.holder)?.fingerprint !== copy.sealed_to
    )
      throw sealedInvalid();
  }

  private refusePlatformConflict(
    tx: Transaction,
    name: string,
    platform: string,
  ): void {
    const row = firstRowOfName(tx, name);
    if (row && row.platform !== platform)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.PlatformConflict,
        "The credential name holds another platform.",
        { platform: row.platform },
      );
  }

  copyPlatform(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
  ): string {
    refuseForeign(tx, set, credentialName);
    const [row] = rowsForName(tx, credentialName, holder);
    if (!row) throw notFound();
    return row.platform;
  }

  get(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string = SERVER_HOLDER,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    this.drainRevisions(tx, credentialName, holder, Date.now());
    const answer = this.answerOf(tx, credentialName, holder);
    if (answer === null) throw notFound();
    return answer;
  }

  list(
    tx: Transaction,
    set: CredentialPlatformSet,
    query: CredentialListQuery & { holder?: string },
  ): CredentialListAnswer {
    const {
      platform,
      holder,
      include_archived: includeArchived,
      limit: requestedLimit,
      cursor,
    } = query;
    const after =
      cursor === undefined ? { name: "", holder: "" } : decodeCursor(cursor);
    const limit = requestedLimit ?? LIST_LIMIT_DEFAULT;
    const groups = tx.database
      .prepare(
        "SELECT name, holder FROM credential WHERE (name > ? OR (name = ? AND holder > ?)) AND (? IS NULL OR platform = ?) AND (? IS NULL OR holder = ?) AND platform IN (SELECT value FROM json_each(?)) GROUP BY name, holder HAVING (? = 1 OR MAX(ended_at IS NULL) = 1) ORDER BY name ASC, holder ASC LIMIT ?",
      )
      .all(
        after.name,
        after.name,
        after.holder,
        platform ?? null,
        platform ?? null,
        holder ?? null,
        holder ?? null,
        JSON.stringify(Object.keys(set.platforms)),
        includeArchived === QUERY_TRUE ? INCLUDE : EXCLUDE,
        limit + EXTRA_ROW,
      ) as { name: string; holder: string }[];
    const page = groups.slice(NO_ROWS, limit);
    const now = Date.now();
    for (const group of page)
      this.drainRevisions(tx, group.name, group.holder, now);
    const items = page.map((group) =>
      this.answerOf(tx, group.name, group.holder)!,
    );
    const last = page.at(-1);
    const nextCursor =
      groups.length > limit && last
        ? encodeCursor(last.name, last.holder)
        : null;
    return { items, next_cursor: nextCursor };
  }

  private insertRevision(
    tx: Transaction,
    row: LiveRow,
    id: string,
    value: unknown,
    sealedTo: string | null,
    metadata: Record<string, unknown> | null,
    now: number,
  ): void {
    const { nonce, ciphertext } = encrypt(
      this.envelopeKey,
      id,
      row.platform,
      value,
    );
    tx.database
      .prepare(
        "INSERT INTO credential (id, name, platform, holder, sealed_to, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, (SELECT MAX(revision) + 1 FROM credential WHERE name = ? AND holder = ?), ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        row.name,
        row.platform,
        row.holder,
        sealedTo,
        row.name,
        row.holder,
        nonce,
        ciphertext,
        metadata === null ? null : canonicalJSON(metadata),
        now,
      );
  }

  private drainRevisions(
    tx: Transaction,
    name: string,
    holder: string,
    now: number,
  ): void {
    const rows = rowsForName(tx, name, holder).filter(
      (row) => row.ended_at === null,
    );
    for (const row of rows.slice(FIRST_REVISION)) {
      if (this.executions.liveExecutionsPinning(tx, row.id).length !== NO_ROWS)
        continue;
      tx.database
        .prepare("UPDATE credential SET ended_at = ? WHERE id = ?")
        .run(now, row.id);
    }
  }

  rotate(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialRotateBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const row = requireLive(
      tx,
      credentialName,
      SERVER_HOLDER,
      body.expected_revision,
    );
    const entry = ownedPlatform(set, row.platform)!;
    if (isGenerated(entry)) throw unsupportedEntry();
    const secret = secretSchemas[entry.secret_shape].safeParse(body.secret);
    if (!secret.success) throw invalidInput();
    return this.insertRotation(
      tx,
      set,
      entry,
      row,
      { value: secret.data, sealed_to: null },
      body.metadata,
      humanIdentity,
    );
  }

  rotateSealed(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string,
    body: SealedRotateBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const row = requireLive(tx, credentialName, holder, body.expected_revision);
    const entry = ownedPlatform(set, row.platform)!;
    if (isGenerated(entry)) throw unsupportedEntry();
    const copy = { holder, sealed: body.sealed, sealed_to: body.sealed_to };
    this.refuseSealedCopy(tx, set, copy);
    return this.insertRotation(
      tx,
      set,
      entry,
      row,
      { value: copy.sealed, sealed_to: copy.sealed_to },
      body.metadata,
      humanIdentity,
    );
  }

  private insertRotation(
    tx: Transaction,
    set: CredentialPlatformSet,
    entry: CredentialPlatform,
    row: LiveRow,
    stored: { value: unknown; sealed_to: string | null },
    replacement: unknown,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    const current = parsedMetadata(row);
    const metadata = validatedMetadata(
      entry,
      replacement === undefined ? current : replacement,
    );
    set.check_metadata?.(tx, {
      name: row.name,
      platform: row.platform,
      holder: row.holder,
      change: RevisionChange.Rotate,
      current,
      next: metadata,
    });
    const id = createIdentity(CREDENTIAL_PREFIX);
    const now = Date.now();
    this.insertRevision(
      tx,
      row,
      id,
      stored.value,
      stored.sealed_to,
      metadata,
      now,
    );
    this.drainRevisions(tx, row.name, row.holder, now);
    this.logger.info(
      { credential_id: id, holder: row.holder, human_identity: humanIdentity },
      "credential rotated",
    );
    return this.answerOf(tx, row.name, row.holder)!;
  }

  updateMetadata(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialUpdateMetadataBody,
    humanIdentity: string | undefined,
    holder: string = SERVER_HOLDER,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const row = requireLive(tx, credentialName, holder, body.expected_revision);
    const entry = ownedPlatform(set, row.platform)!;
    if (isGenerated(entry)) throw unsupportedEntry();
    const metadata = validatedMetadata(entry, body.metadata);
    set.check_metadata?.(tx, {
      name: row.name,
      platform: row.platform,
      holder: row.holder,
      change: RevisionChange.Metadata,
      current: parsedMetadata(row),
      next: metadata,
    });
    const id = createIdentity(CREDENTIAL_PREFIX);
    const value =
      row.holder === SERVER_HOLDER
        ? openSecret(this.envelopeKey, row)
        : storedSealed(this.envelopeKey, row);
    this.insertRevision(
      tx,
      row,
      id,
      value,
      row.sealed_to,
      metadata,
      Date.now(),
    );
    this.logger.info(
      { credential_id: id, holder: row.holder, human_identity: humanIdentity },
      "credential metadata updated",
    );
    return this.answerOf(tx, row.name, row.holder)!;
  }

  revoke(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    revision: number,
    holder: string = SERVER_HOLDER,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const now = Date.now();
    const row = tx.database
      .prepare(
        "SELECT id, ended_at FROM credential WHERE name = ? AND holder = ? AND revision = ?",
      )
      .get(credentialName, holder, revision) as
      { id: string; ended_at: number | null } | undefined;
    if (!row)
      throw new OperationError(
        HttpStatus.NotFound,
        CustodyErrorCode.RevisionNotFound,
        "Credential revision not found.",
      );
    if (row.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionEnded,
        "Credential revision already ended.",
      );
    const later = tx.database
      .prepare(
        "SELECT id FROM credential WHERE name = ? AND holder = ? AND revision > ? AND ended_at IS NULL LIMIT 1",
      )
      .get(credentialName, holder, revision);
    if (!later)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.NewestLive,
        "Cannot revoke the newest live credential revision.",
      );
    tx.database
      .prepare("UPDATE credential SET ended_at = ? WHERE id = ?")
      .run(now, row.id);
    this.drainRevisions(tx, credentialName, holder, now);
    return this.answerOf(tx, credentialName, holder)!;
  }

  archive(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    holder: string = SERVER_HOLDER,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    refuseArchived(tx, credentialName, holder);
    if (rowsForName(tx, credentialName, holder).length === NO_ROWS)
      throw notFound();
    const dependents =
      holder === SERVER_HOLDER
        ? this.credentialDependents(tx, credentialName)
        : {
            agent_providers: [],
            bindings: this.bindingsListingInstance(tx, holder, credentialName),
            inbounds: [],
          };
    if (
      dependents.agent_providers.length +
        dependents.bindings.length +
        dependents.inbounds.length >
      NO_ROWS
    )
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.InUse,
        "Credential is in use.",
        dependents,
      );
    tx.database
      .prepare(
        "UPDATE credential SET ended_at = ? WHERE name = ? AND holder = ? AND ended_at IS NULL",
      )
      .run(Date.now(), credentialName, holder);
    return this.answerOf(tx, credentialName, holder)!;
  }

  requireAvailableName(
    tx: Transaction,
    name: string,
    holder: string = SERVER_HOLDER,
  ): void {
    requireNameForm(name);
    const existing = rowsForName(tx, name, holder);
    if (existing.length !== NO_ROWS)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.Conflict,
        "Credential name already exists.",
        { id: existing[0]!.id },
      );
  }

  requireLoginTarget(tx: Transaction, name: string, holder: string): void {
    if (holder === SERVER_HOLDER) {
      this.requireAvailableName(tx, name);
      return;
    }
    requireNameForm(name);
    refuseArchived(tx, name, holder);
    const row = newestLive(tx, name, holder);
    if (row && this.sealedCurrent(tx, holder, row.sealed_to))
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.Conflict,
        "Credential name already exists.",
        { id: row.id },
      );
  }

  createLoginRevision(
    tx: Transaction,
    set: CredentialPlatformSet,
    name: string,
    platform: string,
    copy: CredentialCopy,
    now: number,
  ): string {
    const entry = ownedPlatform(set, platform);
    assert.ok(entry);
    assert.equal(entry.secret_shape, SecretShape.OAuth);
    this.requireLoginTarget(tx, name, copy.holder);
    this.refusePlatformConflict(tx, name, platform);
    const stored = this.storedCopy(tx, set, entry, copy);
    const id = createIdentity(CREDENTIAL_PREFIX);
    const stale = newestLive(tx, name, copy.holder);
    if (stale) {
      this.insertRevision(
        tx,
        stale,
        id,
        stored.value,
        stored.sealed_to,
        parsedMetadata(stale),
        now,
      );
      this.drainRevisions(tx, name, copy.holder, now);
      return id;
    }
    const { nonce, ciphertext } = encrypt(
      this.envelopeKey,
      id,
      platform,
      stored.value,
    );
    tx.database
      .prepare(
        "INSERT INTO credential (id, name, platform, holder, sealed_to, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL)",
      )
      .run(
        id,
        name,
        platform,
        copy.holder,
        stored.sealed_to,
        FIRST_REVISION,
        nonce,
        ciphertext,
        now,
      );
    return id;
  }

  createGenerated(
    tx: Transaction,
    set: CredentialPlatformSet,
    body: GeneratedCreate,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    const { name, platform } = body;
    const entry = ownedPlatform(set, platform);
    assert(entry !== undefined && isGenerated(entry));
    this.requireAvailableName(tx, name);
    this.refusePlatformConflict(tx, name, platform);
    const { secret, metadata } = this.generatedRevision(
      entry,
      body.generate(name),
    );
    const id = createIdentity(CREDENTIAL_PREFIX);
    const { nonce, ciphertext } = encrypt(
      this.envelopeKey,
      id,
      platform,
      secret,
    );
    tx.database
      .prepare(
        "INSERT INTO credential (id, name, platform, holder, sealed_to, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        name,
        platform,
        SERVER_HOLDER,
        FIRST_REVISION,
        nonce,
        ciphertext,
        canonicalJSON(metadata),
        Date.now(),
      );
    this.logger.info(
      { credential_id: id, human_identity: humanIdentity },
      "credential created",
    );
    return this.answerOf(tx, name, SERVER_HOLDER)!;
  }

  rotateGenerated(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: GeneratedRotate,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const row = requireLive(
      tx,
      credentialName,
      SERVER_HOLDER,
      body.expected_revision,
    );
    const entry = ownedPlatform(set, row.platform)!;
    if (!isGenerated(entry)) throw unsupportedEntry();
    const { secret, metadata } = this.generatedRevision(
      entry,
      body.generate(row.name),
    );
    const id = createIdentity(CREDENTIAL_PREFIX);
    const now = Date.now();
    this.insertRevision(tx, row, id, secret, null, metadata, now);
    this.drainRevisions(tx, row.name, row.holder, now);
    this.logger.info(
      { credential_id: id, human_identity: humanIdentity },
      "credential rotated",
    );
    return this.answerOf(tx, row.name, row.holder)!;
  }

  private generatedRevision(
    entry: CredentialPlatform,
    generated: GeneratedRevision,
  ): { secret: unknown; metadata: Record<string, unknown> } {
    assert(isGenerated(entry));
    const secret = secretSchemas[entry.secret_shape].parse(generated.secret);
    const metadata = validatedMetadata(entry, generated.metadata);
    assert(metadata !== null);
    return { secret, metadata };
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
      return Promise.resolve(
        new Diagnostic(
          CustodyErrorCode.Stopped,
          "custody: a stopped service cannot start again.",
        ),
      );
    this.startTask ??= Promise.resolve(null);
    this.started = true;
    return this.startTask;
  }
  quiesce(): Promise<Error | null> {
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    this.stopTask ??= Promise.resolve(null);
    return this.stopTask;
  }
  async run(context: Context = background): Promise<Error | null> {
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    const error = await this.start();
    if (error) return error;
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? reasonOf(context.signal);
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      credential:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
