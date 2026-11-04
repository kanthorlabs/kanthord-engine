import { addAbortListener } from "node:events";
import type { Logger } from "pino";
import type { HumanActor } from "../kernel/actor.ts";
import { isHumanIdentity } from "../kernel/caller.ts";
import {
  background,
  CancellationContext,
  cancelled,
  type Context,
  reasonOf,
} from "../kernel/context.ts";
import { diagnostic, OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import {
  ALERT_IDENTITY_PREFIX,
  CLEANUP_IDENTITY_PREFIX,
  createIdentity,
  identityTime,
} from "../kernel/identity.ts";
import type { CallerContext, OperationRegistry } from "../kernel/operation.ts";
import {
  type Healthcheck,
  HealthStatus,
  type Service,
} from "../kernel/service.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  CleanableKind,
  type CleanupCreate,
  type CleanupRecord,
  CleanupRule,
  type CleanupRuleValue,
  CleanupState,
  DAY_MS,
  DEFAULT_AGE_DAYS,
  DELETE_OPERATIONS,
  failedMeasure,
  FOOTPRINT_MEASURE_INTERVAL_MS,
  FOOTPRINT_SERVICE_NAME,
  FOOTPRINT_STALE_INTERVALS,
  type FootprintAlert,
  FootprintAlertState,
  FootprintErrorCode,
  footprintKeySchema,
  FootprintKind,
  type FootprintMeasure,
  footprintOperations,
  type FootprintOwner,
  type FootprintStat,
  type FootprintTable,
  type FootprintThreshold,
  KIND_RULES,
  type MeasureError,
  RUNTIME_STORE_DEVICE,
  SERVER_KINDS,
  ThresholdMeasure,
} from "./contract.ts";
import type { FootprintConfig } from "./config.ts";
import {
  decodeCursor,
  defaultRule,
  encodeCursor,
  offsetOf,
  ruleSupported,
  ruleValue,
} from "./candidates.ts";
import {
  cleanupOf,
  cleanupRecord,
  completedSince,
  insertCleanup,
  listCleanups,
  type StoredCleanup,
  updateCleanup,
} from "./cleanup-store.ts";
import {
  acknowledgeAlert,
  alertOf,
  insertAlert,
  listAlerts,
  openAlerts,
  resolveAlert,
  type StoredAlert,
} from "./alert-store.ts";
import {
  acknowledgedUntil,
  acknowledgementHolds,
  type AlertEvent,
  type AlertTrack,
  FIRING_TRACK,
  OK_TRACK,
  step,
} from "./alerts.ts";
import { type CleanupDeleter, CleanupTask } from "./cleanup-task.ts";
import type { ServerHost } from "./server-host.ts";

const MEASURE_ERROR_CHANGED = "footprint.measure.error_changed";
const MEASURE_FAILED = "footprint.measure.failed";
const BACKUP_DELETED = "footprint.backup.deleted";
const ALERT_FIRED = "footprint.alert.fired";
const ALERT_RESOLVED = "footprint.alert.resolved";
const ALERT_EVALUATION_FAILED = "footprint.alert.evaluation_failed";
const KEY_SEPARATOR = "\u0000";
const WINDOW_MIN_DAYS = 1;
const NO_ITEMS = 0;
const NO_GROWTH = 0;
const QUERY_TRUE = "true";

export interface InstanceLookup {
  instanceStateOf(tx: Transaction, name: string): { archived: boolean } | null;
}

export interface Dependencies {
  readonly store: Store;
  readonly config: FootprintConfig;
  readonly logger: Logger;
  readonly serverHost: ServerHost;
  readonly instances: InstanceLookup;
  readonly deleters?: () => Partial<Record<CleanableKind, CleanupDeleter>>;
  readonly now?: () => number;
}

interface Entry {
  readonly measure: FootprintMeasure;
  readonly measured_at: number | null;
  readonly error: MeasureError | null;
  readonly candidates: { count: number; bytes: number | null } | null;
}

