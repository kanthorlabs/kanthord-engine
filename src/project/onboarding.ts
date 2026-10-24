import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { Logger } from "pino";
import { z } from "zod";
import { CancellationContext, type Context } from "../kernel/context.ts";
import {
  EnvironmentSource,
  checksOf,
  setupScriptsOf,
  type Environment,
} from "../kernel/devcontainer.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { isObject, isString } from "../kernel/values.ts";
import { SpanStatus, type ServerTrace } from "../tracking/contract.ts";
import {
  ProjectErrorCode,
  WorkerPlacement,
  type CheckResult,
} from "./contract.ts";
import type { GroupResolution } from "./environment.ts";
import type {
  EnvironmentAgent,
  EnvironmentSessionHandle,
} from "./environment-agent.ts";
import {
  environmentAgentTools,
  type EnvironmentAgentPort,
  type WriteAnswer,
} from "./environment-agent-tools.ts";
import type {
  EnvironmentProbeRunner,
  ProbeCommand,
} from "./environment-probe-contract.ts";
import {
  SecretReleaseOutcome,
  type EnvironmentSecrets,
  type SecretRelease,
} from "./environment-secrets.ts";
import {
  EnvironmentSpan,
  environmentRootEnd,
  environmentRootStart,
  environmentStepSpan,
  type EnvironmentContribution,
  type EnvironmentStepSpan,
  type EnvironmentTelemetry,
} from "./environment-telemetry.ts";
import {
  BASE_SUFFIX,
  EnvironmentFailureClass,
  EnvironmentStatus,
  EnvironmentTarget,
  FailureOrigin,
  ImageBuildOutcome,
  PROVED_SUFFIX,
  ProofOutcome,
  classifyProof,
  environmentDigest,
  environmentPath,
  environmentTagOf,
  type CommandResult,
  type EnvironmentRuntime,
  type EnvironmentSecretEntry,
  type ImageBuildInput,
  type ImageBuildResult,
  type ProofFile,
  type ProofFiles,
  type EnvironmentState,
  type ProofVerdict,
} from "./environment-state.ts";

export {
  environmentStateSchema,
  type EnvironmentState,
} from "./environment-state.ts";

const KEY_SEPARATOR = "\u0000";
const SINGLE_REPOSITORY = 1;
const NO_WORKER_BINDING = 0;
const NO_ITEMS = 0;
const NOT_QUEUED = -1;
const MS_PER_MINUTE = 60000;
const PENDING_RETRY_MS = 60000;
const COMMIT_CHECK_MS = 60000;
const RUN_STARTED = "project.onboarding.run_started";
const RUN_ENDED = "project.onboarding.run_ended";
const RUN_FAILED = "project.onboarding.run_failed";
const CACHE_COLLECTION_FAILED = "project.onboarding.cache_collection_failed";
const READ_FAILED = "project.onboarding.read_failed";
const TRACE_ID_BYTES = 16;
const SPAN_ID_BYTES = 8;
const REDACTED = "[redacted]";
const NO_COMMAND = null;
const NO_EXIT_CODE = null;
const SESSION_FAILED = "project.onboarding.session_failed";
const NO_TOOL_CALLS = 0;
const NO_ATTEMPTS = 0;

export const ENV_AGENT_ATTEMPT_LIMIT = 5;
export const ENV_AGENT_TOOL_CALL_LIMIT = 64;
export const ENV_AGENT_REPAIR_LIMIT = 3;

export const AttemptRefusal = {
  AttemptLimit: "attempt_limit",
  WriteRefused: "write_refused",
} as const;
export type AttemptRefusal =
  (typeof AttemptRefusal)[keyof typeof AttemptRefusal];
export const attemptRefusalSchema = z.enum(AttemptRefusal);

export type AttemptAnswer =
  | {
      outcome: ProofOutcome;
      class: EnvironmentFailureClass | null;
      tail: string;
      checks: CheckResult[];
      attempts_left: number;
    }
  | {
      outcome: null;
      reason: AttemptRefusal;
      detail: string | null;
      attempts_left: number;
    };

const TOOL_LIMIT_ANSWER = { reason: "tool_limit" } as const;

export interface RepositoryGroup {
  binding_id: string;
  binding_name: string;
  resource_identity: string;
  environment_secrets?: Readonly<Record<string, string>>;
}

export interface WorkerBindingFacts {
  placement: WorkerPlacement | null;
  external: boolean;
  environment: string | null;
}

export interface BindingFacts {
  repositories: readonly RepositoryGroup[];
  workers: readonly WorkerBindingFacts[];
}

export interface OnboardingDependencies {
  bindingsOf(projectId: string): BindingFacts;
  workerEnvironmentOf(
    projectId: string,
    workerResourceIdentity: string,
  ): string | null;
  projectIds(): string[];
  resolveGroup(
    bindingId: string,
    target: EnvironmentTarget,
    context: Context,
  ): Promise<GroupResolution>;
  baseCommitOf(bindingId: string, context: Context): Promise<string>;
  runtime: EnvironmentRuntime;
  proofs: ProofFiles;
  secrets: Pick<EnvironmentSecrets, "entriesOf" | "release" | "remove">;
  slotImage: string;
  version: string;
  wake(projectId: string): void;
  environmentAgent: Pick<EnvironmentAgent, "enabled" | "run">;
  probe: EnvironmentProbeRunner;
  writeEnvironment(
    projectId: string,
    bindingId: string,
    environment: unknown,
    context: Context,
  ): Promise<WriteAnswer>;
  environmentReady(
    projectId: string,
    resourceIdentity: string,
    tag: string,
  ): Promise<void>;
  logger: Logger;
  now(): number;
  runId(): string;
  environmentBuildTimeoutMs: number;
  telemetry: EnvironmentTelemetry;
}

type QueuedStep =
  typeof EnvironmentStatus.Building | typeof EnvironmentStatus.Proving;

export interface EnvironmentFailedInput {
  project_id: string;
  execution_id: string;
  resource_identities: readonly string[];
  stop: { code: EnvironmentFailureClass; detail: string };
  digests: Readonly<Record<string, string>>;
}

