import assert from "node:assert/strict";
import type { Logger } from "pino";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { isHumanIdentity, type MachineIdentity } from "../kernel/caller.ts";
import {
  HealthScope,
  ResourceStatus,
  type HealthRegistry,
  type ResourceCheck,
  type ResourceEntry,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON, digest } from "../kernel/json.ts";
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
  type CredentialListAnswer,
  type CredentialListQuery,
  type CredentialMetadata,
  type CredentialPlatform,
  type CredentialPlatforms,
  type CredentialPlatformSet,
  type CredentialRecords,
  type CredentialRotateBody,
  type CredentialUpdateMetadataBody,
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
  type Material,
  piCredentialSchema,
  type WorkbenchCredentialsInput,
  type WorkbenchGrant,
} from "./contract.ts";
import {
  consumeGrant,
  consumeWorkbenchGrant,
  FacilityError,
  mintGrant,
  mintWorkbenchGrant,
  MaterialBuffer,
} from "./facility.ts";
import { credentialOfSecret } from "./payload.ts";
import { ExecutionStoreError } from "./execution-store.ts";
import { workbenchCredentialStore } from "./workbench-store.ts";
import {
  sealMaterial,
  openReport,
  applyReport,
  REVISION_REVOKED,
} from "./handover.ts";
import type { HandoverEnvelope } from "../kernel/handover.ts";
import { decrypt, encrypt } from "./envelope.ts";
import { isReservedName, validateNameForm } from "./names.ts";

export interface Dependencies {
  executions: CustodyExecutions;
  authorization: CustodyAuthorization;
  clientSecret: (clientId: string) => string;
  store: Store;
  platforms: CredentialPlatforms;
  envelopeKey: Buffer;
  logger: Logger;
  health?: HealthRegistry;
  agentProvidersDependentOn: AgentProvidersDependentOnFn;
  bindingsNaming: BindingsNamingFn;
  inboundsNaming: InboundsNamingFn;
}

const CustodyErrorCode = {
  Stopped: "custody.lifecycle.stopped",
  Invalid: "credential.input.invalid",
  UnsupportedPlatform: "credential.platform.unsupported",
  UnsupportedEntry: "credential.entry.unsupported",
  Conflict: "credential.name.conflict",
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

type CredentialRow = {
  id: string;
  name: string;
  platform: string;
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
): ResourceCheck {
  const { id, platform } = row;
  const { probe } = entry;
  const nonce = Buffer.from(row.nonce);
  const ciphertext = Buffer.from(row.ciphertext);
  const metadata: unknown =
    row.metadata === null ? null : JSON.parse(row.metadata);
  return async (context, observe) => {
    if (context.err()) return ResourceStatus.Unknown;
    try {
      if (probe === null) return ResourceStatus.Unknown;
      const secret = decrypt(key, id, platform, nonce, ciphertext);
      return await probe(secret, metadata, context, observe);
    } catch {
      observe?.("probe failed before the remote call");
      return ResourceStatus.Unknown;
    }
  };
}

function newestLive(tx: Transaction, name: string): LiveRow | undefined {
  return tx.database
    .prepare(
      "SELECT id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at FROM credential WHERE name = ? AND ended_at IS NULL ORDER BY revision DESC LIMIT 1",
    )
    .get(name) as LiveRow | undefined;
}

function refuseArchived(tx: Transaction, name: string): void {
  const rows = rowsForName(tx, name);
  if (rows.length !== NO_ROWS && rows.every((row) => row.ended_at !== null))
    throw new OperationError(
      HttpStatus.Conflict,
      CustodyErrorCode.Archived,
      "Credential is archived.",
    );
}

function requireLive(tx: Transaction, name: string, expected: number): LiveRow {
  refuseArchived(tx, name);
  const row = newestLive(tx, name);
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
  const row = rowsForName(tx, name)[0];
  if (row && !ownedPlatform(set, row.platform)) throw notFound();
}

function parsedMetadata(row: CredentialRow): Record<string, unknown> | null {
  return row.metadata === null ? null : JSON.parse(row.metadata);
}

function invalidInput(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CustodyErrorCode.Invalid,
    "Invalid input.",
  );
}

function rowsForName(tx: Transaction, name: string): CredentialRow[] {
  return tx.database
    .prepare(
      "SELECT id, name, platform, revision, metadata, created_at, ended_at FROM credential WHERE name = ? ORDER BY revision DESC",
    )
    .all(name) as CredentialRow[];
}

