import {
  LeaseError,
  type AcquireLeaseResult,
  type Lease,
  type LeaseRecord,
  type LeaseSubject,
} from "./index.ts";

export class NotImplementedLease implements Lease {
  acquire(): AcquireLeaseResult {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
  renew(): LeaseRecord {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
  release(): void {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
  expired(): readonly LeaseRecord[] {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
  expireLeasesOfOwner(): readonly LeaseSubject[] {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
  read(): LeaseRecord | null {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
  assertHeld(): void {
    throw new LeaseError(
      "not-implemented",
      "the lease service is implemented in phase 2",
    );
  }
}