export interface GroupRecord {
  project_id: string;
  binding_id: string;
  binding_name: string;
  resource_identity: string;
  target: EnvironmentTarget;
  source: EnvironmentSource | null;
  commit: string | null;
  document: Environment | null;
  secrets: EnvironmentSecretEntry[];
  digest: string | null;
  tag: string | null;
  proof: ProofFile | null;
  proved: boolean;
  read_succeeded: boolean;
  step: QueuedStep | null;
  run_started_at: number | null;
  step_started_at: number | null;
  reason: string | null;
  reason_started_at: number | null;
  session: AbortController | null;
  environment_from_agent: boolean;
}

interface ReadFailure {
  reason: string;
  failure_reason: string | null;
}

function groupNamed(
  environment: string | null,
  repositories: readonly RepositoryGroup[],
): RepositoryGroup | null {
  if (environment !== null)
    return (
      repositories.find((group) => group.binding_name === environment) ?? null
    );
  return repositories.length === SINGLE_REPOSITORY
    ? (repositories[0] ?? null)
    : null;
}

export function targetOf(
  group: RepositoryGroup,
  facts: BindingFacts,
): EnvironmentTarget {
  const { repositories, workers } = facts;
  const names = (worker: WorkerBindingFacts) =>
    groupNamed(worker.environment, repositories)?.resource_identity ===
    group.resource_identity;
  if (
    workers.some(
      (worker) =>
        worker.placement === WorkerPlacement.Container && names(worker),
    )
  )
    return EnvironmentTarget.Image;
  if (
    workers.length > NO_WORKER_BINDING &&
    workers.every(
      (worker) =>
        worker.placement === WorkerPlacement.Worker || worker.external,
    )
  )
    return EnvironmentTarget.Remote;
  return EnvironmentTarget.Host;
}

