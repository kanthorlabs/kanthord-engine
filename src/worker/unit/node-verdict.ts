import type { Finding } from "../../mission/contract.ts";

export interface JudgedCommit {
  binding_id: string;
  commit: string;
}

export const VerdictSource = {
  FailedChecks: "failed_checks",
  Rework: "rework",
} as const;
export type VerdictSource = (typeof VerdictSource)[keyof typeof VerdictSource];

export interface Verdict {
  source: VerdictSource;
  text: string;
  judged: JudgedCommit[];
  findings: Finding[];
  round: number | null;
  linkUpdates?: number;
}

export interface Prior {
  verdict: Verdict | null;
  cleared: string | null;
}
