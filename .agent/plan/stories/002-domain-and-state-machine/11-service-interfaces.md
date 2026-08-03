# Story 11 — Service interfaces

Epic: `.agent/plan/epics/002-domain-and-state-machine.md`
Depends on: Story 01 (`services/ids`, `services/clock`), Story 03 (`src/domain/state.ts`), Story 04 (`src/domain/agent.ts`, `src/domain/worker.ts`).

Eleven capabilities. `config` exists from EPIC 001 (`src/services/config/index.ts`). `ids` and `clock` come from Story 01. This story creates the remaining eight interfaces, and a throwing implementation for the three that phase 2 fills.

## Change

Every file follows the existing interface convention of `src/services/config/index.ts:1-46`: `Readonly<{ ... }>` data types, a string-literal-union `<X>ErrorCode`, a concrete `<X>Error extends Error` setting `this.name` and a `readonly code`, then the capability interface.

### 1. `src/services/storage/index.ts` (new)

```ts
export interface Transaction {
  run(sql: string, parameters?: readonly unknown[]): void;
  get(sql: string, parameters?: readonly unknown[]): unknown;
  all(sql: string, parameters?: readonly unknown[]): readonly unknown[];
}

export type AppliedMigration = Readonly<{
  version: number;
  name: string;
  appliedAt: number;
}>;

export type PendingMigration = Readonly<{ version: number; name: string }>;

export type MigrationStatus = Readonly<{
  applied: readonly AppliedMigration[];
  pending: readonly PendingMigration[];
}>;

export type StorageErrorCode =
  "storage-migration-failed" | "storage-transaction-failed";

export class StorageError extends Error {
  /* code */
}

export interface Storage {
  transact<T>(work: (transaction: Transaction) => T): T;
  migrate(): MigrationStatus;
  status(): MigrationStatus;
  close(): void;
}
```

`transact` opens one transaction, passes the context to `work`, commits on return and rolls back on a throw. `docs/proposal/database/README.md:45`: "One command is one transaction."

### 2. `src/services/crypto/index.ts` (new)

```ts
export type SealedPayload = Readonly<{
  ciphertext: Uint8Array;
  iv: Uint8Array;
  tag: Uint8Array;
  keyVersion: number;
}>;

export type CryptoErrorCode =
  "crypto-key-missing" | "crypto-authentication-failed";

export class CryptoError extends Error {
  /* code */
}

export interface Crypto {
  seal(plaintext: string): SealedPayload;
  open(sealed: SealedPayload): string;
}
```

The four fields are the four `provider` columns of `docs/proposal/database/provider.md:5-19`. `open` on a tampered ciphertext throws `CryptoError("crypto-authentication-failed", ...)` per `docs/proposal/phase-2/README.md:51`.

### 3. `src/services/git/index.ts` (new)

```ts
export type GitAuth = Readonly<{ username: string; password: string }>;

export type SeedHomeInput = Readonly<{
  gitDir: string;
  remoteUrl: string;
  upstreamBranch: string;
  landingBranch: string;
  auth: GitAuth;
}>;

export type RemoteInfo = Readonly<{
  defaultBranch: string | null;
  branches: readonly string[];
}>;

export type RefUpdateInput = Readonly<{
  gitDir: string;
  ref: string;
  expectedOid: string | null;
  nextOid: string;
}>;

export type RefUpdateResult =
  | Readonly<{ updated: true; oid: string }>
  | Readonly<{ updated: false; observedOid: string | null }>;

export type CloneInput = Readonly<{
  sourceGitDir: string;
  targetDir: string;
  ref: string;
}>;

export type GitErrorCode =
  "git-auth-failed" | "git-url-refused" | "git-lock-held" | "git-ref-missing";

export class GitError extends Error {
  /* code */
}

export interface Git {
  seedHome(input: SeedHomeInput): Promise<void>;
  remoteInfo(
    input: Readonly<{ remoteUrl: string; auth: GitAuth }>,
  ): Promise<RemoteInfo>;
  canPush(
    input: Readonly<{ remoteUrl: string; auth: GitAuth }>,
  ): Promise<boolean>;
  fetch(input: Readonly<{ gitDir: string; auth: GitAuth }>): Promise<void>;
  resolveRef(input: Readonly<{ gitDir: string; ref: string }>): Promise<string>;
  refUpdate(input: RefUpdateInput): Promise<RefUpdateResult>;
  clone(input: CloneInput): Promise<string>;
}
```

`expectedOid: null` means "the ref must not exist" (`docs/proposal/phase-1/git-foundation.md:124`). A mismatch returns `{ updated: false, observedOid }` rather than throwing (`docs/proposal/phase-1/git-foundation.md:112`); `observedOid` is `null` when the ref does not exist.

`clone` returns the absolute path of the created working directory — the same value as `input.targetDir` after resolution. `resolveRef` returns the object id the ref points at, and throws `GitError("git-ref-missing", ...)` when the ref does not exist. `remoteInfo.defaultBranch` is the branch the remote `HEAD` symref names, and `null` when the remote reports none (`docs/proposal/phase-1/git-foundation.md:40`).

