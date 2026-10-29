import assert from "node:assert/strict";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { createIdentity } from "../kernel/identity.ts";
import {
  decodeX25519Key,
  generateX25519KeyPair,
  keyFingerprint,
  type SealedObject,
  sealJSON,
} from "../kernel/hpke.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { packageVersion } from "../kernel/version.ts";
import type { LoginSessionEntry } from "../llm/contract.ts";
import type {
  ExecutionEnds,
  MissionCollaborations,
} from "../mission/contract.ts";
import { getWorkerDeclaration } from "./catalog.ts";
import {
  BindingEntryState,
  CONNECTION_ID_PREFIX,
  type ConnectionBinding,
  INSTANCE_CONNECTED_WINDOW_MS,
  INSTANCE_CONNECTION_INFO,
  instanceConfigurationValue,
  type InstanceConnection,
  type InstanceIssuer,
  instanceNameSchema,
  InstancePlacement,
  type InstanceRecord,
  type LiveInstance,
  PlacementIssue,
  type PlacementStatus,
  type PoolEntry,
  WORKER_TOKEN_INFO,
  type WorkerBindingsOf,
  WorkerErrorCode,
  WorkerHost,
  type WorkerInstanceLookups,
} from "./contract.ts";
import {
  countLiveServerInstances,
  endInstance,
  fingerprintTaken,
  insertInstance,
  listInstances,
  readInstanceById,
  readLatestInstance,
  readLiveInstance,
  readLiveInstanceById,
  readLiveServerInstances,
  revisionIdsOf,
} from "./instance-rows.ts";
import {
  endOfInstances,
  readLiveOfInstances,
  readRow,
  registrationIdsOfInstance,
} from "./registration-rows.ts";

const BASE64URL = "base64url";
const UTF8 = "utf8";
const ZERO_BYTE = 0;
const NO_VERSION = 0;
const FIRST_ITEM = 0;
const QUERY_TRUE = "true";
const CURSOR_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface InstanceKeyInput {
  public_key?: string;
  endpoint?: string;
}

export interface InstanceDependencies {
  store: Store;
  serverInstanceLimit: number;
  placementStatus: (placement: InstancePlacement) => Promise<PlacementStatus>;
  issuer: InstanceIssuer;
  workerBindingsOf: WorkerBindingsOf;
  unendedExecutionOf: (
    tx: Transaction,
    runtimeIdentity: string,
  ) => { execution_id: string } | null;
  archiveHeld: (tx: Transaction, holder: string, now: number) => void;
  revokeForInstanceArchive: MissionCollaborations["revokeForInstanceArchive"];
  reportExecutionEnds: MissionCollaborations["reportExecutionEnds"];
  holderMismatch: (
    tx: Transaction,
    instanceName: string,
    bindings: readonly ListedBinding[],
  ) => boolean;
  loginSessionsOf: (holder: string) => LoginSessionEntry[];
  credentialVersionOf: (holder: string) => number;
}

interface CurrentConnection {
  connection_id: string;
  connection_name: string | null;
  connected_at: number;
  last_heartbeat_at: number;
}

interface PreparedKey {
  public_key: Buffer;
  private_key: Buffer | null;
  endpoint: string | null;
}

export type ListedBinding = ReturnType<WorkerBindingsOf>[number];

function keyInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    WorkerErrorCode.InstanceKeyInvalid,
    "Send a base64url 32-byte X25519 public_key or an endpoint, never both.",
  );
}

function keyForbidden(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    WorkerErrorCode.InstanceKeyForbidden,
    "A server instance takes neither public_key nor endpoint.",
  );
}

function notFound(): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    WorkerErrorCode.InstanceNotFound,
    "Worker instance not found.",
  );
}

function superseded(current: CurrentConnection | undefined): OperationError {
  return new OperationError(
    HttpStatus.Conflict,
    WorkerErrorCode.InstanceConnectionSuperseded,
    "Another connection of the worker instance is current.",
    { connection_name: current?.connection_name ?? null },
  );
}