function entryKey(
  kind: string,
  instanceName: string | null,
  itemKey: string | null,
): string {
  return [kind, instanceName ?? "", itemKey ?? ""].join(KEY_SEPARATOR);
}

function notFound(code: string, message: string): OperationError {
  return new OperationError(HttpStatus.NotFound, code, message);
}

function conflict(code: string, message: string): OperationError {
  return new OperationError(HttpStatus.Conflict, code, message);
}

function invalid(path: string[]): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    FootprintErrorCode.ValidationFailed,
    "Request validation failed.",
    [{ path, code: "custom" }],
  );
}

function humanOf(caller: CallerContext): HumanActor {
  const identity = caller.identity;
  if (!isHumanIdentity(identity))
    throw new OperationError(
      HttpStatus.Unauthorized,
      "gateway.auth.unauthorized",
      "A human identity is required.",
    );
  return { kind: "human", account: identity.accountId, name: identity.name };
}

function isCleanable(kind: FootprintKind): kind is CleanableKind {
  return (Object.values(CleanableKind) as string[]).includes(kind);
}

function isServerKind(kind: FootprintKind): boolean {
  return SERVER_KINDS.includes(kind);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class FootprintService implements Service {
  private readonly dependencies: Dependencies;
  private readonly now: () => number;
  private readonly owners: FootprintOwner[] = [];
  private readonly entries = new Map<string, Entry>();
  private readonly tracks = new Map<string, AlertTrack>();
  private readonly tableCache = new Map<
    FootprintKind,
    { at: number; tables: FootprintTable[] | null }
  >();
  private readonly shutdown = new CancellationContext();
  private task?: CleanupTask;
  private timer?: NodeJS.Timeout;
  private measuring: Promise<void> | null = null;
  private started = false;

  constructor(dependencies: Dependencies) {
    this.dependencies = dependencies;
    this.now = dependencies.now ?? Date.now;
    this.register(dependencies.serverHost);
  }

  register(owner: FootprintOwner): void {
    this.owners.push(owner);
  }

  private cleanupTask(): CleanupTask {
    this.task ??= new CleanupTask({
      store: this.dependencies.store,
      logger: this.dependencies.logger,
      now: this.now,
      deleters: {
        [CleanableKind.DatabaseBackup]: async (call) => ({
          ...(await this.deleteBackups(call.keys, call.requested_by)),
          refused: [],
        }),
        ...this.dependencies.deleters?.(),
      },
    });
    return this.task;
  }

  private ownerOf(kind: FootprintKind): FootprintOwner | null {
    return this.owners.find((owner) => owner.kinds.includes(kind)) ?? null;
  }

  measure(): Promise<void> {
    this.measuring ??= this.measureOwners().finally(() => {
      this.measuring = null;
    });
    return this.measuring;
  }

  private async measureOwners(): Promise<void> {
    const reported = new Set<string>();
    const skipped = new Set<FootprintKind>();
    const hosts = new Set<string | null>([null]);
    for (const owner of this.owners) {
      let measures: readonly FootprintMeasure[];
      try {
        measures = await owner.measure(this.shutdown.signal);
      } catch (error) {
        this.dependencies.logger.error(
          { kinds: owner.kinds, reason: diagnostic(error) },
          MEASURE_FAILED,
        );
        measures = owner.kinds.map((kind) =>
          failedMeasure(kind, MEASURE_FAILED, messageOf(error)),
        );
        owner.kinds.forEach((kind) => skipped.add(kind));
      }
      measures.forEach((measure) => hosts.add(measure.instance_name));
      for (const key of await this.record(owner, measures)) reported.add(key);
    }
    for (const host of hosts) this.settle(host, reported, skipped);
  }

  private async record(
    owner: FootprintOwner,
    measures: readonly FootprintMeasure[],
  ): Promise<Set<string>> {
    const at = this.now();
    const reported = new Set<string>();
    for (const measure of measures) {
      const key = entryKey(
        measure.kind,
        measure.instance_name,
        measure.item_key,
      );
      reported.add(key);
      const previous = this.entries.get(key);
      if (
        (previous?.error?.code ?? null) !==
        (measure.measure_error?.code ?? null)
      )
        this.dependencies.logger.warn(
          {
            kind: measure.kind,
            instance_name: measure.instance_name,
            item_key: measure.item_key,
            code: measure.measure_error?.code ?? null,
          },
          MEASURE_ERROR_CHANGED,
        );
      if (measure.measure_error !== null) {
        this.entries.set(key, {
          measure: previous?.measure ?? measure,
          measured_at: previous?.measured_at ?? null,
          error: measure.measure_error,
          candidates: previous?.candidates ?? null,
        });
        continue;
      }
      this.entries.set(key, {
        measure,
        measured_at: at,
        error: null,
        candidates: await this.defaultCandidates(owner, measure, at),
      });
    }
    return reported;
  }

  private settle(
    instanceName: string | null,
    reported: ReadonlySet<string>,
    skipped: ReadonlySet<FootprintKind>,
  ): void {
    const vanished = (kind: FootprintKind, host: string | null, key: string) =>
      host === instanceName && !skipped.has(kind) && !reported.has(key);
    for (const [key, entry] of this.entries)
      if (vanished(entry.measure.kind, entry.measure.instance_name, key)) {
        this.entries.delete(key);
        this.tracks.delete(key);
      }
    try {
      const open = new Map(
        this.dependencies.store
          .transaction((tx) => openAlerts(tx))
          .map((alert) => [
            entryKey(alert.kind, alert.instance_name, alert.item_key),
            alert,
          ]),
      );
      for (const [key, alert] of open)
        if (vanished(alert.kind, alert.instance_name, key))
          this.resolve(key, alert);
      for (const stat of this.stats()) {
        const key = entryKey(stat.kind, stat.instance_name, stat.item_key);
        if (stat.instance_name !== instanceName || !reported.has(key)) continue;
        const alert = open.get(key);
        const next = step(
          this.tracks.get(key) ?? (alert ? FIRING_TRACK : OK_TRACK),
          stat,
        );
        this.tracks.set(key, next.track);
        if (next.event?.fire) this.fire(stat, next.event);
        else if (next.event && alert) this.resolve(key, alert);
      }
    } catch (error) {
      this.dependencies.logger.error(
        { reason: diagnostic(error) },
        ALERT_EVALUATION_FAILED,
      );
    }
  }

  private fire(
    stat: FootprintStat,
    event: Extract<AlertEvent, { fire: true }>,
  ): void {
    const alert: StoredAlert = {
      alert_id: createIdentity(ALERT_IDENTITY_PREFIX),
      kind: stat.kind,
      instance_name: stat.instance_name,
      item_key: stat.item_key,
      threshold: event.threshold,
      value: event.value,
      resolved_at: null,
      acknowledged_by: null,
      acknowledged_at: null,
      acknowledged_until: null,
    };
    this.dependencies.store.transaction((tx) => insertAlert(tx, alert));
    this.dependencies.logger.warn(
      {
        alert_id: alert.alert_id,
        kind: alert.kind,
        instance_name: alert.instance_name,
        item_key: alert.item_key,
        value: alert.value,
        threshold: alert.threshold,
      },
      ALERT_FIRED,
    );
  }

  private resolve(key: string, alert: StoredAlert): void {
    this.dependencies.store.transaction((tx) =>
      resolveAlert(tx, alert.alert_id, this.now()),
    );
    this.tracks.delete(key);
    this.dependencies.logger.info(
      {
        alert_id: alert.alert_id,
        kind: alert.kind,
        instance_name: alert.instance_name,
        item_key: alert.item_key,
        value: alert.value,
        threshold: alert.threshold,
      },
      ALERT_RESOLVED,
    );
  }

  private async defaultCandidates(
    owner: FootprintOwner,
    measure: FootprintMeasure,
    now: number,
  ): Promise<Entry["candidates"]> {
    if (!isCleanable(measure.kind) || measure.instance_name !== null)
      return null;
    try {
      const page = await owner.candidates({
        kind: measure.kind,
        instance_name: null,
        rule: defaultRule(measure.kind),
        offset: 0,
        limit: 0,
        now,
        signal: this.shutdown.signal,
      });
      return { count: page.total_count, bytes: page.total_bytes };
    } catch {
      return null;
    }
  }

  private thresholds(kind: FootprintKind): FootprintThreshold[] {
    const { disk_free_ratio: ratio, thresholds } = this.dependencies.config;
    if (kind === FootprintKind.Disk)
      return [
        { measure: ThresholdMeasure.FreeRatio, value: ratio },
        {
          measure: ThresholdMeasure.DaysToFloor,
          value: DEFAULT_AGE_DAYS,
          free_ratio: ratio,
        },
      ];
    const bytes = thresholds[kind];
    return bytes === null
      ? []
      : [{ measure: ThresholdMeasure.Bytes, value: bytes }];
  }

  private growth(
    entry: Entry,
    cleanups: readonly StoredCleanup[],
  ): FootprintStat["growth_per_day"] {
    const { measure } = entry;
    if (
      entry.measured_at === null ||
      measure.recent_count === null ||
      measure.count === null ||
      measure.bytes === null
    )
      return null;
    const measuredAt = entry.measured_at;
    const window =
      measure.oldest_at === null
        ? DEFAULT_AGE_DAYS
        : Math.max(
            WINDOW_MIN_DAYS,
            Math.min(
              DEFAULT_AGE_DAYS,
              (measuredAt - measure.oldest_at) / DAY_MS,
            ),
          );
    const perItem =
      measure.count === NO_ITEMS ? NO_ITEMS : measure.bytes / measure.count;
    let removed = 0;
    let removedBytes = 0;
    for (const cleanup of cleanups) {
      if (
        cleanup.kind !== measure.kind ||
        cleanup.instance_name !== measure.instance_name ||
        cleanup.outcome === null ||
        cleanup.finished_at === null ||
        cleanup.finished_at < measuredAt - window * DAY_MS ||
        (cleanup.rule?.name === CleanupRule.OlderThan &&
          cleanup.rule.older_than_days >= DEFAULT_AGE_DAYS)
      )
        continue;
      removed += cleanup.outcome.removed;
      removedBytes +=
        cleanup.outcome.removed_bytes ?? cleanup.outcome.removed * perItem;
    }
    return {
      count: (measure.recent_count + removed) / window,
      bytes: (measure.recent_count * perItem + removedBytes) / window,
    };
  }

  stats(): FootprintStat[] {
    const now = this.now();
    const earliest = Math.min(
      now,
      ...[...this.entries.values()].map((entry) => entry.measured_at ?? now),
    );
    const cleanups = this.dependencies.store.transaction((tx) =>
      completedSince(tx, earliest - DEFAULT_AGE_DAYS * DAY_MS),
    );
    const open = this.dependencies.store.transaction((tx) => openAlerts(tx));
    const entries = [...this.entries.values()];
    const growths = new Map(
      entries.map((entry) => [entry, this.growth(entry, cleanups)]),
    );
    return entries.map((entry) => {
      const { measure } = entry;
      const growth = growths.get(entry) ?? null;
      const alert = open.find(
        (candidate) =>
          candidate.kind === measure.kind &&
          candidate.instance_name === measure.instance_name &&
          candidate.item_key === measure.item_key,
      );
      const cleanable = isCleanable(measure.kind) ? measure.kind : null;
      const rule = cleanable === null ? null : defaultRule(cleanable);
      return {
        kind: measure.kind,
        instance_name: measure.instance_name,
        item_key: measure.item_key,
        instance_names: [...measure.instance_names],
        measured_at: entry.measured_at,
        stale:
          entry.measured_at === null ||
          now - entry.measured_at >
            FOOTPRINT_STALE_INTERVALS * FOOTPRINT_MEASURE_INTERVAL_MS,
        measure_error: entry.error,
        count: measure.count,
        bytes: measure.bytes,
        wal_bytes: measure.wal_bytes,
        free_bytes: measure.free_bytes,
        total_bytes: measure.total_bytes,
        oldest_at: measure.oldest_at,
        newest_at: measure.newest_at,
        growth_per_day: growth,
        days_to_floor:
          measure.kind === FootprintKind.Disk
            ? this.daysToFloor(entry, entries, growths)
            : null,
        thresholds: this.thresholds(measure.kind),
        alert: {
          state:
            this.tracks.get(
              entryKey(measure.kind, measure.instance_name, measure.item_key),
            )?.state ??
            (alert ? FootprintAlertState.Firing : FootprintAlertState.Ok),
          alert_id: alert?.alert_id ?? null,
        },
        delete_operation:
          cleanable === null ? null : DELETE_OPERATIONS[cleanable],
        rules: cleanable === null ? [] : [...KIND_RULES[cleanable]],
        candidates:
          rule === null || entry.candidates === null
            ? null
            : {
                rule,
                count: entry.candidates.count,
                bytes:
                  measure.kind === FootprintKind.Trace
                    ? this.estimate(measure, entry.candidates.count)
                    : entry.candidates.bytes,
                bytes_estimated: measure.kind === FootprintKind.Trace,
              },
      };
    });
  }

  private estimate(measure: FootprintMeasure, count: number): number | null {
    if (measure.bytes === null || measure.count === null) return null;
    return measure.count === NO_ITEMS
      ? NO_ITEMS
      : Math.floor((count * measure.bytes) / measure.count);
  }

  private daysToFloor(
    disk: Entry,
    entries: readonly Entry[],
    growths: ReadonlyMap<Entry, FootprintStat["growth_per_day"]>,
  ): number | null {
    const { measure } = disk;
    if (measure.free_bytes === null || measure.total_bytes === null)
      return null;
    let total: number | null = null;
    for (const entry of entries) {
      const device = entry.measure.device;
      const onDevice =
        device !== null &&
        (device === measure.item_key ||
          (measure.runtime_store && device === RUNTIME_STORE_DEVICE)) &&
        (measure.instance_name === null ||
          entry.measure.instance_name === measure.instance_name);
      const growth = growths.get(entry);
      if (!onDevice || growth === null || growth === undefined) continue;
      total = (total ?? 0) + growth.bytes;
    }
    if (total === null || total === NO_GROWTH) return null;
    const floor =
      this.dependencies.config.disk_free_ratio * measure.total_bytes;
    if (measure.free_bytes < floor) return 0;
    return (measure.free_bytes - floor) / total;
  }

  private checkHost(
    tx: Transaction,
    kind: FootprintKind,
    instanceName: string | null,
  ): { archived: boolean } | null {
    if (isServerKind(kind) === (instanceName !== null))
      throw conflict(
        FootprintErrorCode.HostMismatch,
        "A server kind takes no instance name, and an instance kind requires one.",
      );
    if (instanceName === null) return null;
    const state = this.dependencies.instances.instanceStateOf(tx, instanceName);
    if (state === null)
      throw notFound(
        FootprintErrorCode.InstanceNotFound,
        "No worker instance has the name.",
      );
    return state;
  }

  private ruleOf(
    kind: CleanableKind,
    name: CleanupRule | undefined,
    olderThanDays: number | undefined,
  ): CleanupRuleValue {
    const rule =
      name === undefined ? defaultRule(kind) : ruleValue(name, olderThanDays);
    if (!ruleSupported(kind, rule))
      throw conflict(
        FootprintErrorCode.RuleNotSupported,
        "The rule does not apply to the kind.",
      );
    return rule;
  }

  private async page(
    kind: CleanableKind,
    instanceName: string | null,
    rule: CleanupRuleValue | null,
    limit: number,
    cursor: string | undefined,
  ) {
    const scope = { kind, instance_name: instanceName, rule };
    const offset = offsetOf(decodeCursor(scope, cursor));
    const owner = this.ownerOf(kind);
    const page = owner
      ? await owner.candidates({
          kind,
          instance_name: instanceName,
          rule,
          offset,
          limit,
          now: this.now(),
          signal: this.shutdown.signal,
        })
      : { items: [], total_count: 0, total_bytes: 0 };
    const next = offset + page.items.length;
    return {
      page,
      next_cursor:
        page.items.length === limit && next < page.total_count
          ? encodeCursor(scope, String(next))
          : null,
    };
  }

  private traceStat(): FootprintMeasure | null {
    return (
      this.entries.get(entryKey(FootprintKind.Trace, null, null))?.measure ??
      null
    );
  }

  private alertView(alert: StoredAlert): FootprintAlert {
    return {
      ...alert,
      fired_at: identityTime(alert.alert_id),
      state:
        alert.resolved_at === null
          ? (this.tracks.get(
              entryKey(alert.kind, alert.instance_name, alert.item_key),
            )?.state ?? FootprintAlertState.Firing)
          : FootprintAlertState.Ok,
    };
  }

  private statOf(
    stats: readonly FootprintStat[],
    alert: StoredAlert,
  ): FootprintStat | null {
    return (
      stats.find(
        (stat) =>
          stat.kind === alert.kind &&
          stat.instance_name === alert.instance_name &&
          stat.item_key === alert.item_key,
      ) ?? null
    );
  }

  private async deleteBackups(
    names: readonly string[],
    requestedBy: HumanActor,
  ): Promise<{ removed: number; absent: number; removed_bytes: number }> {
    const answer = await this.dependencies.serverHost.deleteBackups(names);
    this.dependencies.logger.info(
      {
        requested_by: requestedBy.account,
        removed: answer.removed,
        absent: answer.absent,
      },
      BACKUP_DELETED,
    );
    return answer;
  }

  declare(registry: OperationRegistry): void {
    if (
      Object.values(footprintOperations).some(
        (operation) => operation.service !== FOOTPRINT_SERVICE_NAME,
      )
    )
      throw new Error("Footprint operations require footprint ownership.");
    registry.register(footprintOperations["summary.get"], () => {
      const stats = this.stats();
      const open = this.dependencies.store.transaction((tx) => openAlerts(tx));
      return {
        stats,
        open_alerts: open.length,
        unacknowledged_alerts: open.filter(
          (alert) => !acknowledgementHolds(alert, this.statOf(stats, alert)),
        ).length,
      };
    });
    registry.register(
      footprintOperations["kind.get"],
      async ({ params, query }) => {
        const instanceName = query.instance_name ?? null;
        if (instanceName !== null)
          this.dependencies.store.transaction((tx) => {
            if (
              this.dependencies.instances.instanceStateOf(tx, instanceName) ===
              null
            )
              throw notFound(
                FootprintErrorCode.InstanceNotFound,
                "No worker instance has the name.",
              );
          });
        return {
          stats: this.stats().filter(
            (stat) =>
              stat.kind === params.kind &&
              (instanceName === null || stat.instance_name === instanceName),
          ),
          tables: await this.tables(params.kind),
        };
      },
    );
    registry.register(
      footprintOperations["candidate.list"],
      async ({ params, query }) => {
        const instanceName = query.instance_name ?? null;
        this.dependencies.store.transaction((tx) =>
          this.checkHost(tx, params.kind, instanceName),
        );
        const rule = this.ruleOf(
          params.kind,
          query.rule,
          query.older_than_days,
        );
        const { page, next_cursor } = await this.page(
          params.kind,
          instanceName,
          rule,
          query.limit,
          query.cursor,
        );
        const trace = params.kind === FootprintKind.Trace;
        const traceStat = trace ? this.traceStat() : null;
        return {
          items: [...page.items],
          next_cursor,
          total_count: page.total_count,
          total_bytes: trace
            ? traceStat === null
              ? null
              : this.estimate(traceStat, page.total_count)
            : page.total_bytes,
          bytes_estimated: trace,
        };
      },
    );
    registry.register(
      footprintOperations["item.list"],
      async ({ params, query }) => {
        const instanceName = query.instance_name ?? null;
        this.dependencies.store.transaction((tx) =>
          this.checkHost(tx, params.kind, instanceName),
        );
        const { page, next_cursor } = await this.page(
          params.kind,
          instanceName,
          null,
          query.limit,
          query.cursor,
        );
        return { items: [...page.items], next_cursor };
      },
    );
    registry.register(
      footprintOperations["cleanup.create"],
      ({ body }, caller) => this.create(body, caller),
    );
    registry.register(
      footprintOperations["cleanup.get"],
      ({ params }, caller) =>
        caller.commit((tx) =>
          cleanupRecord(this.cleanup(tx, params.cleanup_id)),
        ),
    );
    registry.register(
      footprintOperations["cleanup.list"],
      ({ query }, caller) =>
        caller.commit((tx) => {
          const scope = { kind: query.kind ?? null };
          const before = decodeCursor(scope, query.cursor);
          const items = listCleanups(tx, scope.kind, before, query.limit);
          const last = items.at(-1);
          return {
            items: items.map(cleanupRecord),
            next_cursor:
              items.length === query.limit && last
                ? encodeCursor(scope, last.cleanup_id)
                : null,
          };
        }),
    );
    registry.register(
      footprintOperations["cleanup.cancel"],
      ({ params }, caller) =>
        caller.commit((tx) => {
          const cleanup = this.cleanup(tx, params.cleanup_id);
          if (cleanup.state !== CleanupState.Queued)
            throw conflict(
              FootprintErrorCode.CleanupNotQueued,
              "Only a queued cleanup can be cancelled.",
            );
          const finished = this.now();
          updateCleanup(
            tx,
            cleanup.cleanup_id,
            CleanupState.Cancelled,
            cleanup.outcome,
            finished,
          );
          return cleanupRecord({
            ...cleanup,
            state: CleanupState.Cancelled,
            finished_at: finished,
          });
        }),
    );
    registry.register(footprintOperations["alert.list"], ({ query }, caller) =>
      caller.commit((tx) => {
        const open =
          query.open === undefined ? null : query.open === QUERY_TRUE;
        const scope = { open };
        const before = decodeCursor(scope, query.cursor);
        const items = listAlerts(tx, open, before, query.limit);
        const last = items.at(-1);
        return {
          items: items.map((alert) => this.alertView(alert)),
          next_cursor:
            items.length === query.limit && last
              ? encodeCursor(scope, last.alert_id)
              : null,
        };
      }),
    );
    registry.register(
      footprintOperations["alert.acknowledge"],
      ({ params }, caller) => {
        const by = humanOf(caller);
        const stats = this.stats();
        return caller.commit((tx) => {
          const alert = alertOf(tx, params.alert_id);
          if (alert === null)
            throw notFound(
              FootprintErrorCode.AlertNotFound,
              "No alert has the id.",
            );
          if (alert.resolved_at !== null)
            throw conflict(
              FootprintErrorCode.AlertResolved,
              "The alert episode is resolved.",
            );
          const stat = this.statOf(stats, alert);
          if (acknowledgementHolds(alert, stat))
            throw conflict(
              FootprintErrorCode.AlertAcknowledged,
              "The acknowledgement holds.",
            );
          const at = this.now();
          const until = acknowledgedUntil(
            alert,
            stat,
            this.dependencies.config.disk_free_ratio,
          );
          acknowledgeAlert(tx, alert.alert_id, by, at, until);
          return this.alertView({
            ...alert,
            acknowledged_by: by,
            acknowledged_at: at,
            acknowledged_until: until,
          });
        });
      },
    );
    registry.register(footprintOperations["measure.run"], async () => {
      await this.measure();
      return {
        stats: this.stats().filter((stat) => stat.instance_name === null),
      };
    });
    registry.register(
      footprintOperations["backup.delete"],
      async ({ body }, caller) => {
        const answer = await this.deleteBackups(body.names, humanOf(caller));
        return { removed: answer.removed, absent: answer.absent };
      },
    );
  }

  private cleanup(tx: Transaction, cleanupId: string): StoredCleanup {
    const cleanup = cleanupOf(tx, cleanupId);
    if (cleanup === null)
      throw notFound(
        FootprintErrorCode.CleanupNotFound,
        "No cleanup has the id.",
      );
    return cleanup;
  }

  private create(body: CleanupCreate, caller: CallerContext): CleanupRecord {
    const requestedBy = humanOf(caller);
    const schema = footprintKeySchema(body.kind);
    body.keys.forEach((key, index) => {
      if (!schema.safeParse(key).success)
        throw invalid(["body", "keys", String(index)]);
    });
    if (new Set(body.keys).size !== body.keys.length)
      throw invalid(["body", "keys"]);
    const record = caller.commit((tx) => {
      const state = this.checkHost(tx, body.kind, body.instance_name);
      if (state?.archived)
        throw conflict(
          FootprintErrorCode.InstanceArchived,
          "The worker instance is archived.",
        );
      if (body.rule !== null && !ruleSupported(body.kind, body.rule))
        throw conflict(
          FootprintErrorCode.RuleNotSupported,
          "The rule does not apply to the kind.",
        );
      const cleanup: StoredCleanup = {
        cleanup_id: createIdentity(CLEANUP_IDENTITY_PREFIX),
        kind: body.kind,
        instance_name: body.instance_name,
        rule: body.rule,
        keys: body.keys,
        requested_by: requestedBy,
        state: CleanupState.Queued,
        finished_at: null,
        outcome: null,
      };
      insertCleanup(tx, cleanup);
      return cleanupRecord(cleanup);
    });
    if (this.started) void this.cleanupTask().kick();
    return record;
  }

  private async tables(kind: FootprintKind): Promise<FootprintTable[] | null> {
    if (
      kind !== FootprintKind.Trace &&
      kind !== FootprintKind.OperationalDatabase
    )
      return null;
    const cached = this.tableCache.get(kind);
    const now = this.now();
    if (cached && now - cached.at < FOOTPRINT_MEASURE_INTERVAL_MS)
      return cached.tables;
    const owner = this.ownerOf(kind);
    const tables =
      owner?.tables === undefined
        ? null
        : await owner
            .tables(kind, this.shutdown.signal)
            .then((found) => (found === null ? null : [...found]));
    this.tableCache.set(kind, { at: now, tables });
    return tables;
  }

  async runCleanups(): Promise<void> {
    await this.cleanupTask().kick();
  }

  start(): Promise<Error | null> {
    if (this.shutdown.signal.aborted)
      return Promise.resolve(
        new Error("footprint: a stopped service cannot start again."),
      );
    this.started = true;
    void this.measure();
    void this.cleanupTask().kick();
    this.timer = setInterval(() => {
      void this.measure();
    }, FOOTPRINT_MEASURE_INTERVAL_MS);
    this.timer.unref();
    return Promise.resolve(null);
  }

  quiesce(): Promise<Error | null> {
    return Promise.resolve(null);
  }

  async stop(): Promise<Error | null> {
    this.shutdown.cancel();
    this.started = false;
    clearInterval(this.timer);
    await this.task?.stop();
    await this.measuring?.catch(() => undefined);
    return null;
  }

  async run(context: Context = background): Promise<Error | null> {
    using cancellation = addAbortListener(context.signal, () => {
      void this.stop();
    });
    if (context.signal.aborted)
      return (await this.stop()) ?? reasonOf(context.signal);
    await cancelled(this.shutdown.signal);
    return (await this.stop()) ?? reasonOf(context.signal);
  }

  async healthcheck(): Promise<Healthcheck> {
    return {
      footprint:
        this.started && !this.shutdown.signal.aborted
          ? HealthStatus.Healthy
          : HealthStatus.Unavailable,
    };
  }
}
