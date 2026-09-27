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
} from "./contract.ts";
import { encrypt } from "./envelope.ts";
import {
  metadataSchemaForPlatform,
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