### 4. `src/services/graph/index.ts` (new)

```ts
export type GraphNodeInput = Readonly<{ id: string; parentId: string | null }>;

export type GraphEdgeInput = Readonly<{ from: string; to: string }>;

export type GraphInput = Readonly<{
  nodes: readonly GraphNodeInput[];
  edges: readonly GraphEdgeInput[];
}>;

export type GraphErrorCode = "graph-cycle" | "graph-unknown-node";

export class GraphError extends Error {
  /* code */
}

export interface Graph {
  topologicalOrder(input: GraphInput): readonly string[];
  cycles(input: GraphInput): readonly (readonly string[])[];
  children(input: GraphInput, parentId: string | null): readonly string[];
}
```

Every return is ordered, so an implementation cannot leak the iteration order of a vendor structure:

- `topologicalOrder` breaks a tie by the lexicographically smallest id, the same rule as `src/domain/task-order.ts`, and throws `GraphError("graph-cycle", ...)` on a cycle.
- each cycle in `cycles` starts at its lexicographically smallest member, and the outer array is sorted by that member.
- `children` is sorted lexicographically by id.
- an edge endpoint that is not a member of `input.nodes` throws `GraphError("graph-unknown-node", ...)` in all three operations.

### 5. `src/services/event/index.ts` (new)

```ts
import type { Transaction } from "../storage/index.ts";

export type ActorKind = "human" | "daemon";

export type AppendEventInput = Readonly<{
  subjectKind: string;
  subjectId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: unknown;
}>;

export type RecordedEvent = Readonly<{
  id: string;
  subjectKind: string;
  subjectId: string;
  type: string;
  actorKind: ActorKind;
  actorId: string;
  payload: unknown;
  occurredAt: number;
}>;

export type EventFilter = Readonly<{
  subjectKind?: string;
  subject?: string;
  type?: string;
  actorKind?: ActorKind;
  actor?: string;
  after?: string;
  limit?: number;
}>;

export type EventErrorCode = "event-append-failed";

export class EventError extends Error {
  /* code */
}

export interface EventLog {
  append(transaction: Transaction, input: AppendEventInput): RecordedEvent;
  list(filter: EventFilter): readonly RecordedEvent[];
}
```

`append` takes the transaction context, because `docs/proposal/database/event.md:17` puts the state row and the event in one transaction. `occurredAt` is the timestamp decoded from the event ULID (`docs/proposal/api/event.md:20`). `after` is the last id a client saw (`docs/proposal/database/event.md:19`). The interface is `EventLog`, not `Event`, because `Event` is a global type name.

### 6. `src/services/agent/index.ts` and `src/services/agent/not-implemented.ts` (new)

```ts
import type { AgentKind } from "../../domain/agent.ts";

export type AgentRequest = Readonly<{
  agent: AgentKind;
  prompt: string;
  workspacePath: string;
  timeoutMs: number;
}>;

export type AgentVerdict = "accept" | "reject";

export type AgentResult = Readonly<{
  verdict: AgentVerdict | null;
  diff: string | null;
  reason: string | null;
  toolTrace: string | null;
  usage: unknown;
  adapterVersion: string;
}>;

export type AgentErrorCode = "not-implemented" | "agent-timeout";

export class AgentError extends Error {
  /* code */
}

export interface Agent {
  invoke(request: AgentRequest): Promise<AgentResult>;
}
```

```ts
export class NotImplementedAgent implements Agent {
  invoke(): Promise<AgentResult> {
    throw new AgentError(
      "not-implemented",
      "the agent service is implemented in phase 2",
    );
  }
}
```

The three result fields `verdict`, `diff` and `reason` are the `agent_invocation` columns of `docs/proposal/database/agent_invocation.md:5-22`.

### 7. `src/services/verify/index.ts` and `src/services/verify/not-implemented.ts` (new)

```ts
export type CheckOutcome =
  "passed" | "failed" | "error" | "timed-out" | "cancelled" | "not-applicable";

export type CheckRequest = Readonly<{
  checkName: string;
  command: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
  timeoutMs: number;
  outputLimitBytes: number;
}>;

export type CheckOutput = Readonly<{
  result: CheckOutcome;
  exitCode: number | null;
  output: string;
  envIdentity: string;
  toolchainVersion: string;
  endedAt: number;
}>;

export type VerifyErrorCode = "not-implemented";

export class VerifyError extends Error {
  /* code */
}

export interface Verify {
  run(request: CheckRequest): Promise<CheckOutput>;
}
```

```ts
export class NotImplementedVerify implements Verify {
  run(): Promise<CheckOutput> {
    throw new VerifyError(
      "not-implemented",
      "the verify service is implemented in phase 2",
    );
  }
}
```

`CheckOutcome` omits `"running"`, which the `check_result` row carries while the check is in flight; `run` resolves after the check ends. The request fields are the operational limits of `docs/proposal/phase-2/gates-and-approval.md:46-52`.

