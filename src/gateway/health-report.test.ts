import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import {
  setTimeout as delay,
  setImmediate as turn,
} from "node:timers/promises";
import pino from "pino";
import { mintHumanIdentity } from "../kernel/caller-mint.ts";
import { CancellationContext, type Context } from "../kernel/context.ts";
import {
  HealthScope,
  type ResourceEntry,
  ResourceFailureReason,
  ResourceStatus,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import type { CallerContext } from "../kernel/operation.ts";
import { Store } from "../kernel/store.ts";
import {
  type InventorySnapshot,
  OWNER_AGENT,
  OWNER_INTAKE,
  OWNER_LLM,
  OWNER_PROJECT,
  OWNER_REPOSITORY,
  OWNER_STORAGE,
  OWNER_WORKER,
} from "./contract.ts";
import { resourceHealthReport } from "./health-report.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const LIMITS = { maxConcurrent: 3, checkDeadlineMs: 500, reportBudgetMs: 2000 };
const EMPTY_COUNT = 0;
const SINGLE_CHECK = 1;
const EXPECTED_MAX = 3;
const TARGET_COUNT = 12;
const REPORT_BUDGET_MS = 40;
const ONE_MS = 1;
const CHECK_DEADLINE_MS = 20;
const UNFIRED_FACTOR = 3;
const ACCOUNT = "health-reader";
const SICK_REASON = "status=500";
const LOG_MESSAGE = "resource.health.check";
const CAPABILITY = "reachability";
const CHECK_ERROR = new Error("secret credential or private endpoint");
const OWNERS = [
  OWNER_LLM,
  OWNER_REPOSITORY,
  OWNER_STORAGE,
  OWNER_AGENT,
  OWNER_WORKER,
  OWNER_PROJECT,
  OWNER_INTAKE,
] as const;

function entry(
  name: string,
  overrides: Partial<ResourceEntry> = {},
): ResourceEntry {
  return {
    scope: HealthScope.Global,
    project: null,
    name,
    target: name,
    capability: CAPABILITY,
    check: async () => ResourceStatus.Healthy,
    ...overrides,
  };
}

function fixture(t: TestContext, entries: InventorySnapshot["entries"] = []) {
  const store = new Store(":memory:");
  const context = new CancellationContext();
  const logs: string[] = [];
  let commits = 0;
  let collections = 0;
  const caller: CallerContext = {
    identity: mintHumanIdentity(ACCOUNT, "Health Reader", "health-token"),
    context,
    requestId: "health-request",
    commit: (write) => {
      commits++;
      return store.transaction(write);
    },
  };
  const logger = pino(
    { level: "info" },
    {
      write: (line) => {
        logs.push(line);
      },
    },
  );
  const collect = () => {
    collections++;
    return { entries, missing_inventories: [] };
  };
  stopAfter(t, () => {
    context.cancel();
    store.close();
  });
  return {
    store,
    caller,
    context,
    logger,
    collect,
    logs,
    commits: () => commits,
    collections: () => collections,
    report: (limits = LIMITS) =>
      resourceHealthReport(caller, collect, logger, limits),
  };
}

test("an empty intake inventory answers fresh empty maps", async (t) => {
  const f = fixture(t);
  const report = await f.report();
  assert.deepEqual(report.services.intake, { global: {}, projects: {} });
  report.services.intake.global.changed = {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY,
    failure_reason: ResourceFailureReason.Unclassified,
  };
  assert.deepEqual((await f.report()).services.intake, {
    global: {},
    projects: {},
  });
  assert.equal(f.commits(), SINGLE_CHECK + SINGLE_CHECK);
});

test("shared targets use the first check once across owners and projects and log one safe record", async (t) => {
  let checks = 0;
  const first = entry("first", {
    target: "shared",
    scope: HealthScope.Project,
    project: "one",
    check: async () => {
      checks++;
      return ResourceStatus.Unhealthy;
    },
  });
  const second = entry("second", {
    target: "shared",
    scope: HealthScope.Project,
    project: "two",
    check: async () => {
      throw CHECK_ERROR;
    },
  });
  const f = fixture(t, [
    { owner: OWNER_LLM, entry: first },
    { owner: OWNER_PROJECT, entry: second },
  ]);
  const report = await f.report();
  const expected = {
    status: ResourceStatus.Unhealthy,
    capability: CAPABILITY,
    failure_reason: ResourceFailureReason.Unclassified,
  };
  assert.equal(checks, SINGLE_CHECK);
  assert.deepEqual(report.shared.llm.projects.one?.first, expected);
  assert.deepEqual(report.services.project.projects.two?.second, expected);
  assert.deepEqual(report.services.worker, { global: {}, projects: {} });
  assert.equal(f.logs.length, SINGLE_CHECK);
  const { caller, owner, target, status, msg } = JSON.parse(f.logs[0]!);
  assert.deepEqual(
    { caller, owner, target, status, msg },
    {
      caller: ACCOUNT,
      owner: OWNER_LLM,
      target: first.target,
      status: ResourceStatus.Unhealthy,
      msg: LOG_MESSAGE,
    },
  );
  assert.doesNotMatch(f.logs.join(""), /secret|credential|endpoint/);
});

test("a never-settling check expires, releases its slot and retains its unknown entry", async (t) => {
  const contexts: Context[] = [];
  const f = fixture(t, [
    {
      owner: OWNER_LLM,
      entry: entry("hung", {
        check: (context) => {
          contexts.push(context);
          return new Promise(() => {});
        },
      }),
    },
    { owner: OWNER_WORKER, entry: entry("next") },
  ]);
  const report = await f.report({
    ...LIMITS,
    maxConcurrent: SINGLE_CHECK,
    checkDeadlineMs: CHECK_DEADLINE_MS,
  });
  assert.deepEqual(report.shared.llm.global.hung, {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY,
    failure_reason: ResourceFailureReason.DeadlineExceeded,
  });
  assert.equal(
    report.services.worker.global.next?.status,
    ResourceStatus.Healthy,
  );
  assert.ok(contexts.every((context) => context.signal.reason));
});

test("an injected check deadline ends a check with deadline_exceeded only when it fires", async (t) => {
  const deadline = new AbortController();
  const started = Promise.withResolvers<Context>();
  const f = fixture(t, [
    {
      owner: OWNER_LLM,
      entry: entry("held", {
        check: (context) => {
          started.resolve(context);
          return new Promise(() => {});
        },
      }),
    },
  ]);
  const limits = {
    ...LIMITS,
    checkDeadlineMs: CHECK_DEADLINE_MS,
    checkDeadline: deadline.signal,
  };
  const pending = f.report(limits);
  const context = await started.promise;
  await delay(CHECK_DEADLINE_MS * UNFIRED_FACTOR);
  assert.equal(context.signal.aborted, false);
  deadline.abort();
  const report = await pending;
  assert.deepEqual(report.shared.llm.global.held, {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY,
    failure_reason: ResourceFailureReason.DeadlineExceeded,
  });
  assert.equal(context.signal.aborted, true);
});

test("an injected check deadline that never fires replaces checkDeadlineMs", async (t) => {
  const deadline = new AbortController();
  const f = fixture(t, [
    {
      owner: OWNER_LLM,
      entry: entry("slow", {
        check: async () => {
          await delay(CHECK_DEADLINE_MS * UNFIRED_FACTOR);
          return ResourceStatus.Healthy;
        },
      }),
    },
  ]);
  const limits = {
    ...LIMITS,
    checkDeadlineMs: CHECK_DEADLINE_MS,
    checkDeadline: deadline.signal,
  };
  const report = await f.report(limits);
  assert.equal(report.shared.llm.global.slow?.status, ResourceStatus.Healthy);
});

test("a check of every owner that exceeds its deadline carries deadline_exceeded over its observed reason", async (t) => {
  const f = fixture(
    t,
    OWNERS.map((owner) => ({
      owner,
      entry: entry(owner, {
        check: (_context, observe) => {
          observe?.(SICK_REASON, ResourceFailureReason.Forbidden);
          return new Promise(() => {});
        },
      }),
    })),
  );
  const report = await f.report({
    ...LIMITS,
    maxConcurrent: OWNERS.length,
    checkDeadlineMs: CHECK_DEADLINE_MS,
  });
  const owners = {
    llm: report.shared.llm,
    repository: report.shared.repository,
    storage: report.shared.storage,
    agent: report.shared.agent,
    worker: report.services.worker,
    project: report.services.project,
    intake: report.services.intake,
  };
  for (const owner of OWNERS)
    assert.deepEqual(owners[owner].global[owner], {
      status: ResourceStatus.Unknown,
      capability: CAPABILITY,
      failure_reason: ResourceFailureReason.DeadlineExceeded,
    });
});

test("synchronous throws, rejections and invalid statuses become unknown without losing entries", async (t) => {
  const f = fixture(t, [
    {
      owner: OWNER_LLM,
      entry: entry("throws", {
        check: () => {
          throw CHECK_ERROR;
        },
      }),
    },
    {
      owner: OWNER_LLM,
      entry: entry("rejects", {
        check: async () => {
          throw CHECK_ERROR;
        },
      }),
    },
    {
      owner: OWNER_LLM,
      entry: entry("invalid", {
        check: async () => "invalid" as ResourceStatusValue,
      }),
    },
  ]);
  const report = await f.report();
  assert.deepEqual(Object.keys(report.shared.llm.global), [
    "throws",
    "rejects",
    "invalid",
  ]);
  for (const value of Object.values(report.shared.llm.global))
    assert.deepEqual(value, {
      status: ResourceStatus.Unknown,
      capability: CAPABILITY,
      failure_reason: ResourceFailureReason.Unclassified,
    });
  assert.doesNotMatch(JSON.stringify(report), /secret|endpoint/);
});

test("scheduler concurrency is bounded across owners and releases every completed context", async (t) => {
  let active = 0;
  let maximum = 0;
  const contexts: Context[] = [];
  const f = fixture(
    t,
    Array.from({ length: TARGET_COUNT }, (_, index) => ({
      owner: OWNERS[index % OWNERS.length]!,
      entry: entry(`target-${index}`, {
        check: async (context) => {
          contexts.push(context);
          active++;
          maximum = Math.max(maximum, active);
          await delay(5);
          active--;
          return ResourceStatus.Healthy;
        },
      }),
    })),
  );
  await f.report();
  assert.equal(maximum, EXPECTED_MAX);
  assert.equal(active, EMPTY_COUNT);
  assert.equal(contexts.length, TARGET_COUNT);
  assert.ok(contexts.every((context) => context.signal.reason));
  assert.equal(f.logs.length, TARGET_COUNT);
});

test("report budget abandons active and unstarted targets, cancels contexts and ignores late settlements", async (t) => {
  const contexts: Context[] = [];
  const late = Promise.withResolvers<ResourceStatusValue>();
  const f = fixture(
    t,
    Array.from({ length: TARGET_COUNT }, (_, index) => ({
      owner: OWNER_LLM,
      entry: entry(`target-${index}`, {
        check: (context) => {
          contexts.push(context);
          return late.promise;
        },
      }),
    })),
  );
  t.mock.timers.enable({ apis: ["setTimeout", "Date"] });
  let settled = false;
  const pending = f
    .report({ ...LIMITS, reportBudgetMs: REPORT_BUDGET_MS })
    .finally(() => {
      settled = true;
    });
  while (contexts.length < EXPECTED_MAX)
    await turn(undefined, { signal: t.signal });
  assert.equal(contexts.length, EXPECTED_MAX);
  t.mock.timers.tick(REPORT_BUDGET_MS - ONE_MS);
  await turn();
  assert.equal(settled, false);
  assert.ok(contexts.every((context) => !context.signal.aborted));
  t.mock.timers.tick(ONE_MS);
  const report = await pending;
  assert.equal(contexts.length, EXPECTED_MAX);
  assert.ok(contexts.every((context) => context.signal.reason));
  assert.equal(Object.keys(report.shared.llm.global).length, TARGET_COUNT);
  assert.ok(
    Object.values(report.shared.llm.global).every(
      ({ status, failure_reason }) =>
        status === ResourceStatus.Unknown &&
        failure_reason === ResourceFailureReason.DeadlineExceeded,
    ),
  );
  assert.equal(f.logs.length, TARGET_COUNT);
  const answer = structuredClone(report);
  late.resolve(ResourceStatus.Healthy);
  await turn();
  assert.deepEqual(report, answer);
  assert.equal(f.logs.length, TARGET_COUNT);
});

test("report budget includes inventory collection time and never starts expired work", async (t) => {
  const f = fixture(t);
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let checks = 0;
  const report = await resourceHealthReport(
    f.caller,
    () => {
      now += REPORT_BUDGET_MS;
      return {
        entries: [
          {
            owner: OWNER_LLM,
            entry: entry("queued", {
              check: async () => {
                checks++;
                return ResourceStatus.Healthy;
              },
            }),
          },
        ],
        missing_inventories: [],
      };
    },
    f.logger,
    { ...LIMITS, reportBudgetMs: REPORT_BUDGET_MS },
  );
  assert.equal(checks, EMPTY_COUNT);
  assert.deepEqual(report.shared.llm.global.queued, {
    status: ResourceStatus.Unknown,
    capability: CAPABILITY,
    failure_reason: ResourceFailureReason.DeadlineExceeded,
  });
  assert.equal(f.commits(), SINGLE_CHECK);
});

test("checks scheduled before the report moment do not start after it", async (t) => {
  let now = Date.now();
  t.mock.method(Date, "now", () => now);
  let checks = 0;
  const f = fixture(
    t,
    Array.from({ length: TARGET_COUNT }, (_, index) => ({
      owner: OWNER_LLM,
      entry: entry(`target-${index}`, {
        check: async () => {
          checks++;
          now += REPORT_BUDGET_MS;
          return ResourceStatus.Healthy;
        },
      }),
    })),
  );
  const report = await f.report({
    ...LIMITS,
    reportBudgetMs: REPORT_BUDGET_MS,
  });
  assert.equal(checks, SINGLE_CHECK);
  assert.ok(
    Object.values(report.shared.llm.global).every(
      ({ status, failure_reason }) =>
        status === ResourceStatus.Unknown &&
        failure_reason === ResourceFailureReason.DeadlineExceeded,
    ),
  );
});

test("caller cancellation cancels active checks, stops dispatch and never commits a report", async (t) => {
  const contexts: Context[] = [];
  const started = Promise.withResolvers<void>();
  const f = fixture(
    t,
    Array.from({ length: TARGET_COUNT }, (_, index) => ({
      owner: OWNER_WORKER,
      entry: entry(`target-${index}`, {
        check: (context) => {
          contexts.push(context);
          if (contexts.length === EXPECTED_MAX) started.resolve();
          return new Promise(() => {});
        },
      }),
    })),
  );
  const pending = f.report();
  await started.promise;
  f.context.cancel();
  await assert.rejects(pending, (error) => error === f.context.signal.reason);
  assert.equal(contexts.length, EXPECTED_MAX);
  assert.ok(contexts.every((context) => context.signal.reason));
  assert.equal(f.commits(), EMPTY_COUNT);
});

test("collector transaction failures propagate unchanged and missing inventories never start checks or commit", async (t) => {
  const f = fixture(t);
  await assert.rejects(
    resourceHealthReport(
      f.caller,
      () => {
        throw CHECK_ERROR;
      },
      f.logger,
      LIMITS,
    ),
    (error) => error === CHECK_ERROR,
  );
  await assert.rejects(
    resourceHealthReport(
      f.caller,
      () => ({ entries: [], missing_inventories: [OWNER_PROJECT] }),
      f.logger,
      LIMITS,
    ),
    {
      code: "gateway.healthcheck.inventory_failed",
      details: { missing_inventories: [OWNER_PROJECT] },
    },
  );
  assert.equal(f.commits(), EMPTY_COUNT);
  assert.equal(f.logs.length, EMPTY_COUNT);
});
