import type { ProbeOutcome } from "./index.ts";

export type RawOutcome =
  | { kind: "success" }
  | { kind: "abort" }
  | { kind: "http-auth"; status: number }
  | { kind: "http-not-found"; status: number }
  | { kind: "http-quota"; status: number }
  | { kind: "http-other"; status: number }
  | { kind: "transport-error" };

type VerdictWithoutModel = Omit<ProbeOutcome, "model">;

export function toVerdict(raw: RawOutcome): VerdictWithoutModel {
  switch (raw.kind) {
    case "success":
      return {
        reachability: "reachable",
        authentication: "accepted",
        completed: true,
        refusal: null,
      };
    case "abort":
      return {
        reachability: "unreachable",
        authentication: "unknown",
        completed: false,
        refusal: "endpoint-unreachable",
        detail: "timeout-or-abort",
      };
    case "http-auth":
      return {
        reachability: "reachable",
        authentication: "rejected",
        completed: false,
        refusal: "credential-rejected",
        detail: `HTTP ${raw.status}`,
      };
    case "http-not-found":
      return {
        reachability: "reachable",
        authentication: "accepted",
        completed: false,
        refusal: "model-unavailable",
        detail: `HTTP ${raw.status}`,
      };
    case "http-quota":
      return {
        reachability: "reachable",
        authentication: "accepted",
        completed: false,
        refusal: "quota-exceeded",
        detail: `HTTP ${raw.status}`,
      };
    case "http-other":
      return {
        reachability: "reachable",
        authentication: "unknown",
        completed: false,
        refusal: "endpoint-rejected",
        detail: `HTTP ${raw.status}`,
      };
    case "transport-error":
      return {
        reachability: "unreachable",
        authentication: "unknown",
        completed: false,
        refusal: "endpoint-unreachable",
        detail: "transport-error",
      };
  }
}
