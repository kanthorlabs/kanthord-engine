import type { HeldCopy } from "../custody/contract.ts";
import { ResourceFailureReason, ResourceStatus } from "../kernel/health.ts";
import {
  NO_CREDENTIAL_VERSION,
  type CopyHealth,
  type CopyReportBody,
} from "./contract.ts";
import { CAPABILITY_NONE, isLlmPlatform, LLM_PLATFORMS } from "./platforms.ts";

const VERSION_STEP = 1;

type CopyReport = CopyReportBody & { reported_at: number };

export function unreportedHealth(platform: string): CopyHealth {
  return {
    status: ResourceStatus.Unknown,
    capability: isLlmPlatform(platform)
      ? LLM_PLATFORMS[platform].capability
      : CAPABILITY_NONE,
    failure_reason: ResourceFailureReason.HeldByInstance,
    models: null,
    reported_at: null,
  };
}

export class CopyHealthBook {
  private readonly versions = new Map<string, number>();
  private readonly reports = new Map<string, Map<string, CopyReport>>();

  raise(holder: string): void {
    this.versions.set(holder, this.versionOf(holder) + VERSION_STEP);
  }

  versionOf(holder: string): number {
    return this.versions.get(holder) ?? NO_CREDENTIAL_VERSION;
  }

  record(
    holder: string,
    name: string,
    report: CopyReportBody,
    reportedAt: number,
  ): void {
    const reports = this.reports.get(holder) ?? new Map<string, CopyReport>();
    reports.set(name, { ...report, reported_at: reportedAt });
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
    };
  }
}