function keyOf(projectId: string, resourceIdentity: string): string {
  return `${projectId}${KEY_SEPARATOR}${resourceIdentity}`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function failureReasonOf(error: unknown): string | null {
  if (!(error instanceof OperationError)) return null;
  const { details } = error;
  if (!isObject(details) || Array.isArray(details)) return null;
  const failureReason = details.failure_reason;
  return isString(failureReason) ? failureReason : null;
}

function readFailureOf(error: unknown): ReadFailure {
  const failureReason = failureReasonOf(error);
  const message = messageOf(error);
  return {
    reason:
      failureReason === null
        ? message
        : `${message} The failure reason is ${failureReason}.`,
    failure_reason: failureReason,
  };
}

function redact(text: string, values: readonly string[]): string {
  return values
    .filter((value) => value.length > NO_ITEMS)
    .toSorted((first, second) => second.length - first.length)
    .reduce((redacted, value) => redacted.split(value).join(REDACTED), text);
}

function redactedError(error: unknown, values: readonly string[]): unknown {
  if (values.length === NO_ITEMS) return error;
  return new Error(redact(messageOf(error), values));
}

function emptyRecord(
  projectId: string,
  group: RepositoryGroup,
  target: EnvironmentTarget,
): GroupRecord {
  return {
    project_id: projectId,
    binding_id: group.binding_id,
    binding_name: group.binding_name,
    resource_identity: group.resource_identity,
    target,
    source: null,
    commit: null,
    document: null,
    secrets: [],
    digest: null,
    tag: null,
    proof: null,
    proved: false,
    read_succeeded: false,
    step: null,
    run_started_at: null,
    step_started_at: null,
    reason: null,
    reason_started_at: null,
    session: null,
    environment_from_agent: false,
  };
}

function repairableSource(record: GroupRecord): boolean {
  if (record.source === EnvironmentSource.Stored)
    return record.environment_from_agent;
  return (
    record.source === EnvironmentSource.Detected ||
    record.source === EnvironmentSource.Universal ||
    record.source === EnvironmentSource.None
  );
}

function proofAtCommit(
  proof: ProofFile | null,
  commit: string,
): ProofFile | null {
  return proof?.outcome === ProofOutcome.Failed && proof.commit !== commit
    ? null
    : proof;
}

function decidedStatusOf(record: GroupRecord): EnvironmentStatus | null {
  if (!record.read_succeeded) return EnvironmentStatus.Pending;
  if (record.proof?.outcome === ProofOutcome.Failed)
    return EnvironmentStatus.Failed;
  if (record.target === EnvironmentTarget.Remote) return EnvironmentStatus.None;
  if (
    (record.target === EnvironmentTarget.Image && record.proved) ||
    (record.target === EnvironmentTarget.Host &&
      record.proof?.outcome === ProofOutcome.Passed)
  )
    return EnvironmentStatus.Ready;
  if (record.source === EnvironmentSource.None) return EnvironmentStatus.None;
  return null;
}

export function statusOf(record: GroupRecord): EnvironmentStatus {
  return record.step ?? decidedStatusOf(record) ?? EnvironmentStatus.Pending;
}

function claimable(status: EnvironmentStatus): boolean {
  return (
    status === EnvironmentStatus.None || status === EnvironmentStatus.Ready
  );
}

const detailSchema = z.looseObject({
  command: z.string().optional(),
  exit_code: z.int().optional(),
});

function detailFacts(detail: string): {
  command: string | null;
  exit_code: number | null;
} {
  let value: unknown;
  try {
    value = JSON.parse(detail);
  } catch {
    return { command: NO_COMMAND, exit_code: NO_EXIT_CODE };
  }
  const parsed = detailSchema.safeParse(value);
  if (!parsed.success) return { command: NO_COMMAND, exit_code: NO_EXIT_CODE };
  return {
    command: parsed.data.command ?? NO_COMMAND,
    exit_code: parsed.data.exit_code ?? NO_EXIT_CODE,
  };
}

function failedVerdict(
  failureClass: EnvironmentFailureClass,
  tail: string,
): ProofVerdict {
  return {
    outcome: ProofOutcome.Failed,
    class: failureClass,
    command: NO_COMMAND,
    exit_code: NO_EXIT_CODE,
    tail,
    checks: [],
  };
}

function stateOf(record: GroupRecord): EnvironmentState {
  const status = statusOf(record);
  const proof = record.proof;
  return {
    binding_id: record.binding_id,
    binding_name: record.binding_name,
    resource_identity: record.resource_identity,
    target: record.target,
    source: record.source,
    status,
    digest: record.digest,
    tag: record.tag,
    run_started_at: record.run_started_at,
    step_started_at: record.step_started_at,
    reason: record.reason,
    reason_started_at: record.reason_started_at,
    failure:
      status === EnvironmentStatus.Failed && proof !== null
        ? {
            class: proof.class,
            origin: proof.origin,
            execution_id: proof.execution_id,
            command: proof.command,
            exit_code: proof.exit_code,
            tail: proof.tail,
            reproduce: proof.reproduce,
            ended_at: proof.ended_at,
          }
        : null,
    checks: proof?.checks ?? [],
    repairs: proof?.repairs ?? 0,
    repairing: record.session !== null,
  };
}

export class Onboarding {
  private readonly dependencies: OnboardingDependencies;
  private readonly context = new CancellationContext();
  private readonly records = new Map<string, GroupRecord>();
  private readonly computing = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly marked = new Set<string>();
  private readonly changedWhileReading = new Set<string>();
  private readonly retries = new Map<string, NodeJS.Timeout>();
  private readonly loggedReadFailures = new Map<string, string>();
  private readonly queue: string[] = [];
  private draining: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(dependencies: OnboardingDependencies) {
    this.dependencies = dependencies;
  }

  async start(): Promise<void> {
    const { runtime, proofs } = this.dependencies;
    await runtime.removeStaleRuns();
    const held = new Set<string>();
    for (const projectId of this.dependencies.projectIds())
      for (const group of this.dependencies.bindingsOf(projectId)
        .repositories) {
        held.add(environmentPath(group.resource_identity));
        this.trigger(projectId, group.resource_identity);
      }
    for (const path of proofs.paths()) {
      if (held.has(path)) continue;
      await runtime.collect(path, null);
      proofs.removePath(path);
    }
    await this.collectCacheVolumes();
  }

  private async collectCacheVolumes(): Promise<void> {
    const { runtime, logger } = this.dependencies;
    const held = new Set<string>();
    for (const projectId of this.dependencies.projectIds())
      for (const group of this.dependencies.bindingsOf(projectId).repositories)
        held.add(keyOf(projectId, group.resource_identity));
    try {
      for (const volume of await runtime.cacheVolumes()) {
        if (held.has(keyOf(volume.project_id, volume.resource_identity)))
          continue;
        await runtime
          .removeCacheVolume(volume.project_id, volume.resource_identity)
          .catch((error: unknown) =>
            logger.error({ err: error, ...volume }, CACHE_COLLECTION_FAILED),
          );
      }
    } catch (error) {
      logger.error({ err: error }, CACHE_COLLECTION_FAILED);
    }
  }

  cancel(): void {
    for (const record of this.records.values()) record.session?.abort();
    this.context.cancel();
    for (const timer of this.retries.values()) clearTimeout(timer);
    this.retries.clear();
  }

  async stop(): Promise<void> {
    this.cancel();
    await this.draining;
  }

  bindingsChanged(projectId: string): void {
    const facts = this.dependencies.bindingsOf(projectId);
    const { repositories } = facts;
    const current = new Set(
      repositories.map((group) => group.resource_identity),
    );
    for (const key of this.computing.keys())
      if (key.startsWith(keyOf(projectId, "")))
        this.changedWhileReading.add(key);
    for (const [key, record] of Array.from(this.records))
      if (
        record.project_id === projectId &&
        !current.has(record.resource_identity)
      )
        this.dropRecord(key);
    for (const group of repositories) {
      this.markChanged(projectId, group, facts);
      this.trigger(projectId, group.resource_identity);
    }
    void this.collectCacheVolumes();
  }

  environmentClaimed(projectId: string, resourceIdentity: string): void {
    this.trigger(projectId, resourceIdentity);
  }

  compute(projectId: string, resourceIdentity: string): Promise<void> {
    const key = keyOf(projectId, resourceIdentity);
    const running = this.computing.get(key);
    if (running !== undefined) {
      this.again.add(key);
      return running;
    }
    const run = this.computeWhileMarked(projectId, resourceIdentity);
    this.computing.set(key, run);
    return run;
  }

  states(projectId: string): EnvironmentState[] {
    return Array.from(this.records.values())
      .filter((record) => record.project_id === projectId)
      .sort((first, second) =>
        first.binding_name < second.binding_name ? -1 : 1,
      )
      .map(stateOf);
  }

  environmentsClaimable(
    projectId: string,
    resourceIdentities: readonly string[],
  ): boolean {
    const records = resourceIdentities.map((identity) =>
      this.records.get(keyOf(projectId, identity)),
    );
    resourceIdentities.forEach((identity, index) => {
      if (records[index] === undefined) this.trigger(projectId, identity);
    });
    return records.every(
      (record) => record !== undefined && claimable(statusOf(record)),
    );
  }

  environmentDigestOf(
    projectId: string,
    resourceIdentity: string,
  ): string | null {
    return this.records.get(keyOf(projectId, resourceIdentity))?.digest ?? null;
  }

  environmentOf(
    projectId: string,
    resourceIdentity: string,
  ): { source: EnvironmentSource; document: Environment } | null {
    const record = this.records.get(keyOf(projectId, resourceIdentity));
    if (record?.source == null || record.document === null) return null;
    return { source: record.source, document: record.document };
  }

  slotImage(
    projectId: string,
    workerResourceIdentity: string,
    signal: AbortSignal,
  ): Promise<string> {
    const waiting = AbortSignal.any([signal, this.context.signal]);
    return new Promise((resolve, reject) => {
      if (waiting.aborted) return reject(waiting.reason);
      const settle = () => {
        const answer = this.slotAnswerOf(projectId, workerResourceIdentity);
        if (answer === null) return;
        release();
        resolve(answer);
      };
      const abort = () => {
        release();
        reject(waiting.reason);
      };
      const release = () => {
        this.listeners.delete(settle);
        waiting.removeEventListener("abort", abort);
      };
      this.listeners.add(settle);
      waiting.addEventListener("abort", abort, { once: true });
      const group = this.slotGroupOf(projectId, workerResourceIdentity);
      if (
        group !== null &&
        !this.records.has(keyOf(projectId, group.resource_identity))
      )
        this.trigger(projectId, group.resource_identity);
      settle();
    });
  }

  slotCacheGroupOf(
    projectId: string,
    workerResourceIdentity: string,
    image: string,
  ): string | null {
    const group = this.slotGroupOf(projectId, workerResourceIdentity);
    if (group === null) return null;
    const record = this.records.get(keyOf(projectId, group.resource_identity));
    return record?.tag === image ? group.resource_identity : null;
  }

  private slotGroupOf(
    projectId: string,
    workerResourceIdentity: string,
  ): RepositoryGroup | null {
    return groupNamed(
      this.dependencies.workerEnvironmentOf(projectId, workerResourceIdentity),
      this.dependencies.bindingsOf(projectId).repositories,
    );
  }

  private slotAnswerOf(
    projectId: string,
    workerResourceIdentity: string,
  ): string | null {
    const group = this.slotGroupOf(projectId, workerResourceIdentity);
    if (group === null) return this.dependencies.slotImage;
    const record = this.records.get(keyOf(projectId, group.resource_identity));
    if (record === undefined) return null;
    const status = statusOf(record);
    if (status === EnvironmentStatus.Ready)
      return record.tag ?? this.dependencies.slotImage;
    return status === EnvironmentStatus.None
      ? this.dependencies.slotImage
      : null;
  }

  private trigger(projectId: string, resourceIdentity: string): void {
    setImmediate(() => {
      if (this.context.signal.aborted) return;
      this.compute(projectId, resourceIdentity).catch((error: unknown) =>
        this.dependencies.logger.error(
          {
            err: error,
            project_id: projectId,
            resource_identity: resourceIdentity,
          },
          "Onboarding compute failed.",
        ),
      );
    });
  }

  private markChanged(
    projectId: string,
    group: RepositoryGroup,
    facts: BindingFacts,
  ): void {
    const key = keyOf(projectId, group.resource_identity);
    const record = this.records.get(key);
    if (record === undefined) return;
    const rowChanged =
      record.binding_id !== group.binding_id ||
      record.binding_name !== group.binding_name;
    if (!rowChanged && targetOf(group, facts) === record.target) return;
    if (rowChanged) {
      record.binding_id = group.binding_id;
      record.binding_name = group.binding_name;
      record.environment_from_agent = false;
    }
    record.read_succeeded = false;
    this.loggedReadFailures.delete(key);
    if (record.run_started_at === null) {
      record.step = null;
      record.step_started_at = null;
      this.schedule(key, record);
    }
    this.notify();
  }

  private dropRecord(key: string): void {
    this.records.delete(key);
    this.loggedReadFailures.delete(key);
    const index = this.queue.indexOf(key);
    if (index !== NOT_QUEUED) this.queue.splice(index, 1);
    this.clearRetry(key);
    this.notify();
  }

  private clearRetry(key: string): void {
    const timer = this.retries.get(key);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.retries.delete(key);
  }

  private retryWhileWaiting(key: string, record: GroupRecord): void {
    const status = statusOf(record);
    if (status === EnvironmentStatus.Pending)
      return this.retryAfter(key, PENDING_RETRY_MS, () =>
        this.trigger(record.project_id, record.resource_identity),
      );
    if (status === EnvironmentStatus.Failed)
      return this.retryAfter(
        key,
        COMMIT_CHECK_MS,
        () => void this.checkBaseCommit(key),
      );
    this.clearRetry(key);
  }

  private retryAfter(key: string, delayMs: number, retry: () => void): void {
    if (this.retries.has(key) || this.context.signal.aborted) return;
    const timer = setTimeout(() => {
      this.retries.delete(key);
      retry();
    }, delayMs);
    timer.unref();
    this.retries.set(key, timer);
  }

  private async checkBaseCommit(key: string): Promise<void> {
    const record = this.records.get(key);
    if (record === undefined || statusOf(record) !== EnvironmentStatus.Failed)
      return;
    if (this.busy(key, record) || this.targetMoved(record))
      return this.retryWhileWaiting(key, record);
    let commit: string;
    try {
      commit = await this.dependencies.baseCommitOf(
        record.binding_id,
        this.context,
      );
    } catch (error) {
      if (this.context.signal.aborted) return;
      this.logReadFailure(key, record, readFailureOf(error));
      return this.retryWhileWaiting(key, record);
    }
    if (
      this.context.signal.aborted ||
      this.records.get(key) !== record ||
      statusOf(record) !== EnvironmentStatus.Failed
    )
      return;
    this.loggedReadFailures.delete(key);
    if (record.proof?.commit === commit)
      return this.retryWhileWaiting(key, record);
    this.trigger(record.project_id, record.resource_identity);
  }

  private busy(key: string, record: GroupRecord): boolean {
    return (
      record.run_started_at !== null ||
      record.session !== null ||
      this.computing.has(key)
    );
  }

  private async computeWhileMarked(
    projectId: string,
    resourceIdentity: string,
  ): Promise<void> {
    const key = keyOf(projectId, resourceIdentity);
    try {
      do {
        this.again.delete(key);
        await this.computeOnce(projectId, resourceIdentity);
      } while (this.again.has(key));
    } finally {
      this.computing.delete(key);
    }
  }

  private async computeOnce(
    projectId: string,
    resourceIdentity: string,
  ): Promise<void> {
    const key = keyOf(projectId, resourceIdentity);
    this.changedWhileReading.delete(key);
    const facts = this.dependencies.bindingsOf(projectId);
    const group = facts.repositories.find(
      (candidate) => candidate.resource_identity === resourceIdentity,
    );
    if (group === undefined) {
      this.dropRecord(key);
      return;
    }
    const target = targetOf(group, facts);
    const previous = this.records.get(key);
    if (previous !== undefined && previous.run_started_at !== null) {
      this.marked.add(key);
      return;
    }
    const wasClaimable =
      previous !== undefined && claimable(statusOf(previous));
    let next: GroupRecord;
    let failure: ReadFailure | null = null;
    try {
      next = await this.read(projectId, group, target, previous);
      if (!next.read_succeeded && next.reason !== null)
        failure = { reason: next.reason, failure_reason: null };
    } catch (error) {
      failure = readFailureOf(error);
      const base = previous ?? emptyRecord(projectId, group, target);
      next = {
        ...base,
        ...(base.target === target
          ? {}
          : { digest: null, tag: null, proof: null, proved: false }),
        target,
        reason: failure.reason,
      };
    }
    next.reason_started_at =
      next.reason === null
        ? null
        : (previous?.reason_started_at ?? this.dependencies.now());
    if (this.changedWhileReading.delete(key)) {
      if (!this.context.signal.aborted) this.again.add(key);
      return;
    }
    const current = this.records.get(key);
    if (current !== undefined && current.run_started_at !== null) {
      this.marked.add(key);
      return;
    }
    this.records.set(key, next);
    this.logReadFailure(key, next, failure);
    this.schedule(key, next);
    this.retryWhileWaiting(key, next);
    this.notify();
    if (!wasClaimable && claimable(statusOf(next)))
      this.dependencies.wake(projectId);
  }

  private async read(
    projectId: string,
    group: RepositoryGroup,
    target: EnvironmentTarget,
    previous: GroupRecord | undefined,
  ): Promise<GroupRecord> {
    const { runtime, proofs, version } = this.dependencies;
    const { signal } = this.context;
    const resolved = await this.dependencies.resolveGroup(
      group.binding_id,
      target,
      this.context,
    );
    if (resolved.reason !== undefined)
      return {
        ...emptyRecord(projectId, group, target),
        source: resolved.source,
        commit: resolved.commit,
        reason: resolved.reason,
      };
    const atImage = target === EnvironmentTarget.Image;
    const secrets = this.dependencies.secrets.entriesOf(
      group.environment_secrets ?? {},
    );
    const sum = environmentDigest({
      resource_identity: group.resource_identity,
      target,
      source: resolved.source,
      document: resolved.document,
      files: resolved.files,
      base_image: atImage
        ? await this.baseImageOf(resolved.document?.image, signal)
        : null,
      slot_image: atImage
        ? await runtime.imageId(this.dependencies.slotImage, signal)
        : null,
      secrets,
      version,
    });
    const tag = atImage ? environmentTagOf(group.resource_identity, sum) : null;
    const next: GroupRecord = {
      ...(previous ?? emptyRecord(projectId, group, target)),
      binding_id: group.binding_id,
      binding_name: group.binding_name,
      target,
      source: resolved.source,
      commit: resolved.commit,
      document: resolved.document,
      secrets,
      digest: sum,
      tag,
      proof: proofAtCommit(
        proofs.read(environmentPath(group.resource_identity), sum),
        resolved.commit,
      ),
      proved:
        tag !== null && (await runtime.imageExists(`${tag}${PROVED_SUFFIX}`)),
      read_succeeded: true,
      reason: null,
    };
    next.step = null;
    next.step_started_at = null;
    if (decidedStatusOf(next) === null) next.step = await this.stepOf(next);
    return next;
  }

  private async baseImageOf(
    reference: string | undefined,
    signal: AbortSignal,
  ): Promise<string | null> {
    if (reference === undefined) return null;
    const { runtime } = this.dependencies;
    const found = await runtime.imageId(reference, signal);
    if (found !== null) return found;
    await runtime.pullImage(reference, signal);
    return runtime.imageId(reference, signal);
  }

  private async stepOf(record: GroupRecord): Promise<QueuedStep> {
    if (record.target !== EnvironmentTarget.Image)
      return EnvironmentStatus.Proving;
    assert.ok(record.tag !== null, "An image group holds a tag.");
    return (await this.dependencies.runtime.imageExists(record.tag))
      ? EnvironmentStatus.Proving
      : EnvironmentStatus.Building;
  }

  private schedule(key: string, record: GroupRecord): void {
    const index = this.queue.indexOf(key);
    if (record.step === null) {
      if (index !== NOT_QUEUED) this.queue.splice(index, 1);
      return;
    }
    if (index === NOT_QUEUED) this.queue.push(key);
    this.drain();
  }

  private drain(): void {
    if (this.draining !== null) return;
    this.draining = this.runQueue().finally(() => {
      this.draining = null;
      if (this.queue.length > NO_ITEMS && !this.context.signal.aborted)
        this.drain();
    });
  }

  private async runQueue(): Promise<void> {
    while (this.queue.length > NO_ITEMS && !this.context.signal.aborted) {
      const key = this.queue.shift();
      assert.ok(key !== undefined);
      await this.runGroup(key);
    }
  }

  private async runGroup(key: string): Promise<void> {
    const record = this.records.get(key);
    if (
      record === undefined ||
      record.step === null ||
      record.run_started_at !== null
    )
      return;
    assert.ok(record.digest !== null, "A queued group holds a digest.");
    const ranForSession = record.session !== null;
    const now = this.dependencies.now();
    record.run_started_at = now;
    record.step_started_at = now;
    this.notify();
    const trace = this.openTrace(record, now);
    this.logRun(RUN_STARTED, record);
    let completed = false;
    let verdict: ProofVerdict | null = null;
    const runId = this.dependencies.runId();
    const secretValues: string[] = [];
    try {
      verdict = await this.verdictOf(record, runId, trace, secretValues);
      if (verdict !== null) {
        await this.finalize(record, verdict);
        completed = true;
      }
    } catch (error) {
      if (!this.context.signal.aborted) {
        record.reason = redact(messageOf(error), secretValues);
        record.reason_started_at ??= this.dependencies.now();
        this.dependencies.logger.error(
          {
            err: redactedError(error, secretValues),
            binding: record.binding_name,
            digest: record.digest,
          },
          RUN_FAILED,
        );
      }
    } finally {
      this.dependencies.secrets.remove(runId);
      secretValues.length = NO_ITEMS;
      record.run_started_at = null;
      record.step = null;
      record.step_started_at = null;
      this.notify();
      this.closeTrace(trace, completed ? verdict : null);
      this.logRun(RUN_ENDED, record);
    }
    if (completed && claimable(statusOf(record)))
      this.dependencies.wake(record.project_id);
    if (this.records.get(key) === record) this.retryWhileWaiting(key, record);
    if (this.marked.delete(key))
      this.trigger(record.project_id, record.resource_identity);
    if (completed && verdict?.outcome === ProofOutcome.Failed && !ranForSession)
      this.considerSession(record);
  }

  private targetMoved(record: GroupRecord): boolean {
    const facts = this.dependencies.bindingsOf(record.project_id);
    const group = facts.repositories.find(
      (candidate) => candidate.resource_identity === record.resource_identity,
    );
    return group === undefined || targetOf(group, facts) !== record.target;
  }

  private considerSession(group: GroupRecord): void {
    const key = keyOf(group.project_id, group.resource_identity);
    if (this.records.get(key) !== group || group.session !== null) return;
    if (group.target !== EnvironmentTarget.Image || !repairableSource(group))
      return;
    if (this.targetMoved(group)) return;
    if (!this.dependencies.environmentAgent.enabled()) return;
    assert.ok(group.digest !== null, "A failed group holds a digest.");
    const { proofs } = this.dependencies;
    const path = environmentPath(group.resource_identity);
    const proof = proofs.read(path, group.digest);
    if (proof === null || proof.repairs >= ENV_AGENT_REPAIR_LIMIT) return;
    const failure = {
      ...proof,
      repairs: proofs.incrementRepairs(path, group.digest),
    };
    group.proof = failure;
    void this.startSession(group, failure);
  }

  private emit(trace: ServerTrace, contribution: EnvironmentContribution) {
    try {
      this.dependencies.telemetry.span(trace, contribution);
    } catch {
      return;
    }
  }

  private openTrace(record: GroupRecord, startedAt: number): ServerTrace {
    assert.ok(
      record.source !== null && record.digest !== null,
      "A run holds its source and its digest.",
    );
    const trace: ServerTrace = {
      trace_id: randomBytes(TRACE_ID_BYTES).toString("hex"),
      root_span_id: randomBytes(SPAN_ID_BYTES).toString("hex"),
      project_id: record.project_id,
      created_at: startedAt,
    };
    this.emit(
      trace,
      environmentRootStart(trace, {
        binding_name: record.binding_name,
        target: record.target,
        source: record.source,
        digest: record.digest,
      }),
    );
    return trace;
  }

  private closeTrace(trace: ServerTrace, verdict: ProofVerdict | null): void {
    const passed = verdict?.outcome === ProofOutcome.Passed;
    this.emit(
      trace,
      environmentRootEnd(trace, {
        end_time: this.dependencies.now(),
        status: passed ? SpanStatus.Ok : SpanStatus.Error,
        error_type: verdict?.class ?? null,
      }),
    );
  }

  private recordStep(
    trace: ServerTrace,
    operation: EnvironmentStepSpan,
    startedAt: number,
    failure: EnvironmentFailureClass | null,
  ): void {
    this.emit(
      trace,
      environmentStepSpan(trace, {
        span_id: randomBytes(SPAN_ID_BYTES).toString("hex"),
        operation,
        start_time: startedAt,
        end_time: this.dependencies.now(),
        status: failure === null ? SpanStatus.Ok : SpanStatus.Error,
        error_type: failure,
      }),
    );
  }

  private logReadFailure(
    key: string,
    record: GroupRecord,
    failure: ReadFailure | null,
  ): void {
    if (failure === null) {
      this.loggedReadFailures.delete(key);
      return;
    }
    if (this.loggedReadFailures.get(key) === failure.reason) return;
    this.loggedReadFailures.set(key, failure.reason);
    this.dependencies.logger.error(
      {
        project_id: record.project_id,
        binding: record.binding_name,
        resource_identity: record.resource_identity,
        reason: failure.reason,
        failure_reason: failure.failure_reason,
      },
      READ_FAILED,
    );
  }

  private logRun(event: string, record: GroupRecord): void {
    this.dependencies.logger.info(
      {
        binding: record.binding_name,
        digest: record.digest,
        target: record.target,
        status: statusOf(record),
        class: record.proof?.class ?? null,
      },
      event,
    );
  }

  private async verdictOf(
    record: GroupRecord,
    runId: string,
    trace: ServerTrace,
    secretValues: string[],
  ): Promise<ProofVerdict | null> {
    const signal = AbortSignal.any([
      this.context.signal,
      AbortSignal.timeout(this.dependencies.environmentBuildTimeoutMs),
    ]);
    try {
      const verdict = await this.execute(
        record,
        runId,
        signal,
        trace,
        secretValues,
      );
      return verdict === null
        ? null
        : { ...verdict, tail: redact(verdict.tail, secretValues) };
    } catch (error) {
      if (this.context.signal.aborted) return null;
      this.dependencies.logger.error(
        {
          err: redactedError(error, secretValues),
          binding: record.binding_name,
          digest: record.digest,
        },
        RUN_FAILED,
      );
      return failedVerdict(
        record.step === EnvironmentStatus.Building
          ? EnvironmentFailureClass.BuildFailed
          : EnvironmentFailureClass.SetupFailed,
        signal.aborted
          ? this.deadlineTail()
          : redact(messageOf(error), secretValues),
      );
    }
  }

  private deadlineTail(): string {
    const minutes = this.dependencies.environmentBuildTimeoutMs / MS_PER_MINUTE;
    return `the run deadline of ${minutes} minutes passed`;
  }

  private async execute(
    record: GroupRecord,
    runId: string,
    signal: AbortSignal,
    trace: ServerTrace,
    secretValues: string[],
  ): Promise<ProofVerdict | null> {
    const { runtime } = this.dependencies;
    const { document, commit, tag } = record;
    assert.ok(document !== null && commit !== null, "A run holds its inputs.");
    const base = {
      run_id: runId,
      binding_id: record.binding_id,
      resource_identity: record.resource_identity,
      commit,
    };
    const checksOnly =
      record.target !== EnvironmentTarget.Image &&
      record.source === EnvironmentSource.Detected;
    const proof = {
      ...base,
      project_id: record.project_id,
      setup: checksOnly ? [] : setupScriptsOf(document),
      checks: checksOf(document),
    };
    if (record.target !== EnvironmentTarget.Image) {
      return this.tracedProof(trace, proof.setup.length, () =>
        runtime.proveOnHost(proof, signal),
      );
    }
    assert.ok(tag !== null, "An image group holds a tag.");
    if (record.step === EnvironmentStatus.Building) {
      const released = this.releaseSecrets(record, runId);
      if (released.outcome === SecretReleaseOutcome.Stale) {
        this.marked.add(keyOf(record.project_id, record.resource_identity));
        return null;
      }
      if (released.outcome === SecretReleaseOutcome.Unavailable)
        return failedVerdict(
          EnvironmentFailureClass.BuildFailed,
          `environment secret ${released.variable} is unavailable`,
        );
      secretValues.push(...released.values);
      const built = await this.tracedBuild(
        trace,
        { ...base, tag, document, secrets: released.files },
        signal,
      );
      if (built === null) return null;
      if (built.outcome !== ImageBuildOutcome.Built)
        return failedVerdict(built.class, built.tail);
      record.step = EnvironmentStatus.Proving;
      record.step_started_at = this.dependencies.now();
      this.notify();
    }
    return this.tracedProof(trace, proof.setup.length, () =>
      runtime.prove({ ...proof, tag }, signal),
    );
  }

  private releaseSecrets(record: GroupRecord, runId: string): SecretRelease {
    if (record.secrets.length === NO_ITEMS)
      return { outcome: SecretReleaseOutcome.Released, files: [], values: [] };
    return this.dependencies.secrets.release({
      projectId: record.project_id,
      bindingId: record.binding_id,
      runId,
      entries: record.secrets,
    });
  }

  private async tracedBuild(
    trace: ServerTrace,
    input: ImageBuildInput,
    signal: AbortSignal,
  ): Promise<ImageBuildResult | null> {
    const startedAt = this.dependencies.now();
    let built: ImageBuildResult;
    try {
      built = await this.dependencies.runtime.build(input, signal);
    } catch (error) {
      if (!this.context.signal.aborted)
        this.recordStep(
          trace,
          EnvironmentSpan.Build,
          startedAt,
          EnvironmentFailureClass.BuildFailed,
        );
      throw error;
    }
    if (this.context.signal.aborted) return null;
    this.recordStep(
      trace,
      EnvironmentSpan.Build,
      startedAt,
      built.outcome === ImageBuildOutcome.Built ? null : built.class,
    );
    return built;
  }

  private async tracedProof(
    trace: ServerTrace,
    setupCount: number,
    prove: () => Promise<CommandResult[]>,
  ): Promise<ProofVerdict | null> {
    const startedAt = this.dependencies.now();
    let results: CommandResult[];
    try {
      results = await prove();
    } catch (error) {
      if (!this.context.signal.aborted)
        this.recordProofSteps(
          trace,
          setupCount,
          startedAt,
          EnvironmentFailureClass.SetupFailed,
        );
      throw error;
    }
    if (this.context.signal.aborted) return null;
    const verdict = classifyProof(results);
    this.recordProofSteps(trace, setupCount, startedAt, verdict.class);
    return verdict;
  }

  private recordProofSteps(
    trace: ServerTrace,
    setupCount: number,
    startedAt: number,
    failure: EnvironmentFailureClass | null,
  ): void {
    const setupFailed = failure === EnvironmentFailureClass.SetupFailed;
    if (setupCount > NO_ITEMS || setupFailed)
      this.recordStep(
        trace,
        EnvironmentSpan.Setup,
        startedAt,
        setupFailed ? failure : null,
      );
    if (setupFailed) return;
    this.recordStep(trace, EnvironmentSpan.Proof, startedAt, failure);
  }

  private async finalize(
    record: GroupRecord,
    verdict: ProofVerdict,
  ): Promise<void> {
    const { runtime, proofs } = this.dependencies;
    const { digest, tag, commit } = record;
    assert.ok(digest !== null && commit !== null);
    const path = environmentPath(record.resource_identity);
    const file: ProofFile = {
      digest,
      outcome: verdict.outcome,
      class: verdict.class,
      origin: FailureOrigin.Onboarding,
      execution_id: null,
      command: verdict.command,
      exit_code: verdict.exit_code,
      tail: verdict.tail,
      reproduce: this.reproduceOf(tag),
      checks: verdict.checks,
      repairs: 0,
      ended_at: this.dependencies.now(),
      commit,
    };
    proofs.write(path, file);
    record.proof = file;
    const proved = verdict.outcome === ProofOutcome.Passed && tag !== null;
    if (proved) {
      await runtime.tagProved(tag);
      record.proved = true;
    }
    await runtime.collect(path, digest);
    await this.collectCacheVolumes();
    for (const other of proofs.digests(path))
      if (other !== digest) proofs.remove(path, other);
    if (proved)
      await this.dependencies.environmentReady(
        record.project_id,
        record.resource_identity,
        tag,
      );
  }

  private reproduceOf(tag: string | null): string | null {
    return tag === null
      ? null
      : `${this.dependencies.runtime.runtimeName} run -it --rm ${tag} bash`;
  }

  private async startSession(
    group: GroupRecord,
    failure: ProofFile,
  ): Promise<void> {
    assert.ok(
      group.source !== null && group.commit !== null,
      "A session holds its source and its commit.",
    );
    const key = keyOf(group.project_id, group.resource_identity);
    const controller = new AbortController();
    group.session = controller;
    this.notify();
    try {
      await this.dependencies.environmentAgent.run({
        project_id: group.project_id,
        binding_id: group.binding_id,
        binding_name: group.binding_name,
        resource_identity: group.resource_identity,
        commit: group.commit,
        target: group.target,
        source: group.source,
        document: group.document,
        failure,
        context: {
          signal: AbortSignal.any([controller.signal, this.context.signal]),
          deadline: null,
        },
        tools: (handle) => environmentAgentTools(this.sessionPort(key, handle)),
      });
    } catch (error) {
      this.dependencies.logger.error(
        {
          err: error,
          binding: group.binding_name,
          digest: group.digest,
        },
        SESSION_FAILED,
      );
    } finally {
      const current = this.records.get(key);
      if (current?.session === controller) current.session = null;
      this.notify();
    }
  }

  private sessionPort(
    key: string,
    handle: EnvironmentSessionHandle,
  ): EnvironmentAgentPort {
    let toolCalls = NO_TOOL_CALLS;
    let attempts = NO_ATTEMPTS;
    const overLimit = (): boolean => {
      toolCalls++;
      if (toolCalls <= ENV_AGENT_TOOL_CALL_LIMIT) return false;
      handle.end();
      return true;
    };
    return {
      probe: async (command, signal) =>
        overLimit()
          ? TOOL_LIMIT_ANSWER
          : this.probeOf(key, handle, command, signal),
      write: async (environment, signal) => {
        if (overLimit()) return TOOL_LIMIT_ANSWER;
        attempts++;
        return this.attemptOf(key, handle, attempts, environment, signal);
      },
    };
  }

  private liveRecord(key: string): GroupRecord {
    const record = this.records.get(key);
    if (record === undefined) throw new Error("The environment group is gone.");
    return record;
  }

  private probeOf(
    key: string,
    handle: EnvironmentSessionHandle,
    command: ProbeCommand,
    signal: AbortSignal,
  ) {
    const record = this.liveRecord(key);
    if (record.digest === null)
      throw new Error("The environment group holds no digest.");
    const tag = environmentTagOf(record.resource_identity, record.digest);
    return this.dependencies.probe.run({
      tags: [tag, `${tag}${BASE_SUFFIX}`],
      checkout: handle.checkout,
      command,
      signal,
    });
  }

  private async attemptOf(
    key: string,
    handle: EnvironmentSessionHandle,
    attempt: number,
    environment: unknown,
    signal: AbortSignal,
  ): Promise<AttemptAnswer> {
    const attemptsLeft = Math.max(
      ENV_AGENT_ATTEMPT_LIMIT - attempt,
      NO_ATTEMPTS,
    );
    if (attempt > ENV_AGENT_ATTEMPT_LIMIT) {
      handle.end();
      return {
        outcome: null,
        reason: AttemptRefusal.AttemptLimit,
        detail: null,
        attempts_left: attemptsLeft,
      };
    }
    const lastAttempt = attempt === ENV_AGENT_ATTEMPT_LIMIT;
    const record = this.liveRecord(key);
    const written = await this.dependencies.writeEnvironment(
      record.project_id,
      record.binding_id,
      environment,
      { signal, deadline: null },
    );
    if (!written.written) {
      if (lastAttempt) handle.end();
      return {
        outcome: null,
        reason: AttemptRefusal.WriteRefused,
        detail: written.reason,
        attempts_left: attemptsLeft,
      };
    }
    this.liveRecord(key).environment_from_agent = true;
    await this.compute(record.project_id, record.resource_identity);
    await this.settled(key, signal);
    const proof = this.currentProof(this.liveRecord(key));
    if (lastAttempt || proof.outcome === ProofOutcome.Passed) handle.end();
    return { ...proof, attempts_left: attemptsLeft };
  }

  private currentProof(record: GroupRecord) {
    const file =
      record.digest === null
        ? null
        : this.dependencies.proofs.read(
            environmentPath(record.resource_identity),
            record.digest,
          );
    if (file === null)
      return {
        outcome: ProofOutcome.Failed,
        class: null,
        tail: record.reason ?? "",
        checks: [],
      };
    return {
      outcome: file.outcome,
      class: file.class,
      tail: file.tail,
      checks: file.checks,
    };
  }

  private settled(key: string, signal: AbortSignal): Promise<void> {
    const waiting = AbortSignal.any([signal, this.context.signal]);
    return new Promise((resolve, reject) => {
      if (waiting.aborted) return reject(waiting.reason);
      const check = () => {
        if (!this.runSettled(key)) return;
        release();
        resolve();
      };
      const abort = () => {
        release();
        reject(waiting.reason);
      };
      const release = () => {
        this.listeners.delete(check);
        waiting.removeEventListener("abort", abort);
      };
      this.listeners.add(check);
      waiting.addEventListener("abort", abort, { once: true });
      check();
    });
  }

  private runSettled(key: string): boolean {
    const record = this.records.get(key);
    return (
      record === undefined ||
      (record.step === null &&
        record.run_started_at === null &&
        !this.computing.has(key) &&
        !this.marked.has(key))
    );
  }

  environmentFailed(input: EnvironmentFailedInput): void {
    const { proofs } = this.dependencies;
    for (const identity of input.resource_identities) {
      const record = this.records.get(keyOf(input.project_id, identity));
      if (
        record === undefined ||
        record.digest === null ||
        record.commit === null
      )
        continue;
      if (input.digests[identity] !== record.digest) continue;
      const file: ProofFile = {
        digest: record.digest,
        outcome: ProofOutcome.Failed,
        class: input.stop.code,
        origin: FailureOrigin.Execution,
        execution_id: input.execution_id,
        ...detailFacts(input.stop.detail),
        tail: input.stop.detail,
        reproduce: this.reproduceOf(record.tag),
        checks: record.proof?.checks ?? [],
        repairs: record.proof?.repairs ?? 0,
        ended_at: this.dependencies.now(),
        commit: record.commit,
      };
      proofs.write(environmentPath(identity), file);
      record.proof = file;
      this.considerSession(record);
      this.retryWhileWaiting(keyOf(input.project_id, identity), record);
    }
    this.notify();
  }

  async rebuild(
    projectId: string,
    bindingId: string,
  ): Promise<EnvironmentState> {
    const group = this.dependencies
      .bindingsOf(projectId)
      .repositories.find((candidate) => candidate.binding_id === bindingId);
    if (group === undefined)
      throw new OperationError(
        HttpStatus.NotFound,
        ProjectErrorCode.BindingNotFound,
        "Binding not found.",
      );
    const key = keyOf(projectId, group.resource_identity);
    if (!this.records.has(key))
      await this.compute(projectId, group.resource_identity);
    const record = this.records.get(key);
    if (record !== undefined) {
      this.refuseActiveRun(record);
      await this.discard(record);
    }
    await this.compute(projectId, group.resource_identity);
    const rebuilt = this.records.get(key);
    assert.ok(rebuilt !== undefined, "A rebuilt group holds a record.");
    return stateOf(rebuilt);
  }

  private refuseActiveRun(record: GroupRecord): void {
    if (record.run_started_at === null) return;
    throw new OperationError(
      HttpStatus.Conflict,
      ProjectErrorCode.EnvironmentRunActive,
      "A run of the environment is active.",
    );
  }

  private async discard(record: GroupRecord): Promise<void> {
    const { runtime, proofs } = this.dependencies;
    if (record.digest !== null)
      proofs.remove(environmentPath(record.resource_identity), record.digest);
    record.proof = null;
    record.proved = false;
    const { tag } = record;
    if (tag === null) return;
    await runtime.removeTags([
      tag,
      `${tag}${BASE_SUFFIX}`,
      `${tag}${PROVED_SUFFIX}`,
    ]);
    const image = record.document?.image;
    if (image !== undefined)
      await runtime.pullImage(image, this.context.signal);
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}