function answerForName(tx: Transaction, name: string): CredentialAnswer | null {
  const rows = rowsForName(tx, name);
  if (rows.length === NO_ROWS) return null;
  return {
    name,
    platform: rows[0]!.platform,
    revisions: rows.map((row) => ({
      id: row.id,
      revision: row.revision,
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
      created_at: row.created_at,
      ended_at: row.ended_at,
    })),
  };
}

function decodeCursor(cursor: string): string {
  if (!CURSOR_PATTERN.test(cursor))
    throw new OperationError(
      HttpStatus.BadRequest,
      CustodyErrorCode.InvalidCursor,
      "Invalid cursor.",
    );
  const name = Buffer.from(cursor, "base64url").toString("utf8");
  if (
    !validateNameForm(name) ||
    Buffer.from(name, "utf8").toString("base64url") !== cursor
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      CustodyErrorCode.InvalidCursor,
      "Invalid cursor.",
    );
  return name;
}

export class CustodyComponent implements Service, CredentialRecords {
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
  private readonly clientSecret: (clientId: string) => string;

  constructor(dependencies: Dependencies) {
    this.executions = dependencies.executions;
    this.authorization = dependencies.authorization;
    this.clientSecret = dependencies.clientSecret;
    this.store = dependencies.store;
    this.platforms = dependencies.platforms;
    this.envelopeKey = dependencies.envelopeKey;
    this.logger = dependencies.logger;
    this.agentProvidersDependentOn = dependencies.agentProvidersDependentOn;
    this.bindingsNaming = dependencies.bindingsNaming;
    this.inboundsNaming = dependencies.inboundsNaming;
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
      .map(({ credential, platform }) =>
        mintGrant({ credential, platform, execution }),
      );
  }

