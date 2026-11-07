import type { HeldCopy } from "../custody/contract.ts";
import { ResourceFailureReason, ResourceStatus } from "../kernel/health.ts";
import type { CopyHealth, CopyReportBody } from "./contract.ts";
import { CAPABILITY_NONE, isLlmPlatform, LLM_PLATFORMS } from "./platforms.ts";

const VERSION_STEP = 1;

type CopyReport = CopyReportBody & {
  reported_at: number;
  reported_by: string;
};

export function unreportedHealth(platform: string): CopyHealth {
  return {
    status: ResourceStatus.Unknown,
    capability: isLlmPlatform(platform)
      ? LLM_PLATFORMS[platform].capability
      : CAPABILITY_NONE,
    failure_reason: ResourceFailureReason.HeldByInstance,
    models: null,
    reported_at: null,
    reported_by: null,
  };
}

export class CopyHealthBook {
  private readonly versions = new Map<string, number>();
  private readonly reports = new Map<string, Map<string, CopyReport>>();
  private readonly startVersion: number;
  private readonly machineOf: (instance: string) => string | null;

  constructor(
    startedAt: number,
    machineOf: (instance: string) => string | null,
  ) {
    this.startVersion = startedAt;
    this.machineOf = machineOf;
  }

  raise(holder: string): void {
    this.versions.set(holder, this.counterOf(holder) + VERSION_STEP);
  }

  versionOf(instance: string): number {
    const machine = this.machineOf(instance);
    return (
      this.counterOf(instance) +
      (machine === null ? 0 : this.counterOf(machine))
    );
  }

  private counterOf(holder: string): number {
    return this.versions.get(holder) ?? this.startVersion;
  }

  record(
    holder: string,
    name: string,
    report: CopyReportBody,
    reportedAt: number,
    reportedBy: string,
  ): void {
    const reports = this.reports.get(holder) ?? new Map<string, CopyReport>();
    reports.set(name, {
      ...report,
      reported_at: reportedAt,
      reported_by: reportedBy,
    });
    this.reports.set(holder, reports);
  }

  healthOf(holder: string, copy: HeldCopy): CopyHealth {
    const report = this.reports.get(holder)?.get(copy.name);
    if (!copy.sealed_current || report?.revision !== copy.revision)
      return unreportedHealth(copy.platform);
    return {
      status: report.status,
      capability: report.capability,
      failure_reason: report.failure_reason,
      models: report.models,
      reported_at: report.reported_at,
      reported_by: report.reported_by,
    };
  }
}
