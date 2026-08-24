# Story 04 — Startup refusal rules

Epic: `.agents/plan/epics/001-runtime-foundation.md`
Depends on: Story 01.

## Change

**1. `src/services/config/refusals.ts`** — new file, pure. It reads no file system.

```ts
export function isLoopback(bind: string): boolean;

export type StartableInput = Readonly<{
  masterKey: string;
  masterKeyFile: string;
  masterKeyFileMode: number | undefined;
  bind: string;
  token: string;
}>;

export function assertStartable(input: StartableInput): void;
```

`isLoopback` returns true for exactly three shapes and nothing else:

- `"localhost"`
- `"::1"`
- an IPv4 literal matching `127.<octet>.<octet>.<octet>`, where every octet is a decimal integer from 0 to 255 with no leading zero beyond a single `0`.

`"0.0.0.0"`, `"::"`, `"127.0.0.256"`, `"127.0.0"` and `""` are not loopback.

`assertStartable` throws `ConfigError("config-refused", <message>)` on the first rule that fails, evaluated in exactly this order:

| #   | Condition                                                                | Message                                                           |
| --- | ------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| 1   | `masterKey` and `masterKeyFile` are both empty                           | `no master key configured; set masterKey or masterKeyFile`        |
| 2   | `masterKey` and `masterKeyFile` are both non-empty                       | `masterKey and masterKeyFile are both set; configure exactly one` |
| 3   | `masterKeyFile` non-empty and `masterKeyFileMode & 0o777` is not `0o600` | `masterKeyFile must have mode 0600; found 0<octal>`               |
| 4   | `isLoopback(bind)` is false and `token` is empty                         | `a non-loopback bind address requires http.token`                 |

The order is fixed so that a configuration with two faults always reports the same one.

**2. `src/services/config/convict.ts`** — insert one step into `load`, between the convict `validate` step and the master-key resolution step:

- When `masterKeyFile` is non-empty, `fs.statSync` it. An `ENOENT` throws `ConfigError("config-invalid", ...)` naming the path. Otherwise take `stat.mode`.
- Call `assertStartable({ masterKey, masterKeyFile, masterKeyFileMode, bind: http.bind, token: http.token })`.

The master-key resolution of Story 01 now never sees the empty case, so remove its own empty-value branch. Keep its 32-byte assertion.

## Constraints

- `refusals.ts` imports `ConfigError` from `./index.ts` and nothing else. No `node:` import.
- These are load-time refusals, not listen-time refusals. `load` throws and `serve` never reaches the lock. EPIC 004 asserts the same predicate at listen time and does not move it.
- Do not add a refusal the epic does not name. An empty `http.token` on a loopback bind is legal.

## Verify

`node --test src/services/config/refusals.test.ts`, which asserts:

- `isLoopback` is true for `127.0.0.1`, `127.0.0.2`, `127.1.2.3`, `127.255.255.255`, `localhost`, `::1`.
- `isLoopback` is false for `0.0.0.0`, `::`, `192.168.1.10`, `10.0.0.1`, `127.0.0.256`, `127.0.0`, `128.0.0.1`, `""`.
- `assertStartable` returns undefined for a loopback bind with an empty token and a valid `masterKey`.
- `assertStartable` returns undefined for a non-loopback bind with a non-empty token.
- Rule 1: both key fields empty throws `config-refused`, and the message is exactly `no master key configured; set masterKey or masterKeyFile`.
- Rule 2: both key fields set throws `config-refused` with the rule 2 message, even when the bind is also non-loopback with no token — this pins the order.
- Rule 3: `masterKeyFileMode` of `0o644` throws `config-refused`, and the message ends `found 0644`.
- Rule 4: bind `0.0.0.0` with an empty token throws `config-refused` with the rule 4 message.
- Rule order: an input that fails rules 1 and 4 together reports rule 1.

`node --test src/services/config/convict.test.ts` gains:

- A config file with `http.bind: "0.0.0.0"` and no `http.token` throws `code === "config-refused"`.
- The same file with a non-empty `http.token` loads.
- A file with neither `masterKey` nor `masterKeyFile` throws `config-refused`.
- A file with both throws `config-refused`.
- A `masterKeyFile` written with mode `0o644` throws `config-refused`; the same file after `chmodSync(path, 0o600)` loads.
- A `masterKeyFile` naming a missing path throws `config-invalid`.

`npm run verify` exits 0.

Proof: `PASS 001-CONFIG`.
