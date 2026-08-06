# Story 1 — The origin configuration

Epic: `.agent/plan/epics/010.5-browser-access.md`

## Change

### 1. New file `src/domain/origin.ts`

Pure. `new URL` is already used in `src/domain/loopback.ts:20`, so the URL global is permitted here.

```ts
export type OriginRefusalReason =
  | "wildcard"
  | "whitespace"
  | "scheme"
  | "path"
  | "query"
  | "fragment"
  | "credentials"
  | "unparsable";

export type OriginCanonicalization =
  | Readonly<{ ok: true; origin: string }>
  | Readonly<{ ok: false; reason: OriginRefusalReason }>;

export function canonicalizeOrigin(raw: string): OriginCanonicalization;
```

**The raw string is validated as an origin grammar first, and `URL` is used only to
canonicalize a value that already passed.** The reverse order is unsafe: `new URL` accepts
many non-origin spellings and silently normalizes them into a valid HTTP origin.

Declare one module-level constant, so the control-character class is written once:

```ts
const FORBIDDEN_SPACE = /[\s\u0000-\u001F\u007F]/;
const SCHEME = /^https?:\/\//;
```

Apply these rules in this exact order and return on the first match. The order is
normative: an entry can match two rules, and the reported reason must not depend on the
implementation.

1. `raw` includes `*` → `wildcard`.
2. `FORBIDDEN_SPACE.test(raw)` → `whitespace`. This covers a leading or trailing space and
   any embedded control character. `new URL` strips both silently.
3. `!SCHEME.test(raw)` → `scheme`. The scheme is matched on the **raw string**, not on
   `url.protocol`. This is what refuses `http:a.test` and `http:/a.test`, which `new URL`
   accepts and normalizes to `http://a.test`, and it also refuses `ftp://a.test` and
   `null`.
4. Let `authority = raw.slice(raw.indexOf("://") + 3)`. Rule 3 guarantees `"://"` is
   present. Find the **first** character of `authority` that is one of `/`, `\`, `?`, `#`:
   - `/` or `\` → `path`
   - `?` → `query`
   - `#` → `fragment`

   A backslash is a path separator for a special scheme, so `http://a.test\path` is a path.
   Taking the first delimiter is what keeps the reason deterministic: `http://a.test?q=/`
   is `query`, not `path`.

5. `authority.includes("@")` → `credentials`. Testing the raw authority, not
   `url.username`/`url.password`, is what refuses `http://@a.test` and `http://:@a.test` —
   both parse with empty username and password.
6. `authority.length === 0` → `unparsable`. This refuses a bare `http://`.
7. `new URL(raw)` throws → `unparsable`.
8. `url.origin === "null"` → `unparsable`. A defensive guard against an opaque origin.
9. Otherwise `{ ok: true, origin: url.origin }`.

Rules 4 and 5 are raw-string tests on purpose. Measured behaviour that makes the
`URL`-first alternative wrong:

- `new URL("http://a.test").pathname` and `new URL("http://a.test/").pathname` are **both**
  `"/"`, so `pathname` cannot detect a trailing slash.
- `new URL("http://a.test?").search` and `new URL("http://a.test#").hash` are **both** `""`,
  so a bare delimiter is invisible to `search`/`hash`.
- `new URL("http://user:pw@a.test").origin` is `"http://a.test"` — credentials vanish from
  `origin`.

`url.origin` performs every normalization the epic requires: it lowercases the host, drops
a default port, converts an internationalized name to punycode, and keeps an IPv6 literal
bracketed.

This exact algorithm was executed against the full accept/refuse matrix in the Verify
section below, and every case matches.

### 2. `src/services/config/index.ts:1-6` — add the field

`HttpSettings` gains `allowedOrigins`, after `allowedHosts`:

```ts
export type HttpSettings = Readonly<{
  bind: string;
  port: number;
  token: string;
  allowedHosts: readonly string[];
  allowedOrigins: readonly string[];
}>;
```

### 3. `src/services/config/convict.ts` — the schema, the format, the coercion

Add a validator beside `hostList` (`convict.ts:17-26`). It differs from `hostList` in one
way: an **empty array is legal**, because an empty origin list is the default.

```ts
function originList(value: unknown): void {
  if (!Array.isArray(value)) {
    throw new Error("must be an array");
  }
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error("every entry must be a non-empty string");
    }
  }
}
```

Register it in the `convict.addFormats({ ... })` call at `convict.ts:169-174`, as
`originList: { validate: originList }`.

Add to the `http` group in `buildSchema()` at `convict.ts:53-66`, after `allowedHosts`.
The default is `[]`, **not** `null` — `null` is how this schema expresses "required", and
this field is optional:

