import {
  CancellationContext,
  cancelled,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  entryFailureReason,
  observeDeadline,
  ResourceFailureReason,
  ResourceStatus,
  type ResourceStatusValue,
} from "../../kernel/health.ts";
import { openJSON } from "../../kernel/hpke.ts";
import { HttpStatus } from "../../kernel/http.ts";
import {
  CREDENTIAL_SEAL_INFO,
  credentialSealAad,
  type CredentialAnswer,
  type SealedCopyAnswer,
} from "../../custody/contract.ts";
import type { InstanceCopyKey } from "../../custody/client.ts";
import {
  COPY_REPORT_MODELS_MAX,
  COPY_REPORT_TEXT_MAX_LENGTH,
  Connection,
  PROVIDER_CHECK_TIMEOUT_MS,
  type CopyReportBody,
  type ProviderCheckAnswer,
} from "../../llm/contract.ts";
import { HEALTH_OF_CONNECTION, type LlmProvider } from "../../llm/provider.ts";
import {
  CAPABILITY_NONE,
  isLlmPlatform,
  LLM_PLATFORMS,
  LLM_PROVIDERS,
} from "../../llm/platforms.ts";

import { ExchangeFailure } from "./instance-exchange.ts";

const ZERO_BYTE = 0;
const NO_TEXT_LENGTH = 0;

export interface CopyExchange {
  copies(context: Context): Promise<CredentialAnswer[]>;
  sealedCopy(name: string, context: Context): Promise<SealedCopyAnswer>;
  copyReport(
    name: string,
    body: CopyReportBody,
    context: Context,
  ): Promise<void>;
}

export interface CopyChecksOptions {
  key: InstanceCopyKey;
  exchange: CopyExchange;
  context: Context;
  providers?: Readonly<Partial<Record<string, LlmProvider>>>;
  timeoutMs?: number;
  log: (record: Record<string, unknown>) => void;
}

type Checked = { status: ResourceStatusValue; answer: ProviderCheckAnswer };

function liveCopy(copy: CredentialAnswer): boolean {
  return (
    copy.sealed_current &&
    copy.revisions.some((revision) => revision.ended_at === null)
  );
}

function reportedModels(answer: ProviderCheckAnswer): CopyReportBody["models"] {
  if (answer.connection !== Connection.Ok || answer.models === null)
    return null;
  return answer.models
    .filter(
      (model) =>
        model.id.length > NO_TEXT_LENGTH &&
        model.id.length <= COPY_REPORT_TEXT_MAX_LENGTH &&
        (model.owned_by?.length ?? NO_TEXT_LENGTH) <=
          COPY_REPORT_TEXT_MAX_LENGTH,
    )
    .slice(0, COPY_REPORT_MODELS_MAX);
}

function retryable(error: unknown): boolean {
  return (
    !(error instanceof ExchangeFailure) ||
    error.status === null ||
    error.status >= HttpStatus.InternalServerError
  );
}

export class CopyChecks {
  private readonly options: CopyChecksOptions;
  private seen?: number;
  private running?: Promise<void>;
  private again = false;

  constructor(options: CopyChecksOptions) {
    this.options = options;
  }

  observe(credentialVersion: number): void {
    if (this.seen === credentialVersion) return;
    this.seen = credentialVersion;
    this.start();
  }

  idle(): Promise<void> {
    return this.running ?? Promise.resolve();
  }

  private start(): void {
    if (this.running) {
      this.again = true;
      return;
    }
    this.running = this.checkAll().finally(() => {
      this.running = undefined;
      if (!this.again) return;
      this.again = false;
      this.start();
    });
  }

  private async checkAll(): Promise<void> {
    const { context, exchange } = this.options;
    try {
      const copies = await exchange.copies(context);
      for (const copy of copies.filter(liveCopy)) {
        if (context.signal.aborted) return;
        await this.checkOne(copy.name);
      }
    } catch (error) {
      this.failed(null, error);
    }
  }

  private async checkOne(name: string): Promise<void> {
    const { context, exchange } = this.options;
    try {
      const copy = await exchange.sealedCopy(name, context);
      const report = await this.check(copy);
      if (context.signal.aborted) return;
      await exchange.copyReport(name, report, context);
    } catch (error) {
      this.failed(name, error);
    }
  }

  private async check(copy: SealedCopyAnswer): Promise<CopyReportBody> {
    const capability = isLlmPlatform(copy.platform)
      ? LLM_PLATFORMS[copy.platform].capability
      : CAPABILITY_NONE;
    let failureReason: ResourceFailureReason | null = null;
    const checked = await this.probe(copy, (reason, observed) => {
      failureReason = observed;
      this.options.log({
        msg: "Worker instance credential check failed",
        credential_name: copy.name,
        platform: copy.platform,
        reason,
      });
    });
    return {
      revision: copy.revision,
      status: checked.status,
      capability,
      failure_reason: entryFailureReason(checked.status, failureReason),
      models: reportedModels(checked.answer),
    };
  }

  private async probe(
    copy: SealedCopyAnswer,
    observe: (reason: string, observed: ResourceFailureReason) => void,
  ): Promise<Checked> {
    const unknown: Checked = {
      status: ResourceStatus.Unknown,
      answer: { connection: Connection.Unreachable, models: null },
    };
    const providers: Readonly<Partial<Record<string, LlmProvider>>> =
      this.options.providers ?? LLM_PROVIDERS;
    const provider = providers[copy.platform];
    if (!provider) return unknown;
    const deadline = new CancellationContext(
      this.options.context,
      Date.now() + (this.options.timeoutMs ?? PROVIDER_CHECK_TIMEOUT_MS),
    );
    try {
      const secret = await this.open(copy);
      const answer = await Promise.race([
        provider.check(secret, copy.metadata, deadline, observe),
        cancelled(deadline.signal).then(() => unknown.answer),
      ]);
      if (deadline.signal.aborted) {
        observeDeadline(deadline, observe);
        return unknown;
      }
      return { status: HEALTH_OF_CONNECTION[answer.connection], answer };
    } catch {
      observe(
        "check failed before the remote call",
        ResourceFailureReason.Unclassified,
      );
      observeDeadline(deadline, observe);
      return unknown;
    } finally {
      deadline.cancel();
    }
  }

  private async open(copy: SealedCopyAnswer): Promise<unknown> {
    const { key } = this.options;
    const privateKey = key.private_key();
    try {
      return await openJSON(
        privateKey,
        CREDENTIAL_SEAL_INFO,
        credentialSealAad({
          name: copy.name,
          platform: copy.platform,
          holder: key.holder,
          sealed_to: key.sealed_to,
        }),
        copy.sealed,
      );
    } finally {
      privateKey.fill(ZERO_BYTE);
    }
  }

  private failed(name: string | null, error: unknown): void {
    if (this.options.context.signal.aborted) return;
    if (retryable(error)) this.seen = undefined;
    this.options.log({
      msg: "Worker instance credential report failed",
      credential_name: name,
      code: error instanceof Diagnostic ? error.code : null,
    });
  }
}