function refusePlacement(placement: string | undefined): InstancePlacement {
  const parsed = z.enum(InstancePlacement).safeParse(placement);
  if (!parsed.success)
    throw new OperationError(
      HttpStatus.BadRequest,
      WorkerErrorCode.InstancePlacementInvalid,
      "placement is absent or is not server, container or worker.",
    );
  return parsed.data;
}

const UNAVAILABLE_CONTAINER_REASONS: readonly PlacementIssue[] = [
  PlacementIssue.ServerInContainer,
  PlacementIssue.RuntimeAbsent,
  PlacementIssue.RuntimeRootful,
];

function refuseName(name: string): void {
  if (!instanceNameSchema.safeParse(name).success)
    throw new OperationError(
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceNameInvalid,
      "The instance name breaks the binding name form or is reserved.",
    );
}

function refuseWorker(worker: string): void {
  if (getWorkerDeclaration(worker)?.host !== WorkerHost.Kanthord)
    throw new OperationError(
      HttpStatus.BadRequest,
      WorkerErrorCode.InstanceWorkerInvalid,
      "The worker is unknown or is a worker of an external harness.",
    );
}

function refuseKeyInput(input: InstanceKeyInput): void {
  if (input.public_key !== undefined || input.endpoint !== undefined)
    throw keyForbidden();
}

async function prepareKey(input: InstanceKeyInput): Promise<PreparedKey> {
  if ((input.public_key === undefined) === (input.endpoint === undefined))
    throw keyInvalid();
  if (input.public_key !== undefined) {
    const key = decodeX25519Key(input.public_key);
    if (!key) throw keyInvalid();
    return { public_key: key, private_key: null, endpoint: null };
  }
  const pair = await generateX25519KeyPair();
  return {
    public_key: pair.public_key,
    private_key: pair.private_key,
    endpoint: input.endpoint!,
  };
}

function decodeCursor(cursor: string): string {
  const decoded = Buffer.from(cursor, BASE64URL).toString(UTF8);
  if (
    !CURSOR_PATTERN.test(cursor) ||
    Buffer.from(decoded, UTF8).toString(BASE64URL) !== cursor
  )
    throw new OperationError(
      HttpStatus.BadRequest,
      "system.pagination.cursor_invalid",
      "Invalid cursor.",
    );
  return decoded;
}

export class WorkerInstances implements WorkerInstanceLookups {
  private readonly dependencies: InstanceDependencies;
  private readonly connections = new Map<string, CurrentConnection>();
  private readonly bindingVersions = new Map<string, number>();
  private readonly listedByProject = new Map<string, Set<string>>();

  constructor(dependencies: InstanceDependencies) {
    this.dependencies = dependencies;
  }

  start(tx: Transaction): void {
    this.listedByProject.clear();
    for (const binding of this.dependencies.workerBindingsOf(tx, null))
      for (const name of this.namesOf(binding))
        this.listed(binding.project_id).add(name);
  }

  private namesOf(binding: ListedBinding): string[] {
    return binding.tombstone ? [] : (binding.worker_instances ?? []);
  }

  private listed(projectId: string): Set<string> {
    let names = this.listedByProject.get(projectId);
    if (!names) {
      names = new Set();
      this.listedByProject.set(projectId, names);
    }
    return names;
  }

  bindingsChanged(tx: Transaction, projectId: string): void {
    const previous = this.listed(projectId);
    const current = new Set(
      this.dependencies
        .workerBindingsOf(tx, projectId)
        .flatMap((binding) => this.namesOf(binding)),
    );
    for (const name of new Set([...previous, ...current]))
      this.bindingVersions.set(name, this.bindingVersionOf(name) + 1);
    this.listedByProject.set(projectId, current);
  }

  bindingVersionOf(name: string): number {
    return this.bindingVersions.get(name) ?? NO_VERSION;
  }