```ts
      allowedOrigins: {
        format: "originList",
        default: [],
        env: "KANTHORD_HTTP_ALLOWED_ORIGINS",
      },
```

Add a splitter beside `normalizeAllowedHosts` (`convict.ts:92-105`). Do **not** copy that
function's body: it filters non-string and empty entries out of an **array**, which would
let a config file containing `"allowedOrigins": [123, ""]` normalize to `[]` and validate
clean, contradicting the `originList` contract. Split only the string form, and pass an
array through untouched so the validator sees every entry:

```ts
function normalizeAllowedOrigins(raw: unknown): unknown {
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }
  return raw;
}
```

Unlike the host list, an empty result is legal. Trimming applies to the env form only,
which is why `canonicalizeOrigin` still refuses a whitespace-bearing entry from a config
file rather than silently accepting it.

Because the returned value may be a non-array, `config.set` must run **before**
`config.validate` so `originList` reports a bad entry — that is already true of the
sandwich position below.

The work splits across the existing pipeline in **two** places, and the split is normative.

**Step A — the split, in the existing sandwich.** Between `config.load(parsed)`
(`convict.ts:177`) and `config.validate` (`convict.ts:187`), immediately after the
`http.allowedHosts` lines at `convict.ts:179-180`. There is no convict `coerce` in this
codebase; a list env var is normalized manually in exactly this position.

```ts
config.set(
  "http.allowedOrigins",
  normalizeAllowedOrigins(config.get("http.allowedOrigins")),
);
```

`config.validate` then runs and `originList` reports a non-array or a bad entry as
`config-invalid`.

**Step B — the canonicalization, after validation.** Insert after the `config.validate`
block (`convict.ts:186-190`) and **before** the `assertStartable` call
(`convict.ts:216-222`), so Story 2 reads canonical values.

```ts
const canonicalOrigins: string[] = [];
for (const entry of config.get("http.allowedOrigins") as string[]) {
  const result = canonicalizeOrigin(entry);
  if (!result.ok) {
    throw new ConfigError(
      "config-invalid",
      `http.allowedOrigins entry ${JSON.stringify(entry)} is not a canonical origin (${result.reason})`,
    );
  }
  canonicalOrigins.push(result.origin);
}
config.set("http.allowedOrigins", canonicalOrigins);
```

Canonicalization must not run before `config.validate`, because the value at that point may
not be an array and the loop would throw a `TypeError` instead of a `ConfigError`.

Canonical origins are stored in input order. Do **not** deduplicate; Story 3 builds a
`Set` from this array.

Import `canonicalizeOrigin` from `../../domain/origin.ts`.

Add `allowedOrigins: config.get("http.allowedOrigins") as string[]` to the `http` object of
the returned settings at `convict.ts:239-261`.

## Constraints

- Do not touch `hostList` or `normalizeAllowedHosts`. `http.allowedHosts` keeps rejecting
  an empty array; only the new field tolerates one.
- Do not add `coerce` to any format. `src/services/config/convict.d.ts:21-24` types
  `addFormats` as accepting `{ validate }` only, and widening it is out of scope.
- `config.validate({ allowed: "strict" })` rejects an unknown key, so the schema entry must
  land before any config file mentions the field.
- Do not add a `doc` key. No property in this schema has one.

## Verify

`node --test src/domain/origin.test.ts` — new file. Assert `canonicalizeOrigin`:

Write both tables exactly as listed. Every row was executed against the algorithm above and
every row matches; a differing result means the implementation deviated from the rule order.

Accept table — assert `result.ok === true` and the exact `result.origin`:

| input                          | origin                         |
| ------------------------------ | ------------------------------ |
| `http://a.test`                | `http://a.test`                |
| `http://localhost:8080`        | `http://localhost:8080`        |
| `http://LOCALHOST:80`          | `http://localhost`             |
| `https://a.test:443`           | `https://a.test`               |
| `http://[::1]:8080`            | `http://[::1]:8080`            |
| `http://пример.рф`             | `http://xn--e1afmkfd.xn--p1ai` |
| `http://xn--e1afmkfd.xn--p1ai` | `http://xn--e1afmkfd.xn--p1ai` |

Refuse table — assert `result.ok === false` and the exact `result.reason`:

