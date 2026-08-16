import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  RECOVERY_STEP_ORDER,
  type LeasesResultLike,
  type LeasesStep,
  type ReapReport,
  type ReapStep,
  type RecoveryFinding,
  type ReconcileResultLike,
  type ReconcileStep,
  type SweepRemnantsResultLike,
  type SweepStep,
} from "../../domain/recovery.ts";
import { recoverHome } from "./recover-home.ts";

type Recording = Readonly<{
  calls: readonly string[];
  receivedReap: ReapReport | null;
  steps: {
    reap: ReapStep;
    sweep: SweepStep;
    reconcile: ReconcileStep;
    leases: LeasesStep;
  };
}>;

type StepOverrides = Readonly<{
  reapReport?: ReapReport;
  sweepResult?: SweepRemnantsResultLike;
  reconcileResult?: ReconcileResultLike;
  leasesResult?: Readonly<Record<string, unknown>>;
  reapError?: unknown;
  reconcileError?: unknown;
  plainNames?: boolean;
}>;

function recordingSteps(overrides: StepOverrides = {}): Recording {
  const calls: string[] = [];
  const plainNames = overrides.plainNames === true;
  let receivedReap: ReapReport | null = null;
  const reapReport: ReapReport = overrides.reapReport ?? {
    children: [],
    findings: [],
  };

  const markStart = (name: string): void => {
    calls.push(plainNames ? name : `${name}:start`);
  };
  const markEnd = (name: string): void => {
    if (!plainNames) {
      calls.push(`${name}:end`);
    }
  };

  const steps = {
    reap:
      overrides.reapError !== undefined
        ? ((async () => {
            markStart("reap");
            throw overrides.reapError;
          }) as ReapStep)
        : ((async () => {
            markStart("reap");
            await new Promise((resolve) => setImmediate(resolve));
            markEnd("reap");
            return reapReport;
          }) as ReapStep),
    sweep: (async (reap: ReapReport) => {
      markStart("sweep");
      receivedReap = reap;
      await new Promise((resolve) => setImmediate(resolve));
      markEnd("sweep");
      return overrides.sweepResult ?? { removed: 0, findings: [] };
    }) as SweepStep,
    reconcile:
      overrides.reconcileError !== undefined
        ? ((async () => {
            markStart("reconcile");
            throw overrides.reconcileError;
          }) as ReconcileStep)
        : ((async () => {
            markStart("reconcile");
            await new Promise((resolve) => setImmediate(resolve));
            markEnd("reconcile");
            return (
              overrides.reconcileResult ?? {
                completed: 0,
                discarded: 0,
                leftOpen: 0,
                refusesNewWork: [],
                findings: [],
              }
            );
          }) as ReconcileStep),
    leases: (async () => {
      markStart("leases");
      await new Promise((resolve) => setImmediate(resolve));
      markEnd("leases");
      return {
        returnedToReady: 0,
        blocked: 0,
        objectivesFreed: 0,
        findings: [],
        ...overrides.leasesResult,
      } as LeasesResultLike;
    }) as LeasesStep,
  };

  return {
    calls,
    get receivedReap() {
      return receivedReap;
    },
    steps,
  };
}

function finding(
  step: RecoveryFinding["step"],
  detail: string,
): RecoveryFinding {
  return { step, code: `${step}-code`, repositoryId: null, detail };
}

describe("src/commands/startup/recover-home.test", () => {
  it("the steps run in RECOVERY_STEP_ORDER and the sweep receives the reap report by identity", async () => {
    const reapReport: ReapReport = { children: [], findings: [] };
    const recording = recordingSteps({ reapReport, plainNames: true });
    await recoverHome(recording.steps);
    assert.deepEqual(recording.calls, ["reap", "sweep", "reconcile", "leases"]);
    assert.deepEqual(recording.calls, [...RECOVERY_STEP_ORDER]);
    assert.equal(recording.receivedReap, reapReport);
  });

  it("each step resolves only after the previous one did", async () => {
    const recording = recordingSteps();
    await recoverHome(recording.steps);
    assert.deepEqual(recording.calls, [
      "reap:start",
      "reap:end",
      "sweep:start",
      "sweep:end",
      "reconcile:start",
      "reconcile:end",
      "leases:start",
      "leases:end",
    ]);
  });

  it("the report copies every counter and keeps refusesNewWork unsorted", async () => {
    const reapFinding = finding("reap", "reap-detail");
    const sweepFinding = finding("sweep", "sweep-detail");
    const reconcileFinding = finding("reconcile", "reconcile-detail");
    const leasesFinding = finding("leases", "leases-detail");
    const reapReport: ReapReport = {
      children: [
        {
          pidFile: "/run/a.pid",
          gitOperationId: null,
          repositoryId: "repo_a",
          finding: "stopped",
        },
        {
          pidFile: "/run/b.pid",
          gitOperationId: "gitop_01ARZ3NDEKTSV4RRFFQ69G5FAV",
          repositoryId: "repo_b",
          finding: "no-pid-file",
        },
      ],
      findings: [reapFinding],
    };
    const recording = recordingSteps({
      reapReport,
      sweepResult: { removed: 3, findings: [sweepFinding] },
      reconcileResult: {
        completed: 1,
        discarded: 2,
        leftOpen: 4,
        refusesNewWork: ["repo_b", "repo_a"],
        findings: [reconcileFinding],
      },
      leasesResult: {
        returnedToReady: 5,
        blocked: 6,
        objectivesFreed: 2,
        findings: [leasesFinding],
      },
    });
    const report = await recoverHome(recording.steps);
    assert.deepEqual(report, {
      reaped: 2,
      removed: 3,
      completed: 1,
      discarded: 2,
      leftOpen: 4,
      refusesNewWork: ["repo_b", "repo_a"],
      returnedToReady: 5,
      blocked: 6,
      objectivesFreed: 2,
      findings: [reapFinding, sweepFinding, reconcileFinding, leasesFinding],
    });
  });

  it("findings are the four lists concatenated in step order", async () => {
    const reapA = finding("reap", "reap-a");
    const reapB = finding("reap", "reap-b");
    const sweepA = finding("sweep", "sweep-a");
    const reconcileA = finding("reconcile", "reconcile-a");
    const leasesA = finding("leases", "leases-a");
    const recording = recordingSteps({
      reapReport: { children: [], findings: [reapA, reapB] },
      sweepResult: { removed: 0, findings: [sweepA] },
      reconcileResult: {
        completed: 0,
        discarded: 0,
        leftOpen: 0,
        refusesNewWork: [],
        findings: [reconcileA],
      },
      leasesResult: {
        returnedToReady: 0,
        blocked: 0,
        findings: [leasesA],
      },
    });
    const report = await recoverHome(recording.steps);
    assert.deepEqual(report.findings, [
      reapA,
      reapB,
      sweepA,
      reconcileA,
      leasesA,
    ]);
  });

  it("a rejection in the reap propagates and the sweep is never called", async () => {
    const recording = recordingSteps({ reapError: new Error("reap exploded") });
    await assert.rejects(recoverHome(recording.steps), /reap exploded/);
    assert.deepEqual(recording.calls, ["reap:start"]);
  });

  it("a rejection in the reconcile propagates and the leases step is never called", async () => {
    const recording = recordingSteps({
      reconcileError: new Error("reconcile exploded"),
    });
    await assert.rejects(recoverHome(recording.steps), /reconcile exploded/);
    assert.deepEqual(recording.calls, [
      "reap:start",
      "reap:end",
      "sweep:start",
      "sweep:end",
      "reconcile:start",
    ]);
  });
});
