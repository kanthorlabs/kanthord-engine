import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { TestContext } from "node:test";
import pino from "pino";
import { createInvocation, directClient } from "../gateway/index.ts";
import { OperationRegistry, StoreName } from "../kernel/operation.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import { stopAfter, temporary } from "../kernel/test-support.ts";
import { trackingMigrations, TrackingService } from "../tracking/index.ts";
import {
  TRACKING_SERVICE_NAME,
  trackingOperations,
} from "../tracking/contract.ts";
import {
  emptyMeasure,
  FOOTPRINT_SERVICE_NAME,
  type FootprintKind,
  type FootprintMeasure,
  footprintOperations,
  type FootprintOwner,
} from "./contract.ts";
import {
  DEFAULT_DISK_FREE_RATIO,
  DEFAULT_THRESHOLDS,
  type FootprintConfig,
} from "./config.ts";
import { footprintMigrations } from "./migrations.ts";
import { FootprintService } from "./service.ts";
import { ServerHost } from "./server-host.ts";
import type { CleanupDeleter, InvokeOperation } from "./cleanup-task.ts";

const MASTER_KEY_BYTES = 32;
const AUTH_VERSION = 1;
const WRITABLE_DAYS = 30;
export const NOW = Date.UTC(2026, 10, 3, 9);
export const HUMAN_ACTOR = {
  kind: "human" as const,
  account: "ulrich",
  name: "Ulrich",
};

export class FakeOwner implements FootprintOwner {
  readonly kinds: readonly FootprintKind[];
  measures: FootprintMeasure[];
  constructor(kinds: readonly FootprintKind[], measures: FootprintMeasure[]) {
    this.kinds = kinds;
    this.measures = measures;
  }
  measure(): Promise<readonly FootprintMeasure[]> {
    return Promise.resolve(this.measures);
  }
  candidates() {
    return Promise.resolve({ items: [], total_count: 0, total_bytes: 0 });
  }
}

export function measured(
  kind: FootprintKind,
  fields: Partial<FootprintMeasure>,
): FootprintMeasure {
  return emptyMeasure(kind, fields);
}

export function footprintFixture(
  t: TestContext,
  options: {
    now?: () => number;
    deleters?: Partial<Record<string, CleanupDeleter>>;
    instances?: Record<string, { archived: boolean }>;
    lines?: string[];
    config?: FootprintConfig;
  } = {},
) {
  const directory = temporary(t);
  const store = new Store(IN_MEMORY_DATABASE);
  const trackingStore = new Store(IN_MEMORY_DATABASE);
  stopAfter(t, () => {
    store.close();
    trackingStore.close();
  });
  store.migrate([
    { service: FOOTPRINT_SERVICE_NAME, migrations: footprintMigrations },
  ]);
  trackingStore.migrate([
    { service: TRACKING_SERVICE_NAME, migrations: trackingMigrations },
  ]);
  const lines = options.lines ?? [];
  const logger = pino({ level: "info" }, { write: (line) => lines.push(line) });
  const now = options.now ?? (() => NOW);
  const serverHost = new ServerHost({
    store,
    databasePath: join(directory, "kanthord.db"),
    trackingDatabasePath: join(directory, "tracking.db"),
    configPath: join(directory, "kanthord.yaml"),
    stateDirectory: directory,
    breakdownRows: {},
    now,
  });
  const registry = new OperationRegistry();
  const invocation = createInvocation({
    registry,
    stores: {
      [StoreName.Operational]: store,
      [StoreName.Tracking]: trackingStore,
    },
    masterKey: randomBytes(MASTER_KEY_BYTES).toString("base64"),
    authVersion: AUTH_VERSION,
  });
  stopAfter(t, async () => {
    await invocation.stop();
  });
  const invoke: InvokeOperation = (operation, input, clientOptions) =>
    directClient({ [operation.id]: operation }, invocation)[operation.id]!(
      input as never,
      clientOptions,
    );
  const tracking = new TrackingService({
    store: trackingStore,
    logger,
    writableDays: WRITABLE_DAYS,
    isHostedWorker: () => false,
    executions: { traceOf: () => undefined },
    sessionHosts: {
      read: () => Promise.reject(new Error("Unexpected session read")),
    },
  });
  const service = new FootprintService({
    store,
    config: options.config ?? {
      disk_free_ratio: DEFAULT_DISK_FREE_RATIO,
      thresholds: { ...DEFAULT_THRESHOLDS },
    },
    logger,
    serverHost,
    now,
    instances: {
      instanceStateOf: (_tx: Transaction, name: string) =>
        options.instances?.[name] ?? null,
    },
    deleters: () => options.deleters ?? {},
  });
  stopAfter(t, async () => {
    await service.stop();
  });
  tracking.declare(registry);
  service.declare(registry);
  registry.seal({
    [StoreName.Operational]: store,
    [StoreName.Tracking]: trackingStore,
  });
  return {
    directory,
    store,
    trackingStore,
    service,
    serverHost,
    invoke,
    lines,
    footprint: directClient(footprintOperations, invocation),
    tracking: directClient(trackingOperations, invocation),
  };
}

export function insertTrace(
  store: Store,
  traceId: string,
  createdAt: number,
  state = "ok",
): void {
  store.transaction((tx) =>
    tx.database
      .prepare(
        "INSERT INTO tracking_trace (trace_id, root_span_id, created_at, state) VALUES (?, ?, ?, ?)",
      )
      .run(traceId, "a".repeat(16), createdAt, state),
  );
}
