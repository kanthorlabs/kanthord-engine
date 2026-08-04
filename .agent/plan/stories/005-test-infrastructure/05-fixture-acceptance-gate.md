# Story 05 — Fixture acceptance gate

Epic: `.agent/plan/epics/005-test-infrastructure.md`
Depends on: Story 03 (`startHttpRemote`, `httpAcceptanceChecks`), Story 04
(`startSshRemote`, `sshAcceptanceChecks`).

## Change

Two new files. `acceptance.ts` holds the gate mechanism and knows nothing about
either transport. `index.ts` is the only entry point a consumer imports, and it is
where the handle is withheld.

### `test/helpers/remote/acceptance.ts`

```ts
export type AcceptanceCheck<T> = Readonly<{
  name: string;
  run(subject: T): Promise<void> | void;
}>;

export type AcceptanceFailure = Readonly<{ name: string; reason: string }>;

export class FixtureError extends Error {
  readonly failures: readonly AcceptanceFailure[];
  constructor(fixture: string, failures: readonly AcceptanceFailure[]);
}

export async function runAcceptance<T>(
  fixture: string,
  subject: T,
  checks: readonly AcceptanceCheck<T>[],
): Promise<void>;
```

`runAcceptance` awaits every check **in array order**, never concurrently, and
collects a failure per throwing check as
`{ name, reason: error instanceof Error ? error.message : String(error) }`. It
runs every check even after one fails, so one run reports the whole list. When
`failures.length > 0` it throws `FixtureError(fixture, failures)`. The message is:

```
`${fixture} failed ${failures.length} of ${checks.length} acceptance checks: ${failures.map((f) => f.name).join(", ")}`
```

`runAcceptance` throws `FixtureError(fixture, [{ name: "acceptance", reason: "the check list is empty" }])`
when `checks.length === 0`. An empty list would otherwise pass and gate nothing.

### `test/helpers/remote/index.ts`

```ts
export type FixtureTransport = "http-basic" | "ssh";

export const fixtureTransports: readonly FixtureTransport[];

export type RemoteOverrides<T> = Readonly<{
  checks?: readonly AcceptanceCheck<T>[];
  env?: Readonly<Record<string, string | undefined>>;
}>;

export function createHttpRemote(
  overrides?: RemoteOverrides<HttpRemote>,
): Promise<HttpRemote>;

export function createSshRemote(
  overrides?: RemoteOverrides<SshRemote>,
): Promise<SshRemote>;

export function createRemotes(): Promise<Remotes>;
```

`overrides.env` is passed straight to `resolveTools(env)`. It exists so the
missing-tool assertion can be made **against the factory** rather than only
against `resolveTools`: without it the factory takes no injectable dependency and
the EPIC coverage line "the acceptance gate fails loudly when a required tool is
absent" could only be tested by mutating `process.env`, which is not hermetic.

`fixtureTransports` is `["http-basic", "ssh"] as const`, sorted bytewise.

`createHttpRemote(overrides)`:

1. `const tools = resolveTools(overrides?.env);` — a `ToolError` here propagates
   before anything is created, so a missing tool never reaches a fixture.
2. `const seed = seedRepositories(tools);`
3. `const remote = await startHttpRemote(tools, seed);` inside a `try`; on a throw
   `seed.dispose()` and rethrow. A starter that fails part-way owns disposing its
   own server, and this cleans up the seed the factory created.
4. `await runAcceptance("http-basic", remote, overrides?.checks ?? httpAcceptanceChecks)`
   inside a `try`. On **any** throw, `await remote.dispose()`, then
   `seed.dispose()`, then rethrow. The handle is never returned.
5. Return a handle whose `dispose()` **disposes the seed as well as the server**
   — see the ownership rule below.

`createSshRemote` is the same shape over `startSshRemote` and
`sshAcceptanceChecks`, with the fixture name `"ssh"`.

### Seed ownership

The seed has exactly one owner, and `dispose()` on the owner releases everything
it created. Without this rule a caller that does the obvious thing leaks a
temporary directory per test.

- A **single** factory creates the seed, so it owns it. The returned handle's
  `dispose()` closes the transport **and** disposes the seed. Implement it by
  wrapping the starter's handle: spread it and override `dispose` with
  `async () => { await inner.dispose(); seed.dispose(); }`.
