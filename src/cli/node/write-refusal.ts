import type { CallResult } from "../client.ts";
import { planInvalidDetails } from "../../http/contract/error-details.ts";

type FailedCallResult = Extract<CallResult, { ok: false }>;

export function printNodeWriteRefusal(
  result: FailedCallResult,
  stderr: (text: string) => void,
): void {
  stderr(`kanthord: ${result.code}: ${result.message}\n`);
  if (result.code !== "plan-invalid") {
    return;
  }
  const details = planInvalidDetails.parse(result.details);
  for (const finding of details.findings) {
    stderr(
      `kanthord: plan-invalid: ${finding.code} ${finding.path ?? "-"} ${finding.message}\n`,
    );
  }
}
