import { LeaseError, type Lease, type LeaseRecord } from "./index.ts";

export class NotImplementedLease implements Lease {
  acquire(): LeaseRecord {
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
}
