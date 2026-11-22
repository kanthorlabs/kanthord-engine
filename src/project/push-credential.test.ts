import assert from "node:assert/strict";
import { test } from "node:test";
import type { CredentialRecords } from "../custody/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import { Platform } from "../repository/credential-platform.ts";
import { newestLiveSshRevision } from "./push-credential.ts";

const tx = {} as Transaction;
const NO_REVISION = 0;
const NEWEST_LIVE_REVISION = 3;

function records(
  get: CredentialRecords["get"],
): Pick<CredentialRecords, "get"> {
  return { get };
}

test("newestLiveSshRevision answers the newest live revision and reads the ssh platform set", () => {
  let platforms: string[] = [];
  const answer = newestLiveSshRevision(
    records((_tx, set) => {
      platforms = Object.keys(set.platforms);
      return {
        revisions: [
          { revision: 1, ended_at: 10 },
          { revision: 2, ended_at: null },
          { revision: NEWEST_LIVE_REVISION, ended_at: null },
          { revision: 4, ended_at: 20 },
        ],
      } as never;
    }),
    tx,
    "deploy",
  );
  assert.equal(answer, NEWEST_LIVE_REVISION);
  assert.deepEqual(platforms, [Platform.Ssh]);
});

test("newestLiveSshRevision answers 0 for a missing credential and rethrows another error", () => {
  const missing = records(() => {
    throw new OperationError(
      HttpStatus.NotFound,
      "custody.credential.not_found",
      "Absent.",
    );
  });
  assert.equal(newestLiveSshRevision(missing, tx, "deploy"), NO_REVISION);
  const broken = records(() => {
    throw new Error("boom");
  });
  assert.throws(() => newestLiveSshRevision(broken, tx, "deploy"), /boom/);
});
