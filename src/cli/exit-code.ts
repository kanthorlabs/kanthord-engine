import type { ErrorCode } from "../http/contract/errors.ts";
import { errorStatuses } from "../http/contract/errors.ts";

export const LOCAL_REFUSAL = 1;
export const TRANSPORT_FAILURE = 2;
export const TRANSPORT_FAILURE_CODE = "transport-failure";
export const INDETERMINATE_OUTCOME = 3;
export const INDETERMINATE_OUTCOME_CODE = "outcome-indeterminate";
export const ENVELOPE_UNREADABLE_CODE = "envelope-unreadable";
export const REFUSED_BY_DAEMON = 100;
export const DAEMON_FAULT = 200;

export const exitCodes: Readonly<Record<ErrorCode, number>> = {
  "invalid-request": 110,
  unauthenticated: 120,
  "origin-forbidden": 130,
  "host-forbidden": 131,
  "actor-forbidden": 132,
  "not-found": 140,
  "stale-revision": 150,
  "illegal-transition": 151,
  "binding-in-use": 152,
  "needs-reconcile": 153,
  "acknowledgement-required": 154,
  "lease-held": 155,
  "idempotency-mismatch": 156,
  "choices-stale": 157,
  "choices-changed": 158,
  "host-key-mismatch": 159,
  "plan-invalid": 160,
  "choices-invalid": 161,
  "identity-kind-mismatch": 162,
  "credential-rejected": 163,
  "pair-illegal": 164,
  "assignment-held": 165,
  unroutable: 166,
  "review-head-unavailable": 167,
  "objective-busy": 168,
  "subtree-busy": 169,
  "internal-error": 210,
  "not-implemented": 220,
  "service-unavailable": 230,
};

export function exitCodeForError(code: string, status: number): number {
  if (code === TRANSPORT_FAILURE_CODE) {
    return TRANSPORT_FAILURE;
  }
  if (code === INDETERMINATE_OUTCOME_CODE) {
    return INDETERMINATE_OUTCOME;
  }
  if (Object.hasOwn(exitCodes, code)) {
    return exitCodes[code as ErrorCode];
  }
  if (status >= 400 && status <= 499) {
    return REFUSED_BY_DAEMON;
  }
  if (status >= 500 && status <= 599) {
    return DAEMON_FAULT;
  }
  return LOCAL_REFUSAL;
}

export function envelopeCodeForStatus(status: number): string {
  const declared = (Object.keys(errorStatuses) as readonly ErrorCode[]).filter(
    (code) => errorStatuses[code] === status,
  );
  return declared.length === 1 ? declared[0]! : ENVELOPE_UNREADABLE_CODE;
}
