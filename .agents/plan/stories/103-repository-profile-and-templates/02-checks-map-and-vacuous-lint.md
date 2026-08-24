# Story 2 — The `checks` map and the vacuous-command lint

Epic: `.agents/plan/epics/103-repository-profile-and-templates.md`
Depends on: Story 1.

## Change

- Add `src/domain/profile-check.ts`. It imports `zod` and `./profile-finding.ts` only.
- Export `checkNames = ["e2e", "unit"] as const` in that bytewise order, and `CheckName = (typeof checkNames)[number]`.
- Export `profileCheckLoose = z.strictObject({ run: z.array(z.unknown()), timeout: z.unknown() })`. It stays permissive on purpose: every rule below is a finding, so a zod issue must never pre-empt one. An entry that is not an object, or that carries a third key, still fails the parse and becomes `frontmatter-invalid` in Story 4.
- Export `profileChecks = z.record(z.string(), profileCheckLoose)`, so an illegal check name reaches `validateChecks` as data and becomes a finding instead of a zod issue.
- Export `ProfileCheck = Readonly<{ run: readonly string[]; timeout: string }>`, the shape an entry holds after `validateChecks` returns no finding for it.
- Export `TIMEOUT_PATTERN = /^[1-9][0-9]*m$/`.
- Export `timeoutMilliseconds(token: string): number`. Return `Number(token.slice(0, -1)) * 60000`. It assumes a token that already matched `TIMEOUT_PATTERN`.
- Export `validateChecks(checks: Readonly<Record<string, z.infer<typeof profileCheckLoose>>>): readonly ProfileFinding[]`. It collects every finding and stops at none, then returns `sortProfileFindings` of the collected list.
- Iterate the entry names through `Object.keys(checks).sort()` so collection order never depends on insertion order.
- For a name that is not in `checkNames`, push `check-name-invalid` with `locator` equal to that name, and validate no further part of that entry.
- After the name loop, when `checks.unit` is absent, push `check-missing` with `locator` `unit`. An absent `e2e` is legal and pushes nothing.
- For each legal entry, push `check-run-empty` with the check name as `locator` when `run.length === 0`.
- For each legal entry, push `check-run-invalid` with the check name as `locator` when any element of `run` is not a string, is the empty string, or holds the code unit `\u0000`. Push it once per entry, not once per element.
- For each legal entry, push `check-timeout-invalid` with the check name as `locator` when `timeout` is not a string, or is a string that does not match `TIMEOUT_PATTERN`.
- For each legal entry whose `run` passed the two checks above, apply the vacuous-command lint and push `check-cannot-fail` with the check name as `locator` when it rejects.
- Export `commandCannotFail(run: readonly string[]): boolean`. Take `program` as the last `/`-separated segment of `run[0]`.
- Return `true` when `program` is `true` or `:`.
- Return `true` when `program` is one of `sh`, `bash`, `zsh` or `dash` and the element that follows the **first** `-c` in `run`, trimmed of leading and trailing whitespace, equals `true`, `:` or `exit 0`, or ends with `|| true`, `|| :`, `; true` or `|| exit 0`.
- Return `false` when `run` is empty, when `run[0]` is not a string, when no `-c` appears, or when no element follows the first `-c`. The lint never throws.
- Return `false` in every other case. There is no third rule.
- Give every finding a message. Use these exact messages, with `<name>` the check name: `check-name-invalid` — `check <name> is not a declarable check`; `check-missing` — `the profile declares no unit check`; `check-run-empty` — `check <name> declares an empty run`; `check-run-invalid` — `check <name> declares an invalid run element`; `check-timeout-invalid` — `check <name> declares an invalid timeout`; `check-cannot-fail` — `check <name> declares a command that cannot fail`.

## Constraints

- Do not spawn a process, read a file or resolve a path. The lint is static.
- Do not reject `echo`, `printf`, `env` or `exit`; the closed set above is the whole rule.
- Do not treat `-c` appearing after the command string as the flag; only the first `-c` counts.
- Do not import `src/domain/profile-document.ts`; the dependency runs the other way.

## Verify

- Add `src/domain/profile-check.test.ts`.
- Assert `validateChecks({ unit: { run: ["true"], timeout: "10m" } })` returns exactly one finding, `code` `check-cannot-fail` and `locator` `unit`.
- Assert `validateChecks({ unit: { run: ["npm", "test"], timeout: "10m" } })` returns an empty array.
- Assert `run` of `["bash", "-c", "npm test || true"]` returns `check-cannot-fail` with locator `unit`.
- Assert each of `["echo", "ok"]`, `["printf", "ok"]`, `["exit", "0"]` and `["env", "true"]` returns no finding.
- Assert each of `["env", "true"]`, `["sh", "-c", "exit 0 # ok"]` and `["node", "-e", "process.exit(0)"]` returns no finding.
- Assert `["/usr/bin/true"]` returns `check-cannot-fail`, because the lint reads the last `/`-separated segment.
- Assert each of `["sh", "-c", "  :  "]`, `["zsh", "-c", "exit 0"]`, `["dash", "-c", "make || :"]` and `["bash", "-c", "make ; true"]` returns `check-cannot-fail`.
- Assert `["bash", "-c", "make || exit 0"]` returns `check-cannot-fail`.
- Assert `{ e2e: { run: ["npm", "run", "e2e"], timeout: "30m" } }` with no `unit` returns `check-missing` with locator `unit`.
- Assert `{ lint: { run: ["npm", "run", "lint"], timeout: "5m" }, unit: { run: ["npm", "test"], timeout: "10m" } }` returns exactly one finding, `check-name-invalid` with locator `lint`.
- Assert `timeout` of `10s` returns `check-timeout-invalid`, and that `0m` and `10` also return it.
- Assert `timeoutMilliseconds("10m")` equals `600000` and `timeoutMilliseconds("5m")` equals `300000`.
- Assert `run` of `[]` returns `check-run-empty`, and `run` of `["npm", ""]` and `["npm", "a\u0000b"]` each return `check-run-invalid`.
- Assert a `unit` entry that is both `check-cannot-fail` and an invalid timeout returns both findings, ordered `check-cannot-fail` then `check-timeout-invalid`.
- Assert these boundary cases return **no** `check-cannot-fail`: `["bash", "-c"]` with no element after the flag; `["bash", "make || truex"]` with no `-c` at all; `["bash", "-c", "make || truex"]`, because `|| truex` is not the suffix `|| true`.
- Assert `["bash", "-c", "make", "-c", "true"]` returns no finding, because only the element after the **first** `-c` is read.
- Assert `commandCannotFail([])` returns `false` and throws nothing.
- Run `node --test src/domain/profile-check.test.ts`; it exits 0.
- Proof: EPIC Proof line 47, plus Hermetic coverage lines 59, 60, 61, 62, 63 and 65.
