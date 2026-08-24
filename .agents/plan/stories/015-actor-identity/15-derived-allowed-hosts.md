# Story 15 — Derived `http.allowedHosts` and the generated configuration

Epic: `.agents/plan/epics/015-actor-identity.md`

Independent of every other story in this epic. Dispatch it first.

## Change

- Create `src/domain/host-authority.ts`. Pure; it imports `isLoopbackHost` from `./loopback.ts` and nothing else.

  ```ts
  export const wildcardBinds = ["0.0.0.0", "::"] as const;
  export function isWildcardBind(bind: string): boolean;
  export function deriveAllowedHosts(
    input: Readonly<{ bind: string; port: number }>,
  ): readonly string[];
  ```

- `deriveAllowedHosts` has exactly three cases, and its output order is fixed so two loads of one configuration produce one list.
  1. `isWildcardBind(input.bind)` → return `[]`. A wildcard bind carries no evidence of the authority a client sends, and the caller refuses.
  2. `isLoopbackHost(input.bind)` → return `["127.0.0.1:<port>", "localhost:<port>"]`, and append `"[::1]:<port>"` as a third entry **only when `input.bind === "::1"`**.
  3. Otherwise return one entry, `"<bind>:<port>"`, with the bind wrapped in `[` and `]` when it contains a `:`.
- `isWildcardBind` returns `true` for exactly the two members of `wildcardBinds` and `false` otherwise.
- `src/services/config/convict.ts:18-27`: `hostList` accepts `null` — return early when `value === null`. It keeps its refusal of `[]` and of an entry that is not a non-empty string. `http.allowedHosts` keeps `default: null` at `:167-171` and the key stays optional.
- `src/services/config/convict.ts:225-238`: `normalizeAllowedHosts` returns `null` for `null` and for `undefined`, and keeps its present behaviour for a string and for an array. Change its return type to `string[] | null`. An environment value that trims to empty still yields `[]` and therefore still fails `hostList`, so `KANTHORD_HTTP_ALLOWED_HOSTS=", ,"` stays `config-invalid`.
- `src/services/config/refusals.ts`: `StartableInput` gains `allowedHosts: readonly string[] | null` and `port: number`. `assertStartable` adds two refusals, both `config-refused`, placed after the existing bind/token refusal:
  - `allowedHosts === null && isWildcardBind(input.bind)` → refuse. The message names `http.allowedHosts` and requires an explicit non-empty list.
  - `allowedHosts === null && input.port === 0` → refuse with the same message. The listening port is unknown when the allow list is built.
- `src/services/config/convict.ts`: in `load`, pass the two new fields to `assertStartable`, then apply `deriveAllowedHosts({ bind, port })` when the normalized value is `null`, so `settings.http.allowedHosts` is **always a non-empty list** at `src/main.ts:342`. The derivation runs after `assertStartable`, so the two refused cases never reach it.
- `src/cli/config/generate.ts:38-46`: bind `LOOPBACK_IPV4` from `src/domain/loopback.ts` in place of the literal `0.0.0.0`. Add `--bind <address>` taken once, and `--allowed-host <authority>` taken repeatably. With no `--allowed-host`, write `deriveAllowedHosts({ bind, port: 31415 })`. With a wildcard bind and no `--allowed-host`, write **no file**, print the same refusal text to stderr and exit non-zero.
- `src/cli/config/generate.ts:7-14`: `RegisterConfigGenerateInput` gains `stderr` and `fail`. `src/cli/program.ts:62-68` passes the two dependencies it already holds.

## Constraints

- **A wildcard is not added to the derived list and the port is not stripped.** `src/http/server/host.ts:16-20` compares the whole lower-cased `Host` value, which is the DNS-rebind defence of `docs/proposal/phase-1/transport.md:35`. Exact authority matching is unchanged.
- An operator who uses a DNS alias names that alias. The daemon reads the `Host` header and never resolves a name, so there is no zero-configuration remote mode. Add no resolution and no reverse lookup.
- `src/domain/host-authority.ts` is pure: no `node:*` import, no vendor package, and none of `Date.now(`, `new Date(` or `Math.random(`.
- An operator-supplied `http.allowedHosts` is loaded **verbatim on any bind, wildcard included**, so the container configuration of `020-wiring-and-scenarios.md:73` keeps working. Do not validate a supplied entry against the bind.
- `src/cli/config/generate.ts` carries no VPN mode and no network name. The generator writes a file and reaches nothing.
- `001-runtime-foundation.md:60` calls `http.allowedHosts` required; this story makes it optional and derived. No other setting changes.

