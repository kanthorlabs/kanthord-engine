# Story 02 — Url policy

Epic: `.agents/plan/epics/006-git-primitives.md`
Depends on: EPIC 004 Story 07 (`src/domain/loopback.ts` exports `isLoopbackHost`).

This story starts no process. It is the one story in the epic that runs without `git`.

## Change

### 1. `src/services/git/index.ts` — extend `UrlRefusal`

At `src/services/git/index.ts:64-69`, replace the union with six members, in this order:

```ts
export type UrlRefusal =
  | "malformed"
  | "scheme-not-allowed"
  | "insecure-non-loopback"
  | "password-in-url"
  | "option-like"
  | "control-character";
```

`malformed` is new. `new URL` rejects a url that no other reason describes, and `RemoteUrlVerdict` at `:71-73` carries no channel for "did not parse".

Change nothing else in `index.ts` in this story.

### 2. `src/services/git/url.ts` (new)

```ts
import { isLoopbackHost } from "../../domain/loopback.ts";

import type { RemoteUrlVerdict } from "./index.ts";

export function remoteUrlVerdict(remoteUrl: string): RemoteUrlVerdict;
```

The function is pure and synchronous. It runs these steps in this exact order, and the order is asserted.

1. **Control characters, on the raw string.** Scan every code unit of `remoteUrl`. When any code point is below `0x20`, or equals `0x7f`, refuse `control-character` with reason `"the url carries a control character"`. This runs **before** any parse, because `new URL("https://h/x\n.git")` silently strips the newline and yields path `/x.git` — a later check would never see it.
2. **The scp-like spelling.** Match `/^([A-Za-z0-9._~+-]+)@([^:/@]+):(.+)$/` against `remoteUrl`. On a match, bind `host` to group 2 and `path` to group 3, set the transport to `ssh`, and continue at step 7 with those two values. `git@host:path` throws `ERR_INVALID_URL` in `new URL`, so it is recognised before parsing rather than after a failure.
3. **Parse.** Call `new URL(remoteUrl)` inside a `try`. On a throw, refuse `malformed` with reason `"the url does not parse"`. This is the only refusal the parse itself produces.
4. **Scheme.** Read `url.protocol`.
   - `"https:"` — transport `http-basic`.
   - `"http:"` — transport `http-basic`, and step 8 applies.
   - `"ssh:"` — transport `ssh`.
   - anything else — refuse `scheme-not-allowed` with reason `` `the scheme ${url.protocol.slice(0, -1)} is not allowed` ``.
     Bind `host` to `url.hostname` and `path` to `url.pathname`.
5. **No host, on the raw string.** Find `"://"` in `remoteUrl`. When it is absent, this step passes. Otherwise take the remainder after it and refuse `malformed` with reason `"the url names no host"` when that remainder is empty or begins with `/`, `?` or `#`.
6. **Password.** When `url.password !== ""`, refuse `password-in-url` with reason `"the url carries a password; store the secret in a credential"`. A username is not refused: `git@host:path` is the ordinary ssh spelling, and `url.username` is never inspected. The scp-like branch of step 2 has no password position, so it skips this step.
7. **Option-like.** When `host` starts with `-`, refuse `option-like` with reason `"the host begins with a hyphen"`. When `path`, after one leading `/` is removed, starts with `-`, refuse `option-like` with reason `"the path begins with a hyphen"`.
8. **Plain HTTP.** When the scheme is `http:`, call `isLoopbackHost(host.replace(/^\[/, "").replace(/\]$/, ""))`. On `false`, refuse `insecure-non-loopback` with reason `"plain HTTP is allowed only on a loopback host"`. The bracket strip is required: `new URL("http://[::1]:9/x.git").hostname` is `"[::1]"`, with the brackets.
9. Return `{ allowed: true, transport, host }`, where `host` is the value bound above, brackets included for an IPv6 literal.

Two measured facts fix the position and the mechanism of step 5, both on Node 24.17.0:

- `url.hostname` cannot carry the check. `new URL("https:///r.git").hostname` is `"r.git"` and its pathname is `"/"`, not an empty hostname. `new URL("https://")` throws, so that row refuses at step 3 instead. The raw-string test is what sees the missing authority.
- The no-host check must run **after** the scheme check, not before it. `file:///srv/r.git` and `ext::sh -c whoami` both parse with an empty `hostname`, so a no-host check placed earlier would refuse both as `malformed` while the refusal table below requires `scheme-not-allowed`. The table is the contract; this order is the only one that satisfies it.

## Constraints

