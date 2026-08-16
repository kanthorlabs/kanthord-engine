import type {
  LeasesStep,
  ReapStep,
  RecoveryReport,
  ReconcileStep,
  SweepStep,
} from "../../domain/recovery.ts";

export type RecoverHomeDependencies = Readonly<{
  reap: ReapStep;
  sweep: SweepStep;
  reconcile: ReconcileStep;
  leases: LeasesStep;
}>;

export async function recoverHome(
  dependencies: RecoverHomeDependencies,
): Promise<RecoveryReport> {
  const reap = await dependencies.reap();
  const sweep = await dependencies.sweep(reap);
  const reconcile = await dependencies.reconcile();
  const leases = await dependencies.leases();
  return {
    reaped: reap.children.length,
    removed: sweep.removed,
    completed: reconcile.completed,
    discarded: reconcile.discarded,
    leftOpen: reconcile.leftOpen,
    refusesNewWork: reconcile.refusesNewWork,
    returnedToReady: leases.returnedToReady,
    objectivesFreed: leases.objectivesFreed,
    blocked: leases.blocked,
    findings: [
      ...reap.findings,
      ...sweep.findings,
      ...reconcile.findings,
      ...leases.findings,
    ],
  };
}
