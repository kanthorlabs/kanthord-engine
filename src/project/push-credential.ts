import type {
  CredentialPlatformSet,
  CredentialRecords,
} from "../custody/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import type { Transaction } from "../kernel/store.ts";
import {
  Platform,
  REPOSITORY_PLATFORMS,
} from "../repository/credential-platform.ts";

const NO_LIVE_REVISION = 0;
const SSH_PLATFORM_SET: CredentialPlatformSet = {
  platforms: { [Platform.Ssh]: REPOSITORY_PLATFORMS[Platform.Ssh] },
};

export function newestLiveSshRevision(
  records: Pick<CredentialRecords, "get">,
  tx: Transaction,
  credential: string,
): number {
  let answer: ReturnType<CredentialRecords["get"]>;
  try {
    answer = records.get(tx, SSH_PLATFORM_SET, credential);
  } catch (error) {
    if (error instanceof OperationError && error.status === HttpStatus.NotFound)
      return NO_LIVE_REVISION;
    throw error;
  }
  return answer.revisions
    .filter(({ ended_at: endedAt }) => endedAt === null)
    .reduce(
      (newest, { revision }) => Math.max(newest, revision),
      NO_LIVE_REVISION,
    );
}
