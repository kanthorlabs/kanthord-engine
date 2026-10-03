import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { IdentityKind, type MachineIdentity } from "../kernel/caller.ts";
import {
  HealthScope,
  ResourceStatus,
  type HealthRegistry,
  type ResourceCheck,
  type ResourceEntry,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  credentialCreateSchema,
  custodyOperations,
  LIST_LIMIT_DEFAULT,
  type CredentialAnswer,
  type CredentialMetadata,
  type AgentProviderDependent,
  type BindingRevision,
  type AgentProvidersDependentOnFn,
  type BindingsNamingFn,
  type EnablementsDependentOnModelFn,
  type CustodyExecutions,
  type CustodyAuthorization,
  type CustodyExecution,
  type Grant,
  type Material,
} from "./contract.ts";
import { consumeGrant, mintGrant, MaterialBuffer } from "./facility.ts";
import {
  sealMaterial,
  openReport,
  applyReport,
  REVISION_REVOKED,
} from "./handover.ts";
import type { HandoverEnvelope } from "../kernel/handover.ts";
import { decrypt, encrypt } from "./envelope.ts";
import {
  apiKeySecretSchema,
  oauthSecretSchema,
  s3AccessKeySecretSchema,
  s3MetadataSchema,
  metadataSchemaForPlatform,
  openaiCompatibleMetadataSchema,
  OAUTH_PLATFORMS,
  Platform,
  RESERVED_NAME_LOGIN,
  secretSchemaForPlatform,
  validateNameForm,
} from "./platforms.ts";

import {
  PLATFORM_CAPABILITY,
  TARGET_KIND_CREDENTIAL,
  probeGitHub,
  probeGitHubCopilot,
  probeAnthropic,
  probeOpenAICompatible,
  probeS3,
} from "./resource-healthcheck.ts";
import {
  loginMode,
  loginNotFound,
  LOGIN_VALUE_NOT_AWAITED,
  OAuthLogin,
  type OAuthSecret,
} from "./login.ts";
import {
  LoginSessionStore,
  LoginSessionState,
  type LoginSession,
} from "./sessions.ts";

export interface Dependencies {
  executions: CustodyExecutions;
  authorization: CustodyAuthorization;
  clientSecret: (clientId: string) => string;
  store: Store;
  oauthProviders?: () => readonly Provider[];
  now?: () => number;
  envelopeKey: Buffer;
  logger: Logger;
  health?: HealthRegistry;
  agentProvidersDependentOn: AgentProvidersDependentOnFn;
  bindingsNaming: BindingsNamingFn;
  enablementsDependentOnModel: EnablementsDependentOnModelFn;
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
  BaseUrlFixed: "credential.metadata.base_url_fixed",
  ModelInUse: "credential.metadata.model_in_use",
  RevisionNotFound: "credential.revision.not_found",
  RevisionEnded: "credential.revision.ended",
  RevisionRevoked: REVISION_REVOKED,
  NewestLive: "credential.revision.newest_live",
  InvalidCursor: "system.pagination.cursor_invalid",
} as const;
const FIRST_REVISION = 1;
const NO_ROWS = 0;
const EXTRA_ROW = 1;
const EMPTY_MODELS = 0;
const CREDENTIAL_PREFIX = "credential";
const CUSTODY_HEALTH_NAME = "custody";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

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

type PlatformProbe = (
  secret: unknown,
  metadata: unknown,
  context: Context,
) => Promise<ResourceStatusValue>;

const platformProbes: Record<Platform, PlatformProbe> = {
  [Platform.GitHub]: (secret, _metadata, context) =>
    probeGitHub(apiKeySecretSchema.parse(secret).key, context),
  [Platform.GitHubCopilot]: (secret, _metadata, context) => {
    const { access, expires } = oauthSecretSchema.parse(secret);
    return probeGitHubCopilot(access, expires, context);
  },
  [Platform.Anthropic]: (secret, _metadata, context) =>
    probeAnthropic(apiKeySecretSchema.parse(secret).key, context),
  [Platform.OpenAICompatible]: (secret, metadata, context) =>
    probeOpenAICompatible(
      apiKeySecretSchema.parse(secret).key,
      openaiCompatibleMetadataSchema.parse(metadata).baseUrl,
      context,
    ),
  [Platform.S3]: (secret, metadata, context) => {
    const { accessKeyId, secretAccessKey } =
      s3AccessKeySecretSchema.parse(secret);
    const { endpoint, bucket, region } = s3MetadataSchema.parse(metadata);
    return probeS3(
      accessKeyId,
      secretAccessKey,
      endpoint,
      bucket,
      region,
      context,
    );
  },
};

