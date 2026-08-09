# Story 02 — The run leaves the forge unchanged

Epic: `.agent/plan/epics/011.2-the-deployment-scenarios-move-to-phase-3.md`
Depends on: Story 01.

P1-E5 runs against a repository Ulrich owns. No phase-1 operation writes a ref on a remote, and
the scenario reads the ref advertisement before and after the journey to prove it.

## Two facts that fix the design

- **A scenario may not import `src/`.** `docs/proposal/README.md:110`. No production file under
  `scripts/e2e/lib/scenario/` does. `scripts/e2e/remote.ts:62 listRemoteRefs` is the only ref→oid
  helper in the repository and it pulls five `src/services/git/` modules, so it is unusable here.
- **The ref reader is not a driver capability.** Only P1-E5 needs it, and only on one machine.
  `ExecutionDriver` has fifteen required methods and three test files build a complete literal of
  it — `scripts/e2e/lib/scenario/journey.test.ts:326`,
  `scripts/e2e/lib/scenario/startup-refusal.test.ts:46` and
  `scripts/e2e/lib/scenario/p1-e5.test.ts:370`. A sixteenth required method breaks all three, and
  it forces the podman and ssh drivers to carry a method they refuse. The reader is therefore an
  injected dependency of `runP1E5`, not an interface member.

## Change — the ref reader

New file `scripts/e2e/lib/remote-refs.ts`, beside `scripts/e2e/lib/secret-file.ts`, modelled on
`scripts/e2e/lib/driver/origin-probe.ts:19-64`:

```ts
import type { CommandRecord } from "./command.ts";

export type RemoteRefsInput = Readonly<{
  origin: string;
  username: string;
  tokenPath: string;
}>;

export type ReadRemoteRefs = (
  input: RemoteRefsInput,
) => Promise<Readonly<Record<string, string>>>;

export function remoteRefsScript(input: RemoteRefsInput): string;
export function parseRemoteRefs(
  stdout: string,
): Readonly<Record<string, string>>;
export async function runRemoteRefs(
  runShell: (script: string) => Promise<CommandRecord>,
  input: RemoteRefsInput,
): Promise<Readonly<Record<string, string>>>;
```

- `remoteRefsScript` returns exactly
  `GIT_TERMINAL_PROMPT=0 git -c 'credential.helper=<right>' ls-remote '<origin>'`,
  where `<right>` is the helper string of `scripts/e2e/lib/driver/origin-probe.ts:19-21`:
  `` `!f() { echo username=${username}; echo "password=$(cat ${tokenPath})"; }; f` ``.
  The token is read from a file and never embedded in the script.
- `parseRemoteRefs` splits `stdout` on `\n` and keeps only lines matching
  `/^([0-9a-f]{40,64})\t(.+)$/`. The range admits SHA-256 object ids, so the parser does not
  hard-code the object format. Every other line is ignored, so a `ref: ` symref banner and a
  blank line each change nothing. Keys are inserted in bytewise-ascending ref order. A ref that
  appears twice keeps the **last** oid, and a test pins that rule.
- `runRemoteRefs` returns `parseRemoteRefs(record.stdout)` when `record.exitCode === 0`. On any
  other exit status it throws `RunnerError` with code `unavailable` and the exact message
  `` `git ls-remote against ${input.origin} exited ${record.exitCode}` ``.

## Change — the injection

`scripts/e2e/lib/scenario/p1-e5.ts`:

- `runP1E5` gains a fourth parameter with a default, mirroring how `checkPrerequisites` takes
  `loadEnv = loadE2eEnv`:

  ```ts
  export async function runP1E5(
    context: ScenarioContext,
    driver: ExecutionDriver,
    inputs: RealInputs,
    readRemoteRefs: ReadRemoteRefs = createShellRemoteRefs(context),
  ): Promise<void>;
  ```

- `createShellRemoteRefs` is a local function in `p1-e5.ts`:

  ```ts
  function createShellRemoteRefs(context: ScenarioContext): ReadRemoteRefs {
    return (input) =>
      runRemoteRefs(
        (script) =>
          runCommand(context.sink, {
            argv: ["/bin/sh", "-c", script],
            env: { PATH: process.env.PATH ?? "" },
          }),
        input,
      );
  }
  ```

  `runCommand` is already imported by the module
  (`scripts/e2e/lib/scenario/p1-e3.ts:5` before the rename).

