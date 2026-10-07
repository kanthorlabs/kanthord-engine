import type { Logger } from "pino";
import type { Provider } from "@earendil-works/pi-ai";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  credentialPlatformList,
  RevisionChange,
  SecretShape,
  type AgentProvidersDependentOnFn,
  type CredentialPlatformSet,
  type CredentialRecords,
  type MetadataRevision,
} from "../custody/contract.ts";
import { IdentityKind } from "../kernel/caller.ts";
import {
  background,
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import type { ResourceCheck, ResourceEntry } from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  HealthStatus,
  type Healthcheck,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  LlmErrorCode,
  llmOperations,
  PROVIDER_CHECK_TIMEOUT_MS,
  providerCheckBodySchema,
  type EnablementsDependentOnModelFn,
  type LlmCredentialAnswer,
  type ProviderCheckAnswer,
} from "./contract.ts";
import {
  loginMode,
  loginNotFound,
  LOGIN_VALUE_NOT_AWAITED,
  OAuthLogin,
  type OAuthSecret,
} from "./login.ts";
import {
  approvedModels,
  CAPABILITY_NONE,
  isLlmPlatform,
  LLM_PLATFORMS,
  LLM_PROVIDERS,
  openaiCompatibleMetadataSchema,
  Platform,
  type ApprovedModel,
} from "./platforms.ts";
import {
  LoginSessionStore,
  LoginSessionState,
  type LoginSession,
} from "./sessions.ts";

export interface Dependencies {
  records: CredentialRecords;
  store: Store;
  logger: Logger;
  oauthProviders?: () => readonly Provider[];
  now?: () => number;
  agentProvidersDependentOn: AgentProvidersDependentOnFn;
  enablementsDependentOnModel: EnablementsDependentOnModelFn;
}

const CredentialErrorCode = {
  Invalid: "credential.input.invalid",
  UnsupportedPlatform: "credential.platform.unsupported",
  UnsupportedEntry: "credential.entry.unsupported",
} as const;
const NO_ROWS = 0;

function invalidInput(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CredentialErrorCode.Invalid,
    "Invalid input.",
  );
}

function humanIdentity(caller: CallerContext): string | undefined {
  return caller.identity?.kind === IdentityKind.Human
    ? caller.identity.accountId
    : undefined;
}

export class LlmComponent implements Service {
  private readonly shutdown = new CancellationContext();
  private startTask?: Promise<Error | null>;
  private stopTask?: Promise<Error | null>;
  private readonly quiesceTask = Promise.resolve(null);
  private started = false;
  private readonly records: CredentialRecords;
  private readonly store: Store;
  private readonly logger: Logger;
  private readonly sessions = new LoginSessionStore();
  private readonly logins = new Map<string, OAuthLogin>();
  private readonly oauthProviders: () => readonly Provider[];
  private readonly now: () => number;
  private acceptingLogins = true;
  private readonly agentProvidersDependentOn: AgentProvidersDependentOnFn;
  private readonly enablementsDependentOnModel: EnablementsDependentOnModelFn;
  private readonly platformSet: CredentialPlatformSet;

  constructor(dependencies: Dependencies) {
    this.records = dependencies.records;
    this.store = dependencies.store;
    this.logger = dependencies.logger;
    this.oauthProviders =
      dependencies.oauthProviders ??
      (() => [githubCopilotProvider(), openaiCodexProvider()]);
    this.now = dependencies.now ?? Date.now;
    this.agentProvidersDependentOn = dependencies.agentProvidersDependentOn;
    this.enablementsDependentOnModel = dependencies.enablementsDependentOnModel;
    this.platformSet = {
      platforms: LLM_PLATFORMS,
      check_metadata: (tx, revision) => this.checkMetadata(tx, revision),
    };
  }