function capturedResourceCheck(row: LiveRow, key: Buffer): ResourceCheck {
  const { id, platform } = row;
  const nonce = Buffer.from(row.nonce);
  const ciphertext = Buffer.from(row.ciphertext);
  const metadata: unknown =
    row.metadata === null ? null : JSON.parse(row.metadata);
  return async (context) => {
    if (context.err()) return ResourceStatus.Unknown;
    try {
      const secret = decrypt(key, id, platform, nonce, ciphertext);
      return await platformProbes[platform as Platform](
        secret,
        metadata,
        context,
      );
    } catch {
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

function requireLive(tx: Transaction, name: string, expected: number): LiveRow {
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
  platform: Platform,
  value: unknown,
): Record<string, unknown> | null {
  const schema = metadataSchemaForPlatform(platform);
  if (schema === null) {
    if (value !== null) throw invalidInput();
    return null;
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw invalidInput();
  return parsed.data as Record<string, unknown>;
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
      createdAt: row.created_at,
      endedAt: row.ended_at,
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

export class CustodyComponent implements Service {
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly store: Store;
  private readonly sessions = new LoginSessionStore();
  private readonly logins = new Map<string, OAuthLogin>();
  private readonly oauthProviders: () => readonly Provider[];
  private readonly now: () => number;
  private acceptingLogins = true;
  private readonly envelopeKey: Buffer;
  private readonly logger: Logger;
  private readonly agentProvidersDependentOn: AgentProvidersDependentOnFn;
  private readonly bindingsNaming: BindingsNamingFn;
  private readonly enablementsDependentOnModel: EnablementsDependentOnModelFn;
  private readonly executions: CustodyExecutions;
  private readonly authorization: CustodyAuthorization;
  private readonly clientSecret: (clientId: string) => string;

  constructor(dependencies: Dependencies) {
    this.executions = dependencies.executions;
    this.authorization = dependencies.authorization;
    this.clientSecret = dependencies.clientSecret;
    this.store = dependencies.store;
    this.oauthProviders =
      dependencies.oauthProviders ?? (() => [githubCopilotProvider()]);
    this.now = dependencies.now ?? Date.now;
    this.envelopeKey = dependencies.envelopeKey;
    this.logger = dependencies.logger;
    this.agentProvidersDependentOn = dependencies.agentProvidersDependentOn;
    this.bindingsNaming = dependencies.bindingsNaming;
    this.enablementsDependentOnModel = dependencies.enablementsDependentOnModel;
    dependencies.health?.register(CUSTODY_HEALTH_NAME, () =>
      this.healthcheck(),
    );
  }

  declare(registry: OperationRegistry): void {
    registry.register(custodyOperations.create, (input, caller) =>
      this.create(input, caller),
    );
    registry.register(custodyOperations.get, (input, caller) =>
      this.get(input, caller),
    );
    registry.register(custodyOperations.list, (input, caller) =>
      this.list(input, caller),
    );
    registry.register(custodyOperations.rotate, (input, caller) =>
      this.rotate(input, caller),
    );
    registry.register(custodyOperations.update_metadata, (input, caller) =>
      this.updateMetadata(input, caller),
    );
    registry.register(custodyOperations.revoke, (input, caller) =>
      this.revoke(input, caller),
    );
    registry.register(custodyOperations.login, (input, caller) =>
      this.login(input, caller),
    );
    registry.register(custodyOperations.login_code, (input, caller) =>
      this.loginCode(input, caller),
    );
    registry.register(custodyOperations.login_status, (input, caller) =>
      this.loginStatus(input, caller),
    );
  }

  authorize(
    tx: Transaction,
    identity: MachineIdentity,
    execution: CustodyExecution,
  ): Grant {
    assert(tx.database.isTransaction);
    assert.equal(tx.database, this.store.database);
    const { credential, platform } = this.authorization.authorizeModelInference(
      tx,
      identity,
      execution,
    );
    return mintGrant({ credential, platform, execution });
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
      this.executions.pinCredential(tx, grant.execution.executionId, row.id);
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
    const material = this.release(tx, this.authorize(tx, identity, row), now);
    try {
      const envelope = sealMaterial(
        this.clientSecret(identity.clientId),
        row,
        material,
      );
      this.logger.info(
        {
          executionId: row.executionId,
          workerBindingId: row.workerBindingId,
          credentialId: material.credentialId,
        },
        "credential handover",
      );
      return envelope;
    } finally {
      material.drop();
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
    const written = applyReport(tx, this.envelopeKey, report);
    this.logger.info(
      { executionId: row.executionId, credentialId: report.credentialId },
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

  resourceInventory(tx: Transaction): ResourceEntry[] {
    const rows = tx.database
      .prepare(
        "SELECT id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at FROM credential AS current WHERE ended_at IS NULL AND revision = (SELECT MAX(revision) FROM credential WHERE name = current.name AND ended_at IS NULL) ORDER BY name",
      )
      .all() as LiveRow[];
    return rows.map((row) => ({
      scope: HealthScope.Global,
      project: null,
      name: encodeURIComponent(row.name),
      target: `${TARGET_KIND_CREDENTIAL}:${row.id}`,
      capability: PLATFORM_CAPABILITY[row.platform as Platform],
      check: capturedResourceCheck(row, this.envelopeKey),
    }));
  }

  modelListCheck(tx: Transaction, credentialName: string): ResourceCheck {
    const row = newestLive(tx, credentialName);
    if (
      !row ||
      (row.platform !== Platform.Anthropic &&
        row.platform !== Platform.OpenAICompatible)
    )
      return async () => ResourceStatus.Unknown;
    return capturedResourceCheck(row, this.envelopeKey);
  }

  credentialDependents(
    tx: Transaction,
    credentialName: string,
  ): { agentProviders: AgentProviderDependent[]; bindings: BindingRevision[] } {
    return {
      agentProviders: this.agentProvidersDependentOn(tx, credentialName),
      bindings: this.bindingsNaming(tx, credentialName),
    };
  }

  private create(
    input: typeof custodyOperations.create.input._output,
    caller: CallerContext,
  ): CredentialAnswer {
    return caller.commit((tx) => {
      const bodyResult = credentialCreateSchema.safeParse(input.body);
      if (!bodyResult.success) throw invalidInput();
      const { name, platform, secret, metadata } = bodyResult.data;
      if (!validateNameForm(name) || name === RESERVED_NAME_LOGIN)
        throw invalidInput();
      if (!Object.values(Platform).some((value) => value === platform))
        throw new OperationError(
          HttpStatus.BadRequest,
          CustodyErrorCode.UnsupportedPlatform,
          "Unsupported platform.",
        );
      const supportedPlatform = platform as Platform;
      if (OAUTH_PLATFORMS.includes(supportedPlatform))
        throw new OperationError(
          HttpStatus.BadRequest,
          CustodyErrorCode.UnsupportedEntry,
          "Unsupported credential entry.",
        );
      const existing = rowsForName(tx, name);
      if (existing.length !== NO_ROWS)
        throw new OperationError(
          HttpStatus.Conflict,
          CustodyErrorCode.Conflict,
          "Credential name already exists.",
          { id: existing[0]!.id },
        );
      const parsedSecret =
        secretSchemaForPlatform(supportedPlatform).safeParse(secret);
      if (!parsedSecret.success) throw invalidInput();
      const metadataSchema = metadataSchemaForPlatform(supportedPlatform);
      let parsedMetadata: Record<string, unknown> | null = null;
      if (metadataSchema !== null) {
        const result = metadataSchema.safeParse(metadata);
        if (!result.success) throw invalidInput();
        parsedMetadata = result.data as Record<string, unknown>;
        if (
          supportedPlatform === Platform.OpenAICompatible &&
          (parsedMetadata.models as unknown[]).length !== EMPTY_MODELS
        )
          throw invalidInput();
      } else if (metadata !== null) throw invalidInput();
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
          parsedMetadata === null ? null : canonicalJSON(parsedMetadata),
          Date.now(),
        );
      this.logger.info(
        {
          credentialId: id,
          humanIdentity:
            caller.identity?.kind === IdentityKind.Human
              ? caller.identity.accountId
              : undefined,
        },
        "credential created",
      );
      return answerForName(tx, name)!;
    });
  }

  private get(
    input: typeof custodyOperations.get.input._output,
    caller: CallerContext,
  ): CredentialAnswer {
    return caller.commit((tx) => {
      this.drainRevisions(tx, input.params.credentialName, Date.now());
      const answer = answerForName(tx, input.params.credentialName);
      if (answer === null)
        throw new OperationError(
          HttpStatus.NotFound,
          CustodyErrorCode.NotFound,
          "Credential not found.",
        );
      return answer;
    });
  }

  private list(
    input: typeof custodyOperations.list.input._output,
    caller: CallerContext,
  ): { items: CredentialAnswer[]; nextCursor: string | null } {
    return caller.commit((tx) => {
      const { platform, limit: requestedLimit, cursor } = input.query;
      const after = cursor === undefined ? "" : decodeCursor(cursor);
      const limit = requestedLimit ?? LIST_LIMIT_DEFAULT;
      const names = tx.database
        .prepare(
          "SELECT DISTINCT name FROM credential WHERE name > ? AND (? IS NULL OR platform = ?) ORDER BY name ASC LIMIT ?",
        )
        .all(after, platform ?? null, platform ?? null, limit + EXTRA_ROW) as {
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
      return { items, nextCursor };
    });
  }

  private refuseRemovedModels(
    tx: Transaction,
    credentialName: string,
    removedIds: string[],
  ): void {
    const models = removedIds
      .map((model) => ({
        model,
        agents: this.enablementsDependentOnModel(tx, credentialName, model).map(
          ({ agentName }) => agentName,
        ),
      }))
      .filter(({ agents }) => agents.length > NO_ROWS);
    if (models.length > NO_ROWS)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.ModelInUse,
        "Credential model is in use.",
        { models },
      );
  }

  private checkModels(
    tx: Transaction,
    row: LiveRow,
    metadata: Record<string, unknown> | null,
    allowBaseUrlChange: boolean,
  ): void {
    if (row.platform !== Platform.OpenAICompatible) return;
    const current = openaiCompatibleMetadataSchema.parse(
      JSON.parse(row.metadata!),
    );
    const next = openaiCompatibleMetadataSchema.parse(metadata);
    if (!allowBaseUrlChange && current.baseUrl !== next.baseUrl)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.BaseUrlFixed,
        "Credential base URL cannot be changed by metadata update.",
      );
    const nextIds = new Set(next.models.map((model) => model.id));
    const removedIds = current.models
      .filter((model) => !nextIds.has(model.id))
      .map((model) => model.id);
    this.refuseRemovedModels(tx, row.name, removedIds);
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

  private rotate(
    input: typeof custodyOperations.rotate.input._output,
    caller: CallerContext,
  ): CredentialAnswer {
    return caller.commit((tx) => {
      const row = requireLive(
        tx,
        input.params.credentialName,
        input.body.expectedRevision,
      );
      const platform = row.platform as Platform;
      const secret = secretSchemaForPlatform(platform).safeParse(
        input.body.secret,
      );
      if (!secret.success) throw invalidInput();
      const metadata = validatedMetadata(
        platform,
        input.body.metadata === undefined
          ? row.metadata === null
            ? null
            : JSON.parse(row.metadata)
          : input.body.metadata,
      );
      this.checkModels(tx, row, metadata, true);
      const id = createIdentity(CREDENTIAL_PREFIX);
      const now = Date.now();
      this.insertRevision(tx, row, id, secret.data, metadata, now);
      this.drainRevisions(tx, row.name, now);
      this.logger.info(
        {
          credentialId: id,
          humanIdentity:
            caller.identity?.kind === IdentityKind.Human
              ? caller.identity.accountId
              : undefined,
        },
        "credential rotated",
      );
      return answerForName(tx, row.name)!;
    });
  }

  private updateMetadata(
    input: typeof custodyOperations.update_metadata.input._output,
    caller: CallerContext,
  ): CredentialAnswer {
    return caller.commit((tx) => {
      const row = requireLive(
        tx,
        input.params.credentialName,
        input.body.expectedRevision,
      );
      const metadata = validatedMetadata(
        row.platform as Platform,
        input.body.metadata,
      );
      this.checkModels(tx, row, metadata, false);
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
        {
          credentialId: id,
          humanIdentity:
            caller.identity?.kind === IdentityKind.Human
              ? caller.identity.accountId
              : undefined,
        },
        "credential metadata updated",
      );
      return answerForName(tx, row.name)!;
    });
  }

  private revoke(
    input: typeof custodyOperations.revoke.input._output,
    caller: CallerContext,
  ): CredentialAnswer {
    return caller.commit((tx) => {
      const { credentialName, revision } = input.params;
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
    });
  }

  private requireAvailableName(tx: Transaction, name: string): void {
    const existing = rowsForName(tx, name);
    if (existing.length !== NO_ROWS)
      throw new OperationError(
        HttpStatus.Conflict,
        CustodyErrorCode.Conflict,
        "Credential name already exists.",
        { id: existing[0]!.id },
      );
  }

  private completeLogin(
    session: LoginSession,
    flow: OAuthLogin,
    secret: OAuthSecret,
  ): void {
    const id = this.store.transaction((tx) => {
      flow.requirePending();
      this.requireAvailableName(tx, session.credentialName);
      const id = createIdentity(CREDENTIAL_PREFIX);
      const { nonce, ciphertext } = encrypt(
        this.envelopeKey,
        id,
        session.platform,
        secret,
      );
      tx.database
        .prepare(
          "INSERT INTO credential (id, name, platform, revision, nonce, ciphertext, metadata, created_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, NULL)",
        )
        .run(
          id,
          session.credentialName,
          session.platform,
          FIRST_REVISION,
          nonce,
          ciphertext,
          this.now(),
        );
      return id;
    });
    this.sessions.complete(session.id);
    this.logger.info(
      { credentialId: id, humanIdentity: session.humanIdentity },
      "credential login completed",
    );
  }

  private async login(
    input: typeof custodyOperations.login.input._output,
    caller: CallerContext,
  ): Promise<typeof custodyOperations.login.output._output> {
    if (!this.acceptingLogins)
      throw new Diagnostic(
        CustodyErrorCode.Stopped,
        "custody: login is stopped.",
      );
    const { platform, name, mode: requested } = input.body;
    if (!Object.values(Platform).some((value) => value === platform))
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.UnsupportedPlatform,
        "Unsupported platform.",
      );
    const supported = platform as Platform;
    if (!OAUTH_PLATFORMS.includes(supported))
      throw new OperationError(
        HttpStatus.BadRequest,
        CustodyErrorCode.UnsupportedEntry,
        "Unsupported credential entry.",
      );
    if (!validateNameForm(name) || name === RESERVED_NAME_LOGIN)
      throw invalidInput();
    const mode = loginMode(supported, requested);
    this.store.transaction((tx) => this.requireAvailableName(tx, name));
    if (caller.identity?.kind !== IdentityKind.Human) throw invalidInput();
    const session = this.sessions.start(
      platform,
      mode,
      caller.identity.accountId,
      name,
      this.now(),
    );
    const flow = new OAuthLogin(session, this.sessions, this.now);
    this.logins.set(session.id, flow);
    const unsubscribe = caller.context.onCancel(() => flow.abort());
    void flow
      .run(this.oauthProviders, (secret) =>
        this.completeLogin(session, flow, secret),
      )
      .then(() => this.logins.delete(session.id));
    try {
      await flow.ready.promise;
      const cancelled = caller.context.err();
      if (cancelled) throw cancelled;
      if (
        session.state === LoginSessionState.Failed ||
        session.state === LoginSessionState.Expired ||
        session.address === null
      )
        throw flow.failure;
      return caller.commit(() => ({
        sessionId: session.id,
        address: session.address!,
        code: session.code,
        expiresAt: session.expiresAt,
      }));
    } finally {
      unsubscribe();
    }
  }

  private loginSession(id: string): LoginSession {
    const session = this.sessions.get(id);
    if (!session || session.state === LoginSessionState.Expired)
      throw loginNotFound();
    if (session.expiresAt <= this.now()) {
      this.logins.get(id)?.expire();
      throw loginNotFound();
    }
    return session;
  }

  private loginCode(
    input: typeof custodyOperations.login_code.input._output,
    caller: CallerContext,
  ): typeof custodyOperations.login_code.output._output {
    const session = this.loginSession(input.params.sessionId);
    return caller.commit(() => {
      const flow = this.logins.get(session.id);
      if (!flow)
        throw new OperationError(
          HttpStatus.Conflict,
          LOGIN_VALUE_NOT_AWAITED,
          "No login value is awaited.",
        );
      flow.supply(input.body.value);
      return { sessionId: session.id };
    });
  }

  private loginStatus(
    input: typeof custodyOperations.login_status.input._output,
    caller: CallerContext,
  ): typeof custodyOperations.login_status.output._output {
    const session = this.loginSession(input.params.sessionId);
    return caller.commit(() => ({
      sessionId: session.id,
      state: session.state,
      lastMessage: session.lastMessage,
      failureReason: session.failureReason,
    }));
  }

  private abortLogins(): void {
    this.acceptingLogins = false;
    for (const flow of this.logins.values()) flow.abort();
    this.logins.clear();
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
    this.abortLogins();
    return this.quiesceTask;
  }
  stop(): Promise<Error | null> {
    this.abortLogins();
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
