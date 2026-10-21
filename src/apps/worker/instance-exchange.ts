import { ulid } from "ulid";
import { background, type Context } from "../../kernel/context.ts";
import { Diagnostic, type ErrorDetails } from "../../kernel/errors.ts";
import { openJSON } from "../../kernel/hpke.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { httpClient } from "../../gateway/client.ts";
import type {
  CredentialAnswer,
  SealedCopyAnswer,
} from "../../custody/contract.ts";
import {
  llmOperations,
  type CopyReportBody,
  type LoginReportBody,
} from "../../llm/contract.ts";
import {
  INSTANCE_CONNECTION_INFO,
  WORKER_TOKEN_INFO,
  connectionPayloadSchema,
  workerOperations,
  workerTokenPayloadSchema,
  type InstanceConfiguration,
  type WorkerTokenPayload,
} from "../../worker/contract.ts";

const BASE64URL = "base64url";
export const EXCHANGE_UNAVAILABLE = "worker.instance.exchange_unavailable";

export type ConnectionEntry = ReturnType<
  typeof connectionPayloadSchema.parse
>["bindings"][number];

export interface Connection {
  connection_id: string;
  binding_version: number;
  bindings: ConnectionEntry[];
}

export type HeartbeatAnswer =
  (typeof workerOperations)["instance.heartbeat"]["output"]["_output"];

export class ExchangeFailure extends Diagnostic {
  readonly status: number | null;

  constructor(
    code: string,
    message: string,
    status: number | null,
    details: ErrorDetails | null = null,
  ) {
    super(code, message, { details });
    this.status = status;
  }
}

function settled<T>(result: OperationResult<T>, name: string): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new ExchangeFailure(
      result.error.error.code,
      result.error.error.message,
      result.status,
      (result.error.error.details as ErrorDetails | undefined) ?? null,
    );
  throw new ExchangeFailure(
    EXCHANGE_UNAVAILABLE,
    `worker instance: the ${name} answer is indeterminate.`,
    null,
  );
}

export class InstanceExchange {
  private readonly configuration: InstanceConfiguration;
  private readonly client: ReturnType<
    typeof httpClient<typeof workerOperations>
  >;
  private readonly llm: ReturnType<typeof httpClient<typeof llmOperations>>;
  private workerToken?: string;

  constructor(configuration: InstanceConfiguration, endpoint: string) {
    this.configuration = configuration;
    this.client = httpClient(
      workerOperations,
      endpoint,
      () => this.workerToken,
    );
    this.llm = httpClient(llmOperations, endpoint, () => this.workerToken);
  }

  private privateKey(): Buffer {
    return Buffer.from(this.configuration.private_key, BASE64URL);
  }

  async token(
    context: Context = background,
  ): Promise<{ server_version: string; payload: WorkerTokenPayload }> {
    const answer = settled(
      await this.client["instance.token"](
        {
          params: {},
          query: {},
          body: { instance_id: this.configuration.instance_id },
        },
        { context },
      ),
      "token",
    );
    const key = this.privateKey();
    try {
      const payload = workerTokenPayloadSchema.parse(
        await openJSON(
          key,
          WORKER_TOKEN_INFO,
          this.configuration.instance_id,
          answer.sealed,
        ),
      );
      this.workerToken = payload.token;
      return { server_version: answer.server_version, payload };
    } finally {
      key.fill(0);
    }
  }

  async connect(
    connectionName: string,
    connectionId?: string,
    context: Context = background,
  ): Promise<Connection> {
    const answer = settled(
      await this.client["instance.connect"](
        {
          params: {},
          query: {},
          body: {
            connection_name: connectionName,
            ...(connectionId === undefined
              ? {}
              : { connection_id: connectionId }),
          },
        },
        { context, idempotencyKey: ulid() },
      ),
      "connect",
    );
    const key = this.privateKey();
    try {
      const payload = connectionPayloadSchema.parse(
        await openJSON(
          key,
          INSTANCE_CONNECTION_INFO,
          `${this.configuration.instance_id}${answer.connection_id}`,
          answer.sealed,
        ),
      );
      return {
        connection_id: answer.connection_id,
        binding_version: answer.binding_version,
        bindings: payload.bindings,
      };
    } finally {
      key.fill(0);
    }
  }

  async loginReport(
    sessionId: string,
    body: LoginReportBody,
    idempotencyKey: string,
    context: Context = background,
  ): Promise<void> {
    settled(
      await this.llm.login_report(
        { params: { session_id: sessionId }, query: {}, body },
        { context, idempotencyKey },
      ),
      "login report",
    );
  }

  async copies(context: Context = background): Promise<CredentialAnswer[]> {
    const items: CredentialAnswer[] = [];
    let cursor: string | undefined;
    do {
      const page = settled(
        await this.llm.list(
          {
            params: {},
            query: cursor === undefined ? {} : { cursor },
            body: null,
          },
          { context },
        ),
        "credential list",
      );
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor !== undefined);
    return items;
  }

  async sealedCopy(
    name: string,
    context: Context = background,
  ): Promise<SealedCopyAnswer> {
    return settled(
      await this.llm.sealed(
        { params: { credential_name: name }, query: {}, body: null },
        { context },
      ),
      "sealed copy",
    );
  }

  async copyReport(
    name: string,
    body: CopyReportBody,
    context: Context = background,
  ): Promise<void> {
    settled(
      await this.llm.report(
        { params: { credential_name: name }, query: {}, body },
        { context, idempotencyKey: ulid() },
      ),
      "credential report",
    );
  }

  async heartbeat(
    connectionId: string,
    connectionName: string,
    context: Context = background,
  ): Promise<HeartbeatAnswer> {
    return settled(
      await this.client["instance.heartbeat"](
        {
          params: {},
          query: {},
          body: {
            connection_id: connectionId,
            connection_name: connectionName,
          },
        },
        { context, idempotencyKey: ulid() },
      ),
      "heartbeat",
    );
  }
}
