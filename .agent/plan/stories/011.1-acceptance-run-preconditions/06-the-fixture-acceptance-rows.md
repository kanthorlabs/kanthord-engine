# Story 06 — The fixture acceptance rows are proved before the journey

Epic: `.agent/plan/epics/011.1-acceptance-run-preconditions.md`

## Change

The probe reaches the origin through a new driver method, because the podman network is `--internal`
and `topology.fixtureOrigin` is `http://127.0.0.1:7422` inside the pod
(`scripts/e2e/lib/podman/topology.ts:40`, `:113-131`). The runner host cannot reach it; the daemon
container can.

### 1. New file `scripts/e2e/lib/driver/origin-probe.ts`

```ts
export type OriginProbeInput = Readonly<{
  origin: string;
  username: string;
  tokenPath: string;
  wrongToken: string;
  defaultBranch: string;
}>;

export type ProbeRow = Readonly<{ name: string; passed: boolean }>;

export const originProbeRowNames = [
  "fixture-head-symref",
  "fixture-fetch",
  "fixture-receive-pack-refuses-wrong-token",
] as const;

export function originProbeScripts(
  input: OriginProbeInput,
): readonly Readonly<{ name: string; script: string }>[];

export async function runOriginProbe(
  runShell: (script: string) => Promise<CommandRecord>,
  input: OriginProbeInput,
): Promise<readonly ProbeRow[]>;
```

Two credential-helper builders, both private to the file:

```ts
function rightHelper(username: string, tokenPath: string): string {
  return `!f() { echo username=${username}; echo "password=$(cat ${tokenPath})"; }; f`;
}

function wrongHelper(username: string, wrongToken: string): string {
  return `!f() { echo username=${username}; echo password=${wrongToken}; }; f`;
}
```

The right helper reads the token from the mode-0600 file the driver already delivered, so the real
token never appears in an argv. The wrong token is the fixture's rejected literal and may appear.

`originProbeScripts` returns exactly three entries, in `originProbeRowNames` order:

1. `fixture-head-symref`

   ```sh
   GIT_TERMINAL_PROMPT=0 git -c 'credential.helper=<right>' ls-remote --symref '<origin>' HEAD
   ```

2. `fixture-fetch`

   ```sh
   set -e; d=$(mktemp -d); git init -q --template= "$d"; GIT_TERMINAL_PROMPT=0 git -C "$d" -c 'credential.helper=<right>' fetch --no-tags --prune '<origin>' 'refs/heads/<branch>:refs/remotes/origin/<branch>'; git -C "$d" rev-parse 'refs/remotes/origin/<branch>' >/dev/null; test -z "$(git -C "$d" for-each-ref --format='%(refname)' refs/heads refs/tags)"; rm -rf "$d"
   ```

3. `fixture-receive-pack-refuses-wrong-token`

   ```sh
   set -e; d=$(mktemp -d); git init -q --template= "$d"; git -C "$d" -c user.name=probe -c user.email=probe@example.invalid commit -q --allow-empty -m probe; set +e; GIT_TERMINAL_PROMPT=0 git -C "$d" -c 'credential.helper=<wrong>' push --dry-run '<origin>' HEAD:refs/heads/kanthord-e2e-probe; status=$?; rm -rf "$d"; exit $status
   ```

`git push --dry-run` performs a real `git-receive-pack` advertisement and writes no ref.

`runOriginProbe` runs the three scripts in order and maps each to a row:

- rows 1 and 2 — `passed = record.exitCode === 0`;
- row 3 — `passed = record.exitCode !== 0`.

It returns all three rows. It never throws on a failing row.

### 2. `scripts/e2e/lib/driver/index.ts` — the method

Add to `ExecutionDriver` (`index.ts:40-67`), after `deliverToken` at line 55:

```ts
  probeOrigin(input: OriginProbeInput): Promise<readonly ProbeRow[]>;
```

Import both types from `./origin-probe.ts`. Add `"probeOrigin"` to `driverMethodNames`
(`index.ts:69-84`) immediately after `"deliverToken"`.

### 3. The three implementations

- `scripts/e2e/lib/driver/local.ts` — `probeOrigin(input)` calls
  `runOriginProbe((script) => runCommand(context.sink, { argv: ["/bin/sh", "-c", script], env: { PATH: process.env.PATH ?? "" } }), input)`.
- `scripts/e2e/lib/driver/podman.ts` — `probeOrigin(input)` calls
  `runOriginProbe((script) => execute(["podman", "exec", topology.daemonContainer, "sh", "-c", script]), input)`.
  The daemon container shares the pod with the fixture container, so it reaches
  `http://127.0.0.1:7422`.
- `scripts/e2e/lib/driver/ssh.ts` — `probeOrigin()` throws
  `new RunnerError("unavailable", "the ssh driver runs the real profile and probes no fixture origin")`.
  The fixture profile has no `ssh` origin source (`profile/fixture.ts:76-81`), so it is never called.

### 4. `scripts/e2e/lib/driver/interface.test.ts`