  liveInstance(instanceId: string): LiveInstance | null {
    const instance = readLiveInstanceById(this.dependencies.store, instanceId);
    return instance
      ? {
          id: instance.id,
          name: instance.name,
          worker: instance.worker,
          placement: instance.placement,
        }
      : null;
  }

  holdConnection(
    instanceId: string,
    connectionId: string,
    connectionName: string | null = null,
  ): boolean {
    const current = this.connections.get(instanceId);
    if (current) {
      if (current.connection_id !== connectionId) return false;
      current.connection_name ??= connectionName;
      return true;
    }
    const now = Date.now();
    this.connections.set(instanceId, {
      connection_id: connectionId,
      connection_name: connectionName,
      connected_at: now,
      last_heartbeat_at: now,
    });
    return true;
  }

  connectionOf(instanceId: string): InstanceConnection {
    const current = this.connections.get(instanceId);
    if (!current) return null;
    if (Date.now() - current.last_heartbeat_at > INSTANCE_CONNECTED_WINDOW_MS)
      return null;
    return {
      connection_name: current.connection_name ?? "",
      connected_at: current.connected_at,
      last_heartbeat_at: current.last_heartbeat_at,
    };
  }

  connected(name: string): boolean {
    const instance = this.dependencies.store.transaction((tx) =>
      readLiveInstance(tx, name),
    );
    const current = instance ? this.connections.get(instance.id) : undefined;
    return (
      current !== undefined &&
      Date.now() - current.last_heartbeat_at <= INSTANCE_CONNECTED_WINDOW_MS
    );
  }

  dropConnection(instanceId: string): void {
    this.connections.delete(instanceId);
  }

  bindingsListing(tx: Transaction, name: string): ListedBinding[] {
    return this.dependencies
      .workerBindingsOf(tx, null)
      .filter((binding) => this.namesOf(binding).includes(name));
  }

  registrationsOfInstance(tx: Transaction, runtimeIdentity: string): string[] {
    const row = readRow(tx, runtimeIdentity);
    if (!row?.instance_id) return [];
    return readLiveOfInstances(tx, [row.instance_id])
      .map((registration) => registration.runtime_identity)
      .filter((identity) => identity !== runtimeIdentity);
  }

  async create(
    commit: <T>(write: (tx: Transaction) => T) => T,
    input: InstanceKeyInput & {
      name: string;
      worker: string;
      placement?: string;
    },
  ): Promise<InstanceRecord & { instance_configuration?: string }> {
    refuseName(input.name);
    refuseWorker(input.worker);
    const placement = refusePlacement(input.placement);
    const key = await this.prepareKeyAt(placement, input);
    await this.refuseUnavailableRuntime(placement);
    try {
      return commit((tx) => {
        if (readLatestInstance(tx, input.name))
          throw new OperationError(
            HttpStatus.Conflict,
            WorkerErrorCode.InstanceNameConflict,
            "The instance name is taken by a live or an archived instance.",
          );
        if (placement !== InstancePlacement.Worker) this.refuseServerLimit(tx);
        const record = this.insertKey(
          tx,
          { name: input.name, worker: input.worker, placement },
          key,
          null,
        );
        return this.answer(record, key);
      });
    } finally {
      key?.private_key?.fill(ZERO_BYTE);
    }
  }

  private async prepareKeyAt(
    placement: InstancePlacement,
    input: InstanceKeyInput,
  ): Promise<PreparedKey | null> {
    if (placement === InstancePlacement.Worker) return prepareKey(input);
    refuseKeyInput(input);
    return null;
  }