## Verify

- Create `src/domain/host-authority.test.ts`, suite name `src/domain/host-authority.test`. Assert `deriveAllowedHosts` returns the **exact** list for each bind shape at port `31415`:
  - `127.0.0.1` → `["127.0.0.1:31415", "localhost:31415"]`
  - `localhost` → `["127.0.0.1:31415", "localhost:31415"]`
  - `::1` → `["127.0.0.1:31415", "localhost:31415", "[::1]:31415"]`
  - `10.1.2.3` → `["10.1.2.3:31415"]`
  - `fd00::1` → `["[fd00::1]:31415"]`
  - `0.0.0.0` → `[]`
  - `::` → `[]`
  - `127.0.0.5` → `["127.0.0.1:31415", "localhost:31415"]`, because `isLoopbackHost` accepts every `127.x.y.z`.
  - Each assertion uses `deepEqual`, so the order is pinned and not only the membership.
  - `isWildcardBind` is `true` for the two wildcards and `false` for `127.0.0.1`, `localhost`, `::1`, `10.1.2.3` and `""`.
  - Two successive calls on one input return deep-equal lists.
- `src/services/config/convict.test.ts`:
  - **Replace the present case at `:227-256`.** A configuration that omits `http.allowedHosts` on a loopback bind now **loads**, and `settings.http.allowedHosts` deep-equals `["127.0.0.1:8080", "localhost:8080"]` for the fixture's port. The old case asserted `config-invalid` for exactly this configuration.
  - A configuration that omits `http.allowedHosts` on the bind `0.0.0.0` throws `config-refused`, and the message includes `http.allowedHosts`. Same for the bind `::`, and same for a configured port of `0` on a loopback bind.
  - The four cases at `:265-291` **pass unchanged**: `http.bind: ""`, `allowedHosts: []`, `allowedHosts: [""]` and `allowedHosts: ", ,"` each stay `config-invalid`.
  - A configuration supplying an explicit `http.allowedHosts` on the bind `0.0.0.0` loads that list **verbatim**.
  - A configuration supplying an explicit list on a loopback bind loads it verbatim rather than the derived list.
- `src/services/config/refusals.test.ts`: add cases for the two new refusals, each asserting the code `config-refused` and the message content, and assert that a non-null `allowedHosts` never triggers either.
- `src/cli/config/generate.test.ts`:
  - The present assertion at `:69` reads `["127.0.0.1:31415", "localhost:31415"]` and **passes unchanged**; assert additionally that `config.http.bind` now equals `"127.0.0.1"` rather than `"0.0.0.0"`. Only the bind value changes.
  - `--bind 10.1.2.3` writes `http.allowedHosts` deep-equal to `["10.1.2.3:31415"]` and `http.bind` equal to `"10.1.2.3"`.
  - `--bind 0.0.0.0 --allowed-host kanthord.internal:31415 --allowed-host 10.1.2.3:31415` writes both entries **in the supplied order**.
  - `--bind 0.0.0.0` with no `--allowed-host` writes **no file** and exits non-zero, asserted through zero recorded `writeFile` calls and a `fail`/`exit` count of 1, and stderr naming `http.allowedHosts`.
  - The existing case asserting stdout leaks neither `masterKey` nor `token` passes unchanged.
- `test/helpers/home.ts:25` and `test/helpers/home.test.ts` supply an explicit `allowedHosts` today; assert they still load verbatim and change them only if `npm run verify` reports a failure.
- Run `node --test --test-timeout=60000 src/domain/host-authority.test.ts src/services/config/convict.test.ts src/services/config/refusals.test.ts src/cli/config/generate.test.ts src/http/server/host.test.ts test/helpers/home.test.ts`; each exits 0.
- `npm run verify` exits 0. Its final step `node scripts/verify-db-status.ts` sets an explicit `allowedHosts` at `scripts/verify-db-status.ts:49`, so it exercises the verbatim path.
- Proof: `PASS EPIC-015`, and Hermetic coverage lines 134, 135, 136, 137, 138, 139, 140 and 141.