Add `"probeOrigin"` to `expectedMethodNames` (`interface.test.ts:12-26`) after `"deliverToken"`, in
the same position as the production list.

### 5. `scripts/e2e/lib/profile/fixture.ts` — the probe runs before the journey

Extend `OriginSource`'s return type (`fixture.ts:23-26`) with `wrongToken: string`:

- `local` — `wrongToken: remote.wrongCredential.token`;
- `podman` — `wrongToken: httpWrongCredential.token`, imported from
  `../../../../test/helpers/remote/http.ts` beside the existing `httpCredentials` import at line 3.

In `createFixtureProfile`, insert between `const tokenFile = await driver.deliverToken(token);`
(line 85) and the `deliverDirectory` call (line 87):

```ts
const probeRows = await driver.probeOrigin({
  origin,
  username,
  tokenPath: tokenFile,
  wrongToken,
  defaultBranch: fixtureDefaultBranch,
});

for (const row of probeRows) {
  try {
    context.assert(row.name, true, row.passed);
  } catch {
    throw new RunnerError("unavailable", `fixture row ${row.name} failed`);
  }
}
```

`context.assert` (`scripts/e2e/lib/bundle.ts:151-164`) pushes the assertion row onto the bundle
**before** it throws, so a failed row is recorded and then converted to `unavailable`.

Add `const fixtureDefaultBranch = "main";` beside the other constants at `fixture.ts:9-11` and use it
at line 97 in place of the literal, so the probe and the profile cannot disagree.

Import `RunnerError` from `../errors.ts`.

## Constraints

- The real token never reaches an argv. It is read inside the shell script from `tokenPath`, the
  mode-0600 file the driver delivered.
- `probeOrigin` runs for the `local` and `podman` drivers only. The `ssh` driver refuses.
- The probe runs after the origin exists and before the first journey command. `createFixtureProfile`
  returns before `runJourney` is called (`scenario/p1-e1.ts:9-10`, `scenario/p1-e4.ts:225`), so the
  insertion point above is the only one needed.
- A failed row raises `unavailable`, never `assertion-failed`. Exit `3`, not `1`.
- Do not add a generic `exec` to `ExecutionDriver`. `probeOrigin` is the named capability.
- Do not use `driver.name ===` anywhere in `scenario/` or `profile/` —
  `scripts/e2e/lib/scenario/index.test.ts:53-73` forbids it. The `originSources` lookup table stays
  the dispatch.

## Verify

New file `scripts/e2e/lib/driver/origin-probe.test.ts`:

1. `originProbeRowNames` deep-equals the three names in the pinned order.
2. `originProbeScripts` returns three entries whose `name` values equal `originProbeRowNames`.
3. Script 1 contains `ls-remote --symref`, the origin and `HEAD`; script 2 contains
   `fetch --no-tags --prune` and `refs/heads/main:refs/remotes/origin/main`; script 3 contains
   `push --dry-run` and `HEAD:refs/heads/kanthord-e2e-probe`.
4. **SECURITY:** no script contains the string passed as the token value. Pass `tokenPath` and a
   distinct sentinel token value and assert the sentinel appears in no script. The wrong token
   **does** appear, in script 3 only.
5. `runOriginProbe` with a stub `runShell` returning exit `0`, `0`, `1` → all three rows `passed:
true`.
6. Exit `1` on script 1 → row 1 `passed: false`, and all three rows are still returned.
7. Exit `1` on script 2 → row 2 `passed: false`.
8. Exit `0` on script 3 → row 3 `passed: false`.
9. `runShell` receives the three scripts in `originProbeRowNames` order.

Added to `scripts/e2e/lib/profile/profile.test.ts` (extend the existing fake driver at lines 51-72):

10. `createFixtureProfile` on a fake podman driver calls `probeOrigin` exactly once, with
    `tokenPath` equal to the value `deliverToken` returned, `defaultBranch: "main"`, and
    `wrongToken` equal to `httpWrongCredential.token`.
11. The three rows are recorded through `context.assert` with `expected === true`. Use a context fake
    that collects `{ name, expected, actual }` and deep-equal the three entries.
12. A `probeOrigin` returning a `passed: false` row makes `createFixtureProfile` reject with
    `RunnerError`, `code === "unavailable"`, message
    `fixture row fixture-head-symref failed`, and the row is recorded before the rejection.
13. **Command order:** the fake driver appends its method name to a shared array on every call.
    Assert `probeOrigin` appears in that array, and that `cli` does not appear at all — the profile
    factory issues no journey command.

Added to `scripts/e2e/lib/driver/interface.test.ts`:

14. The existing `assertDriverShape` case passes for all three drivers with `probeOrigin` in
    `expectedMethodNames`.
15. The `ssh` driver's `probeOrigin` rejects with `RunnerError`, `code === "unavailable"`.

- `npm run verify` exits 0.
- Proof: delivers the `P1-E1` and `P1-E2` lines of the EPIC Proof block, which now run the probe
  against the live loopback fixture before their journeys. Both must stay `passed`.
