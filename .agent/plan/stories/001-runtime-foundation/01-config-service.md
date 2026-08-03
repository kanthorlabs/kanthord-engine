# Story 01 — Config service on convict

Epic: `.agent/plan/epics/001-runtime-foundation.md`

## Change

Create `src/services/config/index.ts` — the interface, no implementation and no re-export of one.

```ts
export type HttpSettings = Readonly<{
  bind: string;
  port: number;
  token: string;
  allowedHosts: readonly string[];
}>;

export type Settings = Readonly<{
  home: string;
  actor: string;
  masterKey: Buffer;
  http: HttpSettings;
  attemptLimit: number;
}>;

export type Discovery = Readonly<{
  resolved: string;
  searched: readonly string[];
}>;

export type Loaded = Readonly<{ settings: Settings; discovery: Discovery }>;

export type LoadInput = Readonly<{
  explicitConfigPath: string;
  homeOverride?: string;
  env: Readonly<Record<string, string | undefined>>;
  cwd: string;
}>;

export type ConfigErrorCode =
  "config-not-found" | "config-invalid" | "config-refused";

export class ConfigError extends Error {
  readonly code: ConfigErrorCode;
  constructor(code: ConfigErrorCode, message: string) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
  }
}

export interface Config {
  load(input: LoadInput): Loaded;
}
```

Create `src/services/config/convict.ts` — `export class ConvictConfig implements Config`.

`load(input)` runs these steps in this order, and no other:

1. Read `input.explicitConfigPath` with `fs.readFileSync`. An `ENOENT` throws `ConfigError("config-not-found", ...)` naming that path. Story 02 puts the search order in front of this step.
2. `JSON.parse` the bytes. A parse failure throws `ConfigError("config-invalid", ...)` naming the path and the parser message.
3. Build a fresh convict schema per call — never a module-level singleton — and `load` the parsed object.
4. Normalize `http.allowedHosts` on the loaded instance, before `validate`, with `config.set`. A `string` splits on `,`, each part trims, and an empty part drops. An array maps the same trim-and-drop over its entries. The result keeps its declared order. Measured: convict splits an `Array` environment value on `,` by itself but trims nothing and keeps empty parts, so `"x:1, y:2 ,,z:3"` arrives as `["x:1", " y:2 ", "", "z:3"]`. Normalizing before `validate` is what lets `hostList` be a schema format instead of a second check.
5. Apply `input.homeOverride` over `home` with `config.set` when it is present and non-empty, then `validate({ allowed: "strict" })`. A convict throw becomes `ConfigError("config-invalid", <convict message>)`.
6. Resolve the master key. `masterKey` non-empty decodes as base64. Otherwise `masterKeyFile` is read and its contents `trim()` decode as base64. A decode that does not yield exactly 32 bytes throws `ConfigError("config-invalid", ...)` naming the byte count it got. Story 04 owns the case where neither is set.
7. Return `{ settings, discovery: { resolved: input.explicitConfigPath, searched: [input.explicitConfigPath] } }`.

The convict schema, exactly:

| Path                | convict `format`  | `default`   | `env`                         |
| ------------------- | ----------------- | ----------- | ----------------------------- |
| `home`              | `nonEmptyString`  | `null`      | `KANTHORD_HOME`               |
| `actor`             | `nonEmptyString`  | `null`      | `KANTHORD_ACTOR`              |
| `masterKey`         | `String`          | `""`        | `KANTHORD_MASTER_KEY`         |
| `masterKeyFile`     | `String`          | `""`        | `KANTHORD_MASTER_KEY_FILE`    |
| `http.bind`         | `nonEmptyString`  | `127.0.0.1` | `KANTHORD_HTTP_BIND`          |
| `http.port`         | `"port"`          | `null`      | `KANTHORD_HTTP_PORT`          |
| `http.token`        | `String`          | `""`        | `KANTHORD_HTTP_TOKEN`         |
| `http.allowedHosts` | `hostList`        | `null`      | `KANTHORD_HTTP_ALLOWED_HOSTS` |
| `attemptLimit`      | `positiveInteger` | `3`         | `KANTHORD_ATTEMPT_LIMIT`      |

