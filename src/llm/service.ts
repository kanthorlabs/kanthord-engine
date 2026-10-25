import { addAbortListener } from "node:events";
import type { Logger } from "pino";
import type { Provider } from "@earendil-works/pi-ai";
import { registerBunOAuthFlows as registerOAuthFlows } from "@earendil-works/pi-ai/bun-oauth";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
  credentialPlatformList,
  RevisionChange,
  SecretShape,
  SERVER_HOLDER,
  type AgentProvidersDependentOnFn,
  type CredentialCopy,
  type CredentialPlatformSet,
  type CredentialRecords,
  type HeldCopy,
  type InstanceKey,
  type InstanceKeys,
  type MetadataRevision,
} from "../custody/contract.ts";
import { sealedObjectSchema, type SealedObject } from "../kernel/hpke.ts";
import {
  IdentityKind,
  isWorkerIdentity,
  type WorkerIdentity,
} from "../kernel/caller.ts";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
} from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import {
  ResourceFailureReason,
  ResourceStatus,
  type ResourceCheck,
  type ResourceEntry,
} from "../kernel/health.ts";
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
  MODEL_CHECK_TIMEOUT_MS,
  PROVIDER_CHECK_TIMEOUT_MS,
  providerCheckBodySchema,
  type CopyHealth,
  type CopyReportBody,
  type EnablementsDependentOnModelFn,
  type LlmCredentialAnswer,
  type LlmCredentialCreate,
  type LlmCredentialRotate,
  type LoginSessionEntry,
  type ModelCheckAnswer,
  type ProviderCheckAnswer,
} from "./contract.ts";
import {
  isLoopbackHost,
  LOGIN_INSTANCE_UNAVAILABLE,
  loginMode,
  loginNotFound,
  LOGIN_VALUE_NOT_AWAITED,
  OAuthLogin,
  type OAuthSecret,
} from "./login.ts";
import { InstanceLogin } from "./instance-login.ts";
import { CopyHealthBook } from "./copy-health.ts";
import { checkModel } from "./model-check.ts";
import type { ModelRuntimeModule } from "./model-connector.ts";
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
  loadModelRuntime: () => Promise<ModelRuntimeModule>;
  instanceKeys?: InstanceKeys;
  instanceConnected?: (holder: string) => boolean;
}

const NO_INSTANCE_KEYS: InstanceKeys = {
  keyOf: () => null,
  nameOf: () => null,
};

const CredentialErrorCode = {
  Invalid: "credential.input.invalid",
  UnsupportedPlatform: "credential.platform.unsupported",
  UnsupportedEntry: "credential.entry.unsupported",
  SealedInvalid: "credential.sealed.invalid",
  NotFound: "credential.credential.not_found",
  RevisionConflict: "credential.revision.conflict",
} as const;
const NO_ROWS = 0;
const LOGIN_FAILED_REASON = "login failed";

function invalidInput(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    CredentialErrorCode.Invalid,
    "Invalid input.",
  );
}

function instanceForbidden(): OperationError {
  return new OperationError(
    HttpStatus.Forbidden,
    LlmErrorCode.InstanceForbidden,
    "A worker instance acts only on the copies of its own instance.",
  );
}

function sealedBody(body: { sealed?: unknown; sealed_to?: string }): {
  sealed: SealedObject;
  sealed_to: string;
} {
  if (body.sealed === undefined || body.sealed_to === undefined)
    throw invalidInput();
  const sealed = sealedObjectSchema.safeParse(body.sealed);
  if (!sealed.success)
    throw new OperationError(
      HttpStatus.BadRequest,
      CredentialErrorCode.SealedInvalid,
      "The sealed credential copy is invalid.",
    );
  return { sealed: sealed.data, sealed_to: body.sealed_to };
}

