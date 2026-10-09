import assert from "node:assert/strict";
import type { Logger } from "pino";
import type { z } from "zod";
import { isHumanIdentity } from "../kernel/caller.ts";
import {
  CancellationContext,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import {
  HealthScope,
  ResourceStatus,
  type ResourceObserver,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  gatewayOperations,
  MAX_CONCURRENT_CHECKS,
  RESOURCE_CHECK_DEADLINE_MS,
  REPORT_MARGIN_MS,
  OWNER_LLM,
  OWNER_REPOSITORY,
  OWNER_STORAGE,
  OWNER_AGENT,
  OWNER_WORKER,
  OWNER_PROJECT,
  OWNER_INTAKE,
  type InventoryCollector,
  type InventorySnapshot,
  type ResourceInventories,
} from "./contract.ts";
import { GatewayError } from "./errors.ts";

const EMPTY_COUNT = 0;
const MIN_LIMIT = 1;
const EMPTY_OWNER = { global: {}, projects: {} } as const;
const INVENTORY_OWNERS = [
  OWNER_LLM,
  OWNER_REPOSITORY,
  OWNER_STORAGE,
  OWNER_AGENT,
  OWNER_WORKER,
  OWNER_PROJECT,
  OWNER_INTAKE,
] as const;
const DEFAULT_LIMITS = {
  maxConcurrent: MAX_CONCURRENT_CHECKS,
  checkDeadlineMs: RESOURCE_CHECK_DEADLINE_MS,
  reportBudgetMs: gatewayOperations.healthcheck.timeoutMs - REPORT_MARGIN_MS,
};
interface ReportLimits {
  maxConcurrent: number;
  checkDeadlineMs: number;
  reportBudgetMs: number;
}
type Report = z.output<typeof gatewayOperations.healthcheck.output>;
type OwnerReport = Report["shared"]["llm"];
type InventoryEntry = InventorySnapshot["entries"][number];

export function collectInventories(
  tx: Transaction,
  inventories: ResourceInventories,
): InventorySnapshot {
  const snapshot: InventorySnapshot = { entries: [], missing_inventories: [] };
  for (const owner of INVENTORY_OWNERS) {
    try {
      const entries = inventories[owner](tx);
      for (const entry of entries) snapshot.entries.push({ owner, entry });
    } catch {
      snapshot.missing_inventories.push(owner);
    }
  }
  return snapshot;
}

export async function resourceHealthReport(
  caller: CallerContext,
  collect: InventoryCollector,
  logger: Logger,
  limits: ReportLimits = DEFAULT_LIMITS,
): Promise<Report> {
  const reportAt = Date.now() + limits.reportBudgetMs;
  assert.ok(isHumanIdentity(caller.identity));
  assert.ok(
    Number.isSafeInteger(limits.maxConcurrent) &&
      limits.maxConcurrent >= MIN_LIMIT,
  );
  assert.ok(
    Number.isSafeInteger(limits.checkDeadlineMs) &&
      limits.checkDeadlineMs >= MIN_LIMIT,
  );
  assert.ok(
    Number.isSafeInteger(limits.reportBudgetMs) &&
      limits.reportBudgetMs >= MIN_LIMIT,
  );
  throwIfCancelled(caller.context);
  const snapshot = collect();
  if (snapshot.missing_inventories.length > EMPTY_COUNT)
    throw new GatewayError(
      HttpStatus.ServiceUnavailable,
      "gateway.healthcheck.inventory_failed",
      "One or more resource owners failed to supply their inventory.",
      { missing_inventories: snapshot.missing_inventories },
    );
  const unique = new Map<string, InventoryEntry>();
  for (const item of snapshot.entries)
    if (!unique.has(item.entry.target)) unique.set(item.entry.target, item);
  const statuses = await runChecks(
    [...unique.values()],
    caller,
    logger,
    limits,
    reportAt,
  );
  throwIfCancelled(caller.context);
  const report = assembleReport(snapshot.entries, statuses);
  return caller.commit(() => report);
}

async function checkResource(
  { entry }: InventoryEntry,
  parent: Context,
  reportContext: Context,
  checkDeadlineMs: number,
  reportAt: number,
  observe: ResourceObserver,
): Promise<ResourceStatusValue> {
  const deadline = Date.now() + checkDeadlineMs;
  const context = new CancellationContext(parent, deadline);
  const unlink = reportContext.onCancel(() => context.cancel());
  try {
    const result = await Promise.race([
      Promise.resolve()
        .then(() => {
          throwIfCancelled(context);
          if (Date.now() >= reportAt) return ResourceStatus.Unknown;
          return entry.check(context, observe);
        })
        .catch(() => ResourceStatus.Unknown),
      context.done().then(() => ResourceStatus.Unknown),
    ]);
    if (context.err() || Date.now() >= deadline || Date.now() >= reportAt)
      return ResourceStatus.Unknown;
    return Object.values(ResourceStatus).includes(result)
      ? result
      : ResourceStatus.Unknown;
  } finally {
    unlink();
    context.cancel();
  }
}

async function runChecks(
  entries: InventoryEntry[],
  caller: CallerContext,
  logger: Logger,
  limits: ReportLimits,
  reportAt: number,
): Promise<Map<string, ResourceStatusValue>> {
  assert.ok(isHumanIdentity(caller.identity));
  const statuses = new Map<string, ResourceStatusValue>(
    entries.map(({ entry }) => [entry.target, ResourceStatus.Unknown]),
  );
  const reasons = new Map<string, string>();
  const reportContext = new CancellationContext(caller.context);
  const timer = setTimeout(
    () => reportContext.cancel(),
    Math.max(EMPTY_COUNT, reportAt - Date.now()),
  );
  let next = 0;
  const work = async () => {
    for (let count = 0; count < entries.length; count++) {
      if (
        reportContext.err() ||
        Date.now() >= reportAt ||
        next >= entries.length
      )
        return;
      const item = entries[next++]!;
      const status = await checkResource(
        item,
        caller.context,
        reportContext,
        limits.checkDeadlineMs,
        reportAt,
        (reason) => reasons.set(item.entry.target, reason),
      );
      statuses.set(item.entry.target, status);
    }
  };
  try {
    await Promise.all(
      Array.from(
        { length: Math.min(limits.maxConcurrent, entries.length) },
        work,
      ),
    );
    return statuses;
  } finally {
    clearTimeout(timer);
    reportContext.cancel();
    for (const { owner, entry } of entries) {
      const status = statuses.get(entry.target);
      const reason = reasons.get(entry.target);
      logger.info(
        {
          caller: caller.identity.accountId,
          owner,
          target: entry.target,
          status,
          ...(status !== ResourceStatus.Healthy && reason !== undefined
            ? { reason }
            : {}),
        },
        "resource.health.check",
      );
    }
  }
}

function emptyOwner(): OwnerReport {
  return structuredClone(EMPTY_OWNER);
}

function assembleReport(
  entries: InventoryEntry[],
  statuses: Map<string, ResourceStatusValue>,
): Report {
  const owners = {
    [OWNER_LLM]: emptyOwner(),
    [OWNER_REPOSITORY]: emptyOwner(),
    [OWNER_STORAGE]: emptyOwner(),
    [OWNER_AGENT]: emptyOwner(),
    [OWNER_WORKER]: emptyOwner(),
    [OWNER_PROJECT]: emptyOwner(),
    [OWNER_INTAKE]: emptyOwner(),
  };
  for (const { owner, entry } of entries) {
    const status = statuses.get(entry.target);
    assert.ok(status !== undefined);
    const report = owners[owner];
    let resources = report.global;
    if (entry.scope === HealthScope.Project) {
      assert.ok(entry.project !== null);
      if (!Object.hasOwn(report.projects, entry.project))
        Object.defineProperty(report.projects, entry.project, {
          value: {},
          enumerable: true,
          configurable: true,
          writable: true,
        });
      resources = report.projects[entry.project]!;
    }
    Object.defineProperty(resources, entry.name, {
      value: { status, capability: entry.capability },
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return {
    services: {
      project: owners.project,
      intake: owners.intake,
      worker: owners.worker,
    },
    shared: {
      llm: owners.llm,
      repository: owners.repository,
      storage: owners.storage,
      agent: owners.agent,
    },
  };
}