- `createRemotes()` creates **one** shared `SeedRoot` and owns it, so neither
  per-remote `dispose` may touch it — disposing one transport would otherwise
  invalidate the other. It returns
  `Readonly<{ http: HttpRemote; ssh: SshRemote; dispose(): Promise<void> }>` whose
  `dispose` disposes both transports and then the shared seed. It gates both, and
  if the second fixture fails it disposes the first plus the seed before
  rethrowing.
- The starters of Stories 03 and 04 never dispose a seed. They did not create it.

Both remotes from `createRemotes` therefore serve the same repositories, as the
epic requires; the single-fixture factories each get their own.

Re-export from `index.ts` the types a consumer needs and nothing more:
`FixtureCredential`, `FixtureHostKey`, `HttpRemote`, `SshRemote`, `SeededRepository`,
`fixtureObjectIds`, `httpCredentials`, `httpWrongCredential`, `FixtureError`,
`AcceptanceCheck`.

`startHttpRemote` and `startSshRemote` are **not** re-exported.

**Be precise about what that buys.** TypeScript has no module privacy, so a test
can still write `import { startHttpRemote } from "./http.ts"` and reach an
unchecked fixture. Omitting the names from `index.ts` is a barrel convention, not
an enforcement, and this story must not claim otherwise.

The enforcement is a **grep assertion**, which is this repository's own mechanism
for a rule the type system cannot carry — `AGENTS.md` lists a grep-based allowance
under "What is enforced, and by what". Add it to `index.test.ts`:

- Walk every `.ts` file under `src/` and `test/`.
- Fail on any file other than `test/helpers/remote/index.ts`,
  `test/helpers/remote/http.ts`, `test/helpers/remote/http.test.ts`,
  `test/helpers/remote/ssh.ts` and `test/helpers/remote/ssh.test.ts` that mentions
  `startHttpRemote` or `startSshRemote`.
- The two `*.test.ts` files are allowed because each story tests its own fixture
  directly, which is the co-location rule of `AGENTS.md`. Every other consumer must
  come through a gated factory.
- The failure message names the offending file and the required factory, so a new
  consumer is redirected rather than merely blocked.

That assertion is what makes the rule structural: a bypass fails `npm run verify`
in a named file, instead of passing quietly.

## Constraints

- The gate runs in the factory, before the return. Never as a `before` hook, never
  as a separate test file, and never as a module-level side effect — file order
  between test files is not a guarantee.
- A failure disposes everything it started. A leaked `sshd` outlives the run.
- `acceptance.ts` imports nothing from `http.ts` or `ssh.ts`. It is generic over
  `T`, which is what lets it be tested with synthetic checks and no fixture.
- The `overrides.checks` seam exists for the failure assertion below. It is the
  only way to inject a check list, and the default is always the real list.

## Verify

`node --test test/helpers/remote/acceptance.test.ts`, asserting exactly:

- `runAcceptance("x", 1, [{ name: "a", run() {} }])` resolves.
- Order: three checks pushing their names into an array run in array order, giving
  `["a", "b", "c"]`, asserted as an exact array. An `async` check that awaits a
  resolved promise before pushing still lands in order, which proves the loop
  awaits rather than mapping.
- A single throwing check rejects with a `FixtureError` whose `failures`
  deep-equals `[{ name: "b", reason: "boom" }]` and whose message is exactly
  `"x failed 1 of 3 acceptance checks: b"`.
- Two throwing checks report **both**, in list order, and the message ends
  `"acceptance checks: b, c"` — proving the run does not stop at the first
  failure.
- A check throwing a non-`Error` value records `reason: "17"` for `throw 17`.
- `runAcceptance("x", 1, [])` rejects with `FixtureError` whose message contains
  `"the check list is empty"`.
- `FixtureError` is an `instanceof Error` and its `failures` is frozen or at least
  deep-equal to the input; assert `error instanceof FixtureError`.

`node --test test/helpers/remote/index.test.ts`, asserting exactly:

- `fixtureTransports` deep-equals `["http-basic", "ssh"]`.
- **The proposal-parity assertion**, written as a two-way set comparison rather
  than a phrase count. Declare one table in the test:

  ```ts
  const transportEvidence = {
    "http-basic": "git smart HTTP",
    ssh: "`sshd`",
  } as const;
  ```

  Read `docs/proposal/README.md` and take the line beginning
  ``- **`deterministic`**`` (line 78 today; find it by that prefix, never by
  number). Then assert **both** directions:
  - every key of `transportEvidence` appears in `fixtureTransports`, and every
    entry of `fixtureTransports` is a key of `transportEvidence` —
    `assert.deepEqual([...fixtureTransports].sort(), Object.keys(transportEvidence).sort())`;
  - every phrase in `transportEvidence` appears in the tier line.

  Then the **drift guard in the other direction**, which is the half a phrase check
  cannot do: assert the tier line contains no transport keyword outside the table.
  Scan it for `/\b(git|ssh|http|https|file|rsync)\b/gi` plus the literal `sshd`,
  reduce the hits to a set, and assert that set is a subset of a declared
  vocabulary — the words the two known phrases already account for. A third
  transport named in the prose introduces a word outside the vocabulary and fails.

  Record the limit in the test's own name: the tier is prose, so this asserts set
  equality against a hand-declared evidence table plus a closed keyword
  vocabulary. It is not registry parity, because `docs/proposal/README.md:78` has no
  machine-readable transport list to parse. Do not describe it as structural
  parity.

- `createHttpRemote()` resolves to a handle whose `transport` is `"http-basic"`,
  and a `git ls-remote` through it reports `fixtureObjectIds.commit2`.
- `createSshRemote()` resolves to a handle whose `transport` is `"ssh"`.
- **The withheld-handle assertion, HTTP**: `createHttpRemote({ checks: [...httpAcceptanceChecks.slice(0, 3), { name: "forced", run() { throw new Error("forced failure"); } }] })`
  rejects with `FixtureError`, `failures` deep-equals
  `[{ name: "forced", reason: "forced failure" }]`, and **no handle is returned**.
  Then assert nothing leaked: the port the fixture chose refuses a connection
  afterwards. Capture the port by having the forced check record
  `subject.port` before it throws.
- **The withheld-handle assertion, ssh**: the same substitution against
  `createSshRemote`, rejecting with `FixtureError`, and the reserved port refuses a
  connection afterwards, proving `sshd` was killed.
- `createRemotes()` resolves with both handles sharing one seed:
  `remotes.http.seed.path === remotes.ssh.seed.path`.
- `createRemotes()` `dispose()` resolves, and afterwards the HTTP port refuses a
  connection, the ssh port refuses a connection, and the shared seed path does not
  exist.
- **Seed ownership, single factory**: capture `remote.seed.path` from
  `createHttpRemote()`, call `remote.dispose()`, and assert
  `fs.existsSync(seedPath) === false`. The same for `createSshRemote()`. This is
  the leak the ownership rule exists to prevent, so it is asserted directly.
- **Seed ownership, shared**: from `createRemotes()`, call
  `remotes.http.dispose()` alone and assert the shared seed path **still exists**,
  so disposing one transport does not invalidate the other. Then
  `remotes.dispose()` removes it.
- **The missing-tool assertion against the factory**:
  `createHttpRemote({ env: { KANTHORD_TEST_GIT: "/nonexistent/git" } })` rejects
  with `ToolError` whose `tool` is `"git"`, and no temporary directory is left
  behind — capture `fs.readdirSync(tmpdir())` filtered to `kanthord-` prefixes
  before and after and assert the sets are equal. The same for
  `createSshRemote({ env: { KANTHORD_TEST_SSHD: "/nonexistent/sshd" } })`. This is
  the EPIC coverage line "the acceptance gate fails loudly when a required tool is
  absent, rather than skipping", asserted where the gate actually lives.
- **The starters are not re-exported**: assert
  `Object.keys(await import("./index.ts"))` contains neither `startHttpRemote` nor
  `startSshRemote`. State in the test name that this covers the barrel only.
- **The starters are not reachable from a new consumer**: the grep assertion
  described above, over every `.ts` file under `src/` and `test/`, with the
  five-file allow list. This is the assertion that carries the structural claim;
  the `Object.keys` one does not.

`npm run verify` exits 0.

Proof: `node --test test/helpers/remote/*.test.ts && echo "PASS EPIC-005"` — this
story closes the glob and delivers `PASS EPIC-005`. It also delivers the coverage
lines "A consumer that asks for a fixture whose acceptance list fails receives an
error instead of a handle, asserted by forcing one row to fail", "The acceptance
gate fails loudly when a required tool is absent, rather than skipping" (through
`resolveTools` throwing inside the factory, asserted in Story 01), and "The
`deterministic` tier of `docs/proposal/README.md` names both transports, and a
test asserts the fixture set matches that list rather than drifting from it".