- Inside `runP1E5`, after `driver.deliverToken(...)` returns `deliveredTokenPath` and **before**
  `runJourney(...)`:
  `const before = await readRemoteRefs({ origin, username: "x-access-token", tokenPath: deliveredTokenPath });`
- After `runJourney(...)` returns, read `after` with an input built from the same three values.
- Emit `context.assert("forge-unchanged", before, after)` as the **last** assertion of `runP1E5`,
  before the four disclosure assertions of `run`.

`x-access-token` is the username `scripts/e2e/remote.ts:44` uses for a GitHub PAT over
http-basic. It belongs to the harness's own `ls-remote` and it does not change the credential the
product registers.

## Constraints

- `ExecutionDriver` gains no member. `scripts/e2e/lib/driver/index.ts` and all three drivers are
  untouched, so `driverMethodNames` stays at fifteen and the three complete driver literals stay
  valid.
- `context.assert(name, expected, actual)` compares the two maps
  (`scripts/e2e/lib/scenario/context.ts:11`). Assert the maps themselves, never a count and never
  a subset.
- The comparison covers every ref the advertisement carries, tags included, because a phase-1 run
  adds none of them.

## Two limits this assertion has, stated so it is not over-claimed

- **It is a detector, not a guard.** It runs after the journey. A write that the run makes and
  then reverts leaves both snapshots equal and passes. The assertion catches a ref that survives,
  which is the failure that would cost Ulrich work.
- **It assumes the repository is dedicated to the gate.** A push by another person, a bot, a
  merge queue or a release automation between the two reads fails P1-E5 with no product defect.
  `E2E_GH_REPO` in `.env.e2e` therefore names a throwaway repository with no automation and no
  second writer. Record that requirement as one line in the story's own `Constraints` section of
  the run instruction, and treat a `forge-unchanged` failure as a finding to investigate rather
  than an automatic product blocker.

A read-only token does not solve this and is not an option: registration proves the credential
with a `git-receive-pack` advertisement (`docs/proposal/phase-1/README.md`, the Preflight
verification bullet), so a token that cannot write fails the journey by design.

## Verify

- `node --test scripts/e2e/lib/remote-refs.test.ts` — new file:
  - `remoteRefsScript embeds the token path and never the token` — assert the returned string
    contains `cat /tmp/token` and does not contain the string `secret-token-value`.
  - `parseRemoteRefs maps every oid line and ignores the rest` — feed
    `"ref: refs/heads/main\tHEAD\n" + "a".repeat(40) + "\tHEAD\n" + "b".repeat(40) + "\trefs/heads/main\n\n"`
    and assert the exact object
    `{ HEAD: "aaa…", "refs/heads/main": "bbb…" }`.
  - `parseRemoteRefs accepts a sixty-four character object id` — one line with a 64-hex oid, and
    assert it is kept.
  - `parseRemoteRefs returns keys in bytewise-ascending ref order` — feed refs out of order and
    assert `Object.keys(...)` deep-equals the same array sorted through `Buffer.compare`.
  - `parseRemoteRefs keeps the last oid when a ref repeats` — two lines for one ref, assert the
    second oid.
  - `runRemoteRefs returns the parsed map on exit status zero`.
  - `runRemoteRefs raises unavailable on a non-zero exit` — assert the `RunnerError` code is
    `unavailable` and the message is exactly
    `git ls-remote against https://github.com/o/r.git exited 128`.
- `node --test scripts/e2e/lib/scenario/p1-e5.test.ts` — add, each with an injected fake
  `readRemoteRefs` so no network is reached:
  - `runP1E5 reads the remote refs twice, with the same input both times` — assert exactly two
    calls and that both inputs deep-equal
    `{ origin, username: "x-access-token", tokenPath }`.
  - `runP1E5 reads the refs before the first journey command and after the last` — assert the
    call order against the recorded command list.
  - `runP1E5 asserts forge-unchanged with the two maps` — assert the assertion name is
    `forge-unchanged` and that expected and actual are the two returned maps.
  - `runP1E5 records forge-unchanged as failed when a ref appears during the journey` — the fake
    returns a second map with one extra ref; assert the recorded assertion has
    `expected` not deep-equal to `actual`.
- `node --test scripts/e2e/lib/driver/interface.test.ts` — unchanged and green, proving the
  driver interface did not move.
- `npm run verify` exits 0.
- Proof: delivers the EPIC coverage item
  `The remote ref advertisement is identical before and after the run`.