  declare(registry: OperationRegistry): void {
    registry.register(llmOperations.platform_list, () =>
      credentialPlatformList(LLM_PLATFORMS),
    );
    registry.register(llmOperations.create, (input, caller) =>
      caller.commit((tx) =>
        this.records.create(
          tx,
          this.platformSet,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(llmOperations.list, (input, caller) =>
      caller.commit((tx) =>
        this.records.list(tx, this.platformSet, input.query),
      ),
    );
    registry.register(llmOperations.get, (input, caller) =>
      caller.commit((tx) => this.get(tx, input.params.credential_name)),
    );
    registry.register(llmOperations.rotate, (input, caller) =>
      caller.commit((tx) =>
        this.records.rotate(
          tx,
          this.platformSet,
          input.params.credential_name,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(llmOperations.update_metadata, (input, caller) =>
      caller.commit((tx) =>
        this.records.updateMetadata(
          tx,
          this.platformSet,
          input.params.credential_name,
          input.body,
          humanIdentity(caller),
        ),
      ),
    );
    registry.register(llmOperations.revoke, (input, caller) =>
      caller.commit((tx) =>
        this.records.revoke(
          tx,
          this.platformSet,
          input.params.credential_name,
          input.params.revision,
        ),
      ),
    );
    registry.register(llmOperations.archive, (input, caller) =>
      caller.commit((tx) =>
        this.records.archive(
          tx,
          this.platformSet,
          input.params.credential_name,
        ),
      ),
    );
    registry.register(llmOperations.verify, async (input, caller) => {
      const answer = await this.records.verify(
        this.platformSet,
        input.params.credential_name,
        caller.context,
      );
      throwIfCancelled(caller.context);
      return caller.commit(() => answer);
    });
    registry.register(llmOperations.check, async (input, caller) => {
      const answer = await this.records.check(
        this.platformSet,
        input.body,
        caller.context,
      );
      throwIfCancelled(caller.context);
      return caller.commit(() => answer);
    });
    registry.register(llmOperations.login, (input, caller) =>
      this.login(input, caller),
    );
    registry.register(llmOperations.login_code, (input, caller) =>
      this.loginCode(input, caller),
    );
    registry.register(llmOperations.login_status, (input, caller) =>
      this.loginStatus(input, caller),
    );
    registry.register(llmOperations.provider_check, (input, caller) =>
      this.providerCheck(input, caller),
    );
  }

  resourceInventory(tx: Transaction): ResourceEntry[] {
    return this.records.resourceInventory(tx, this.platformSet);
  }

  providerHealthCheck(tx: Transaction, credentialName: string): ResourceCheck {
    return this.records.resourceCheck(tx, this.platformSet, credentialName);
  }

  providerCapability(tx: Transaction, credentialName: string): string {
    const record = this.records.credentialMetadata(tx, credentialName);
    if (!record || !isLlmPlatform(record.platform)) return CAPABILITY_NONE;
    return LLM_PLATFORMS[record.platform].capability;
  }

  approvedModels(
    tx: Transaction,
    credentialName: string,
  ): ApprovedModel[] | null {
    const record = this.records.credentialMetadata(tx, credentialName);
    return record && approvedModels(record.platform, record.metadata);
  }

  private async providerCheck(
    input: typeof llmOperations.provider_check.input._output,
    caller: CallerContext,
  ): Promise<ProviderCheckAnswer> {
    const body = providerCheckBodySchema.safeParse(input.body);
    if (!body.success)
      throw new OperationError(
        HttpStatus.BadRequest,
        LlmErrorCode.ProviderInvalidInput,
        "Invalid input.",
      );
    const material = this.store.transaction((tx) =>
      this.records.checkMaterial(tx, this.platformSet, body.data.credential),
    );
    if (!material)
      throw new OperationError(
        HttpStatus.NotFound,
        LlmErrorCode.ProviderCredentialNotFound,
        "Credential not found.",
      );
    const provider = LLM_PROVIDERS[material.platform as Platform];
    if (!provider)
      throw new OperationError(
        HttpStatus.BadRequest,
        LlmErrorCode.ProviderCheckUnsupported,
        "The platform of the credential has no LLM provider.",
      );
    const context = new CancellationContext(
      caller.context,
      Date.now() + PROVIDER_CHECK_TIMEOUT_MS,
    );
    try {
      const answer = await provider.check(
        material.secret(),
        material.metadata,
        context,
        (reason) =>
          this.logger.info(
            { credential: body.data.credential, reason },
            "provider check failed",
          ),
      );
      throwIfCancelled(caller.context);
      return caller.commit(() => answer);
    } finally {
      context.cancel();
    }
  }

  private get(tx: Transaction, credentialName: string): LlmCredentialAnswer {
    const answer = this.records.get(tx, this.platformSet, credentialName);
    return {
      ...answer,
      agentProviders: this.agentProvidersDependentOn(tx, credentialName).map(
        ({ agent_name: agentName, provider_name: providerName }) => ({
          agent: agentName,
          name: providerName,
        }),
      ),
    };
  }

  private checkMetadata(tx: Transaction, revision: MetadataRevision): void {
    if (revision.platform !== Platform.OpenAICompatible) return;
    const next = openaiCompatibleMetadataSchema.parse(revision.next);
    if (revision.change === RevisionChange.Create) {
      if (next.models.length !== NO_ROWS) throw invalidInput();
      return;
    }
    const current = openaiCompatibleMetadataSchema.parse(revision.current);
    if (
      revision.change === RevisionChange.Metadata &&
      current.base_url !== next.base_url
    )
      throw new OperationError(
        HttpStatus.Conflict,
        LlmErrorCode.BaseUrlFixed,
        "Credential base URL cannot be changed by metadata update.",
      );
    const nextIds = new Set(next.models.map((model) => model.id));
    const models = current.models
      .filter((model) => !nextIds.has(model.id))
      .map(({ id: model }) => ({
        model,
        agents: this.enablementsDependentOnModel(tx, revision.name, model).map(
          ({ agentName }) => agentName,
        ),
      }))
      .filter(({ agents }) => agents.length > NO_ROWS);
    if (models.length > NO_ROWS)
      throw new OperationError(
        HttpStatus.Conflict,
        LlmErrorCode.ModelInUse,
        "Credential model is in use.",
        { models },
      );
  }

  private completeLogin(
    session: LoginSession,
    flow: OAuthLogin,
    secret: OAuthSecret,
  ): void {
    const id = this.store.transaction((tx) => {
      flow.requirePending();
      return this.records.createLoginRevision(
        tx,
        this.platformSet,
        session.credentialName,
        session.platform,
        secret,
        this.now(),
      );
    });
    this.sessions.complete(session.id);
    this.logger.info(
      { credentialId: id, humanIdentity: session.humanIdentity },
      "credential login completed",
    );
  }

  private async login(
    input: typeof llmOperations.login.input._output,
    caller: CallerContext,
  ): Promise<typeof llmOperations.login.output._output> {
    if (!this.acceptingLogins)
      throw new Diagnostic(LlmErrorCode.Stopped, "llm: login is stopped.");
    const { platform, name, mode: requested } = input.body;
    if (!isLlmPlatform(platform))
      throw new OperationError(
        HttpStatus.BadRequest,
        CredentialErrorCode.UnsupportedPlatform,
        "Unsupported platform.",
      );
    if (LLM_PLATFORMS[platform].secret_shape !== SecretShape.OAuth)
      throw new OperationError(
        HttpStatus.BadRequest,
        CredentialErrorCode.UnsupportedEntry,
        "Unsupported credential entry.",
      );
    this.store.transaction((tx) => this.records.requireAvailableName(tx, name));
    const mode = loginMode(platform, requested);
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
    input: typeof llmOperations.login_code.input._output,
    caller: CallerContext,
  ): typeof llmOperations.login_code.output._output {
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
    input: typeof llmOperations.login_status.input._output,
    caller: CallerContext,
  ): typeof llmOperations.login_status.output._output {
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
          LlmErrorCode.Stopped,
          "llm: a stopped component cannot start again.",
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
      login:
        this.started && !this.shutdown.err()
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