A `default` of `null` is convict's required marker.

Three of those formats are custom validator functions declared in `convict.ts`, because convict's built-ins do not carry these rules. Measured against `convict@6.2.5`: `String` accepts `""`, `Array` accepts `[]`, and `"nat"` accepts `0`. A format function throws, and convict wraps the throw, so all three report as `config-invalid`.

- `nonEmptyString(value)` throws unless `typeof value === "string"` and `value.length > 0`.
- `hostList(value)` throws unless `value` is an array with at least one entry and every entry is a non-empty string. It runs inside `validate` at step 5, after the normalization of step 4, so a comma-separated value has already become an array.
- `positiveInteger(value)` throws unless `Number.isInteger(value)` and `value >= 1`.

`masterKey` and `masterKeyFile` never reach `Settings`. Only the resolved 32-byte `Buffer` does.

Read the environment from `input.env`, never from `process.env`. Convict reads `process.env` by itself, so pass `{ env: input.env }` as the second argument of `convict(...)` — convict's `env` option overrides the ambient environment, and a test that mutated `process.env` would not be hermetic.

## Constraints

- `src/services/config/index.ts` holds types, the error class and the interface, and imports nothing at all. `Buffer` is a global in `@types/node`, so the interface names it without an import and the file stays as dependency-free as a `domain/` file.
- `ConvictConfig` throws `ConfigError` and never a bare `Error` and never a convict error.
- No caching. Two `load` calls with the same input produce two equal results, and a changed file is visible to the second call.
- Build the returned `Settings` as one object literal with its keys in the declared order — `home`, `actor`, `masterKey`, `http`, `attemptLimit`. A test asserts that order, because a canonical key order is what later serialization depends on.
- Do not touch `src/main.ts`. Story 07 wires this.

## Verify

`node --test src/services/config/convict.test.ts`, which asserts:

- A file holding every required key returns `Settings` with each value, and `attemptLimit` is `3` when the file omits it.
- `discovery.resolved` and `discovery.searched` both name the explicit path.
- An absent path throws `ConfigError` with `code === "config-not-found"`, and the message contains the path.
- A file holding `{` throws `code === "config-invalid"`.
- A file omitting `home`, one omitting `actor`, one omitting `http.port` and one omitting `http.allowedHosts` each throw `code === "config-invalid"`.
- `actor: ""`, `home: ""`, `http.bind: ""`, `http.allowedHosts: []`, `http.allowedHosts: [""]` and `http.allowedHosts: ", ,"` each throw `config-invalid`. These are the cases convict's built-in formats accept, so each one is a guard on a custom format.
- No test asserts a convict message string. Every assertion is on `error.code`.
- An unknown key in the file throws `config-invalid`, because `validate` runs with `allowed: "strict"`.
- `http.port: "not-a-port"` and `http.port: 70000` each throw `config-invalid`.
- `attemptLimit: 0`, `attemptLimit: -1` and `attemptLimit: 1.5` each throw `config-invalid`. `attemptLimit: 1` loads.
- `input.env` overrides the file: `KANTHORD_ACTOR=from-env` wins over an `actor` in the file. The same for `KANTHORD_HTTP_PORT`.
- `KANTHORD_HTTP_ALLOWED_HOSTS="a:1, b:2 ,,c:3"` yields exactly `["a:1", "b:2", "c:3"]`, in that order.
- `homeOverride` wins over `home` from the file and from the environment.
- `masterKeyFile` pointing at a file whose contents are a 32-byte base64 value with a trailing newline yields the same `Buffer` as the equivalent `masterKey`, compared with `Buffer.equals`.
- A 31-byte base64 `masterKey` throws `config-invalid`, and the message names `31`.
- `Settings` carries no `masterKey` string and no `masterKeyFile` key: `Object.keys(settings)` equals `["home","actor","masterKey","http","attemptLimit"]` exactly, in that order.

Every test writes its file into its own `fs.mkdtempSync(join(tmpdir(), "kanthord-config-"))` directory and removes it in `after`. Story 08's helper does not exist yet, and this test does not wait for it.

`npm run verify` exits 0.

Proof: `PASS 001-CONFIG`.