| input                   | reason        |
| ----------------------- | ------------- |
| `*`                     | `wildcard`    |
| `http://*.test`         | `wildcard`    |
| `http://*.test/path`    | `wildcard`    |
| `null`                  | `scheme`      |
| `ftp://a.test`          | `scheme`      |
| `http:a.test`           | `scheme`      |
| `http:/a.test`          | `scheme`      |
| `http://user:pw@a.test` | `credentials` |
| `http://@a.test`        | `credentials` |
| `http://:@a.test`       | `credentials` |
| `http://a.test/`        | `path`        |
| `http://a.test/path`    | `path`        |
| `http://a.test\path`    | `path`        |
| `http://a.test?q=1`     | `query`       |
| `http://a.test?`        | `query`       |
| `http://a.test?q=/`     | `query`       |
| `http://a.test#f`       | `fragment`    |
| `http://a.test#`        | `fragment`    |
| `http://a.test#/`       | `fragment`    |
| `  http://a.test`       | `whitespace`  |
| `http://a.test  `       | `whitespace`  |
| `http://`               | `unparsable`  |
| `https://`              | `unparsable`  |

Nine of these rows exist only because `new URL` accepts the value and normalizes it to a
valid HTTP origin. Do not drop them:

- `http:a.test`, `http:/a.test` → `new URL` yields origin `http://a.test`.
- `http://a.test\path` → the backslash is a path separator for a special scheme.
- `http://@a.test`, `http://:@a.test` → empty userinfo, so `url.username` is `""`.
- `http://a.test?`, `http://a.test#` → bare delimiter, so `url.search`/`url.hash` are `""`.
- `  http://a.test`, `http://a.test  ` → `new URL` strips the whitespace.

Rule-order rows: `http://*.test/path` reports `wildcard`, not `path`; `http://a.test?q=/`
reports `query`, not `path`.

`node --test src/services/config/convict.test.ts` — extend. Follow the file's conventions:
a `tmpDir()` per test with a `finally` cleanup, `env` injected through `loadInput`, never
`process.env`, and a refusal asserted through `assert.throws` with a predicate checking
`err.code`.

- Omitting `http.allowedOrigins` from the config file loads and yields `[]`.
- `KANTHORD_HTTP_ALLOWED_ORIGINS=""` yields `[]` and loads. (Contrast with
  `http.allowedHosts`, where an empty value is `config-invalid`.)
- `KANTHORD_HTTP_ALLOWED_ORIGINS="http://a.test, http://b.test ,,http://c.test"` yields
  exactly `["http://a.test", "http://b.test", "http://c.test"]`.
- `KANTHORD_HTTP_ALLOWED_ORIGINS="http://LOCALHOST:80"` yields exactly
  `["http://localhost"]`.
- A table test over `*`, `http://*.test`, `http://a.test/`, `http://a.test/path`,
  `ftp://a.test`, `http://user:pw@a.test`, `null`, `http:a.test`, `http://a.test?`,
  `http://@a.test`: each fails to load with `err.code` `config-invalid`, and `assert.match`
  confirms the message contains the offending entry rendered by `JSON.stringify`.
- Entry order is preserved, and a duplicate is kept:
  `"http://b.test,http://a.test,http://b.test"` yields
  `["http://b.test", "http://a.test", "http://b.test"]`.

Canonicalization must be proved through a **config file array**, not only through the env
var, because the two take different paths through `normalizeAllowedOrigins`:

- A config file with `"allowedOrigins": ["http://LOCALHOST:80", "https://a.test:443"]`
  loads and yields exactly `["http://localhost", "https://a.test"]`.
- A config file with `"allowedOrigins": ["http://a.test?q=1"]` fails with `config-invalid`
  and the message names the entry — proving query refusal reaches the load path, not only
  the domain unit.
- A config file with `"allowedOrigins": ["http://a.test#f"]` fails with `config-invalid`.
- A config file with `"allowedOrigins": [123]` fails with `config-invalid`, and a file with
  `"allowedOrigins": [""]` fails with `config-invalid`. Neither may normalize to `[]` and
  load clean. This is the assertion that pins the `normalizeAllowedOrigins` array
  pass-through.
- A config file with `"allowedOrigins": "http://a.test,http://b.test"` (a string, not an
  array) loads and yields `["http://a.test", "http://b.test"]`.

Every one of these tests supplies a non-empty `http.token`, because Story 2 makes a
non-empty origin list with an empty token refuse startup.

`npm run verify` exits 0.

Proof: this story's own suites (`src/domain/origin.test.ts`,
`src/services/config/convict.test.ts`) are **not** in the EPIC Proof command; they run under
`npm run verify`. See "Open questions for the human" in `index.md` — the Proof command needs
widening, which is an EPIC edit this story cannot make. The `PASS EPIC-010.5` line is
delivered collectively.
