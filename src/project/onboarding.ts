import assert from "node:assert/strict";
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
import { ProjectErrorCode, WorkerPlacement } from "./contract.ts";
import type { GroupResolution } from "./environment.ts";
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
  type EnvironmentRuntime,
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
const RUN_DEADLINE_MS = 1800000;
const RUN_DEADLINE_TAIL = "the run deadline of 30 minutes passed";
const RUN_STARTED = "project.onboarding.run_started";
const RUN_ENDED = "project.onboarding.run_ended";
const RUN_FAILED = "project.onboarding.run_failed";
const NO_COMMAND = null;
const NO_EXIT_CODE = null;

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
  ): Promise<void>;
  logger: Logger;
  now(): number;
  runId(): string;
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
    commit: null,
    document: null,
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
  private readonly marked = new Set<string>();
  private readonly queue: string[] = [];
  private draining: Promise<void> | null = null;
  private readonly listeners = new Set<() => void>();

  constructor(dependencies: OnboardingDependencies) {
    this.dependencies = dependencies;
  }

  async stop(): Promise<void> {
    this.context.cancel();
    await this.draining;
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
    if (previous !== undefined && previous.run_started_at !== null) {
      this.marked.add(key);
      return;
    }
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
    const current = this.records.get(key);
    if (current !== undefined && current.run_started_at !== null) {
      this.marked.add(key);
      return;
    }
    this.records.set(key, next);
    this.schedule(key, next);
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
      commit: resolved.commit,
      document: resolved.document,
      digest: sum,
      tag,
      proof: proofs.read(environmentPath(group.resource_identity), sum),
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
    const now = this.dependencies.now();
    record.run_started_at = now;
    record.step_started_at = now;
    this.notify();
    this.logRun(RUN_STARTED, record);
    let completed = false;
    try {
      const verdict = await this.verdictOf(record, this.dependencies.runId());
      if (verdict !== null) {
        await this.finalize(record, verdict);
        completed = true;
      }
    } catch (error) {
      if (!this.context.signal.aborted) {
        record.reason = messageOf(error);
        this.dependencies.logger.error(
          { err: error, binding: record.binding_name, digest: record.digest },
          RUN_FAILED,
        );
      }
    } finally {
      record.run_started_at = null;
      record.step = null;
      record.step_started_at = null;
      this.notify();
      this.logRun(RUN_ENDED, record);
    }
    if (completed && claimable(statusOf(record)))
      this.dependencies.wake(record.project_id);
    if (this.marked.delete(key))
      this.trigger(record.project_id, record.resource_identity);
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
  ): Promise<ProofVerdict | null> {
    const signal = AbortSignal.any([
      this.context.signal,
      AbortSignal.timeout(RUN_DEADLINE_MS),
    ]);
    try {
      return await this.execute(record, runId, signal);
    } catch (error) {
      if (this.context.signal.aborted) return null;
      this.dependencies.logger.error(
        { err: error, binding: record.binding_name, digest: record.digest },
        RUN_FAILED,
      );
      return failedVerdict(
        record.step === EnvironmentStatus.Building
          ? EnvironmentFailureClass.BuildFailed
          : EnvironmentFailureClass.SetupFailed,
        signal.aborted ? RUN_DEADLINE_TAIL : messageOf(error),
      );
    }
  }

  private async execute(
    record: GroupRecord,
    runId: string,
    signal: AbortSignal,
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
    const proof = {
      ...base,
      setup: setupScriptsOf(document),
      checks: checksOf(document),
    };
    if (record.target !== EnvironmentTarget.Image) {
      const results = await runtime.proveOnHost(proof, signal);
      return this.context.signal.aborted ? null : classifyProof(results);
    }
    assert.ok(tag !== null, "An image group holds a tag.");
    if (record.step === EnvironmentStatus.Building) {
      const built = await runtime.build({ ...base, tag, document }, signal);
      if (this.context.signal.aborted) return null;
      if (built.outcome !== ImageBuildOutcome.Built)
        return failedVerdict(built.class, built.tail);
      record.step = EnvironmentStatus.Proving;
      record.step_started_at = this.dependencies.now();
      this.notify();
    }
    const results = await runtime.prove({ ...proof, tag }, signal);
    return this.context.signal.aborted ? null : classifyProof(results);
  }

  private async finalize(
    record: GroupRecord,
    verdict: ProofVerdict,
  ): Promise<void> {
    const { runtime, proofs } = this.dependencies;
    const { digest, tag } = record;
    assert.ok(digest !== null);
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
    };
    proofs.write(path, file);
    record.proof = file;
    const proved = verdict.outcome === ProofOutcome.Passed && tag !== null;
    if (proved) {
      await runtime.tagProved(tag);
      record.proved = true;
    }
    await runtime.collect(path, digest);
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

  environmentFailed(input: EnvironmentFailedInput): void {
    const { proofs } = this.dependencies;
    for (const identity of input.resource_identities) {
      const record = this.records.get(keyOf(input.project_id, identity));
      if (record === undefined || record.digest === null) continue;
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
      };
      proofs.write(environmentPath(identity), file);
      record.proof = file;
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