  release(tx: Transaction, grant: Grant, now: number): Material {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    consumeGrant(grant);
    const rows = rowsForName(tx, grant.credential);
    let row = rows.find((candidate) =>
      grant.execution.credentials.includes(candidate.id),
    );
    if (row && row.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionRevoked,
        "The pinned credential revision is revoked.",
      );
    if (!row) {
      row = rows.find((candidate) => candidate.ended_at === null);
      if (!row)
        throw new OperationError(
          HttpStatus.NotFound,
          CustodyErrorCode.NotFound,
          "Credential not found.",
        );
      this.executions.pinCredential(tx, grant.execution.execution_id, row.id);
      this.drainRevisions(tx, row.name, now);
    }
    if (row.platform !== grant.platform)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.PlatformMismatch,
        "Credential platform mismatch.",
      );
    const encrypted = tx.database
      .prepare("SELECT nonce, ciphertext FROM credential WHERE id = ?")
      .get(row.id) as { nonce: Buffer; ciphertext: Buffer };
    assert(encrypted);
    return new MaterialBuffer(
      row.id,
      row.platform,
      decrypt(
        this.envelopeKey,
        row.id,
        row.platform,
        encrypted.nonce,
        encrypted.ciphertext,
      ),
    );
  }

  private workbenchRow(tx: Transaction, grant: WorkbenchGrant): LiveRow {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    consumeWorkbenchGrant(grant);
    const row = newestLive(tx, grant.credential);
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
      decrypt(
        this.envelopeKey,
        row.id,
        row.platform,
        row.nonce,
        row.ciphertext,
      ),
    );
  }

  workbenchCredentials(input: WorkbenchCredentialsInput) {
    assert(Object.hasOwn(this.platforms, input.platform));
    const shape = this.platforms[input.platform]!.secret_shape;
    assert(shape === SecretShape.ApiKey || shape === SecretShape.OAuth);
    const grant = (tx: Transaction): WorkbenchGrant => {
      const requester = input.requester();
      if (!isHumanIdentity(requester)) throw new FacilityError();
      const { credential, platform } = input.authorize(
        tx,
        requester,
        input.session_id,
      );
      if (platform !== input.platform) throw new FacilityError();
      return mintWorkbenchGrant({
        credential,
        platform,
        session_id: input.session_id,
      });
    };
    return workbenchCredentialStore({
      providerId: input.platform,
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
        this.store.transaction((tx) => {
          const row = this.workbenchRow(tx, grant(tx));
          if (this.executions.liveExecutionsPinning(tx, row.id).length)
            throw new ExecutionStoreError(
              "A live execution holds the credential revision.",
            );
          applyReport(
            tx,
            this.envelopeKey,
            {
              credential_id: row.id,
              digest: digest(current),
              credential: piCredentialSchema.parse(next),
            },
            this.platforms,
          );
        }),
    });
  }

  handover(
    tx: Transaction,
    identity: MachineIdentity,
    execution: { executionId: string; runtimeIdentity: string },
    now: number,
  ): HandoverEnvelope {
    const row = this.executions.requireRunning(
      tx,
      execution.executionId,
      execution.runtimeIdentity,
      now,
    );
    const materials: Material[] = [];
    try {
      for (const grant of this.authorize(tx, identity, row))
        materials.push(this.release(tx, grant, now));
      const envelope = sealMaterial(
        this.clientSecret(identity.clientId),
        row,
        materials,
        this.platforms,
      );
      for (const material of materials)
        this.logger.info(
          {
            execution_id: row.execution_id,
            worker_binding_id: row.worker_binding_id,
            credential_id: material.credential_id,
          },
          "credential handover",
        );
      return envelope;
    } finally {
      for (const material of materials) material.drop();
    }
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
    const written = applyReport(tx, this.envelopeKey, report, this.platforms);
    this.logger.info(
      { execution_id: row.execution_id, credential_id: report.credential_id },
      written ? "credential report" : "credential report stale",
    );
  }

  custodySuitability(
    tx: Transaction,
    req: { credential: string; platform: string },
  ): void {
    const row = newestLive(tx, req.credential);
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
    const row = rowsForName(tx, credentialName).find(({ id }) =>
      claim.credentials.includes(id),
    );
    if (!row) return null;
    if (row.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.RevisionRevoked,
        "Pinned credential revision is revoked.",
      );
    this.drainRevisions(tx, credentialName, now);
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
  ): CredentialMetadata | null {
    const row = newestLive(tx, credentialName);
    if (!row) return null;
    return {
      id: row.id,
      name: row.name,
      platform: row.platform,
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
    };
  }

  resourceInventory(
    tx: Transaction,
    set: CredentialPlatformSet,
  ): ResourceEntry[] {
    const rows = tx.database
      .prepare(
        "SELECT id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at FROM credential AS current WHERE ended_at IS NULL AND revision = (SELECT MAX(revision) FROM credential WHERE name = current.name AND ended_at IS NULL) AND platform IN (SELECT value FROM json_each(?)) ORDER BY name",
      )
      .all(JSON.stringify(Object.keys(set.platforms))) as LiveRow[];
    return rows.map((row) => {
      const entry = ownedPlatform(set, row.platform)!;
      return {
        scope: HealthScope.Global,
        project: null,
        name: encodeURIComponent(row.name),
        target: `${TARGET_KIND_CREDENTIAL}:${row.id}`,
        capability: entry.capability,
        check: capturedResourceCheck(row, this.envelopeKey, entry),
      };
    });
  }

  resourceCheck(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): ResourceCheck {
    const row = newestLive(tx, credentialName);
    const entry = row && ownedPlatform(set, row.platform);
    if (!row || !entry) return async () => ResourceStatus.Unknown;
    return capturedResourceCheck(row, this.envelopeKey, entry);
  }

  checkMaterial(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CheckMaterial | null {
    const row = newestLive(tx, credentialName);
    if (!row || !ownedPlatform(set, row.platform)) return null;
    const { id, platform } = row;
    const key = this.envelopeKey;
    const nonce = Buffer.from(row.nonce);
    const ciphertext = Buffer.from(row.ciphertext);
    return {
      platform,
      metadata: row.metadata === null ? null : JSON.parse(row.metadata),
      secret: () => decrypt(key, id, platform, nonce, ciphertext),
    };
  }

  async verify(
    set: CredentialPlatformSet,
    credentialName: string,
    context: Context,
  ): Promise<CredentialCheckAnswer> {
    const { row, entry } = this.store.transaction((tx) => {
      refuseForeign(tx, set, credentialName);
      refuseArchived(tx, credentialName);
      const live = newestLive(tx, credentialName);
      if (!live) throw notFound();
      const owned = ownedPlatform(set, live.platform)!;
      if (owned.probe === null)
        throw new OperationError(
          HttpStatus.BadRequest,
          CustodyErrorCode.CheckUnsupported,
          "Unsupported credential check.",
        );
      return { row: live, entry: owned };
    });
    const deadline = new CancellationContext(
      context,
      Date.now() + CREDENTIAL_CHECK_TIMEOUT_MS,
    );
    try {
      const status = await Promise.race([
        capturedResourceCheck(
          row,
          this.envelopeKey,
          entry,
        )(deadline, (reason) =>
          this.logger.info(
            { credential: credentialName, platform: row.platform, reason },
            "credential verify failed",
          ),
        ),
        deadline.done().then(() => ResourceStatus.Unknown),
      ]);
      return {
        status: deadline.err() ? ResourceStatus.Unknown : status,
        capability: entry.capability,
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
    if (probe === null || entry.secret_shape === SecretShape.OAuth)
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
    try {
      const status = await probe(
        parsedSecret.data,
        parsedMetadata,
        deadline,
        (reason) =>
          this.logger.info({ platform, reason }, "credential check failed"),
      ).catch(() => {
        this.logger.info(
          { platform, reason: "check failed before the remote call" },
          "credential check failed",
        );
        return ResourceStatus.Unknown;
      });
      return { status, capability: entry.capability };
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
    if (!validateNameForm(name) || isReservedName(name)) throw invalidInput();
    const entry = ownedPlatform(set, platform);
    if (!entry)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.UnsupportedPlatform,
        "Unsupported platform.",
      );
    if (entry.secret_shape === SecretShape.OAuth)
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.UnsupportedEntry,
        "Unsupported credential entry.",
      );
    this.requireAvailableName(tx, name);
    const parsedSecret = secretSchemas[entry.secret_shape].safeParse(secret);
    if (!parsedSecret.success) throw invalidInput();
    const next = validatedMetadata(entry, metadata);
    set.check_metadata?.(tx, {
      name,
      platform,
      change: RevisionChange.Create,
      current: null,
      next,
    });
    const id = createIdentity(CREDENTIAL_PREFIX);
    const { nonce, ciphertext } = encrypt(
      this.envelopeKey,
      id,
      platform,
      parsedSecret.data,
    );
    tx.database
      .prepare(
        "INSERT INTO credential (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        name,
        platform,
        FIRST_REVISION,
        nonce,
        ciphertext,
        next === null ? null : canonicalJSON(next),
        Date.now(),
      );
    this.logger.info(
      { credential_id: id, human_identity: humanIdentity },
      "credential created",
    );
    return answerForName(tx, name)!;
  }

  get(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    this.drainRevisions(tx, credentialName, Date.now());
    const answer = answerForName(tx, credentialName);
    if (answer === null) throw notFound();
    return answer;
  }

  list(
    tx: Transaction,
    set: CredentialPlatformSet,
    query: CredentialListQuery,
  ): CredentialListAnswer {
    const {
      platform,
      include_archived: includeArchived,
      limit: requestedLimit,
      cursor,
    } = query;
    const after = cursor === undefined ? "" : decodeCursor(cursor);
    const limit = requestedLimit ?? LIST_LIMIT_DEFAULT;
    const names = tx.database
      .prepare(
        "SELECT name FROM credential WHERE name > ? AND (? IS NULL OR platform = ?) AND platform IN (SELECT value FROM json_each(?)) GROUP BY name HAVING (? = 1 OR MAX(ended_at IS NULL) = 1) ORDER BY name ASC LIMIT ?",
      )
      .all(
        after,
        platform ?? null,
        platform ?? null,
        JSON.stringify(Object.keys(set.platforms)),
        includeArchived === QUERY_TRUE ? INCLUDE : EXCLUDE,
        limit + EXTRA_ROW,
      ) as {
      name: string;
    }[];
    const page = names.slice(NO_ROWS, limit);
    const now = Date.now();
    for (const { name } of page) this.drainRevisions(tx, name, now);
    const items = page.map(({ name }) => answerForName(tx, name)!);
    const nextCursor =
      names.length > limit
        ? Buffer.from(page.at(-1)!.name, "utf8").toString("base64url")
        : null;
    return { items, next_cursor: nextCursor };
  }

  private insertRevision(
    tx: Transaction,
    row: LiveRow,
    id: string,
    secret: unknown,
    metadata: Record<string, unknown> | null,
    now: number,
  ): void {
    const { nonce, ciphertext } = encrypt(
      this.envelopeKey,
      id,
      row.platform,
      secret,
    );
    tx.database
      .prepare(
        "INSERT INTO credential (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, (SELECT MAX(revision) + 1 FROM credential WHERE name = ?), ?, ?, ?, ?, NULL)",
      )
      .run(
        id,
        row.name,
        row.platform,
        row.name,
        nonce,
        ciphertext,
        metadata === null ? null : canonicalJSON(metadata),
        now,
      );
  }

  private drainRevisions(tx: Transaction, name: string, now: number): void {
    const rows = rowsForName(tx, name).filter((row) => row.ended_at === null);
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
    const row = requireLive(tx, credentialName, body.expected_revision);
    const entry = ownedPlatform(set, row.platform)!;
    const secret = secretSchemas[entry.secret_shape].safeParse(body.secret);
    if (!secret.success) throw invalidInput();
    const current = parsedMetadata(row);
    const metadata = validatedMetadata(
      entry,
      body.metadata === undefined ? current : body.metadata,
    );
    set.check_metadata?.(tx, {
      name: row.name,
      platform: row.platform,
      change: RevisionChange.Rotate,
      current,
      next: metadata,
    });
    const id = createIdentity(CREDENTIAL_PREFIX);
    const now = Date.now();
    this.insertRevision(tx, row, id, secret.data, metadata, now);
    this.drainRevisions(tx, row.name, now);
    this.logger.info(
      { credential_id: id, human_identity: humanIdentity },
      "credential rotated",
    );
    return answerForName(tx, row.name)!;
  }

  updateMetadata(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    body: CredentialUpdateMetadataBody,
    humanIdentity: string | undefined,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const row = requireLive(tx, credentialName, body.expected_revision);
    const entry = ownedPlatform(set, row.platform)!;
    const metadata = validatedMetadata(entry, body.metadata);
    set.check_metadata?.(tx, {
      name: row.name,
      platform: row.platform,
      change: RevisionChange.Metadata,
      current: parsedMetadata(row),
      next: metadata,
    });
    const id = createIdentity(CREDENTIAL_PREFIX);
    const secret = decrypt(
      this.envelopeKey,
      row.id,
      row.platform,
      row.nonce,
      row.ciphertext,
    );
    this.insertRevision(tx, row, id, secret, metadata, Date.now());
    this.logger.info(
      { credential_id: id, human_identity: humanIdentity },
      "credential metadata updated",
    );
    return answerForName(tx, row.name)!;
  }

  revoke(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
    revision: number,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    const now = Date.now();
    const row = tx.database
      .prepare(
        "SELECT id, ended_at FROM credential WHERE name = ? AND revision = ?",
      )
      .get(credentialName, revision) as
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
        "SELECT id FROM credential WHERE name = ? AND revision > ? AND ended_at IS NULL LIMIT 1",
      )
      .get(credentialName, revision);
    if (!later)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.NewestLive,
        "Cannot revoke the newest live credential revision.",
      );
    tx.database
      .prepare("UPDATE credential SET ended_at = ? WHERE id = ?")
      .run(now, row.id);
    this.drainRevisions(tx, credentialName, now);
    return answerForName(tx, credentialName)!;
  }

  archive(
    tx: Transaction,
    set: CredentialPlatformSet,
    credentialName: string,
  ): CredentialAnswer {
    refuseForeign(tx, set, credentialName);
    refuseArchived(tx, credentialName);
    if (rowsForName(tx, credentialName).length === NO_ROWS) throw notFound();
    const dependents = this.credentialDependents(tx, credentialName);
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
        "UPDATE credential SET ended_at = ? WHERE name = ? AND ended_at IS NULL",
      )
      .run(Date.now(), credentialName);
    return answerForName(tx, credentialName)!;
  }

  requireAvailableName(tx: Transaction, name: string): void {
    if (!validateNameForm(name) || isReservedName(name)) throw invalidInput();
    const existing = rowsForName(tx, name);
    if (existing.length !== NO_ROWS)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.Conflict,
        "Credential name already exists.",
        { id: existing[0]!.id },
      );
  }

  createLoginRevision(
    tx: Transaction,
    set: CredentialPlatformSet,
    name: string,
    platform: string,
    secret: unknown,
    now: number,
  ): string {
    const entry = ownedPlatform(set, platform);
    assert.equal(entry?.secret_shape, SecretShape.OAuth);
    this.requireAvailableName(tx, name);
    const parsedSecret = secretSchemas[entry.secret_shape].safeParse(secret);
    if (!parsedSecret.success) throw invalidInput();
    const id = createIdentity(CREDENTIAL_PREFIX);
    const { nonce, ciphertext } = encrypt(
      this.envelopeKey,
      id,
      platform,
      parsedSecret.data,
    );
    tx.database
      .prepare(
        "INSERT INTO credential (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)",
      )
      .run(id, name, platform, FIRST_REVISION, nonce, ciphertext, now);
    return id;
  }

  start(): Promise<Error | null> {
    if (this.shutdown.err())
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
    const unsubscribe = context.onCancel(() => {
      void this.stop();
    });
    try {
      if (context.err()) return (await this.stop()) ?? context.err();
      const error = await this.start();
      if (error) return error;
      await this.shutdown.done();
      return (await this.stop()) ?? context.err();
    } finally {
      unsubscribe();
    }
  }
  async healthcheck(): Promise<Healthcheck> {
    return {
      credential:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