  private async refuseUnavailableRuntime(
    placement: InstancePlacement,
  ): Promise<void> {
    if (placement !== InstancePlacement.Container) return;
    const status = await this.dependencies.placementStatus(placement);
    if (
      status.reason === null ||
      !UNAVAILABLE_CONTAINER_REASONS.includes(status.reason)
    )
      return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.InstancePlacementUnavailable,
      "The container runtime is unavailable.",
      { placement, reason: status.reason },
    );
  }

  private refuseServerLimit(tx: Transaction): void {
    const limit = this.dependencies.serverInstanceLimit;
    if (countLiveServerInstances(tx) < limit) return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceServerLimit,
      "The live server instances reach worker.server_instance_limit.",
      { limit },
    );
  }

  private refuseServerReset(name: string): void {
    const latest = this.dependencies.store.transaction((tx) =>
      readLatestInstance(tx, name),
    );
    if (!latest || latest.placement === InstancePlacement.Worker) return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.InstancePlacementUnsupported,
      "Reset key applies only at the worker placement.",
      { placement: latest.placement },
    );
  }

  async rotate(
    commit: <T>(write: (tx: Transaction) => T) => T,
    name: string,
    input: InstanceKeyInput & { expected_revision: number },
    ended: (previous: string, registrations: string[]) => void,
  ): Promise<InstanceRecord & { instance_configuration?: string }> {
    this.refuseServerReset(name);
    const key = await prepareKey(input);
    try {
      return commit((tx) => {
        const live = this.requireLive(tx, name, input.expected_revision);
        const now = Date.now();
        endInstance(tx, live.id, now);
        const registrations = endOfInstances(tx, [live.id], now);
        const record = this.insertKey(
          tx,
          { name: live.name, worker: live.worker, placement: live.placement },
          key,
          live,
        );
        ended(live.id, registrations);
        return this.answer(record, key);
      });
    } finally {
      key.private_key?.fill(ZERO_BYTE);
    }
  }

  archive(
    tx: Transaction,
    name: string,
    input: { expected_revision: number; force?: boolean },
  ): {
    record: InstanceRecord;
    ended: string[];
    executionEnds: ExecutionEnds[];
  } {
    const live = this.requireLive(tx, name, input.expected_revision);
    this.refuseListed(tx, name);
    const revisions = revisionIdsOf(tx, name);
    const executions = this.liveExecutionsOf(tx, revisions);
    if (executions.length && !input.force)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.InstanceInUse,
        "A registration of the worker instance holds a live execution.",
        { executions },
      );
    const executionEnds = executions.flatMap((executionId) => {
      const ends = this.dependencies.revokeForInstanceArchive(tx, executionId);
      return ends ? [ends] : [];
    });
    const now = Date.now();
    endInstance(tx, live.id, now);
    const ended = endOfInstances(tx, revisions, now);
    this.dependencies.archiveHeld(tx, name, now);
    const record = readInstanceById(tx, live.id);
    assert.ok(record);
    return { record, ended, executionEnds };
  }

  reportExecutionEnds(ends: readonly ExecutionEnds[]): void {
    if (!ends.length) return;
    this.dependencies.reportExecutionEnds({
      lost: ends.flatMap((end) => end.lost),
      revoked: ends.flatMap((end) => end.revoked),
    });
  }

  private refuseListed(tx: Transaction, name: string): void {
    const bindings = this.bindingsListing(tx, name);
    if (!bindings.length) return;
    throw new OperationError(
      HttpStatus.Conflict,
      WorkerErrorCode.InstanceInUse,
      "A binding lists the worker instance.",
      {
        bindings: bindings.map((binding) => ({
          project_id: binding.project_id,
          binding: binding.name,
        })),
      },
    );
  }

  private liveExecutionsOf(
    tx: Transaction,
    revisions: readonly string[],
  ): string[] {
    return revisions.flatMap((instanceId) =>
      registrationIdsOfInstance(tx, instanceId).flatMap((id) => {
        const execution = this.dependencies.unendedExecutionOf(tx, id);
        return execution ? [execution.execution_id] : [];
      }),
    );
  }

  list(
    tx: Transaction,
    query: {
      worker?: string;
      include_archived?: "true" | "false";
      limit: number;
      cursor?: string;
    },
  ) {
    const rows = listInstances(tx, {
      worker: query.worker,
      include_archived: query.include_archived === QUERY_TRUE,
      after:
        query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.slice(FIRST_ITEM, query.limit).map((record) => {
      const bindings = this.bindingsListing(tx, record.name);
      return {
        ...record,
        connection: this.connectionOf(record.id),
        binding_count: bindings.length,
        holder_mismatch:
          record.placement === InstancePlacement.Worker &&
          this.dependencies.holderMismatch(tx, record.name, bindings),
      };
    });
    return {
      items,
      next_cursor:
        rows.length > query.limit
          ? Buffer.from(items.at(-1)!.name, UTF8).toString(BASE64URL)
          : null,
    };
  }

  requireLatest(tx: Transaction, name: string): InstanceRecord {
    const latest = readLatestInstance(tx, name);
    if (!latest) throw notFound();
    return latest;
  }

  liveRegistrationsOf(tx: Transaction, name: string) {
    return readLiveOfInstances(tx, revisionIdsOf(tx, name));
  }

  async token(
    instanceId: string,
  ): Promise<{ server_version: string; sealed: SealedObject }> {
    const instance = this.dependencies.store.transaction((tx) =>
      readInstanceById(tx, instanceId),
    );
    if (!instance || instance.ended_at !== null || instance.public_key === null)
      throw notFound();
    const issued = await this.dependencies.issuer.workerToken({
      instanceId: instance.id,
      name: instance.name,
    });
    return {
      server_version: packageVersion(),
      sealed: await sealJSON(
        Buffer.from(instance.public_key, BASE64URL),
        WORKER_TOKEN_INFO,
        instance.id,
        {
          token: issued.token,
          expired_at: issued.expiresAt,
          name: instance.name,
          worker: instance.worker,
          fingerprint: instance.fingerprint,
        },
      ),
    };
  }

  async connect(
    instanceId: string,
    input: { connection_id?: string; connection_name: string },
  ): Promise<{
    connection_id: string;
    binding_version: number;
    sealed: SealedObject;
  }> {
    const plan = this.dependencies.store.transaction((tx) => {
      const instance = readInstanceById(tx, instanceId);
      if (
        !instance ||
        instance.ended_at !== null ||
        instance.public_key === null
      )
        throw notFound();
      return {
        instance,
        publicKey: instance.public_key,
        entries: this.entriesOf(tx, instance),
      };
    });
    const connectionId = this.takeConnection(
      instanceId,
      input.connection_id,
      input.connection_name,
    );
    const bindings: ConnectionBinding[] = [];
    for (const entry of plan.entries) {
      const issued = await this.dependencies.issuer.clientToken({
        clientId: entry.client_id,
        projectId: entry.project_id,
        resourceIdentity: entry.resource_identity,
        instanceId,
        connectionId,
        name: plan.instance.name,
      });
      bindings.push({
        ...entry,
        token: issued.token,
        expired_at: issued.expiresAt,
        client_secret: this.dependencies.issuer.clientSecret(entry.client_id),
      });
    }
    return {
      connection_id: connectionId,
      binding_version: this.bindingVersionOf(plan.instance.name),
      sealed: await sealJSON(
        Buffer.from(plan.publicKey, BASE64URL),
        INSTANCE_CONNECTION_INFO,
        `${instanceId}${connectionId}`,
        { bindings },
      ),
    };
  }

  heartbeat(
    instanceId: string,
    name: string,
    connectionId: string,
    connectionName: string,
  ): {
    server_version: string;
    binding_version: number;
    credential_version: number;
    login_sessions: LoginSessionEntry[];
  } {
    if (!this.holdConnection(instanceId, connectionId, connectionName))
      throw superseded(this.connections.get(instanceId));
    this.connections.get(instanceId)!.last_heartbeat_at = Date.now();
    return {
      server_version: packageVersion(),
      binding_version: this.bindingVersionOf(name),
      credential_version: this.dependencies.credentialVersionOf(name),
      login_sessions: this.dependencies.loginSessionsOf(name),
    };
  }

  private takeConnection(
    instanceId: string,
    connectionId: string | undefined,
    connectionName: string,
  ): string {
    const now = Date.now();
    if (connectionId === undefined) {
      const created = createIdentity(CONNECTION_ID_PREFIX);
      this.connections.set(instanceId, {
        connection_id: created,
        connection_name: connectionName,
        connected_at: now,
        last_heartbeat_at: now,
      });
      return created;
    }
    if (!this.holdConnection(instanceId, connectionId))
      throw superseded(this.connections.get(instanceId));
    const current = this.connections.get(instanceId)!;
    current.connection_name = connectionName;
    current.last_heartbeat_at = now;
    return connectionId;
  }

  liveServerInstances(tx: Transaction): InstanceRecord[] {
    return readLiveServerInstances(tx);
  }

  entriesOf(tx: Transaction, instance: InstanceRecord): PoolEntry[] {
    const entry = (binding: ListedBinding, state: BindingEntryState) => ({
      project_id: binding.project_id,
      resource_identity: binding.resource_identity,
      client_id: this.dependencies.issuer.clientIdentity(
        instance.id,
        binding.project_id,
        binding.resource_identity,
        binding.generation,
      ),
      state,
    });
    const serving = this.bindingsListing(tx, instance.name).map((binding) =>
      entry(binding, BindingEntryState.Serving),
    );
    const keys = new Set(
      serving.map((item) => `${item.project_id}/${item.resource_identity}`),
    );
    const draining = readLiveOfInstances(tx, [instance.id]).flatMap(
      (registration) => {
        const key = `${registration.project_id}/${registration.resource_identity}`;
        if (keys.has(key)) return [];
        keys.add(key);
        const binding = this.dependencies
          .workerBindingsOf(tx, registration.project_id)
          .find(
            (item) =>
              item.resource_identity === registration.resource_identity &&
              !item.tombstone,
          );
        return binding ? [entry(binding, BindingEntryState.Draining)] : [];
      },
    );
    return [...serving, ...draining];
  }

  private requireLive(
    tx: Transaction,
    name: string,
    expectedRevision: number,
  ): InstanceRecord {
    const latest = this.requireLatest(tx, name);
    if (latest.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.InstanceArchived,
        "The worker instance is archived.",
      );
    const live = readLiveInstance(tx, name);
    assert.ok(live);
    if (live.revision !== expectedRevision)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.InstanceRevisionConflict,
        "expected_revision is not the live revision.",
        { revision: live.revision },
      );
    return live;
  }

  private insertKey(
    tx: Transaction,
    instance: { name: string; worker: string; placement: InstancePlacement },
    key: PreparedKey | null,
    previous: InstanceRecord | null,
  ): InstanceRecord {
    const fingerprint = key ? keyFingerprint(key.public_key) : null;
    if (fingerprint !== null && fingerprintTaken(tx, fingerprint))
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.InstanceKeyConflict,
        "An instance revision holds this key.",
      );
    return insertInstance(
      tx,
      {
        ...instance,
        revision: previous ? previous.revision + 1 : undefined,
        public_key: key ? key.public_key.toString(BASE64URL) : null,
        fingerprint,
      },
      Date.now(),
    );
  }

  private answer(
    record: InstanceRecord,
    key: PreparedKey | null,
  ): InstanceRecord & { instance_configuration?: string } {
    if (!key?.private_key || key.endpoint === null) return record;
    return {
      ...record,
      instance_configuration: instanceConfigurationValue({
        name: record.name,
        endpoint: key.endpoint,
        instance_id: record.id,
        private_key: key.private_key.toString(BASE64URL),
      }),
    };
  }
}
