import assert from "node:assert/strict";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  decodeX25519Key,
  generateX25519KeyPair,
  keyFingerprint,
} from "../kernel/hpke.ts";
import type { Transaction } from "../kernel/store.ts";
import type { HeldCopy } from "../custody/contract.ts";
import type { CopyHealth } from "../llm/contract.ts";
import {
  type InstanceConnection,
  instanceNameSchema,
  machineConfigurationValue,
  type MachineRecord,
  WorkerErrorCode,
} from "./contract.ts";
import {
  fingerprintTaken,
  nameTaken,
  readLiveInstancesOfMachine,
} from "./instance-rows.ts";
import { decodeCursor } from "./instances.ts";
import {
  endMachine,
  insertMachine,
  listLiveMachines,
  readLatestMachine,
  readLiveMachine,
  readMachineById,
} from "./machine-rows.ts";

const BASE64URL = "base64url";
const UTF8 = "utf8";
const ZERO_BYTE = 0;
const FIRST_ITEM = 0;

export interface MachineKeyInput {
  public_key?: string;
}

export interface MachineDependencies {
  archiveHeld: (tx: Transaction, holder: string, now: number) => void;
  heldCopies: (
    tx: Transaction,
    machine: string,
  ) => (HeldCopy & { health: CopyHealth })[];
  connectionOf: (instanceId: string) => InstanceConnection;
}

interface PreparedKey {
  public_key: Buffer;
  private_key: Buffer | null;
}

type MachineWriteAnswer = MachineRecord & { machine_configuration?: string };

function keyInvalid(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    WorkerErrorCode.MachineKeyInvalid,
    "public_key is not a base64url 32-byte X25519 public key.",
  );
}

function notFound(): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    WorkerErrorCode.MachineNotFound,
    "Worker machine not found.",
  );
}

function refuseName(name: string): void {
  if (!instanceNameSchema.safeParse(name).success)
    throw new OperationError(
      HttpStatus.BadRequest,
      WorkerErrorCode.MachineNameInvalid,
      "The machine name breaks the binding name form or is reserved.",
    );
}

async function prepareKey(input: MachineKeyInput): Promise<PreparedKey> {
  if (input.public_key === undefined) {
    const pair = await generateX25519KeyPair();
    return { public_key: pair.public_key, private_key: pair.private_key };
  }
  const key = decodeX25519Key(input.public_key);
  if (!key) throw keyInvalid();
  return { public_key: key, private_key: null };
}

export class WorkerMachines {
  private readonly dependencies: MachineDependencies;

  constructor(dependencies: MachineDependencies) {
    this.dependencies = dependencies;
  }

  async create(
    commit: <T>(write: (tx: Transaction) => T) => T,
    input: MachineKeyInput & { name: string },
  ): Promise<MachineWriteAnswer> {
    refuseName(input.name);
    const key = await prepareKey(input);
    try {
      return commit((tx) => {
        if (nameTaken(tx, input.name))
          throw new OperationError(
            HttpStatus.Conflict,
            WorkerErrorCode.MachineNameConflict,
            "The machine name is taken by a live or an archived machine or instance.",
          );
        return this.answer(this.insertKey(tx, input.name, key, null), key);
      });
    } finally {
      key.private_key?.fill(ZERO_BYTE);
    }
  }

  async rotate(
    commit: <T>(write: (tx: Transaction) => T) => T,
    name: string,
    input: MachineKeyInput & { expected_revision: number },
  ): Promise<MachineWriteAnswer> {
    const key = await prepareKey(input);
    try {
      return commit((tx) => {
        const live = this.requireLive(tx, name, input.expected_revision);
        endMachine(tx, live.id, Date.now());
        return this.answer(this.insertKey(tx, live.name, key, live), key);
      });
    } finally {
      key.private_key?.fill(ZERO_BYTE);
    }
  }

  archive(
    tx: Transaction,
    name: string,
    input: { expected_revision: number },
  ): MachineRecord {
    const live = this.requireLive(tx, name, input.expected_revision);
    const instances = readLiveInstancesOfMachine(tx, name);
    if (instances.length)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.MachineInUse,
        "A live instance names the worker machine.",
        { instances: instances.map((instance) => instance.name) },
      );
    const now = Date.now();
    endMachine(tx, live.id, now);
    this.dependencies.archiveHeld(tx, name, now);
    const record = readMachineById(tx, live.id);
    assert.ok(record);
    return record;
  }

  list(tx: Transaction, query: { limit: number; cursor?: string }) {
    const rows = listLiveMachines(tx, {
      after:
        query.cursor === undefined ? undefined : decodeCursor(query.cursor),
      limit: query.limit,
    });
    const items = rows.slice(FIRST_ITEM, query.limit).map((record) => ({
      ...record,
      instance_count: readLiveInstancesOfMachine(tx, record.name).length,
    }));
    return {
      items,
      next_cursor:
        rows.length > query.limit
          ? Buffer.from(items.at(-1)!.name, UTF8).toString(BASE64URL)
          : null,
    };
  }

  get(tx: Transaction, name: string) {
    const record = readLatestMachine(tx, name);
    if (!record) throw notFound();
    return {
      ...record,
      instances: readLiveInstancesOfMachine(tx, name).map((instance) => ({
        ...instance,
        connection: this.dependencies.connectionOf(instance.id),
      })),
      credentials: this.dependencies.heldCopies(tx, name),
    };
  }

  private requireLive(
    tx: Transaction,
    name: string,
    expectedRevision: number,
  ): MachineRecord {
    const latest = readLatestMachine(tx, name);
    if (!latest) throw notFound();
    if (latest.ended_at !== null)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.MachineArchived,
        "The worker machine is archived.",
      );
    const live = readLiveMachine(tx, name);
    assert.ok(live);
    if (live.revision !== expectedRevision)
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.MachineRevisionConflict,
        "expected_revision is not the live revision.",
        { revision: live.revision },
      );
    return live;
  }

  private insertKey(
    tx: Transaction,
    name: string,
    key: PreparedKey,
    previous: MachineRecord | null,
  ): MachineRecord {
    const fingerprint = keyFingerprint(key.public_key);
    if (fingerprintTaken(tx, fingerprint))
      throw new OperationError(
        HttpStatus.Conflict,
        WorkerErrorCode.MachineKeyConflict,
        "A machine or an instance revision holds this key.",
      );
    return insertMachine(
      tx,
      {
        name,
        revision: previous ? previous.revision + 1 : undefined,
        public_key: key.public_key.toString(BASE64URL),
        fingerprint,
      },
      Date.now(),
    );
  }

  private answer(record: MachineRecord, key: PreparedKey): MachineWriteAnswer {
    if (!key.private_key) return record;
    return {
      ...record,
      machine_configuration: machineConfigurationValue({
        name: record.name,
        private_key: key.private_key.toString(BASE64URL),
      }),
    };
  }
}
