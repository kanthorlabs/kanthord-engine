# Story 03 — The evidence bundle

Epic: `.agent/plan/epics/011-end-to-end-scenarios.md`
Depends on: Story 01, Story 02.

## Change

### New — `scripts/e2e/lib/bundle.ts`

```ts
export const bundleSchemaVersion = 1;

export type AssertionRecord = Readonly<{
  name: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}>;

export type HashRecord = Readonly<{ path: string; sha256: string }>;

export type BundleVersions = Readonly<{
  daemon: string;
  cli: string;
  git: string;
  podman: string | null;
}>;

export type BundleIdentity = Readonly<{
  hostname: string;
  platform: string;
  architecture: string;
}>;

export type Bundle = Readonly<{
  schemaVersion: number;
  scenarioId: ScenarioId;
  mode: "deterministic" | "deployment";
  driver: DriverName;
  profile: ProfileName;
  tag: string;
  commit: string;
  startedAt: string;
  finishedAt: string;
  identity: BundleIdentity;
  hosts: Readonly<Record<string, BundleIdentity>>;
  versions: BundleVersions;
  fixtureHashes: readonly HashRecord[];
  notes: Readonly<Record<string, string>>;
  objectIds: Readonly<Record<string, string>>;
  assertions: readonly AssertionRecord[];
  commands: readonly CommandRecord[];
  cleanupFailures: readonly ResourceFailure[];
  outcome: "passed" | "failed" | "unavailable";
  logs: Readonly<Record<string, string>>;
}>;

export type BundleWriter = Readonly<{
  sink: CommandSink;
  assert(name: string, expected: unknown, actual: unknown): void;
  note(key: string, value: string): void;
  noteHost(name: string, identity: BundleIdentity): void;
  noteObject(key: string, id: string): void;
  attachLog(name: string, text: string): void;
  setVersions(versions: Partial<BundleVersions>): void;
  finish(
    input: Readonly<{
      outcome: Bundle["outcome"];
      cleanupFailures: readonly ResourceFailure[];
      finishedAt: string;
    }>,
  ): Bundle;
}>;

export function createBundleWriter(
  input: Readonly<{
    scenarioId: ScenarioId;
    mode: Bundle["mode"];
    driver: DriverName;
    profile: ProfileName;
    tag: string;
    commit: string;
    startedAt: string;
    identity: BundleIdentity;
    fixtureHashes: readonly HashRecord[];
  }>,
): BundleWriter;

export function serializeBundle(bundle: Bundle): string;
export async function writeBundle(
  directory: string,
  bundle: Bundle,
): Promise<void>;
export async function hashFixtures(
  root: string,
): Promise<readonly HashRecord[]>;
export async function readCommit(
  sink: CommandSink,
  git: string,
): Promise<string>;
```

Pinned rules:

- `serializeBundle` emits the top-level keys in **exactly the declaration order of the
  `Bundle` type above**, `JSON.stringify(ordered, null, 2)` plus one trailing `\n`. Key
  order is explicit, never `Object.keys` of an accumulator, because insertion order across
  two runs is not a guarantee this EPIC may rely on.
- `writeBundle` writes `${directory}/bundle.json`, and one file per `logs` entry at
  `${directory}/logs/${name}.log`. Every string in the bundle passes through `redact`
  (Story 10) before serialization.
- `hashFixtures(root)` walks `root` recursively, hashes each file with
  `createHash("sha256")`, and returns records sorted by `path` with
  `Buffer.compare(Buffer.from(a.path), Buffer.from(b.path))`. `path` is relative to `root`
  and uses `/`. Bytewise ordering, per AGENTS.md.
- `readCommit` runs `[git, "rev-parse", "HEAD"]` and returns the trimmed stdout.
- `note(key, value)` writes into `notes`. Every free-form evidence field a scenario records
  lands there under a fixed key, so the `Bundle` type needs no field per scenario. The keys
  are closed and declared here: `productDigest`, `baseDigest`, `imageId`, `architecture`,
  `podmanRootless`, `bindAddress`, `daemonNamespace`, `clientNamespace`. `note` refuses any
  other key with `RunnerError("invalid-argument", \`unknown note key ${key}\`)`, and
`serializeBundle`emits`notes` with its keys in that declared order.
- `assert` appends an `AssertionRecord` and throws
  `RunnerError("assertion-failed", name)` when `expected` and `actual` are not
  `deepStrictEqual`. The failing record is in the bundle before the throw.
- `identity` is `{ hostname: hostname(), platform: process.platform, architecture: process.arch }`
  for the runner host. `noteHost` records a second and a third identity for a two-host run,
  keyed `"daemon"` and `"client"`.
- `versions.podman` is `null` on a run whose driver is not `podman`.

### Changed — `scripts/e2e/lib/main.ts`

`main` builds the writer before invoking the scenario, hands `writer.sink` and
`writer.assert` into the `ScenarioContext`, and calls `writer.finish` then `writeBundle` in
a `finally`, so a thrown assertion still writes evidence. `outcome` is `passed` when no
assertion failed and `cleanupFailures` is empty, `unavailable` when the error code is
`unavailable`, and `failed` otherwise.

## Constraints

- The bundle is written once, at the end, from one place. No scenario writes a file into
  the bundle directory itself.
- A test asserts the bundle on an injected `startedAt`, `finishedAt`, `commit` and
  `identity`. No test reads the wall clock, and no assertion in any scenario compares a
  timestamp.
- `objectIds` holds only ids the run observed. It never holds a secret, and `redact` runs
  over it like every other field.

## Verify

`node --test scripts/e2e/lib/bundle.test.ts`

Asserts:

- `bundleSchemaVersion` equals `1`.
- `serializeBundle` of a fully populated bundle equals an exact expected string, byte for
  byte, held inline in the test. The key order in that string is the `Bundle` declaration
  order.
- `serializeBundle` produces the same bytes when the writer received its `note` and
  `noteObject` calls in a different order — asserted by building two writers with permuted
  call order and comparing with `assert.equal`.
- `hashFixtures` over a `mkdtemp` tree holding `b.md`, `a.md` and `nested/á.md` returns
  three records ordered `a.md`, `b.md`, `nested/á.md` by `Buffer.compare`, with the exact
  sha256 of each file's bytes.
- `assert("x", 1, 2)` throws `RunnerError` with code `assertion-failed` and message `x`,
  **and** `finish` afterwards holds
  `{ name: "x", passed: false, expected: 1, actual: 2 }` as the last assertion.
- `finish({ outcome: "passed", cleanupFailures: [], finishedAt })` on a writer whose
  driver is `local` produces `versions.podman === null`.
- `note("productDigest", "sha256:a")` lands in `notes`; `note("nope", "x")` throws
  `invalid-argument`; `notes` serializes with the eight declared keys in declared order
  regardless of call order.
- `writeBundle` into a `mkdtemp` directory creates `bundle.json` and one file per log entry
  under `logs/`, and re-reading `bundle.json` and parsing it deep-equals the bundle.

`npm run verify` exits 0.

Proof: precondition of all three `node scripts/e2e/run.mjs <id>` lines. The EPIC 012 Proof
depends on it too, because that report references bundles by path and per-file digest.