### 8. `src/services/lease/index.ts` and `src/services/lease/not-implemented.ts` (new)

```ts
import type { Transaction } from "../storage/index.ts";

export type LeaseSubjectKind = "node" | "repository";

export type LeaseRecord = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string | null;
  fence: number;
  acquiredAt: number | null;
  renewedAt: number | null;
  expiresAt: number | null;
}>;

export type AcquireLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  ttlMs: number;
}>;

export type RenewLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  owner: string;
  fence: number;
  ttlMs: number;
}>;

export type ReleaseLeaseInput = Readonly<{
  subjectKind: LeaseSubjectKind;
  subjectId: string;
  fence: number;
}>;

export type LeaseErrorCode = "not-implemented" | "lease-held" | "lease-fenced";

export class LeaseError extends Error {
  /* code */
}

export interface Lease {
  acquire(transaction: Transaction, input: AcquireLeaseInput): LeaseRecord;
  renew(transaction: Transaction, input: RenewLeaseInput): LeaseRecord;
  release(transaction: Transaction, input: ReleaseLeaseInput): void;
  expired(transaction: Transaction, now: number): readonly LeaseRecord[];
}
```

```ts
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
```

`release` sets `owner` to null and keeps the row, per `docs/proposal/database/lease.md:26,36`. `fence` never resets, per `docs/proposal/database/lease.md:22`.

### 9. `src/domain/layout.test.ts` — extend the capability inventory

Story 01 creates this file. Add the service-inventory assertions listed under **Verify**.

## Constraints

- An interface file declares types and one interface. No implementation, and no re-export of one. `src/services/config/index.ts` is the model.
- `src/services/event/index.ts` and `src/services/lease/index.ts` import `Transaction` from `../storage/index.ts`. `AGENTS.md:39` permits a service interface to import any service interface, `eslint.config.js:105-113` enforces that it reaches only the other capability's `index.ts`, and the AGENTS.md transaction rule requires it: "every service that persists inside that write accepts the context through its interface".
- No file in this story imports `node:sqlite`, `isomorphic-git`, `graphology` or `pi-coding-agent`. The interface names the capability, not the vendor.
- `not-implemented.ts` is named after the behaviour, not a vendor, because there is no vendor. It is the one implementation file in each of those three capabilities.
- Create no `src/commands/`, `src/queries/`, `src/http/` or `src/cli/` file. Those are EPICs 004 and later.
- Do not modify `src/services/config/index.ts` or `src/main.ts`.

## Verify

`node --test src/services/agent/not-implemented.test.ts` — suite `"src/services/agent/not-implemented.test"`:

- `new NotImplementedAgent().invoke(request)` throws synchronously, `error instanceof AgentError`, `error.code === "not-implemented"`, `error.name === "AgentError"`, and `error.message === "the agent service is implemented in phase 2"`.

`node --test src/services/verify/not-implemented.test.ts` — suite `"src/services/verify/not-implemented.test"`:

- `new NotImplementedVerify().run(request)` throws with `code === "not-implemented"` and `name === "VerifyError"`.

`node --test src/services/lease/not-implemented.test.ts` — suite `"src/services/lease/not-implemented.test"`:

- Each of `acquire`, `renew`, `release` and `expired` throws with `code === "not-implemented"` and `name === "LeaseError"`. A loop over the four method names drives it.

`node --test src/domain/layout.test.ts` — the extended file:

- Read `src/services/` with `fs.readdirSync(..., { withFileTypes: true })`. The sorted list of directory names deep-equals the literal `["agent", "clock", "config", "crypto", "event", "git", "graph", "home-lock", "ids", "lease", "storage", "verify"]` — the eleven capabilities of the epic plus `home-lock` from EPIC 001.
- Every one of those directories holds an `index.ts`.
- For each of `agent`, `verify` and `lease`, the directory holds a `not-implemented.ts`.
- Read every `src/services/*/index.ts` as text and assert none contains `"implements "` — an interface file holds no implementation.
- Using `lintCase` from `test/helpers/lint.ts`: a case at `filePath: "src/services/event/index.ts"` with code `import type { Transaction } from "../storage/index.ts";` returns a rule list not containing `"boundaries/dependencies"`.
- Using `lintCase`: a case at `filePath: "src/services/event/sqlite.ts"` with code `import { SqliteStorage } from "../storage/sqlite.ts";` returns a rule list containing `"boundaries/dependencies"` — one capability's implementation may not import another's.

The rule id is `boundaries/dependencies`. `eslint.config.js:69` and `:264` are the two places it is configured, and `eslint-plugin-boundaries@7.0.2` exposes no rule named `element-types` in this configuration. A test that asserts the wrong id proves nothing on the allow case and fails on the deny case.

`npx tsc --noEmit` exits 0, which is the type-level proof that each `NotImplemented*` class satisfies its interface.

`npm run verify` exits 0.

Proof: contributes `src/domain/layout.test.ts` to `node --test src/domain/**/*.test.ts`; the service tests are covered by `npm run verify`.
