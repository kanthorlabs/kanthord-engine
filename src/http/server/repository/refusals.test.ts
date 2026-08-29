import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { toHttpError } from "./refusals.ts";
import { RegisterRepositoryError } from "../../../commands/repository/register-repository.ts";
import type { RegisterRepositoryRefusal } from "../../../commands/repository/register-repository.ts";
import {
  GitError,
  InspectRepositoryError,
} from "../../../queries/repository/inspect-repository.ts";
import type { InspectRefusal } from "../../../queries/repository/inspect-repository.ts";
import type { GitFailure } from "../../../services/git/index.ts";
import {
  credentialRejectedDetails,
  hostKeyMismatchDetails,
  invalidRequestDetails,
} from "../../contract/error-details.ts";
import { baselineErrors } from "../../contract/error-baseline.ts";
import { findOperation } from "../../contract/registry.ts";

// "outside-writer" is excluded on purpose: nothing constructs it (Story 05 step 3
// of the epic's contract-schemas plan), and its shape contradicts the ratified
// {expected, current} stale-revision payload. It stays a dead branch.
const everyReachableRegisterRefusal: Readonly<
  Record<Exclude<RegisterRepositoryRefusal, "outside-writer">, true>
> = {
  "name-taken": true,
  "credential-not-found": true,
  "credential-wrong-kind": true,
  "credential-unreadable": true,
  "host-fingerprint-required": true,
  "host-fingerprint-forbidden": true,
  "host-key-mismatch": true,
  "host-key-unavailable": true,
};

const everyGitFailure: Readonly<Record<GitFailure, true>> = {
  "auth-failed": true,
  "permission-denied": true,
  "transport-failed": true,
  "host-key-mismatch": true,
  "host-key-unavailable": true,
  "url-refused": true,
  "lock-held": true,
  "timed-out": true,
  "output-exceeded": true,
  unknown: true,
  "empty-remote": true,
};

const everyInspectRefusal: Readonly<Record<InspectRefusal, true>> = {
  "credential-not-found": true,
  "credential-wrong-kind": true,
  "credential-unreadable": true,
  "host-key-unavailable": true,
};

describe("src/http/server/repository/refusals.test", () => {
  it("RegisterRepositoryError host-key-mismatch details satisfy hostKeyMismatchDetails", () => {
    const error = toHttpError(
      new RegisterRepositoryError(
        "host-key-mismatch",
        "the host key does not match",
        { presented: ["SHA256:aaaa"], confirmed: null },
      ),
    );
    assert.equal(error.code, "host-key-mismatch");
    assert.doesNotThrow(() => hostKeyMismatchDetails.parse(error.details));
  });

  it("GitError host-key-mismatch details satisfy hostKeyMismatchDetails", () => {
    const error = toHttpError(
      new GitError("host-key-mismatch", "the host key does not match"),
    );
    assert.equal(error.code, "host-key-mismatch");
    assert.doesNotThrow(() => hostKeyMismatchDetails.parse(error.details));
  });

  it("GitError auth-failed and permission-denied satisfy credentialRejectedDetails", () => {
    for (const failure of ["auth-failed", "permission-denied"] as const) {
      const error = toHttpError(new GitError(failure, "the remote refused"));
      assert.equal(error.code, "credential-rejected");
      assert.doesNotThrow(() => credentialRejectedDetails.parse(error.details));
    }
  });

  it("RegisterRepositoryError name-taken satisfies invalidRequestDetails", () => {
    const error = toHttpError(
      new RegisterRepositoryError("name-taken", "the name is already taken"),
    );
    assert.equal(error.code, "invalid-request");
    assert.doesNotThrow(() => invalidRequestDetails.parse(error.details));
  });

  it("the codes toHttpError can emit beyond the baseline equal repository.inspect and repository.register's declared additions", () => {
    const baselineCodes = new Set(Object.keys(baselineErrors));
    const collected = new Set<string>();

    for (const refusal of Object.keys(everyReachableRegisterRefusal) as Exclude<
      RegisterRepositoryRefusal,
      "outside-writer"
    >[]) {
      try {
        collected.add(
          toHttpError(new RegisterRepositoryError(refusal, "x")).code,
        );
      } catch {}
    }
    for (const failure of Object.keys(everyGitFailure) as GitFailure[]) {
      try {
        collected.add(toHttpError(new GitError(failure, "x")).code);
      } catch {}
    }
    for (const refusal of Object.keys(
      everyInspectRefusal,
    ) as InspectRefusal[]) {
      try {
        collected.add(
          toHttpError(new InspectRepositoryError(refusal, "x")).code,
        );
      } catch {}
    }

    const extras = [...collected]
      .filter((code) => !baselineCodes.has(code))
      .sort();

    for (const operationId of [
      "repository.inspect",
      "repository.register",
    ] as const) {
      const entry = findOperation(operationId);
      assert.ok(
        entry?.errors !== undefined,
        `${operationId} declares no errors`,
      );
      const declaredExtras = Object.keys(entry.errors)
        .filter((code) => !baselineCodes.has(code))
        .sort();
      assert.deepEqual(extras, declaredExtras, `${operationId} mismatch`);
    }
  });
});
