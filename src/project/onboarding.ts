import assert from "node:assert/strict";
import type { Logger } from "pino";
import { CancellationContext, type Context } from "../kernel/context.ts";
import { EnvironmentSource } from "../kernel/devcontainer.ts";
import { WorkerPlacement } from "./contract.ts";
import type { GroupResolution } from "./environment.ts";
import {
  EnvironmentStatus,
  EnvironmentTarget,
  PROVED_SUFFIX,
  ProofOutcome,
  environmentDigest,
  environmentPath,
  environmentTagOf,
  type EnvironmentRuntime,
  type EnvironmentState,
  type ProofFile,
  type ProofFiles,
} from "./environment-state.ts";

const KEY_SEPARATOR = "\u0000";
const SINGLE_REPOSITORY = 1;
const NO_WORKER_BINDING = 0;

export interface RepositoryGroup {
  binding_id: string;
  binding_name: string;
  resource_identity: string;
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
  runtime: EnvironmentRuntime;
  proofs: ProofFiles;
  slotImage: string;
  version: string;
  wake(projectId: string): void;
  environmentReady(
    projectId: string,
    resourceIdentity: string,
    tag: string,
  ): void;
  logger: Logger;
  now(): number;
  runId(): string;
}

type QueuedStep =
  typeof EnvironmentStatus.Building | typeof EnvironmentStatus.Proving;

export interface GroupRecord {
  project_id: string;
  binding_id: string;
  binding_name: string;
  resource_identity: string;
  target: EnvironmentTarget;
  source: EnvironmentSource | null;
  digest: string | null;
  tag: string | null;
  proof: ProofFile | null;
  proved: boolean;
  read_succeeded: boolean;
  step: QueuedStep | null;
  run_started_at: number | null;
  step_started_at: number | null;
  reason: string | null;
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
    digest: null,
    tag: null,
    proof: null,
    proved: false,
    read_succeeded: false,
    step: null,
    run_started_at: null,
    step_started_at: null,
    reason: null,
  };
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
    repairing: false,
  };
}

export class Onboarding {
  private readonly dependencies: OnboardingDependencies;
  private readonly context = new CancellationContext();
  private readonly records = new Map<string, GroupRecord>();
  private readonly computing = new Map<string, Promise<void>>();
  private readonly again = new Set<string>();
  private readonly listeners = new Set<() => void>();

  constructor(dependencies: OnboardingDependencies) {
    this.dependencies = dependencies;
  }

  close(): void {
    this.context.cancel();
  }

  compute(projectId: string, resourceIdentity: string): Promise<void> {
    const key = keyOf(projectId, resourceIdentity);
    const running = this.computing.get(key);
    if (running !== undefined) {
      this.again.add(key);
      return running;
    }
    const run = this.computeWhileMarked(projectId, resourceIdentity).finally(
      () => this.computing.delete(key),
    );
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

  slotImage(
    projectId: string,
    workerResourceIdentity: string,
    signal: AbortSignal,
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      const settle = () => {
        const answer = this.slotAnswerOf(projectId, workerResourceIdentity);
        if (answer === null) return;
        release();
        resolve(answer);
      };
      const abort = () => {
        release();
        reject(signal.reason);
      };
      const release = () => {
        this.listeners.delete(settle);
        signal.removeEventListener("abort", abort);
      };
      this.listeners.add(settle);
      signal.addEventListener("abort", abort, { once: true });
      const group = this.slotGroupOf(projectId, workerResourceIdentity);
      if (
        group !== null &&
        !this.records.has(keyOf(projectId, group.resource_identity))
      )
        this.trigger(projectId, group.resource_identity);
      settle();
    });
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
  }

  private async computeWhileMarked(
    projectId: string,
    resourceIdentity: string,
  ): Promise<void> {
    const key = keyOf(projectId, resourceIdentity);
    do {
      this.again.delete(key);
      await this.computeOnce(projectId, resourceIdentity);
    } while (this.again.has(key));
  }

  private async computeOnce(
    projectId: string,
    resourceIdentity: string,
  ): Promise<void> {
    const key = keyOf(projectId, resourceIdentity);
    const facts = this.dependencies.bindingsOf(projectId);
    const group = facts.repositories.find(
      (candidate) => candidate.resource_identity === resourceIdentity,
    );
    if (group === undefined) {
      this.records.delete(key);
      this.notify();
      return;
    }
    const target = targetOf(group, facts);
    const previous = this.records.get(key);
    const wasClaimable =
      previous !== undefined && claimable(statusOf(previous));
    let next: GroupRecord;
    try {
      next = await this.read(projectId, group, target, previous);
    } catch (error) {
      next = {
        ...(previous ?? emptyRecord(projectId, group, target)),
        reason: messageOf(error),
      };
    }
    this.records.set(key, next);
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
    const atImage = target === EnvironmentTarget.Image;
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
      version,
    });
    const tag = atImage ? environmentTagOf(group.resource_identity, sum) : null;
    const next: GroupRecord = {
      ...(previous ?? emptyRecord(projectId, group, target)),
      binding_id: group.binding_id,
      binding_name: group.binding_name,
      target,
      source: resolved.source,
      digest: sum,
      tag,
      proof: proofs.read(environmentPath(group.resource_identity), sum),
      proved:
        tag !== null && (await runtime.imageExists(`${tag}${PROVED_SUFFIX}`)),
      read_succeeded: true,
      reason: null,
    };
    if (next.run_started_at === null) {
      next.step = null;
      next.step_started_at = null;
    }
    if (next.step === null && decidedStatusOf(next) === null)
      await this.enqueue(next);
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

  private async enqueue(record: GroupRecord): Promise<void> {
    if (record.target !== EnvironmentTarget.Image) {
      record.step = EnvironmentStatus.Proving;
      return;
    }
    assert.ok(record.tag !== null, "An image group holds a tag.");
    record.step = (await this.dependencies.runtime.imageExists(record.tag))
      ? EnvironmentStatus.Proving
      : EnvironmentStatus.Building;
  }

  private notify(): void {
    for (const listener of Array.from(this.listeners)) listener();
  }
}