- `src/services/git/url.ts` contains no `127.` literal and no `"localhost"` literal. `.agents/plan/stories/004-transport-skeleton/07-cli-program-skeleton.md:377-380` asserts that exactly two files under `src/` hold either substring — `domain/loopback.ts` and `services/config/convict.ts`. A third file fails that test. The classification comes from `isLoopbackHost` and from nowhere else.
- The function imports `node:` nothing, spawns nothing, and reads no file. `URL` is a global.
- Never call `decodeURIComponent`, and never re-serialise the url. The verdict reports a decision; the caller passes the original string to `git`. A percent-encoded leading hyphen — `https://forge.test/%2Dx.git` — is therefore **allowed**, and that is correct: `git` sends the path as written and never decodes it into an option, so decoding here would invent a refusal the transport does not need.
- A query string and a fragment are not inspected. No product url carries either, and refusing one would be a policy this epic was not asked to write.
- Do not widen the scp-like regular expression to accept a `/` before the `:`. `https://h/a:b` must reach step 3 as a url, not step 2 as an scp path.

## Verify

`node --test src/services/git/url.test.ts` — new file, suite `"src/services/git/url.test"`.

An accepted table, each asserted as `{ allowed: true, transport, host }` exactly:

| url                             | transport    | host         |
| ------------------------------- | ------------ | ------------ |
| `https://forge.test/o/r.git`    | `http-basic` | `forge.test` |
| `https://user@forge.test/r.git` | `http-basic` | `forge.test` |
| `http://127.0.0.1:7999/r.git`   | `http-basic` | `127.0.0.1`  |
| `http://localhost/r.git`        | `http-basic` | `localhost`  |
| `http://[::1]:7999/r.git`       | `http-basic` | `[::1]`      |
| `ssh://git@forge.test/o/r.git`  | `ssh`        | `forge.test` |
| `ssh://git@forge.test:2222/r`   | `ssh`        | `forge.test` |
| `git@forge.test:o/r.git`        | `ssh`        | `forge.test` |
| `git@forge.test:/abs/r.git`     | `ssh`        | `forge.test` |

`git@forge.test:o/r.git` accepted is the epic's coverage line "a `git@host:path` url is accepted".

A refusal table, each asserted by `refusal` **and** by the exact `reason` string:

| url                                    | refusal                 |
| -------------------------------------- | ----------------------- |
| `https://user:secret@forge.test/r.git` | `password-in-url`       |
| `http://forge.test/r.git`              | `insecure-non-loopback` |
| `http://127.0.0.1.evil.test/r.git`     | `insecure-non-loopback` |
| `git://forge.test/r.git`               | `scheme-not-allowed`    |
| `file:///srv/r.git`                    | `scheme-not-allowed`    |
| `ext::sh -c whoami`                    | `scheme-not-allowed`    |
| `https://-forge.test/r.git`            | `option-like`           |
| `https://forge.test/-upload-pack.git`  | `option-like`           |
| `git@-forge.test:r.git`                | `option-like`           |
| `git@forge.test:-r.git`                | `option-like`           |
| `"https://forge.test/r\n.git"`         | `control-character`     |
| `"https://forge.test/r\t.git"`         | `control-character`     |
| `"ssh://git@forge.test/r\u007f.git"`   | `control-character`     |
| `not a url at all`                     | `malformed`             |
| `https://`                             | `malformed`             |
| `https:///r.git`                       | `malformed`             |

The three `control-character` rows are TypeScript string literals carrying a real escape, not the two characters `\` and `n`. A space is `0x20` and is not a control character: `remoteUrlVerdict("https://forge.test/r .git")` is allowed, and the test asserts that, so the boundary of the scan is pinned from both sides.

Every value of `UrlRefusal` appears at least once in that table, asserted by collecting the six refusals from the results and deep-equalling the sorted set against the sorted union members. Together with the accepted table, this is the epic coverage line "Every refusal of the url policy is asserted by reason, and a `git@host:path` url is accepted."

Order assertions — these prove step order rather than step presence:

- `remoteUrlVerdict("https://user:secret@forge.test/r\n.git")` refuses `control-character`, not `password-in-url`. The raw scan precedes the parse.
- `remoteUrlVerdict("http://user:secret@forge.test/r.git")` refuses `password-in-url`, not `insecure-non-loopback`. The password check precedes the loopback check.
- `remoteUrlVerdict("http://-forge.test/r.git")` refuses `option-like`, not `insecure-non-loopback`.

Two allowed cases that pin what is **not** refused: `https://forge.test/%2Dx.git` and `https://forge.test/r.git?ref=main` are both allowed, asserted as `{ allowed: true }`. Each is a refusal a stricter reading would add, and neither is this policy's.

Construction assertions. Read `src/services/git/url.ts` as text with `fs.readFileSync`, resolving from `import.meta.url`, and assert it does not include `"127."`, does not include `"localhost"`, does not include `"node:"`, and does not include `"decodeURIComponent"`.

`npm run verify` exits 0.

Proof: contributes `src/services/git/url.test.ts` to `node --test src/services/git/**/*.test.ts`.
