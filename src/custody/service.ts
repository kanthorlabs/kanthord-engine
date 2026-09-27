import type { Logger } from "pino";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { IdentityKind } from "../kernel/caller.ts";
import type { HealthRegistry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { type CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  credentialCreateSchema,
  custodyOperations,
  LIST_LIMIT_DEFAULT,
  type CredentialAnswer,
  type CredentialMetadata,
} from "./contract.ts";
import { decrypt, encrypt } from "./envelope.ts";
import {
  metadataSchemaForPlatform,
  openaiCompatibleMetadataSchema,
  OAUTH_PLATFORMS,
  Platform,
  RESERVED_NAME_LOGIN,
  secretSchemaForPlatform,
  validateNameForm,
} from "./platforms.ts";

export interface Dependencies {
  envelopeKey: Buffer;
  logger: Logger;
  health?: HealthRegistry;
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
  RevisionNotFound: "credential.revision.not_found",
  RevisionEnded: "credential.revision.ended",
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
  private readonly envelopeKey: Buffer;
  private readonly logger: Logger;

  constructor(dependencies: Dependencies) {
    this.envelopeKey = dependencies.envelopeKey;
    this.logger = dependencies.logger;
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
    void tx;
    void credentialName;
    void removedIds;
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
        Date.now(),
      );
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
      this.insertRevision(tx, row, id, secret.data, metadata);
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
      this.insertRevision(tx, row, id, secret, metadata);
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
        .run(Date.now(), row.id);
      return answerForName(tx, credentialName)!;
    });
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