function reportInvalid(report: CopyReportBody): boolean {
  return (
    report.failure_reason === ResourceFailureReason.HeldByInstance ||
    (report.status === ResourceStatus.Healthy) !==
      (report.failure_reason === null)
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
  private readonly instanceLogins = new Map<string, InstanceLogin>();
  private readonly copyHealth: CopyHealthBook;
  private readonly oauthProviders: () => readonly Provider[];
  private readonly now: () => number;
  private acceptingLogins = true;
  private readonly agentProvidersDependentOn: AgentProvidersDependentOnFn;
  private readonly enablementsDependentOnModel: EnablementsDependentOnModelFn;
  private readonly loadModelRuntime: () => Promise<ModelRuntimeModule>;
  private readonly platformSet: CredentialPlatformSet;
  private readonly instanceKeys: InstanceKeys;
  private readonly instanceConnected: (holder: string) => boolean;

  constructor(dependencies: Dependencies) {
    registerOAuthFlows();
    this.records = dependencies.records;
    this.store = dependencies.store;
    this.logger = dependencies.logger;
    this.oauthProviders =
      dependencies.oauthProviders ??
      (() => [
        githubCopilotProvider(),
        openaiCodexProvider(),
        anthropicProvider(),
      ]);
    this.now = dependencies.now ?? Date.now;
    this.copyHealth = new CopyHealthBook(this.now());
    this.agentProvidersDependentOn = dependencies.agentProvidersDependentOn;
    this.enablementsDependentOnModel = dependencies.enablementsDependentOnModel;
    this.loadModelRuntime = dependencies.loadModelRuntime;
    this.instanceKeys = dependencies.instanceKeys ?? NO_INSTANCE_KEYS;
    this.instanceConnected = dependencies.instanceConnected ?? (() => false);
    this.platformSet = {
      platforms: LLM_PLATFORMS,
      instance_copies: true,
      check_metadata: (tx, revision) => this.checkMetadata(tx, revision),
    };
  }

  declare(registry: OperationRegistry): void {
    registry.register(llmOperations.platform_list, () =>
      credentialPlatformList(LLM_PLATFORMS),
    );
    registry.register(llmOperations.create, (input, caller) =>
      this.create(input.body, caller),
    );
    registry.register(llmOperations.list, (input, caller) =>
      caller.commit((tx) =>
        this.records.list(tx, this.platformSet, {
          ...input.query,
          holder: this.readHolder(tx, caller, input.query.holder),
        }),
      ),
    );
    registry.register(llmOperations.get, (input, caller) =>
      caller.commit((tx) =>
        this.get(
          tx,
          input.params.credential_name,
          this.readHolder(tx, caller, input.query.holder) ?? SERVER_HOLDER,
        ),
      ),
    );
    registry.register(llmOperations.rotate, (input, caller) =>
      this.rotate(
        input.params.credential_name,
        input.query,
        input.body,
        caller,
      ),
    );
    registry.register(llmOperations.update_metadata, (input, caller) => {
      const holder = input.query.holder ?? SERVER_HOLDER;
      return this.written(
        [holder],
        caller.commit((tx) =>
          this.records.updateMetadata(
            tx,
            this.platformSet,
            input.params.credential_name,
            input.body,
            humanIdentity(caller),
            holder,
          ),
        ),
      );
    });
    registry.register(llmOperations.revoke, (input, caller) => {
      const holder = input.query.holder ?? SERVER_HOLDER;
      return this.written(
        [holder],
        caller.commit((tx) =>
          this.records.revoke(
            tx,
            this.platformSet,
            input.params.credential_name,
            input.params.revision,
            holder,
          ),
        ),
      );
    });
    registry.register(llmOperations.archive, (input, caller) => {
      const holder = input.query.holder ?? SERVER_HOLDER;
      return this.written(
        [holder],
        caller.commit((tx) =>
          this.records.archive(
            tx,
            this.platformSet,
            input.params.credential_name,
            holder,
          ),
        ),
      );
    });
    registry.register(llmOperations.verify, async (input, caller) => {
      const answer = await this.records.verify(
        this.platformSet,
        input.params.credential_name,
        caller.context,
      );
      caller.context.signal.throwIfAborted();
      return caller.commit(() => answer);
    });
    registry.register(llmOperations.check, async (input, caller) => {
      const answer = await this.records.check(
        this.platformSet,
        input.body,
        caller.context,
      );
      caller.context.signal.throwIfAborted();
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
    registry.register(llmOperations.login_report, (input, caller) =>
      this.loginReport(input, caller),
    );
    registry.register(llmOperations.report, (input, caller) =>
      this.report(input, caller),
    );
    registry.register(llmOperations.sealed, (input, caller) =>
      caller.commit((tx) =>
        this.records.sealedCopy(
          tx,
          this.platformSet,
          input.params.credential_name,
          this.callerHolder(tx, caller),
        ),
      ),
    );
    registry.register(llmOperations.provider_check, (input, caller) =>
      this.providerCheck(input, caller),
    );
    registry.register(llmOperations.model_check, (input, caller) =>
      this.modelCheck(input, caller),
    );
  }

  credentialVersionOf(holder: string): number {
    return this.copyHealth.versionOf(holder);
  }

  raiseCredentialVersion(holder: string): void {
    this.copyHealth.raise(holder);
  }

  copyHealthOf(holder: string, copy: HeldCopy): CopyHealth {
    return this.copyHealth.healthOf(holder, copy);
  }

  private written<T>(holders: readonly string[], answer: T): T {
    for (const holder of holders)
      if (holder !== SERVER_HOLDER) this.copyHealth.raise(holder);
    return answer;
  }

  private callerHolder(tx: Transaction, caller: CallerContext): string {
    if (!isWorkerIdentity(caller.identity)) throw instanceForbidden();
    return this.workerHolder(tx, caller.identity);
  }

  private report(
    input: typeof llmOperations.report.input._output,
    caller: CallerContext,
  ): null {
    const name = input.params.credential_name;
    const report = input.body;
    if (reportInvalid(report)) throw invalidInput();
    let holder = SERVER_HOLDER;
    caller.commit((tx) => {
      holder = this.callerHolder(tx, caller);
      const copy = this.records.heldCopy(tx, this.platformSet, name, holder);
      if (!copy?.sealed_current)
        throw new OperationError(
          HttpStatus.NotFound,
          CredentialErrorCode.NotFound,
          "Credential not found.",
        );
      if (copy.revision !== report.revision)
        throw new OperationError(
          HttpStatus.Conflict,
          CredentialErrorCode.RevisionConflict,
          "Credential revision conflict.",
          { revision: copy.revision },
        );
      if (
        !isLlmPlatform(copy.platform) ||
        LLM_PLATFORMS[copy.platform].capability !== report.capability
      )
        throw invalidInput();
      return null;
    });
    this.copyHealth.record(holder, name, report, this.now());
    this.logger.info(
      {
        credential_name: name,
        holder,
        revision: report.revision,
        status: report.status,
        failure_reason: report.failure_reason,
      },
      "credential health report",
    );
    return null;
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
    const lists = this.records
      .copiesMetadata(tx, credentialName)
      .map((record) => approvedModels(record.platform, record.metadata));
    const [first, ...others] = lists;
    if (!first || others.some((list) => list === null)) return null;
    return first.filter((model) =>
      others.every((list) => list!.some(({ id }) => id === model.id)),
    );
  }

  private workerHolder(tx: Transaction, identity: WorkerIdentity): string {
    const holder = this.instanceKeys.nameOf(tx, identity.instanceId);
    if (holder === null) throw instanceForbidden();
    return holder;
  }

  private readHolder(
    tx: Transaction,
    caller: CallerContext,
    requested: string | undefined,
  ): string | undefined {
    if (!isWorkerIdentity(caller.identity)) return requested;
    const own = this.workerHolder(tx, caller.identity);
    if (requested !== undefined && requested !== own) throw instanceForbidden();
    return own;
  }

  private instanceKey(tx: Transaction, holder: string): InstanceKey {
    const key = this.instanceKeys.keyOf(tx, holder);
    if (key === null)
      throw new OperationError(
        HttpStatus.BadRequest,
        LlmErrorCode.InstanceUnknown,
        "The holder names no live worker instance.",
        { holder },
      );
    return key;
  }

  private create(
    body: LlmCredentialCreate,
    caller: CallerContext,
  ):
    | typeof llmOperations.create.output._output
    | Promise<typeof llmOperations.create.output._output> {
    const { name, platform, metadata } = body;
    const identity = caller.identity;
    if (isWorkerIdentity(identity)) {
      if (
        body.secret !== undefined ||
        body.holders !== undefined ||
        body.holder === undefined
      )
        throw invalidInput();
      const holder = body.holder;
      const copy = { holder, ...sealedBody(body) };
      return this.written(
        [holder],
        caller.commit((tx) => {
          if (this.workerHolder(tx, identity) !== holder)
            throw instanceForbidden();
          const [answer] = this.records.createCopies(
            tx,
            this.platformSet,
            { name, platform, metadata, copies: [copy] },
            undefined,
          );
          return answer!;
        }),
      );
    }
    if (
      body.secret === undefined ||
      body.holder !== undefined ||
      body.sealed !== undefined ||
      body.sealed_to !== undefined
    )
      throw invalidInput();
    const holders = body.holders ?? [SERVER_HOLDER];
    if (new Set(holders).size !== holders.length) throw invalidInput();
    if (holders.every((holder) => holder === SERVER_HOLDER))
      return this.commitCopies(
        body,
        holders.map((holder) => ({ holder, secret: body.secret })),
        caller,
      );
    return this.createSealed(body, body.secret, holders, caller);
  }

  private async createSealed(
    body: LlmCredentialCreate,
    secret: unknown,
    holders: string[],
    caller: CallerContext,
  ): Promise<typeof llmOperations.create.output._output> {
    const { name, platform } = body;
    const instances = holders.filter((holder) => holder !== SERVER_HOLDER);
    const keys = this.store.transaction((tx) =>
      instances.map((holder) => this.instanceKey(tx, holder)),
    );
    const sealed = await this.records.sealCopies(this.platformSet, {
      name,
      platform,
      secret,
      keys,
    });
    caller.context.signal.throwIfAborted();
    const copies: CredentialCopy[] = holders.map(
      (holder) =>
        sealed.find((copy) => copy.holder === holder) ?? { holder, secret },
    );
    return this.commitCopies(body, copies, caller);
  }

  private commitCopies(
    body: LlmCredentialCreate,
    copies: CredentialCopy[],
    caller: CallerContext,
  ): typeof llmOperations.create.output._output {
    const { name, platform, metadata } = body;
    return this.written(
      copies.map((copy) => copy.holder),
      caller.commit((tx) => {
        for (const copy of copies)
          if (copy.holder !== SERVER_HOLDER) this.instanceKey(tx, copy.holder);
        const [answer] = this.records.createCopies(
          tx,
          this.platformSet,
          { name, platform, metadata, copies },
          humanIdentity(caller),
        );
        return answer!;
      }),
    );
  }

  private rotate(
    credentialName: string,
    query: { holder?: string },
    body: LlmCredentialRotate,
    caller: CallerContext,
  ):
    | typeof llmOperations.rotate.output._output
    | Promise<typeof llmOperations.rotate.output._output> {
    const { expected_revision: expectedRevision, metadata } = body;
    const identity = caller.identity;
    if (isWorkerIdentity(identity)) {
      if (body.secret !== undefined || body.holder === undefined)
        throw invalidInput();
      const holder = body.holder;
      const copy = sealedBody(body);
      return this.written(
        [holder],
        caller.commit((tx) => {
          if (
            this.workerHolder(tx, identity) !== holder ||
            (query.holder !== undefined && query.holder !== holder)
          )
            throw instanceForbidden();
          return this.records.rotateSealed(
            tx,
            this.platformSet,
            credentialName,
            holder,
            { expected_revision: expectedRevision, ...copy, metadata },
            undefined,
          );
        }),
      );
    }
    if (
      body.secret === undefined ||
      body.holder !== undefined ||
      body.sealed !== undefined ||
      body.sealed_to !== undefined
    )
      throw invalidInput();
    const holder = query.holder ?? SERVER_HOLDER;
    if (holder === SERVER_HOLDER)
      return caller.commit((tx) =>
        this.records.rotate(
          tx,
          this.platformSet,
          credentialName,
          {
            expected_revision: expectedRevision,
            secret: body.secret,
            metadata,
          },
          humanIdentity(caller),
        ),
      );
    return this.rotateInstanceCopy(credentialName, holder, body, caller);
  }

  private async rotateInstanceCopy(
    credentialName: string,
    holder: string,
    body: LlmCredentialRotate,
    caller: CallerContext,
  ): Promise<typeof llmOperations.rotate.output._output> {
    const { key, platform } = this.store.transaction((tx) => ({
      platform: this.records.copyPlatform(
        tx,
        this.platformSet,
        credentialName,
        holder,
      ),
      key: this.instanceKey(tx, holder),
    }));
    const [copy] = await this.records.sealCopies(this.platformSet, {
      name: credentialName,
      platform,
      secret: body.secret,
      keys: [key],
    });
    caller.context.signal.throwIfAborted();
    return this.written(
      [holder],
      caller.commit((tx) => {
        this.instanceKey(tx, holder);
        return this.records.rotateSealed(
          tx,
          this.platformSet,
          credentialName,
          holder,
          {
            expected_revision: body.expected_revision,
            sealed: copy!.sealed,
            sealed_to: copy!.sealed_to,
            metadata: body.metadata,
          },
          humanIdentity(caller),
        );
      }),
    );
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
            { credential_name: body.data.credential, reason },
            "provider check failed",
          ),
        material.refreshStore ?? undefined,
      );
      caller.context.signal.throwIfAborted();
      return caller.commit(() => answer);
    } finally {
      context.cancel();
    }
  }

  private async modelCheck(
    input: typeof llmOperations.model_check.input._output,
    caller: CallerContext,
  ): Promise<ModelCheckAnswer> {
    const { body } = input;
    const material = this.store.transaction((tx) =>
      this.records.checkMaterial(tx, this.platformSet, body.credential),
    );
    if (!material || !isLlmPlatform(material.platform))
      throw new OperationError(
        HttpStatus.NotFound,
        LlmErrorCode.ModelCredentialNotFound,
        "Credential not found.",
      );
    const context = new CancellationContext(
      caller.context,
      Date.now() + MODEL_CHECK_TIMEOUT_MS,
    );
    try {
      const answer = await checkModel(
        {
          credential: body.credential,
          platform: material.platform,
          secret: material.secret(),
          metadata: material.metadata,
          model_identifier: body.model_identifier,
          reasoning_effort: body.reasoning_effort,
        },
        await this.loadModelRuntime(),
        context,
        material.refreshStore ?? undefined,
      );
      caller.context.signal.throwIfAborted();
      if (answer.message !== null)
        this.logger.info(
          {
            credential_name: body.credential,
            model_identifier: body.model_identifier,
            result: answer.result,
            reason: answer.message,
          },
          "model check failed",
        );
      return caller.commit(() => answer);
    } finally {
      context.cancel();
    }
  }

  private get(
    tx: Transaction,
    credentialName: string,
    holder: string,
  ): LlmCredentialAnswer {
    const answer = this.records.get(
      tx,
      this.platformSet,
      credentialName,
      holder,
    );
    return {
      ...answer,
      agent_providers: this.agentProvidersDependentOn(tx, credentialName).map(
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
      if (revision.holder === SERVER_HOLDER && next.models.length !== NO_ROWS)
        throw invalidInput();
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
          ({ agent_name }) => agent_name,
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
        session.credential_name,
        session.platform,
        { holder: SERVER_HOLDER, secret },
        this.now(),
      );
    });
    this.sessions.complete(session.id);
    this.logger.info(
      { credential_id: id, human_identity: session.human_identity },
      "credential login completed",
    );
  }

  private async login(
    input: typeof llmOperations.login.input._output,
    caller: CallerContext,
  ): Promise<typeof llmOperations.login.output._output> {
    if (!this.acceptingLogins)
      throw new OperationError(
        HttpStatus.ServiceUnavailable,
        LlmErrorCode.Stopped,
        "The LLM component is stopped.",
      );
    const { platform, name, mode: requested } = input.body;
    const holder = input.body.holder ?? SERVER_HOLDER;
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
    if (holder !== SERVER_HOLDER)
      return this.loginInstance(input, caller, platform, holder);
    this.store.transaction((tx) => this.records.requireAvailableName(tx, name));
    const mode = loginMode(
      platform,
      requested,
      caller.host === undefined || isLoopbackHost(caller.host),
    );
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
    using cancellation = addAbortListener(caller.context.signal, () =>
      flow.abort(),
    );
    if (caller.context.signal.aborted) flow.abort();
    void flow
      .run(this.oauthProviders, (secret) =>
        this.completeLogin(session, flow, secret),
      )
      .then(() => this.logins.delete(session.id));
    await flow.ready.promise;
    caller.context.signal.throwIfAborted();
    if (
      session.state === LoginSessionState.Failed ||
      session.state === LoginSessionState.Expired ||
      session.address === null
    )
      throw flow.failure;
    return caller.commit(() => ({
      session_id: session.id,
      address: session.address!,
      code: session.code,
      expires_at: session.expires_at,
    }));
  }

  private async loginInstance(
    input: typeof llmOperations.login.input._output,
    caller: CallerContext,
    platform: Platform,
    holder: string,
  ): Promise<typeof llmOperations.login.output._output> {
    const { name, mode: requested } = input.body;
    this.store.transaction((tx) => {
      this.instanceKey(tx, holder);
      this.records.requireLoginTarget(tx, name, holder);
    });
    const mode = loginMode(platform, requested, false);
    if (caller.identity?.kind !== IdentityKind.Human) throw invalidInput();
    if (!this.instanceConnected(holder))
      throw new OperationError(
        HttpStatus.Conflict,
        LOGIN_INSTANCE_UNAVAILABLE,
        "The worker instance holds no current connection.",
        { holder },
      );
    const session = this.sessions.start(
      platform,
      mode,
      caller.identity.accountId,
      name,
      this.now(),
      holder,
    );
    const flow = new InstanceLogin(session, this.sessions, this.now, () =>
      this.instanceLogins.delete(session.id),
    );
    this.instanceLogins.set(session.id, flow);
    flow.arm();
    using cancellation = addAbortListener(caller.context.signal, () =>
      flow.fail(LOGIN_FAILED_REASON),
    );
    await flow.ready.promise;
    caller.context.signal.throwIfAborted();
    if (!flow.pending() || session.address === null) throw flow.failure;
    return caller.commit(() => ({
      session_id: session.id,
      address: session.address!,
      code: session.code,
      expires_at: session.expires_at,
    }));
  }

  loginSessionsOf(holder: string): LoginSessionEntry[] {
    const entries: LoginSessionEntry[] = [];
    for (const [id, flow] of this.instanceLogins) {
      if (!flow.pending()) this.instanceLogins.delete(id);
      else if (flow.session.holder === holder) entries.push(flow.entry());
    }
    return entries;
  }

  private loginReport(
    input: typeof llmOperations.login_report.input._output,
    caller: CallerContext,
  ): null {
    const identity = caller.identity;
    if (!isWorkerIdentity(identity)) throw instanceForbidden();
    let apply = () => {};
    let flow: InstanceLogin | undefined;
    caller.commit((tx) => {
      const holder = this.workerHolder(tx, identity);
      flow = this.instanceLogins.get(input.params.session_id);
      if (!flow || flow.session.holder !== holder) throw loginNotFound();
      const { session } = flow;
      apply = flow.report(input.body, (copy) =>
        this.records.createLoginRevision(
          tx,
          this.platformSet,
          session.credential_name,
          session.platform,
          copy,
          this.now(),
        ),
      );
      return null;
    });
    apply();
    const { session } = flow!;
    if (session.state === LoginSessionState.Completed) {
      this.copyHealth.raise(session.holder);
      this.logger.info(
        { holder: session.holder, human_identity: session.human_identity },
        "credential login completed",
      );
    }
    return null;
  }

  private loginSession(id: string): LoginSession {
    const session = this.sessions.get(id);
    if (!session) throw loginNotFound();
    if (session.expires_at <= this.now()) {
      this.logins.get(id)?.expire();
      this.instanceLogins.get(id)?.expire();
    }
    return session;
  }

  private loginCode(
    input: typeof llmOperations.login_code.input._output,
    caller: CallerContext,
  ): typeof llmOperations.login_code.output._output {
    const session = this.loginSession(input.params.session_id);
    return caller.commit(() => {
      const instance = this.instanceLogins.get(session.id);
      if (instance) {
        instance.supply(input.body.value);
        return { session_id: session.id };
      }
      const flow = this.logins.get(session.id);
      if (!flow)
        throw new OperationError(
          HttpStatus.Conflict,
          LOGIN_VALUE_NOT_AWAITED,
          "No login value is awaited.",
        );
      flow.supply(input.body.value);
      return { session_id: session.id };
    });
  }

  private loginStatus(
    input: typeof llmOperations.login_status.input._output,
    caller: CallerContext,
  ): typeof llmOperations.login_status.output._output {
    const session = this.loginSession(input.params.session_id);
    return caller.commit(() => ({
      session_id: session.id,
      state: session.state,
      last_message: session.last_message,
      failure_reason: session.failure_reason,
    }));
  }

  private abortLogins(): void {
    this.acceptingLogins = false;
    for (const flow of this.logins.values()) flow.abort();
    this.logins.clear();
    for (const flow of this.instanceLogins.values())
      flow.fail(LOGIN_FAILED_REASON);
    this.instanceLogins.clear();
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
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
      login:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
